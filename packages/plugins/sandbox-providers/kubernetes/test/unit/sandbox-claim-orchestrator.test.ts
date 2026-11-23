import { describe, it, expect, vi } from "vitest";
import {
  assertNeverReturnToWarmPool,
  buildSandboxClaimManifest,
  buildSandboxTemplateManifest,
  buildSandboxWarmPoolManifest,
  createSandboxClaim,
  destroyClaimedSandbox,
  SANDBOX_EXTENSIONS_API_VERSION,
  SandboxClaimTimeoutError,
  waitForSandboxClaimReady,
  WarmPoolMetricsTracker,
  WarmPoolReturnForbiddenError,
} from "../../src/sandbox-claim-orchestrator.js";

/**
 * Contract subset derived from kubernetes-sigs/agent-sandbox v1beta1 CRDs
 * (`k8s/crds/extensions.agents.x-k8s.io_sandboxclaims.yaml` and
 * `k8s/crds/extensions.agents.x-k8s.io_sandboxwarmpools.yaml`, commit 1b7d5336).
 */
const V1BETA1_SHUTDOWN_POLICY_ENUM = new Set(["Delete", "DeleteForeground", "Retain"]);

describe("v1beta1 SandboxClaim / SandboxTemplate / SandboxWarmPool builders", () => {
  it("conforms to agent-sandbox v1beta1 SandboxClaim CRD schema (warmPoolRef + lifecycle.shutdownTime/shutdownPolicy)", () => {
    const nowMs = Date.parse("2026-11-23T00:00:00.000Z");
    const manifest = buildSandboxClaimManifest({
      namespace: "paperclip-acme",
      claimName: "claim-01",
      warmPoolName: "expert-codex-min-arm64",
      runId: "run-01",
      companyId: "comp-01",
      runGeneration: 3,
      ttlSeconds: 1800,
      nowMs,
    }) as {
      apiVersion: string;
      kind: string;
      metadata: { labels: Record<string, string> };
      spec: {
        warmPoolRef: { name: string };
        sandboxTemplateRef?: unknown;
        lifecycle: { shutdownTime: string; shutdownPolicy: string };
      };
    };

    expect(manifest.apiVersion).toBe(SANDBOX_EXTENSIONS_API_VERSION);
    expect(manifest.kind).toBe("SandboxClaim");
    expect(manifest.spec.warmPoolRef).toEqual({ name: "expert-codex-min-arm64" });
    expect(manifest.spec.sandboxTemplateRef).toBeUndefined();
    expect(manifest.spec.lifecycle.shutdownTime).toBe("2026-11-23T00:30:00.000Z");
    expect(V1BETA1_SHUTDOWN_POLICY_ENUM.has(manifest.spec.lifecycle.shutdownPolicy)).toBe(true);
    expect(manifest.spec.lifecycle.shutdownPolicy).toBe("DeleteForeground");
    expect(manifest.metadata.labels["paperclip.io/run-generation"]).toBe("3");
  });

  it("rejects non-positive TTL or empty warmPoolName", () => {
    expect(() =>
      buildSandboxClaimManifest({
        namespace: "ns",
        claimName: "c1",
        warmPoolName: "pool-1",
        runId: "r1",
        companyId: "co1",
        runGeneration: 1,
        ttlSeconds: 0,
      }),
    ).toThrow(/ttlSeconds/);

    expect(() =>
      buildSandboxClaimManifest({
        namespace: "ns",
        claimName: "c1",
        warmPoolName: "",
        runId: "r1",
        companyId: "co1",
        runGeneration: 1,
      }),
    ).toThrow(/warmPoolName/);
  });

  it("builds a zero-credential clean SandboxTemplate aligned with PSS restricted baseline", () => {
    const tpl = buildSandboxTemplateManifest({
      namespace: "paperclip",
      templateName: "expert-codex-min-arm64",
      image: `ghcr.io/hrygo/delegra/codex-min@sha256:${"a".repeat(64)}`,
      serviceAccountName: "paperclip-tenant-sa",
    }) as {
      apiVersion: string;
      kind: string;
      spec: {
        podTemplate: {
          spec: {
            priorityClassName: string;
            nodeSelector: Record<string, string>;
            automountServiceAccountToken: boolean;
            restartPolicy: string;
            containers: Array<{
              name: string;
              envFrom?: unknown;
              securityContext: { readOnlyRootFilesystem: boolean; runAsUser: number };
            }>;
          };
        };
      };
    };

    expect(tpl.apiVersion).toBe("extensions.agents.x-k8s.io/v1beta1");
    expect(tpl.kind).toBe("SandboxTemplate");
    const podSpec = tpl.spec.podTemplate.spec;
    expect(podSpec.priorityClassName).toBe("paperclip-warm-pool");
    expect(podSpec.nodeSelector).toEqual({ "kubernetes.io/arch": "arm64" });
    expect(podSpec.automountServiceAccountToken).toBe(false);
    expect(podSpec.restartPolicy).toBe("Always");
    expect(podSpec.containers[0].name).toBe("agent");
    expect(podSpec.containers[0].envFrom).toBeUndefined();
    expect(podSpec.containers[0].securityContext.readOnlyRootFilesystem).toBe(true);
    expect(podSpec.containers[0].securityContext.runAsUser).toBe(1000);
  });

  it("builds a v1beta1 SandboxWarmPool manifest", () => {
    const pool = buildSandboxWarmPoolManifest({
      namespace: "paperclip",
      poolName: "expert-codex-min-arm64",
      templateName: "expert-codex-min-arm64",
      replicas: 4,
    }) as { apiVersion: string; kind: string; spec: { replicas: number } };

    expect(pool.apiVersion).toBe("extensions.agents.x-k8s.io/v1beta1");
    expect(pool.kind).toBe("SandboxWarmPool");
    expect(pool.spec.replicas).toBe(4);
  });
});

