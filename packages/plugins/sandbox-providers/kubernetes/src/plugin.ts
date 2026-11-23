import { randomBytes } from "node:crypto";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentSyncInParams,
  PluginEnvironmentSyncOutParams,
  PluginEnvironmentSyncResult,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";
import {
  kubernetesProviderConfigSchema,
  type KubernetesProviderConfig,
  type KubernetesLeaseMetadata,
} from "./types.js";
import { createKubeConfig, makeKubeClients } from "./kube-client.js";
import { getAdapterDefaults, buildAdapterEnv, resolveRunAdapterType } from "./adapter-defaults.js";
import { parseDigestImageRef, resolveImageDetailed } from "./image-allowlist.js";
import { buildJobManifest } from "./pod-spec-builder.js";
import {
  buildSandboxCrManifest,
  resolvePodSizing,
  type ExpertResourceProfileName,
} from "./sandbox-cr-builder.js";
import { ensureTenant } from "./tenant-orchestrator.js";
import { createAgentSessionSecret, createPerRunSecret } from "./secret-manager.js";
import { FastUploadInterceptor } from "./upload-interceptor.js";
import { jobOrchestrator, JobTimeoutError } from "./job-orchestrator.js";
import {
  createSandboxCrOrchestrator,
  sandboxCrOrchestrator,
  SandboxCrTimeoutError,
  type SandboxCrApiVersion,
} from "./sandbox-cr-orchestrator.js";
import {
  buildSandboxClaimManifest,
  createSandboxClaim,
  destroyClaimedSandbox,
  waitForSandboxClaimReady,
  WarmPoolMetricsTracker,
} from "./sandbox-claim-orchestrator.js";
import {
  evaluateCapacityAdmission,
  PriorityBackpressureQueue,
  readTenantQuotaWatermark,
  resolveSensitiveIsolationPolicy,
  type DataClassificationLevel,
} from "./capacity-admission.js";
import { execInPod, execInPodStreaming, wrapCommandWithEnv } from "./pod-exec.js";
import { performSyncIn, performSyncOut, type PodStreamExec } from "./file-sync.js";
import { checkLeaseResumable, destroyLeaseResources } from "./lease-lifecycle.js";
import {
  appendNetworkEgressDenyHint,
  createScopedNetworkEgressPolicyOrReleaseWorkload,
  NETWORK_EGRESS_GRANT_PATH,
  parseScopedNetworkEgressGrant,
} from "./scoped-network-egress.js";
import {
  deriveCompanySlug,
  deriveNamespaceName,
  extractRuntimeEvidence,
  newRunUlidDns,
  paperclipLabels,
  stripRegistryScheme,
} from "./utils.js";

// The namespace paperclip-server itself runs in. Used when building
// NetworkPolicy manifests so the tenant namespace allows inbound traffic
// from the server pod.
const PAPERCLIP_SERVER_NAMESPACE = "paperclip";

// Name of the ServiceAccount created inside each tenant namespace by ensureTenant.
const TENANT_SERVICE_ACCOUNT = "paperclip-tenant-sa";

// Resource quota defaults applied to every tenant namespace (tunable via
// config in a future iteration).
const DEFAULT_RESOURCE_QUOTA = {
  pods: "20",
  requestsCpu: "10",
  requestsMemory: "20Gi",
  limitsCpu: "20",
  limitsMemory: "40Gi",
};

function deriveTenantNamespace(config: KubernetesProviderConfig, companyId: string): string {
  // TODO: future versions could thread companyName through AcquireLeaseParams
  // to get a friendlier slug (e.g. "acme-corp") instead of the UUID-derived one.
  const slug = config.companySlug ?? deriveCompanySlug(companyId);
  return deriveNamespaceName(config.namespacePrefix, slug);
}

function generateBootstrapToken(): string {
  // TODO: tighten once the agent runtime shim (companion images PR) lands its
  // callback auth scheme; paperclip-server's callback auth is out of scope for
  // this plugin. For now this per-run random token is stored in the per-run
  // Secret and read by the runtime image entrypoint for initial registration.
  return randomBytes(32).toString("hex");
}

// One FastUploadInterceptor instance per active lease. Scoping per lease
// prevents `releaseLease` from wiping in-flight upload buffers belonging to
// other concurrent leases — a single shared singleton would do exactly that
// on `reset()`. The Map is keyed by `providerLeaseId`; entries are lazily
// created in `onEnvironmentExecute` and removed in `onEnvironmentReleaseLease`.
const uploadInterceptorsByLease = new Map<string, FastUploadInterceptor>();

function getOrCreateUploadInterceptor(leaseId: string): FastUploadInterceptor {
  let interceptor = uploadInterceptorsByLease.get(leaseId);
  if (!interceptor) {
    interceptor = new FastUploadInterceptor();
    uploadInterceptorsByLease.set(leaseId, interceptor);
  }
  return interceptor;
}

// In-memory cache of sandbox CR names we've already observed reaching the
// Ready condition during the current plugin-worker lifetime. The k8s
// sandbox-cr lifecycle means once a Sandbox pod is Running, subsequent
// execs into it don't need another readiness poll — saves one
// `getNamespacedCustomObject` round-trip per exec, which adds up across
// dozens of sequential exec calls in a typical adapter workflow.
// On worker restart this resets, which is fine: the first exec on each
// lease then re-confirms readiness from scratch.
const readySandboxesByLease = new Set<string>();
const backpressureQueue = new PriorityBackpressureQueue();
const warmPoolMetrics = new WarmPoolMetricsTracker();

export class CapacityAdmissionDeniedError extends Error {
  readonly reason: "quota_exhausted" | "pending_backoff";
  readonly retryAfterMs: number;

