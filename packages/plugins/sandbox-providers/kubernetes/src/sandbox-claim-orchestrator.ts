/**
 * Declarative v1beta1 SandboxClaim & one-way SandboxWarmPool orchestrator
 * (`extensions.agents.x-k8s.io/v1beta1`, kubernetes-sigs/agent-sandbox v1.0.12+).
 *
 * Schema contract verified against `kubernetes-sigs/agent-sandbox`
 * `k8s/crds/extensions.agents.x-k8s.io_sandboxclaims.yaml` and
 * `k8s/crds/extensions.agents.x-k8s.io_sandboxwarmpools.yaml` (`v1beta1`):
 * - `SandboxClaim.spec` requires `warmPoolRef: { name }` and accepts
 *   `lifecycle: { shutdownTime, shutdownPolicy: "Delete" | "DeleteForeground" | "Retain" }`.
 * - `SandboxClaim.status` reports `sandbox: { name, podIPs?, serviceFQDN? }` and
 *   per-condition `observedGeneration` on `status.conditions[]`.
 * - `SandboxWarmPool.spec` requires `sandboxTemplateRef: { name }`.
 *
 * Key invariants:
 * - Zero-credential warm pods: SandboxTemplate pods carry NO user Secrets, NO
 *   workspace data, and NO historical session state.
 * - Atomic declarative claim: creates a `SandboxClaim` referencing a
 *   `SandboxWarmPool` (`spec.warmPoolRef.name`) with mandatory
 *   `spec.lifecycle.shutdownTime` and `shutdownPolicy: DeleteForeground`.
 * - Anti-stale & anti-CrashLoop readiness: verifies condition-level
 *   `observedGeneration >= metadata.generation` + `Ready=True` +
 *   `status.sandbox.name`, then performs a secondary Pod `GET` verifying
 *   `phase === "Running"`, no `deletionTimestamp`, and an explicit `"agent"`
 *   container status entry with `restartCount === 0` (keeps polling if only
 *   sidecar container statuses are present).
 * - Strictly one-way lifecycle: once claimed, a pod is NEVER returned to any
 *   warm pool; completion, timeout, cancellation, or revocation destroys it
 *   idempotently (404 treated as success).
 */

import type { KubeClients } from "./kube-client.js";
import { deleteSandboxCr } from "./sandbox-cr-orchestrator.js";
import { isKubeNotFoundError } from "./lease-lifecycle.js";
import { DEFAULT_SANDBOX_DNS_NDOTS } from "./sandbox-cr-builder.js";

export const SANDBOX_EXTENSIONS_GROUP = "extensions.agents.x-k8s.io";
export const SANDBOX_EXTENSIONS_VERSION = "v1beta1";
export const SANDBOX_EXTENSIONS_API_VERSION =
  `${SANDBOX_EXTENSIONS_GROUP}/${SANDBOX_EXTENSIONS_VERSION}` as const;
export const SANDBOX_CLAIMS_PLURAL = "sandboxclaims";
export const SANDBOX_TEMPLATES_PLURAL = "sandboxtemplates";
export const SANDBOX_WARMPOOLS_PLURAL = "sandboxwarmpools";

export const DEFAULT_WARM_POOL_PRIORITY_CLASS = "paperclip-warm-pool";
export const DEFAULT_CLAIM_TTL_SECONDS = 3600;
export const DEFAULT_SHUTDOWN_POLICY = "DeleteForeground" as const;

export class SandboxClaimTimeoutError extends Error {
  constructor(namespace: string, name: string, timeoutMs: number) {
    super(
      `SandboxClaim ${namespace}/${name} did not become Ready within ${timeoutMs}ms`,
    );
    this.name = "SandboxClaimTimeoutError";
  }
}

export class WarmPoolReturnForbiddenError extends Error {
  constructor(sandboxName: string) {
    super(
      `Refusing to return claimed sandbox "${sandboxName}" to a warm pool: ` +
        `claimed expert sandboxes are strictly one-way and must be destroyed after use.`,
    );
    this.name = "WarmPoolReturnForbiddenError";
  }
}

/**
 * Fail-closed guard enforcing the one-way warm-pool red line: a claimed or
 * dirty pod must NEVER be returned to a warm pool.
 */