describe("waitForSandboxClaimReady & one-way lifecycle guards", () => {
  it("handles representative v1beta1 controller response (condition-level observedGeneration) and verifies agent restartCount === 0", async () => {
    const getCustom = vi
      .fn()
      .mockResolvedValueOnce({
        metadata: { generation: 2 },
        status: {
          sandbox: { name: "sb-warm-1", podIPs: ["10.42.0.18"] },
          conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
        },
      })
      .mockResolvedValueOnce({
        metadata: { generation: 2 },
        status: {
          sandbox: { name: "sb-warm-1", podIPs: ["10.42.0.18"] },
          poolHit: true,
          conditions: [{ type: "Ready", status: "True", observedGeneration: 2 }],
        },
      });
    const readPod = vi.fn().mockResolvedValue({
      metadata: { name: "sb-warm-1" },
      status: {
        phase: "Running",
        containerStatuses: [{ name: "agent", restartCount: 0 }],
      },
    });
    const clients = {
      custom: { getNamespacedCustomObject: getCustom },
      core: { readNamespacedPod: readPod },
    };

    const res = await waitForSandboxClaimReady(clients as never, "paperclip-acme", "claim-1", {
      timeoutMs: 2000,
      pollMs: 5,
    });

    expect(getCustom).toHaveBeenCalledTimes(2);
    expect(readPod).toHaveBeenCalledOnce();
    expect(res.sandboxName).toBe("sb-warm-1");
    expect(res.podName).toBe("sb-warm-1");
    expect(res.poolHit).toBe(true);
  });

  it("keeps polling when Pod is Running with only a sidecar container status and no agent status yet", async () => {
    const getCustom = vi.fn().mockResolvedValue({
      metadata: { generation: 1 },
      status: {
        sandbox: { name: "sb-sidecar" },
        conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
      },
    });
    const readPod = vi
      .fn()
      .mockResolvedValueOnce({
        metadata: { name: "sb-sidecar" },
        status: {
          phase: "Running",
          containerStatuses: [{ name: "istio-proxy", restartCount: 0 }],
        },
      })
      .mockResolvedValueOnce({
        metadata: { name: "sb-sidecar" },
        status: {
          phase: "Running",
          containerStatuses: [
            { name: "istio-proxy", restartCount: 0 },
            { name: "agent", restartCount: 0 },
          ],
        },
      });
    const clients = {
      custom: { getNamespacedCustomObject: getCustom },
      core: { readNamespacedPod: readPod },
    };

    const res = await waitForSandboxClaimReady(clients as never, "paperclip-acme", "claim-sidecar", {
      timeoutMs: 2000,
      pollMs: 5,
    });

    expect(readPod).toHaveBeenCalledTimes(2);
    expect(res.podName).toBe("sb-sidecar");
  });

  it("rejects CrashLoop false-ready pods with restartCount > 0", async () => {
    const clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: { generation: 1 },
          status: {
            sandbox: { name: "sb-crash" },
            conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
          },
        }),
      },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue({
          metadata: { name: "sb-crash" },
          status: {
            phase: "Running",
            containerStatuses: [{ name: "agent", restartCount: 2 }],
          },
        }),
      },
    };

    await expect(
      waitForSandboxClaimReady(clients as never, "ns", "claim-crash", {
        timeoutMs: 1000,
        pollMs: 5,
      }),
    ).rejects.toThrow(/restartCount=2/);
  });

  it("throws SandboxClaimTimeoutError when claim never reaches Ready", async () => {
    const clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: { generation: 1 },
          status: { conditions: [{ type: "Ready", status: "False", observedGeneration: 1 }] },
        }),
      },
      core: { readNamespacedPod: vi.fn() },
    };

    await expect(
      waitForSandboxClaimReady(clients as never, "ns", "claim-timeout", {
        timeoutMs: 30,
        pollMs: 5,
      }),
    ).rejects.toBeInstanceOf(SandboxClaimTimeoutError);
  });

  it("forbids returning any claimed or dirty sandbox back to a warm pool", () => {
    expect(() =>
      assertNeverReturnToWarmPool({
        sandboxName: "sb-dirty-1",
        wasClaimed: true,
        hasWorkspaceData: true,
        hasExecutedTools: true,
        boundRunGeneration: 1,
      }),
    ).toThrow(WarmPoolReturnForbiddenError);
  });

  it("destroys claimed sandbox resources idempotently (treats 404 as success)", async () => {
    const delCustom = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({ code: 404 });
    const delPod = vi.fn().mockRejectedValue({ statusCode: 404 });
    const delSecret = vi.fn().mockResolvedValue({});
    const clients = {
      custom: { deleteNamespacedCustomObject: delCustom },
      core: { deleteNamespacedPod: delPod, deleteNamespacedSecret: delSecret },
    };

    await expect(
      destroyClaimedSandbox(clients as never, {
        namespace: "paperclip-acme",
        claimName: "claim-1",
        sandboxName: "sb-1",
        podName: "sb-1",
        secretName: "pc-01-agent-env",
      }),
    ).resolves.toBeUndefined();

    expect(delCustom).toHaveBeenCalledTimes(2);
    expect(delPod).toHaveBeenCalledOnce();
    expect(delSecret).toHaveBeenCalledOnce();
  });

  it("creates SandboxClaim via extensions.agents.x-k8s.io/v1beta1", async () => {
    const create = vi.fn().mockResolvedValue({ metadata: { uid: "claim-uid-1" } });
    const clients = { custom: { createNamespacedCustomObject: create } };
    const result = await createSandboxClaim(clients as never, "ns", { kind: "SandboxClaim" });
    expect(result.uid).toBe("claim-uid-1");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        group: "extensions.agents.x-k8s.io",
        version: "v1beta1",
        plural: "sandboxclaims",
      }),
    );
  });
});

describe("WarmPoolMetricsTracker", () => {
  it("tracks ready count, hit/cold counters, and latency percentiles", () => {
    const metrics = new WarmPoolMetricsTracker();
    metrics.setPoolReadyCount(4);
    metrics.recordClaim({ poolHit: true, claimDurationMs: 120 });
    metrics.recordClaim({ poolHit: true, claimDurationMs: 350 });
    metrics.recordColdStart(4200);

    const snap = metrics.snapshot();
    expect(snap.poolReadyCount).toBe(4);
    expect(snap.poolHits).toBe(2);
    expect(snap.coldStarts).toBe(1);
    expect(snap.claimCount).toBe(3);
    expect(snap.p50ClaimWaitMs).toBe(350);
    expect(snap.p95ClaimWaitMs).toBe(4200);
  });
});