  constructor(reason: "quota_exhausted" | "pending_backoff", detail: string, retryAfterMs: number) {
    super(`Kubernetes capacity admission denied (${reason}): ${detail}`);
    this.name = "CapacityAdmissionDeniedError";
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

export function getKubernetesSchedulerMetrics() {
  return {
    backpressure: backpressureQueue.snapshot(),
    warmPool: warmPoolMetrics.snapshot(),
  };
}

// How long onEnvironmentResumeLease waits for an existing Sandbox pod to
// report Ready before declaring the lease non-resumable. Deliberately short:
// this is a liveness check on an already-provisioned pod, not a fresh
// provision — if the pod isn't (almost) up, falling back to acquireLease is
// faster and more reliable than waiting.
const RESUME_READY_TIMEOUT_MS = 30_000;
const RESUME_READY_POLL_MS = 1_000;

// The workspace remote dir is the confinement root for native file sync. It is
// recorded on the lease metadata at realizeWorkspace time (`remoteCwd`); require
// it so a sync can never run without a concrete root to confine every sandbox
// path against.
function resolveSyncRemoteDir(lease: PluginEnvironmentLease): string {
  const remoteCwd = lease.metadata?.remoteCwd;
  if (typeof remoteCwd === "string" && remoteCwd.trim().length > 0) {
    return remoteCwd.trim();
  }
  throw new Error("Kubernetes file sync requires a workspace remote dir on the lease metadata.");
}

/**
 * Resolve the running Sandbox-CR pod for a native file-sync operation and return
 * a `PodStreamExec` bound to it, exactly like `onEnvironmentExecute` resolves its exec
 * target: parse config, derive the namespace, wait for the Sandbox pod to reach
 * Ready (cached per lease), and find the pod name. The `job` backend carries no
 * file path and is out of scope — file sync is only supported on `sandbox-cr`.
 */
async function resolveSyncPodExec(
  params:
    | PluginEnvironmentSyncInParams
    | PluginEnvironmentSyncOutParams,
): Promise<{ exec: PodStreamExec; timeoutMs: number }> {
  const { lease } = params;
  if (!lease.providerLeaseId) {
    throw new Error("Kubernetes file sync requires a provider lease ID.");
  }

  const config = kubernetesProviderConfigSchema.parse(params.config);
  const namespace =
    typeof lease.metadata?.namespace === "string"
      ? lease.metadata.namespace
      : deriveTenantNamespace(config, params.companyId);

  const leaseBackend =
    typeof lease.metadata?.backend === "string"
      ? (lease.metadata.backend as "sandbox-cr" | "job")
      : config.backend;
  if (leaseBackend !== "sandbox-cr") {
    throw new Error(
      `Kubernetes file sync is only supported on the sandbox-cr backend (lease backend: ${leaseBackend}).`,
    );
  }

  const kc = createKubeConfig({
    inCluster: config.inCluster,
    kubeconfig: config.kubeconfig,
  });
  const clients = makeKubeClients(kc);
  const timeoutMs = config.podActivityDeadlineSec * 1000;

  // Ensure the Sandbox pod is Ready (wait only the first time for this lease),
  // then resolve the pod name — mirrors the onEnvironmentExecute resolution.
  if (!readySandboxesByLease.has(lease.providerLeaseId)) {
    await sandboxCrOrchestrator.waitForCompletion(clients, namespace, lease.providerLeaseId, {
      timeoutMs,
      pollMs: 2000,
    });
    readySandboxesByLease.add(lease.providerLeaseId);
  }

  const podName =
    typeof lease.metadata?.podName === "string" && lease.metadata.podName
      ? lease.metadata.podName
      : await sandboxCrOrchestrator.findPod(clients, namespace, lease.providerLeaseId);
  if (!podName) {
    throw new Error("Kubernetes file sync could not resolve the Sandbox pod name.");
  }

  // Bind the streaming exec: raw tar bytes move over stdin/stdout straight to and
  // from a host file, so neither side buffers the whole payload. The file-sync
  // module bounds the untrusted pod's stdout with its own streamed-bytes disk
  // guard and passes the stderr cap through `io`.
  const exec: PodStreamExec = (command, io) =>
    execInPodStreaming(kc, namespace, podName, "agent", command, {
      ...io,
      timeoutMs: io.timeoutMs ?? timeoutMs,
    });
  return { exec, timeoutMs };
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Kubernetes sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Kubernetes sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const parsed = kubernetesProviderConfigSchema.safeParse(params.config);
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map((i) => i.message),
      };
    }
    const warnings: string[] = [];
    const cfg = parsed.data;
    const adapterDefaults = getAdapterDefaults(cfg.adapterType, cfg.adapters);
    const totalFqdns = [...adapterDefaults.allowFqdns, ...cfg.egressAllowFqdns];
    if (cfg.egressMode === "standard" && totalFqdns.length > 0) {
      if (cfg.egressAllowCidrs.length === 0) {
        warnings.push(
          `egressMode=standard cannot enforce FQDN-based egress rules (Kubernetes NetworkPolicy is CIDR-only). To keep the configured FQDNs reachable (${totalFqdns.join(", ")}) without operator intervention, the plugin will allow public IPv4 egress on TCP 80/443 with private/link-local/loopback/multicast ranges excluded. This is broader than exact FQDN allow-listing — switch egressMode to "cilium" (requires Cilium CNI) for precise enforcement, or set egressAllowCidrs explicitly to override the fallback.`,
        );
      } else {
        warnings.push(
          `egressMode=standard cannot enforce FQDN-based egress rules. The following FQDNs are reachable only via the operator-supplied egressAllowCidrs: ${totalFqdns.join(", ")}. Switch egressMode to "cilium" (requires Cilium CNI) for exact FQDN allow-listing.`,
        );
      }
    }
    if (cfg.requireImmutableDigest && !parseDigestImageRef(adapterDefaults.runtimeImage)) {
      warnings.push(
        `requireImmutableDigest=true is enabled, but the default runtime image for adapter "${cfg.adapterType}" (${adapterDefaults.runtimeImage}) does not pin an @sha256 digest. Ensure per-run imageOverride or adapter registry entries pin immutable @sha256 digests.`,
      );
    }
    return { ok: true, normalizedConfig: cfg as Record<string, unknown>, warnings: warnings.length > 0 ? warnings : undefined };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const parsed = kubernetesProviderConfigSchema.safeParse(params.config);
    if (!parsed.success) {
      return {
        ok: false,
        summary: "Invalid Kubernetes provider configuration.",
        metadata: {
          errors: parsed.error.issues.map((i) => i.message),
        },
      };
    }
    const config = parsed.data;
    const namespace = deriveTenantNamespace(config, params.companyId);