export function assertNeverReturnToWarmPool(input: {
  sandboxName: string;
  wasClaimed?: boolean;
  hasWorkspaceData?: boolean;
  hasExecutedTools?: boolean;
  boundRunGeneration?: number | null;
}): never {
  throw new WarmPoolReturnForbiddenError(input.sandboxName);
}

export interface BuildSandboxClaimInput {
  namespace: string;
  claimName: string;
  /** Target `SandboxWarmPool` name (`spec.warmPoolRef.name` in v1beta1). */
  warmPoolName: string;
  runId: string;
  companyId: string;
  runGeneration: number;
  /** Mandatory TTL in seconds (positive integer); translated to UTC `shutdownTime`. */
  ttlSeconds?: number;
  /** Clock override for deterministic tests. */
  nowMs?: number;
  extraLabels?: Record<string, string>;
}

export function buildSandboxClaimManifest(
  input: BuildSandboxClaimInput,
): Record<string, unknown> {
  if (!input.warmPoolName || input.warmPoolName.trim().length === 0) {
    throw new Error("SandboxClaim requires a non-empty warmPoolName");
  }
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`SandboxClaim requires a positive integer ttlSeconds (got ${ttlSeconds})`);
  }
  if (!Number.isInteger(input.runGeneration) || input.runGeneration < 1) {
    throw new Error(`SandboxClaim requires a positive integer runGeneration (got ${input.runGeneration})`);
  }
  const now = input.nowMs ?? Date.now();
  const shutdownTime = new Date(now + ttlSeconds * 1000).toISOString();

  return {
    apiVersion: SANDBOX_EXTENSIONS_API_VERSION,
    kind: "SandboxClaim",
    metadata: {
      name: input.claimName,
      namespace: input.namespace,
      labels: {
        ...(input.extraLabels ?? {}),
        "paperclip.io/managed-by": "paperclip-k8s-plugin",
        "paperclip.io/run-id": input.runId,
        "paperclip.io/company-id": input.companyId,
        "paperclip.io/run-generation": String(input.runGeneration),
      },
    },
    spec: {
      warmPoolRef: {
        name: input.warmPoolName,
      },
      lifecycle: {
        shutdownTime,
        shutdownPolicy: DEFAULT_SHUTDOWN_POLICY,
      },
    },
  };
}

export interface BuildSandboxTemplateInput {
  namespace: string;
  templateName: string;
  image: string;
  serviceAccountName: string;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  nodeSelector?: Record<string, string>;
  priorityClassName?: string;
  runtimeClassName?: string;
  imagePullSecrets?: string[];
  workspaceSizeLimit?: string;
  tmpSizeLimit?: string;
  shmSizeLimit?: string;
  dnsNdots?: number;
  labels?: Record<string, string>;
}

/**
 * Builds a clean-state zero-credential `SandboxTemplate` (`v1beta1`) aligned
 * with `sandbox-cr-builder.ts` (container `agent`, UID 1000, `restartPolicy: Always`,
 * Tini sleep-infinity entrypoint, `HOME=/home/paperclip`, PSS `restricted`, and
 * ZERO `envFrom` / user Secrets).
 */