    try {
      const kc = createKubeConfig({
        inCluster: config.inCluster,
        kubeconfig: config.kubeconfig,
      });
      const clients = makeKubeClients(kc);
      // Reachability check: list pods in the tenant namespace. If the namespace
      // doesn't exist yet this will throw a 404 which we treat as "reachable
      // but namespace not provisioned" — still a successful probe.
      try {
        await clients.core.listNamespacedPod({ namespace });
      } catch (err) {
        const code = (err as { code?: number; statusCode?: number }).code
          ?? (err as { code?: number; statusCode?: number }).statusCode;
        if (code !== 404) throw err;
        // 404 means namespace doesn't exist yet — cluster is reachable.
      }
      return {
        ok: true,
        summary: `Kubernetes cluster reachable. Tenant namespace: ${namespace}.`,
        metadata: { namespace, provider: "kubernetes" },
      };
    } catch (err) {
      return {
        ok: false,
        summary: "Kubernetes cluster probe failed.",
        metadata: {
          namespace,
          provider: "kubernetes",
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams & {
      adapterType?: string;
      imageOverride?: string | null;
      platformDigest?: string | null;
      resourceProfile?: ExpertResourceProfileName | null;
      priorityClassName?: string | null;
      dataClassification?: DataClassificationLevel;
      kataFcAvailable?: boolean;
      runGeneration?: number;
      gatewayProxyUrl?: string | null;
      proxySessionToken?: string | null;
      warmPoolName?: string | null;
      executionWorkspaceSettings?: Record<string, unknown> | null;
    },
  ): Promise<PluginEnvironmentLease> {
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace = deriveTenantNamespace(config, params.companyId);

    const effectiveAdapterType = resolveRunAdapterType(params.adapterType, config.adapterType);

    const adapterDefaultsForWarn = getAdapterDefaults(effectiveAdapterType, config.adapters);
    const totalFqdnsForWarn = [...adapterDefaultsForWarn.allowFqdns, ...config.egressAllowFqdns];
    if (config.egressMode === "standard" && totalFqdnsForWarn.length > 0) {
      if (config.egressAllowCidrs.length === 0) {
        console.warn(
          `[plugin-kubernetes] egressMode=standard cannot enforce FQDN-based egress rules; falling back to public-IPv4 (TCP 80/443) with private/link-local ranges excluded so the configured FQDNs (${totalFqdnsForWarn.join(", ")}) remain reachable. Switch egressMode to "cilium" for exact FQDN allow-listing.`,
        );
      } else {
        console.warn(
          `[plugin-kubernetes] egressMode=standard cannot enforce FQDN-based egress rules. The following FQDNs are reachable only via operator-supplied egressAllowCidrs: ${totalFqdnsForWarn.join(", ")}. Switch egressMode to "cilium" for exact FQDN allow-listing.`,
        );
      }
    }

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
    });
    const clients = makeKubeClients(kc);

    const adapterDefaults = getAdapterDefaults(effectiveAdapterType, config.adapters);

    await ensureTenant(clients, {
      namespace,
      companyId: params.companyId,
      paperclipServerNamespace: PAPERCLIP_SERVER_NAMESPACE,
      serviceAccountAnnotations: config.serviceAccountAnnotations,
      egressMode: config.egressMode,
      egressAllowFqdns: config.egressAllowFqdns,
      adapterEgress: {
        adapterType: effectiveAdapterType,
        allowFqdns: adapterDefaults.allowFqdns,
      },
      egressAllowCidrs: config.egressAllowCidrs,
      resourceQuota: DEFAULT_RESOURCE_QUOTA,
    });

    const resolvedImage = resolveImageDetailed(
      {
        imageOverride: params.imageOverride ?? null,
        platformDigest: params.platformDigest ?? null,
      },
      adapterDefaults,
      {
        imageAllowList: config.imageAllowList,
        imageRegistry: stripRegistryScheme(config.imageRegistry),
        requireDigest: config.requireImmutableDigest,
      },
    );
    const sizing = resolvePodSizing(params.resourceProfile, resolvedImage.image);
    const useProfileSizing = Boolean(
      params.resourceProfile || params.imageOverride || !config.defaultResources,
    );
    const effectiveResources = useProfileSizing
      ? {
          requests: { ...sizing.requests, ...config.defaultResources?.requests },
          limits: { ...sizing.limits, ...config.defaultResources?.limits },
        }
      : config.defaultResources ?? {};

    // Fail-closed C3/C4 regulated workload isolation (Kata-FC microVM).
    const isolation = resolveSensitiveIsolationPolicy({
      dataClassification: params.dataClassification,
      configuredRuntimeClassName: config.runtimeClassName,
      kataFcAvailable: params.kataFcAvailable,
      requestsMemory: effectiveResources.requests?.memory ?? sizing.requests.memory,
      limitsMemory: effectiveResources.limits?.memory ?? sizing.limits.memory,
    });

    // Pre-dispatch ResourceQuota watermark backpressure admission check.
    if (typeof clients.core?.readNamespacedResourceQuota === "function") {
      const quota = await readTenantQuotaWatermark(clients, namespace);
      const admission = evaluateCapacityAdmission({
        quota,
        requested: {
          requestsCpu: effectiveResources.requests?.cpu ?? sizing.requests.cpu,
          requestsMemory: isolation.requestsMemory,
          limitsCpu: effectiveResources.limits?.cpu ?? sizing.limits.cpu,
          limitsMemory: isolation.limitsMemory,
        },
      });
      if (!admission.admitted) {
        backpressureQueue.recordAdmissionReject();
        throw new CapacityAdmissionDeniedError(
          admission.reason,
          admission.detail,
          admission.retryAfterMs,
        );
      }
    }

    const baseNodeSelector =
      config.nodeArch !== "any"
        ? { "kubernetes.io/arch": config.nodeArch }
        : undefined;
    const nodeSelector = isolation.nodeSelector
      ? { ...(baseNodeSelector ?? {}), ...isolation.nodeSelector }
      : baseNodeSelector;
    const priorityClassName = params.priorityClassName ?? config.priorityClassName;

    const labels = paperclipLabels({
      runId: params.runId,
      agentId: params.agentId ?? params.runId,
      companyId: params.companyId,
      adapterType: effectiveAdapterType,
      resourceProfile: sizing.profile,
      nodeArch: config.nodeArch,
    });

    const isSandboxCrBackend = config.backend === "sandbox-cr";
    const sandboxOrchestrator = createSandboxCrOrchestrator(config.sandboxApiVersion);
    const orchestrator = isSandboxCrBackend ? sandboxOrchestrator : jobOrchestrator;
    const ownerApiVersion = isSandboxCrBackend ? config.sandboxApiVersion : "batch/v1";
    const runGeneration = Number.isInteger(params.runGeneration) && (params.runGeneration as number) >= 1
      ? (params.runGeneration as number)
      : 1;

    const warmPoolTarget = params.warmPoolName ?? config.warmPool?.templateName ?? null;
    const useWarmPoolClaim =
      isSandboxCrBackend &&
      config.sandboxApiVersion === "agents.x-k8s.io/v1beta1" &&
      config.warmPool?.enabled === true &&
      Boolean(warmPoolTarget);

    let jobName = `pc-${newRunUlidDns()}`;
    let secretName = `${jobName}-env`;
    let ownerUid = "";
    let podName: string | null = null;
    let sandboxClaimName: string | null = null;
    let poolHit: boolean | undefined = undefined;
    let ownerKind: string = isSandboxCrBackend ? "Sandbox" : "Job";
    let effectiveOwnerApiVersion: string = ownerApiVersion;

    if (useWarmPoolClaim && warmPoolTarget) {
      sandboxClaimName = jobName;
      const claimManifest = buildSandboxClaimManifest({
        namespace,
        claimName: sandboxClaimName,
        warmPoolName: warmPoolTarget,
        runId: params.runId,
        companyId: params.companyId,
        runGeneration,
        ttlSeconds: config.warmPool?.defaultTtlSeconds,
        extraLabels: labels,
      });
      const claimed = await createSandboxClaim(clients, namespace, claimManifest);
      ownerUid = claimed.uid;
      ownerKind = "SandboxClaim";
      effectiveOwnerApiVersion = "extensions.agents.x-k8s.io/v1beta1";
      try {
        const ready = await waitForSandboxClaimReady(clients, namespace, sandboxClaimName, {
          timeoutMs: config.warmPool?.claimTimeoutMs,
        });
        warmPoolMetrics.recordClaim({ poolHit: ready.poolHit, claimDurationMs: ready.claimDurationMs });
        jobName = ready.sandboxName;
        podName = ready.podName;
        poolHit = ready.poolHit;
        secretName = `${jobName}-env`;
        readySandboxesByLease.add(jobName);
      } catch (err) {
        await destroyClaimedSandbox(clients, {
          namespace,
          claimName: sandboxClaimName,
          sandboxApiVersion: config.sandboxApiVersion,
        });
        throw err;
      }
    } else {
      const manifest = isSandboxCrBackend
        ? buildSandboxCrManifest({
            apiVersion: config.sandboxApiVersion,
            namespace,
            sandboxName: jobName,
            adapterType: effectiveAdapterType,
            image: resolvedImage.image,
            envSecretName: secretName,
            serviceAccountName: TENANT_SERVICE_ACCOUNT,
            labels,
            resources: {
              requests: { ...(effectiveResources.requests ?? {}), memory: isolation.requestsMemory },
              limits: { ...(effectiveResources.limits ?? {}), memory: isolation.limitsMemory },
            },
            runtimeClassName: isolation.runtimeClassName,
            imagePullSecrets: config.imagePullSecrets,
            nodeSelector,
            tolerations: isolation.tolerations,
            podAnnotations: isolation.podAnnotations,
            priorityClassName,
            workspaceSizeLimit: useProfileSizing ? sizing.workspaceSizeLimit : undefined,
            tmpSizeLimit: useProfileSizing ? sizing.tmpSizeLimit : undefined,
            shmSizeLimit: useProfileSizing ? sizing.shmSizeLimit : undefined,
          })
        : buildJobManifest({
            namespace,
            jobName,
            adapterType: effectiveAdapterType,
            image: resolvedImage.image,
            envSecretName: secretName,
            serviceAccountName: TENANT_SERVICE_ACCOUNT,
            labels,
            resources: effectiveResources,
            runtimeClassName: isolation.runtimeClassName,
            activeDeadlineSec: config.podActivityDeadlineSec,
            ttlSecondsAfterFinished: config.jobTtlSecondsAfterFinished,
            imagePullSecrets: config.imagePullSecrets,
          });

      const claimed = await orchestrator.claim(clients, namespace, manifest);
      ownerUid = claimed.uid;
    }

    const releaseOnError = () =>
      sandboxClaimName
        ? destroyClaimedSandbox(clients, {
            namespace,
            claimName: sandboxClaimName,
            sandboxName: jobName,
            podName,
            secretName,
            sandboxApiVersion: config.sandboxApiVersion,
          })
        : orchestrator.release(clients, namespace, jobName);

    const scopedNetworkEgress = parseScopedNetworkEgressGrant(params.executionWorkspaceSettings);
    const scopedNetworkPolicyName = await createScopedNetworkEgressPolicyOrReleaseWorkload(
      {
        clients,
        namespace,
        mode: config.egressMode,
        runId: params.runId,
        workloadName: jobName,
        ownerReference: {
          apiVersion: effectiveOwnerApiVersion,
          kind: ownerKind,
          name: sandboxClaimName ?? jobName,
          uid: ownerUid,
          controller: false,
          blockOwnerDeletion: false,
        },
        grant: scopedNetworkEgress,
      },
      releaseOnError,
    );

    const adapterEnv = buildAdapterEnv(adapterDefaults);
    adapterEnv.PAPERCLIP_NETWORK_EGRESS_POLICY = "kubernetes-default-deny";
    adapterEnv.PAPERCLIP_NETWORK_EGRESS_GRANT_PATH = NETWORK_EGRESS_GRANT_PATH;
    adapterEnv.PAPERCLIP_NETWORK_EGRESS_ALLOW_FQDNS = scopedNetworkEgress.allowFqdns.join(",");
    adapterEnv.PAPERCLIP_NETWORK_EGRESS_ALLOW_CIDRS = scopedNetworkEgress.allowCidrs.join(",");
    const bootstrapToken = generateBootstrapToken();
    const gatewayProxyUrl = params.gatewayProxyUrl ?? config.gatewayProxyUrl ?? null;

    if (gatewayProxyUrl) {
      // Zero-user-credential expert session Secret: enforces assertNoUserCredentialsInEnv.
      await createAgentSessionSecret(clients, {
        namespace,
        secretName,
        runId: params.runId,
        runGeneration,
        ownerKind,
        ownerApiVersion: effectiveOwnerApiVersion,
        ownerName: sandboxClaimName ?? jobName,
        ownerUid,
        bootstrapToken,
        gatewayProxyUrl,
        ...(params.proxySessionToken ? { proxySessionToken: params.proxySessionToken } : {}),
        runtimeEnv: adapterEnv,
      });
    } else {
      await createPerRunSecret(clients, {
        namespace,
        secretName,
        runId: params.runId,
        ownerKind,
        ownerApiVersion: effectiveOwnerApiVersion,
        ownerName: sandboxClaimName ?? jobName,
        ownerUid,
        bootstrapToken,
        adapterEnv,
      });
    }

    if (!podName) {
      podName = await orchestrator.findPod(clients, namespace, jobName);
    }
    let podSnapshot: Record<string, unknown> | null = null;
    if (podName && typeof clients.core?.readNamespacedPod === "function") {
      try {
        podSnapshot = (await clients.core.readNamespacedPod({
          namespace,
          name: podName,
        })) as Record<string, unknown>;
      } catch {
        // Pod may still be initializing; runtime evidence remains null-filled.
      }
    }
    const runtimeEvidence = extractRuntimeEvidence(
      podSnapshot,
      resolvedImage.digest,
      resolvedImage.expectedPlatformDigest,
    );

    const leaseMetadata: KubernetesLeaseMetadata = {
      namespace,
      jobName,
      podName,
      secretName,
      phase: sandboxClaimName ? "Running" : "Pending",
      backend: config.backend,
      scopedNetworkPolicyName,
      scopedNetworkEgress,
      resolvedImage: resolvedImage.image,
      resolvedImageDigest: resolvedImage.digest,
      expectedPlatformDigest: resolvedImage.expectedPlatformDigest,
      resourceProfile: sizing.profile,
      nodeArch: config.nodeArch,
      priorityClassName: priorityClassName ?? null,
      sandboxClaimName,
      poolHit,
      sandboxApiVersion: isSandboxCrBackend ? config.sandboxApiVersion : undefined,
      zeroTrustGateway: Boolean(gatewayProxyUrl),
      runtimeEvidence,
      nativeFileSyncUnsupported: config.backend !== "sandbox-cr",
    };

    return {
      providerLeaseId: jobName,
      metadata: leaseMetadata as unknown as Record<string, unknown>,
    };
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace =
      typeof params.leaseMetadata?.namespace === "string"
        ? params.leaseMetadata.namespace
        : deriveTenantNamespace(config, params.companyId);
    const leaseBackend =
      typeof params.leaseMetadata?.backend === "string"
        ? (params.leaseMetadata.backend as "sandbox-cr" | "job")
        : config.backend;
    // acquireLease names the per-run Secret `${jobName}-env` and uses jobName
    // as the providerLeaseId, so the suffix fallback reconstructs it exactly.
    const secretName =
      typeof params.leaseMetadata?.secretName === "string"
        ? params.leaseMetadata.secretName
        : `${params.providerLeaseId}-env`;

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
    });
    const clients = makeKubeClients(kc);

    const check = await checkLeaseResumable(clients, {
      namespace,
      name: params.providerLeaseId,
      backend: leaseBackend,
      readyTimeoutMs: RESUME_READY_TIMEOUT_MS,
      pollMs: RESUME_READY_POLL_MS,
    });

    if (!check.resumable) {
      // Kubernetes pods are NOT restartable the way Daytona sandboxes are: a
      // stopped Daytona sandbox can be started again by ID, but a k8s pod that
      // is gone or terminally failed can never be revived in place. Gone = not
      // resumable, by design. Returning providerLeaseId: null tells the server
      // the lease expired so it falls back to a fresh acquireLease.
      return {
        providerLeaseId: null,
        metadata: { expired: true, reason: check.reason },
      };
    }

    // A resumed lease starts with clean per-lease state: drop any stale upload
    // interceptor buffers a previous run on this lease may have left behind.
    uploadInterceptorsByLease.delete(params.providerLeaseId);
    if (leaseBackend === "sandbox-cr") {
      // We just observed the Sandbox pod Ready, so the first exec on the
      // resumed lease can skip its readiness poll.
      readySandboxesByLease.add(params.providerLeaseId);
    }

    const leaseMetadata: KubernetesLeaseMetadata = {
      namespace,
      jobName: params.providerLeaseId,
      podName: check.podName,
      secretName,
      phase: check.phase,
      backend: leaseBackend,
      scopedNetworkPolicyName:
        typeof params.leaseMetadata?.scopedNetworkPolicyName === "string"
          ? params.leaseMetadata.scopedNetworkPolicyName
          : null,
      scopedNetworkEgress: parseScopedNetworkEgressGrant({
        networkEgress: params.leaseMetadata?.scopedNetworkEgress,
      }),
      // See acquireLease: only the sandbox-cr backend has a pod-exec channel for
      // native sync, so a resumed job lease must keep the base64 fallback.
      nativeFileSyncUnsupported: leaseBackend !== "sandbox-cr",
    };

    return {
      providerLeaseId: params.providerLeaseId,
      metadata: {
        ...leaseMetadata,
        resumedLease: true,
      } as unknown as Record<string, unknown>,
    };
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    // The agent pod already has /workspace mounted as an emptyDir at pod
    // scheduling time (see pod-spec-builder). Nothing to provision here —
    // we just hand back the cwd. Honor a caller-supplied remotePath if set.
    const cwd =
      params.workspace.remotePath && params.workspace.remotePath.trim().length > 0
        ? params.workspace.remotePath.trim()
        : "/workspace";
    return {
      cwd,
      metadata: {
        provider: "kubernetes",
        remoteCwd: cwd,
      },
    };
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace =
      typeof params.leaseMetadata?.namespace === "string"
        ? params.leaseMetadata.namespace
        : deriveTenantNamespace(config, params.companyId);

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
    });
    const clients = makeKubeClients(kc);

    const leaseBackend =
      typeof params.leaseMetadata?.backend === "string"
        ? (params.leaseMetadata.backend as "sandbox-cr" | "job")
        : config.backend;
    const leaseApiVersion =
      typeof params.leaseMetadata?.sandboxApiVersion === "string"
        ? (params.leaseMetadata.sandboxApiVersion as SandboxCrApiVersion)
        : config.sandboxApiVersion;
    const sandboxClaimName =
      typeof params.leaseMetadata?.sandboxClaimName === "string" &&
      params.leaseMetadata.sandboxClaimName.length > 0
        ? params.leaseMetadata.sandboxClaimName
        : null;
    const releaseOrchestrator =
      leaseBackend === "sandbox-cr"
        ? createSandboxCrOrchestrator(leaseApiVersion)
        : jobOrchestrator;

    uploadInterceptorsByLease.delete(params.providerLeaseId);
    readySandboxesByLease.delete(params.providerLeaseId);

    if (sandboxClaimName) {
      // Claimed warm-pool sandboxes are strictly one-way and must be destroyed.
      const secretName =
        typeof params.leaseMetadata?.secretName === "string"
          ? params.leaseMetadata.secretName
          : `${params.providerLeaseId}-env`;
      const podName =
        typeof params.leaseMetadata?.podName === "string" &&
        params.leaseMetadata.podName.length > 0
          ? params.leaseMetadata.podName
          : null;
      await destroyClaimedSandbox(clients, {
        namespace,
        claimName: sandboxClaimName,
        sandboxName: params.providerLeaseId,
        podName,
        secretName,
        sandboxApiVersion: leaseApiVersion,
      });
      return;
    }

    try {
      await releaseOrchestrator.release(clients, namespace, params.providerLeaseId);
    } catch (err) {
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { code?: number; statusCode?: number }).statusCode;
      if (code !== 404) throw err;
    }
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const config = kubernetesProviderConfigSchema.parse(params.config);
    const namespace =
      typeof params.leaseMetadata?.namespace === "string"
        ? params.leaseMetadata.namespace
        : deriveTenantNamespace(config, params.companyId);
    const leaseBackend =
      typeof params.leaseMetadata?.backend === "string"
        ? (params.leaseMetadata.backend as "sandbox-cr" | "job")
        : config.backend;
    const leaseApiVersion =
      typeof params.leaseMetadata?.sandboxApiVersion === "string"
        ? (params.leaseMetadata.sandboxApiVersion as SandboxCrApiVersion)
        : config.sandboxApiVersion;
    const sandboxClaimName =
      typeof params.leaseMetadata?.sandboxClaimName === "string" &&
      params.leaseMetadata.sandboxClaimName.length > 0
        ? params.leaseMetadata.sandboxClaimName
        : null;
    const secretName =
      typeof params.leaseMetadata?.secretName === "string"
        ? params.leaseMetadata.secretName
        : `${params.providerLeaseId}-env`;
    const podName =
      typeof params.leaseMetadata?.podName === "string" &&
      params.leaseMetadata.podName.length > 0
        ? params.leaseMetadata.podName
        : null;

    uploadInterceptorsByLease.delete(params.providerLeaseId);
    readySandboxesByLease.delete(params.providerLeaseId);

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
    });
    const clients = makeKubeClients(kc);

    if (sandboxClaimName) {
      await destroyClaimedSandbox(clients, {
        namespace,
        claimName: sandboxClaimName,
        sandboxName: params.providerLeaseId,
        podName,
        secretName,
        sandboxApiVersion: leaseApiVersion,
      });
      return;
    }

    await destroyLeaseResources(clients, {
      namespace,
      name: params.providerLeaseId,
      backend: leaseBackend,
      podName,
      secretName,
    });
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    const { lease, timeoutMs } = params;

    if (!lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "No provider lease ID available for execution.",
      };
    }

    const config = kubernetesProviderConfigSchema.parse(params.config);
    const scopedNetworkEgress = parseScopedNetworkEgressGrant({
      networkEgress: lease.metadata?.scopedNetworkEgress,
    });
    const namespace =
      typeof lease.metadata?.namespace === "string"
        ? lease.metadata.namespace
        : deriveTenantNamespace(config, params.companyId);

    // Determine which backend this lease was created with.
    const leaseBackend =
      typeof lease.metadata?.backend === "string"
        ? (lease.metadata.backend as "sandbox-cr" | "job")
        : config.backend;

    const kc = createKubeConfig({
      inCluster: config.inCluster,
      kubeconfig: config.kubeconfig,
    });
    const clients = makeKubeClients(kc);

    const effectiveTimeoutMs =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? timeoutMs
        : config.podActivityDeadlineSec * 1000;

    if (leaseBackend === "sandbox-cr") {
      // ── Sandbox-CR backend ──────────────────────────────────────────────────
      // 1. Ensure the Sandbox pod is Ready (wait only on first exec for this lease).
      // 2. Exec the command into the running pod.
      // 3. Return exec result directly (no log scraping needed).

      let podName =
        typeof lease.metadata?.podName === "string" && lease.metadata.podName
          ? lease.metadata.podName
          : null;

      // Skip the readiness poll if we've already observed this Sandbox CR
      // reaching Ready during this worker's lifetime. See readySandboxesByLease
      // declaration for rationale.
      const podAlreadyKnownReady = readySandboxesByLease.has(lease.providerLeaseId);

      // The caller's timeout is a budget for the WHOLE execute call: readiness
      // wait + exec must share it, or the first exec on a fresh lease could
      // block for up to twice the requested timeout.
      const executeStartedAt = Date.now();

      if (!podAlreadyKnownReady) {
        try {
          await sandboxCrOrchestrator.waitForCompletion(
            clients,
            namespace,
            lease.providerLeaseId,
            { timeoutMs: effectiveTimeoutMs, pollMs: 2000 },
          );
          readySandboxesByLease.add(lease.providerLeaseId);
        } catch (err) {
          if (err instanceof SandboxCrTimeoutError) {
            return {
              exitCode: null,
              timedOut: true,
              stdout: "",
              stderr: `Sandbox pod did not become Ready within ${effectiveTimeoutMs}ms`,
              metadata: {
                provider: "kubernetes",
                backend: "sandbox-cr",
                namespace,
                sandboxName: lease.providerLeaseId,
              },
            };
          }
          throw err;
        }
      }

      // Resolve pod name (may now be populated in Sandbox status).
      if (!podName) {
        podName = await sandboxCrOrchestrator.findPod(
          clients,
          namespace,
          lease.providerLeaseId,
        );
      }

      if (!podName) {
        return {
          exitCode: 1,
          timedOut: false,
          stdout: "",
          stderr: "Sandbox pod is Ready but podName could not be resolved.",
          metadata: {
            provider: "kubernetes",
            backend: "sandbox-cr",
            namespace,
            sandboxName: lease.providerLeaseId,
          },
        };
      }

      // Build the command to exec. The adapter passes shell invocations as
      // `command: "sh", args: ["-c", "<script>"]` — must combine both, NOT
      // drop args. If only command is present (no args), wrap in a login shell.
      const command = typeof params.command === "string" ? params.command.trim() : "";
      const args = Array.isArray(params.args) ? params.args : [];

      // Fast-upload interceptor: short-circuit the chunked-shell file transfer
      // protocol (adapter-utils writeFile) so an N-chunk upload becomes 1 exec
      // instead of N+2. Falls back transparently when patterns don't match.
      // See upload-interceptor.ts.
      const shellScript =
        command === "sh" && args[0] === "-c" && typeof args[1] === "string"
          ? args[1]
          : null;
      if (shellScript) {
        const decision = getOrCreateUploadInterceptor(lease.providerLeaseId).decide(shellScript);
        if (decision.action === "ack") {
          return {
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
            metadata: {
              provider: "kubernetes",
              backend: "sandbox-cr",
              namespace,
              sandboxName: lease.providerLeaseId,
              podName,
              fastUpload: "ack",
            },
          };
        }
        if (decision.action === "flush") {
          // Single exec: `head -c <N> | base64 -d > '<TARGET>'` with stdin =
          // base64 ASCII. `head -c` reads EXACTLY N bytes and exits, so we
          // don't depend on WebSocket-driven EOF detection on stdin (which is
          // racy against the `base64 -d` exit timing in @kubernetes/client-node
          // v0.21.0 — see pod-exec.ts). All bytes are sent through the
          // WebSocket data channel; size is unbounded by ARG_MAX.
          const base64Body = decision.flush.payload.toString("base64");
          const dir = decision.flush.targetPath.substring(
            0,
            decision.flush.targetPath.lastIndexOf("/"),
          );
          const script =
            `mkdir -p '${dir}' && ` +
            `head -c ${base64Body.length} | base64 -d > '${decision.flush.targetPath}'`;
          // The flush shares the caller's single execute budget (same contract
          // as the normal exec path below) and surfaces watchdog/WebSocket
          // failures as a timed-out result instead of an uncaught throw.
          const flushTimeoutMs = Math.max(
            5_000,
            effectiveTimeoutMs - (Date.now() - executeStartedAt),
          );
          let flushResult: { exitCode: number; stdout: string; stderr: string };
          try {
            flushResult = await execInPod(
              kc,
              namespace,
              podName,
              "agent",
              ["/bin/sh", "-c", script],
              base64Body,
              flushTimeoutMs,
            );
          } catch (err) {
            return {
              exitCode: null,
              timedOut: true,
              stdout: "",
              stderr: `fast-upload flush failed: ${err instanceof Error ? err.message : String(err)}`,
              metadata: {
                provider: "kubernetes",
                backend: "sandbox-cr",
                namespace,
                sandboxName: lease.providerLeaseId,
                podName,
                fastUpload: "flush",
              },
            };
          }
          return {
            exitCode: flushResult.exitCode,
            timedOut: false,
            stdout: flushResult.stdout,
            stderr: flushResult.stderr,
            metadata: {
              provider: "kubernetes",
              backend: "sandbox-cr",
              namespace,
              sandboxName: lease.providerLeaseId,
              podName,
              fastUpload: "flush",
              uploadedBytes: decision.flush.payload.length,
            },
          };
        }
        // decision.action === "passthrough" — fall through to normal exec
      }

      const baseExecCommand =
        command.length > 0 && args.length > 0
          ? [command, ...args]
          : command.length > 0
            ? ["/bin/sh", "-lc", command]
            : ["/bin/sh", "-l"];

      // Apply the caller-provided run env (params.env) to the in-pod process. Without
      // this the adapter's runtime env (e.g. XDG_CONFIG_HOME pointing at the shipped
      // OpenCode config, plus helper settings like small_model/provider routing) never
      // reaches the harness, which falls back to its in-image HOME config -> wrong or
      // partial behaviour.
      const execCommand = wrapCommandWithEnv(baseExecCommand, params.env);

      // Remaining share of the caller's budget after the readiness wait (floor
      // of 5s so an exec attempt is still made when readiness consumed most of
      // it; the watchdog then bounds it tightly).
      const remainingTimeoutMs = Math.max(
        5_000,
        effectiveTimeoutMs - (Date.now() - executeStartedAt),
      );

      let execResult: { exitCode: number; stdout: string; stderr: string };
      try {
        execResult = await execInPod(
          kc,
          namespace,
          podName,
          "agent",
          execCommand,
          typeof params.stdin === "string" ? params.stdin : undefined,
          remainingTimeoutMs,
        );
      } catch (err) {
        // Watchdog-fired or WebSocket-setup error. Surface as a timeout so
        // the caller can retry instead of hanging forever.
        return {
          exitCode: null,
          timedOut: true,
          stdout: "",
          stderr: appendNetworkEgressDenyHint(err instanceof Error ? err.message : String(err), scopedNetworkEgress),
          metadata: {
            provider: "kubernetes",
            backend: "sandbox-cr",
            namespace,
            sandboxName: lease.providerLeaseId,
            podName,
          },
        };
      }

      return {
        exitCode: execResult.exitCode,
        timedOut: false,
        stdout: execResult.stdout,
        stderr: appendNetworkEgressDenyHint(execResult.stderr, scopedNetworkEgress),
        metadata: {
          provider: "kubernetes",
          backend: "sandbox-cr",
          namespace,
          sandboxName: lease.providerLeaseId,
          podName,
        },
      };
    } else {
      // ── Job backend (legacy / stable fallback) ──────────────────────────────
      // The container entrypoint is baked into the Job spec (Tini + paperclip-agent-shim).
      // We do NOT re-exec command/args — instead we wait for the Job to finish
      // and collect its logs.
      //
      // params.command / params.args / params.stdin are intentionally ignored.

      let status;
      let timedOut = false;
      try {
        status = await jobOrchestrator.waitForCompletion(
          clients,
          namespace,
          lease.providerLeaseId,
          { timeoutMs: effectiveTimeoutMs, pollMs: 2000 },
        );
      } catch (err) {
        if (err instanceof JobTimeoutError) {
          timedOut = true;
          status = null;
        } else {
          throw err;
        }
      }

      // Collect logs from the pod.
      const podName =
        typeof lease.metadata?.podName === "string"
          ? lease.metadata.podName
          : await jobOrchestrator.findPod(
              clients,
              namespace,
              lease.providerLeaseId,
            );

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      if (podName) {
        await jobOrchestrator.streamLogs(
          clients,
          namespace,
          podName,
          async (stream, text) => {
            if (stream === "stdout") stdoutChunks.push(text);
            else stderrChunks.push(text);
          },
        );
      }

      return {
        exitCode: timedOut ? null : status?.phase === "Succeeded" ? 0 : 1,
        timedOut,
        stdout: stdoutChunks.join(""),
        stderr: appendNetworkEgressDenyHint(stderrChunks.join(""), scopedNetworkEgress),
        metadata: {
          provider: "kubernetes",
          backend: "job",
          namespace,
          jobName: lease.providerLeaseId,
          podName: podName ?? null,
          phase: status?.phase ?? null,
        },
      };
    }
  },

  // Opt-in native inbound transfer. Defining this hook (with onEnvironmentSyncOut)
  // makes the worker advertise `environmentSyncIn`/`environmentSyncOut`, so the
  // host runner routes workspace/asset transfers through a single pod exec per
  // operation (host tar streamed over the exec stdin → in-pod `head -c <N> | tar
  // -x` → stage-then-atomic-`mv -f`) instead of the base64-over-exec chunk loop.
  // Only the sandbox-cr backend is supported; the job backend carries no file
  // path. Providers that do not define these keep the byte-identical fallback.
  async onEnvironmentSyncIn(
    params: PluginEnvironmentSyncInParams,
  ): Promise<PluginEnvironmentSyncResult> {
    const remoteDir = resolveSyncRemoteDir(params.lease);
    const { exec, timeoutMs } = await resolveSyncPodExec(params);
    return await performSyncIn({
      exec,
      operations: params.operations,
      remoteDir,
      timeoutMs,
    });
  },

  // Opt-in native outbound transfer. See onEnvironmentSyncIn.
  async onEnvironmentSyncOut(
    params: PluginEnvironmentSyncOutParams,
  ): Promise<PluginEnvironmentSyncResult> {
    const remoteDir = resolveSyncRemoteDir(params.lease);
    const { exec, timeoutMs } = await resolveSyncPodExec(params);
    return await performSyncOut({
      exec,
      operations: params.operations,
      remoteDir,
      timeoutMs,
    });
  },
});

export default plugin;