export function buildSandboxTemplateManifest(
  input: BuildSandboxTemplateInput,
): Record<string, unknown> {
  const volumeMounts: Array<{ name: string; mountPath: string }> = [
    { name: "workspace", mountPath: "/workspace" },
    { name: "home", mountPath: "/home/paperclip" },
    { name: "cache", mountPath: "/home/paperclip/.cache" },
    { name: "tmp", mountPath: "/tmp" },
  ];
  const volumes: Array<Record<string, unknown>> = [
    { name: "workspace", emptyDir: { sizeLimit: input.workspaceSizeLimit ?? "8Gi" } },
    { name: "home", emptyDir: { sizeLimit: "1Gi" } },
    { name: "cache", emptyDir: { sizeLimit: "1Gi" } },
    { name: "tmp", emptyDir: { sizeLimit: input.tmpSizeLimit ?? "2Gi" } },
  ];
  if (input.shmSizeLimit) {
    volumeMounts.push({ name: "dshm", mountPath: "/dev/shm" });
    volumes.push({ name: "dshm", emptyDir: { medium: "Memory", sizeLimit: input.shmSizeLimit } });
  }
  const ndots = input.dnsNdots ?? DEFAULT_SANDBOX_DNS_NDOTS;

  return {
    apiVersion: SANDBOX_EXTENSIONS_API_VERSION,
    kind: "SandboxTemplate",
    metadata: {
      name: input.templateName,
      namespace: input.namespace,
      labels: {
        ...(input.labels ?? {}),
        "paperclip.io/managed-by": "paperclip-k8s-plugin",
        "paperclip.io/pool-clean-state": "true",
      },
    },
    spec: {
      podTemplate: {
        metadata: {
          labels: {
            ...(input.labels ?? {}),
            "paperclip.io/role": "agent",
            "paperclip.io/managed-by": "paperclip-k8s-plugin",
          },
        },
        spec: {
          serviceAccountName: input.serviceAccountName,
          automountServiceAccountToken: false,
          restartPolicy: "Always",
          dnsConfig: {
            options: [{ name: "ndots", value: String(ndots) }],
          },
          nodeSelector: input.nodeSelector ?? { "kubernetes.io/arch": "arm64" },
          priorityClassName: input.priorityClassName ?? DEFAULT_WARM_POOL_PRIORITY_CLASS,
          ...(input.runtimeClassName ? { runtimeClassName: input.runtimeClassName } : {}),
          ...(input.imagePullSecrets && input.imagePullSecrets.length > 0
            ? { imagePullSecrets: input.imagePullSecrets.map((name) => ({ name })) }
            : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "agent",
              image: input.image,
              imagePullPolicy: "IfNotPresent",
              command: ["/usr/bin/tini", "--", "/bin/sh", "-c", "sleep infinity"],
              env: [{ name: "HOME", value: "/home/paperclip" }],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: input.resources?.requests ?? { cpu: "250m", memory: "512Mi" },
                limits: input.resources?.limits ?? { cpu: "1", memory: "2Gi" },
              },
              volumeMounts,
            },
          ],
          volumes,
        },
      },
    },
  };
}

export interface BuildSandboxWarmPoolInput {
  namespace: string;
  poolName: string;
  templateName: string;
  replicas: number;
  labels?: Record<string, string>;
}

export function buildSandboxWarmPoolManifest(
  input: BuildSandboxWarmPoolInput,
): Record<string, unknown> {
  if (!Number.isInteger(input.replicas) || input.replicas < 0) {
    throw new Error(`SandboxWarmPool requires a non-negative integer replicas (got ${input.replicas})`);
  }
  return {
    apiVersion: SANDBOX_EXTENSIONS_API_VERSION,
    kind: "SandboxWarmPool",
    metadata: {
      name: input.poolName,
      namespace: input.namespace,
      labels: {
        ...(input.labels ?? {}),
        "paperclip.io/managed-by": "paperclip-k8s-plugin",
      },
    },
    spec: {
      replicas: input.replicas,
      sandboxTemplateRef: {
        name: input.templateName,
      },
    },
  };
}

export async function createSandboxClaim(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<{ uid: string }> {
  const result = await clients.custom.createNamespacedCustomObject({
    group: SANDBOX_EXTENSIONS_GROUP,
    version: SANDBOX_EXTENSIONS_VERSION,
    namespace,
    plural: SANDBOX_CLAIMS_PLURAL,
    body: manifest,
  });
  const uid = (result as { metadata?: { uid?: string } }).metadata?.uid;
  if (!uid) throw new Error("SandboxClaim created without a UID");
  return { uid };
}

export interface ClaimReadyResult {
  sandboxName: string;
  podName: string;
  claimDurationMs: number;
  poolHit: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type AgentContainerHealth =
  | { status: "ready" }
  | { status: "pending" }
  | { status: "restarted"; restartCount: number };

function inspectAgentContainerStatus(pod: {
  status?: { containerStatuses?: Array<{ name?: string; restartCount?: number }> };
}): AgentContainerHealth {
  const statuses = pod.status?.containerStatuses;
  if (!Array.isArray(statuses)) return { status: "pending" };
  const agent = statuses.find((c) => c.name === "agent");
  if (!agent || typeof agent.restartCount !== "number") {
    return { status: "pending" };
  }
  if (agent.restartCount > 0) {
    return { status: "restarted", restartCount: agent.restartCount };
  }
  return { status: "ready" };
}

function isConditionCurrent(
  condition: { observedGeneration?: number },
  generation: number | undefined,
): boolean {
  if (typeof generation !== "number") return true;
  if (typeof condition.observedGeneration !== "number") return true;
  return condition.observedGeneration >= generation;
}

/**
 * Waits for a `SandboxClaim` (`v1beta1`) to bind a sandbox and become Ready:
 * 1. Verifies condition-level `observedGeneration >= metadata.generation`
 *    (matching `extensions.agents.x-k8s.io_sandboxclaims.yaml`).
 * 2. Requires `Ready=True` condition and non-empty `status.sandbox.name`.
 * 3. Performs a secondary Pod `GET` confirming `phase === "Running"`, no
 *    `deletionTimestamp`, and an explicit `"agent"` container status entry with
 *    `restartCount === 0` (defends against sidecar-only or CrashLoop pods).
 */
export async function waitForSandboxClaimReady(
  clients: KubeClients,
  namespace: string,
  claimName: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ClaimReadyResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 200;
  const deadline = startedAt + timeoutMs;

  while (Date.now() < deadline) {
    const claim = (await clients.custom.getNamespacedCustomObject({
      group: SANDBOX_EXTENSIONS_GROUP,
      version: SANDBOX_EXTENSIONS_VERSION,
      namespace,
      plural: SANDBOX_CLAIMS_PLURAL,
      name: claimName,
    })) as {
      metadata?: { generation?: number; deletionTimestamp?: unknown };
      status?: {
        sandbox?: { name?: string; podIPs?: string[]; serviceFQDN?: string };
        poolHit?: boolean;
        conditions?: Array<{
          type?: string;
          status?: string;
          reason?: string;
          message?: string;
          observedGeneration?: number;
        }>;
      };
    };

    if (claim.metadata?.deletionTimestamp) {
      throw new Error(`SandboxClaim ${namespace}/${claimName} is Terminating`);
    }

    const generation = claim.metadata?.generation;
    const status = claim.status ?? {};
    const conditions = Array.isArray(status.conditions) ? status.conditions : [];

    const failedCond = conditions.find(
      (c) =>
        isConditionCurrent(c, generation) &&
        (c.type === "Failed" ||
          (c.type === "Ready" &&
            c.status === "False" &&
            typeof c.reason === "string" &&
            /failed|expired|invalid/i.test(c.reason))),
    );
    if (failedCond) {
      throw new Error(
        `SandboxClaim ${namespace}/${claimName} failed: ${failedCond.reason ?? "unknown"} — ${failedCond.message ?? ""}`,
      );
    }

    const readyCond = conditions.find((c) => c.type === "Ready");
    const sandboxName = status.sandbox?.name?.trim();
    if (
      readyCond &&
      readyCond.status === "True" &&
      isConditionCurrent(readyCond, generation) &&
      sandboxName
    ) {
      const pod = (await clients.core.readNamespacedPod({
        namespace,
        name: sandboxName,
      })) as {
        metadata?: { name?: string; deletionTimestamp?: unknown };
        status?: {
          phase?: string;
          containerStatuses?: Array<{ name?: string; restartCount?: number }>;
        };
      };

      if (pod.metadata?.deletionTimestamp) {
        throw new Error(
          `Claimed pod ${namespace}/${sandboxName} is already terminating — refusing lease`,
        );
      }

      const agentHealth = inspectAgentContainerStatus(pod);
      if (agentHealth.status === "restarted") {
        throw new Error(
          `Claimed pod ${namespace}/${sandboxName} has restartCount=${agentHealth.restartCount} (CrashLoop guard)`,
        );
      }
      if (pod.status?.phase === "Running" && agentHealth.status === "ready") {
        return {
          sandboxName,
          podName: pod.metadata?.name ?? sandboxName,
          claimDurationMs: Date.now() - startedAt,
          poolHit: status.poolHit ?? true,
        };
      }
    }

    await sleep(pollMs);
  }

  throw new SandboxClaimTimeoutError(namespace, claimName, timeoutMs);
}

export async function deleteSandboxClaim(
  clients: KubeClients,
  namespace: string,
  claimName: string,
): Promise<void> {
  try {
    await clients.custom.deleteNamespacedCustomObject({
      group: SANDBOX_EXTENSIONS_GROUP,
      version: SANDBOX_EXTENSIONS_VERSION,
      namespace,
      plural: SANDBOX_CLAIMS_PLURAL,
      name: claimName,
      propagationPolicy: "Foreground",
    });
  } catch (err) {
    if (!isKubeNotFoundError(err)) throw err;
  }
}

export interface DestroyClaimedSandboxInput {
  namespace: string;
  claimName: string;
  sandboxName?: string | null;
  podName?: string | null;
  secretName?: string | null;
  sandboxApiVersion?: "agents.x-k8s.io/v1alpha1" | "agents.x-k8s.io/v1beta1";
}

/**
 * Strictly one-way idempotent teardown for a warm-pool claimed sandbox.
 * Deletes the `SandboxClaim`, backing `Sandbox` CR, Pod, and per-run Secret,
 * treating 404 as success so concurrent cancel/complete calls remain safe.
 */
export async function destroyClaimedSandbox(
  clients: KubeClients,
  input: DestroyClaimedSandboxInput,
): Promise<void> {
  await deleteSandboxClaim(clients, input.namespace, input.claimName);

  if (input.sandboxName) {
    try {
      await deleteSandboxCr(
        clients,
        input.namespace,
        input.sandboxName,
        input.sandboxApiVersion ?? "agents.x-k8s.io/v1beta1",
      );
    } catch (err) {
      if (!isKubeNotFoundError(err)) throw err;
    }
  }

  if (input.podName) {
    try {
      await clients.core.deleteNamespacedPod({
        namespace: input.namespace,
        name: input.podName,
      });
    } catch (err) {
      if (!isKubeNotFoundError(err)) throw err;
    }
  }

  if (input.secretName) {
    try {
      await clients.core.deleteNamespacedSecret({
        namespace: input.namespace,
        name: input.secretName,
      });
    } catch (err) {
      if (!isKubeNotFoundError(err)) throw err;
    }
  }
}

export interface WarmPoolMetricsSnapshot {
  poolReadyCount: number;
  poolHits: number;
  coldStarts: number;
  claimCount: number;
  p50ClaimWaitMs: number;
  p95ClaimWaitMs: number;
}

/**
 * Lightweight in-memory metrics tracker exposing warm-pool readiness, hit rate,
 * cold-start counts, and claim wait latency percentiles to the control plane.
 */
export class WarmPoolMetricsTracker {
  private poolReadyCount = 0;
  private poolHits = 0;
  private coldStarts = 0;
  private readonly claimWaitSamples: number[] = [];
  private readonly maxSamples: number;

  constructor(maxSamples = 500) {
    this.maxSamples = maxSamples;
  }

  setPoolReadyCount(count: number): void {
    this.poolReadyCount = Math.max(0, Math.floor(count));
  }

  recordClaim(result: { poolHit: boolean; claimDurationMs: number }): void {
    if (result.poolHit) {
      this.poolHits += 1;
    } else {
      this.coldStarts += 1;
    }
    this.claimWaitSamples.push(Math.max(0, result.claimDurationMs));
    if (this.claimWaitSamples.length > this.maxSamples) {
      this.claimWaitSamples.shift();
    }
  }

  recordColdStart(durationMs: number): void {
    this.recordClaim({ poolHit: false, claimDurationMs: durationMs });
  }

  snapshot(): WarmPoolMetricsSnapshot {
    const sorted = [...this.claimWaitSamples].sort((a, b) => a - b);
    const percentile = (p: number): number => {
      if (sorted.length === 0) return 0;
      const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
      return sorted[Math.max(0, idx)] ?? 0;
    };
    return {
      poolReadyCount: this.poolReadyCount,
      poolHits: this.poolHits,
      coldStarts: this.coldStarts,
      claimCount: this.poolHits + this.coldStarts,
      p50ClaimWaitMs: percentile(50),
      p95ClaimWaitMs: percentile(95),
    };
  }
}
