import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  clients: {} as Record<string, unknown>,
  execInPod: vi.fn(),
  deliverLeaseTokenViaStdin: vi.fn(),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

vi.mock("../../src/pod-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pod-exec.js")>();
  return {
    ...actual,
    execInPod: (...args: unknown[]) => h.execInPod(...args),
    deliverLeaseTokenViaStdin: (...args: unknown[]) => h.deliverLeaseTokenViaStdin(...args),
  };
});

import plugin, {
  CapacityAdmissionDeferredError,
  getWarmPoolMetricsSnapshot,
} from "../../src/plugin.js";
import { clearTenantReconcileCache } from "../../src/tenant-orchestrator.js";
import { KataIsolationRequiredError } from "../../src/capacity-admission.js";

function makeBaseClients(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clusterId: "test-cluster",
    applyServerSide: vi.fn().mockResolvedValue({}),
    core: {
      readNamespace: vi.fn().mockResolvedValue({
        metadata: { labels: { "paperclip.io/company-id": "acme" } },
      }),
      createNamespacedSecret: vi.fn().mockResolvedValue({}),
      readNamespacedPod: vi.fn().mockResolvedValue({
        metadata: { name: "sandbox-warm-1" },
        spec: { nodeName: "arm64-node-1" },
        status: {
          phase: "Running",
          containerStatuses: [{ name: "agent", restartCount: 0, imageID: "docker-pullable://ghcr.io/org/codex-node@sha256:aaaa" }],
        },
      }),
      readNamespacedResourceQuota: vi.fn().mockResolvedValue({
        status: {
          hard: { pods: "20", "requests.cpu": "10", "requests.memory": "20Gi" },
          used: { pods: "2", "requests.cpu": "1", "requests.memory": "2Gi" },
        },
      }),
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
      deleteNamespacedPod: vi.fn().mockResolvedValue({}),
      deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
    },
    networking: {
      deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    },
    custom: {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({ metadata: { uid: "uid-1" } }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { generation: 1 },
        status: {
          sandbox: { name: "sandbox-warm-1" },
          poolHit: true,
          conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
        },
      }),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    },
    ...overrides,
  };
}

beforeEach(() => {
  clearTenantReconcileCache();
  h.clients = makeBaseClients();
  h.execInPod.mockReset();
  h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
  h.deliverLeaseTokenViaStdin.mockReset();
  h.deliverLeaseTokenViaStdin.mockResolvedValue(undefined);
});

describe("Kubernetes plugin production wiring", () => {
  it("validates expertZeroTrust and warmPool configuration contracts", async () => {
    const missingProxy = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, expertZeroTrust: { enabled: true } },
    });
    expect(missingProxy.ok).toBe(false);
    expect(missingProxy.errors?.[0]).toMatch(/gatewayProxyUrl/);

    const missingPool = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, warmPool: { enabled: true } },
    });
    expect(missingPool.ok).toBe(false);
    expect(missingPool.errors?.[0]).toMatch(/warmPoolName/);

    const valid = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: {
        inCluster: true,
        egressMode: "cilium",
        sandboxApiVersion: "agents.x-k8s.io/v1beta1",
        warmPool: { enabled: true, warmPoolName: "expert-light-pool" },
        expertZeroTrust: {
          enabled: true,
          gatewayProxyUrl: "http://delegra-gateway-proxy.paperclip.svc.cluster.local:8080",
        },
      },
    });
    expect(valid.ok).toBe(true);
    expect(valid.warnings).toBeUndefined();
  });

  it("acquires v1beta1 SandboxClaim from warm pool, delivers zero-trust token via stdin, and destroys one-way on release", async () => {
    const beforeClaims = getWarmPoolMetricsSnapshot().claimCount;

    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      runId: "run-warm-1",
      agentId: "agent-1",
      config: {
        inCluster: true,
        egressMode: "cilium",
        sandboxApiVersion: "agents.x-k8s.io/v1beta1",
        warmPool: {
          enabled: true,
          warmPoolName: "expert-light-pool",
          claimTimeoutMs: 5_000,
          defaultTtlSeconds: 1800,
        },
        expertZeroTrust: {
          enabled: true,
          gatewayProxyUrl: "http://delegra-gateway-proxy.paperclip.svc.cluster.local:8080",
        },
      },
      runGeneration: 2,
      proxySessionToken: "one-time-session-token-xyz",
    } as never);

    expect(lease.providerLeaseId).toBe("sandbox-warm-1");
    expect(lease.metadata).toEqual(
      expect.objectContaining({
        backend: "sandbox-cr",
        sandboxApiVersion: "agents.x-k8s.io/v1beta1",
        poolHit: true,
        zeroTrustMode: true,
        podName: "sandbox-warm-1",
      }),
    );
    expect(typeof lease.metadata?.sandboxClaimName).toBe("string");
    // Session token must never leak into lease metadata.
    expect(JSON.stringify(lease.metadata)).not.toContain("one-time-session-token-xyz");
    expect(h.deliverLeaseTokenViaStdin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        podName: "sandbox-warm-1",
        containerName: "agent",
        token: "one-time-session-token-xyz",
        targetPath: "/run/delegra-auth/lease-token",
      }),
    );
    expect(getWarmPoolMetricsSnapshot().claimCount).toBe(beforeClaims + 1);

    // Release must perform strictly one-way destruction of both SandboxClaim and Sandbox CR.
    await plugin.definition.onEnvironmentReleaseLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: {
        inCluster: true,
        sandboxApiVersion: "agents.x-k8s.io/v1beta1",
      },
      providerLeaseId: lease.providerLeaseId,
      leaseMetadata: lease.metadata,
    });

    const deleteCalls = (
      (h.clients.custom as { deleteNamespacedCustomObject: ReturnType<typeof vi.fn> })
        .deleteNamespacedCustomObject
    ).mock.calls.map((c) => c[0] as { group: string; version: string; plural: string });
    expect(deleteCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: "extensions.agents.x-k8s.io",
          version: "v1beta1",
          plural: "sandboxclaims",
        }),
        expect.objectContaining({
          group: "agents.x-k8s.io",
          version: "v1beta1",
          plural: "sandboxes",
        }),
      ]),
    );
  });

  it("defers acquisition with CapacityAdmissionDeferredError when tenant ResourceQuota is exhausted", async () => {
    const createCustom = vi.fn();
    h.clients = makeBaseClients({
      core: {
        ...(makeBaseClients().core as Record<string, unknown>),
        readNamespacedResourceQuota: vi.fn().mockResolvedValue({
          status: {
            hard: { pods: "2", "requests.cpu": "10", "requests.memory": "20Gi" },
            used: { pods: "2", "requests.cpu": "1", "requests.memory": "2Gi" },
          },
        }),
      },
      custom: {
        ...(makeBaseClients().custom as Record<string, unknown>),
        createNamespacedCustomObject: createCustom,
      },
    });

    await expect(
      plugin.definition.onEnvironmentAcquireLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        runId: "run-quota-full",
        config: {
          inCluster: true,
          capacityAdmission: { enabled: true, quotaName: "paperclip-quota" },
        },
      } as never),
    ).rejects.toBeInstanceOf(CapacityAdmissionDeferredError);

    expect(createCustom).not.toHaveBeenCalled();
  });

  it("enforces fail-closed kata-fc isolation for C3/C4 workloads and injects tolerations/annotations", async () => {
    await expect(
      plugin.definition.onEnvironmentAcquireLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        runId: "run-c3-denied",
        config: {
          inCluster: true,
          defaultResources: {
            requests: { cpu: "1", memory: "2Gi" },
            limits: { cpu: "2", memory: "2Gi" },
          },
        },
        dataClassification: "C3",
        kataFcAvailable: false,
      } as never),
    ).rejects.toBeInstanceOf(KataIsolationRequiredError);

    const createCustom = vi.fn().mockResolvedValue({ metadata: { uid: "uid-kata" } });
    h.clients = makeBaseClients({
      custom: {
        ...(makeBaseClients().custom as Record<string, unknown>),
        createNamespacedCustomObject: createCustom,
      },
    });

    await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      runId: "run-c4-ok",
      config: {
        inCluster: true,
        sandboxApiVersion: "agents.x-k8s.io/v1beta1",
        defaultResources: {
          requests: { cpu: "1", memory: "2Gi" },
          limits: { cpu: "2", memory: "2Gi" },
        },
      },
      dataClassification: "C4",
      kataFcAvailable: true,
    } as never);

    expect(createCustom).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "v1beta1",
        body: expect.objectContaining({
          apiVersion: "agents.x-k8s.io/v1beta1",
          spec: expect.objectContaining({
            podTemplate: expect.objectContaining({
              metadata: expect.objectContaining({
                annotations: expect.objectContaining({
                  "io.katacontainers.config.hypervisor.default_memory_offset_mb": "512",
                }),
              }),
              spec: expect.objectContaining({
                runtimeClassName: "kata-fc",
                nodeSelector: expect.objectContaining({
                  "kubernetes.io/arch": "arm64",
                  "paperclip.io/runtime": "kata-fc",
                }),
                tolerations: [
                  {
                    key: "paperclip.io/runtime",
                    operator: "Equal",
                    value: "kata-fc",
                    effect: "NoSchedule",
                  },
                ],
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("uses createAgentSessionSecret (zero user credentials) and delivers deferred lease token on first execute", async () => {
    const createSecret = vi.fn().mockResolvedValue({});
    h.clients = makeBaseClients({
      core: {
        ...(makeBaseClients().core as Record<string, unknown>),
        createNamespacedSecret: createSecret,
      },
      custom: {
        ...(makeBaseClients().custom as Record<string, unknown>),
        createNamespacedCustomObject: vi.fn().mockResolvedValue({ metadata: { uid: "uid-zt" } }),
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: { generation: 1 },
          status: {
            podName: "pc-zt-pod",
            conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
          },
        }),
      },
    });

    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      runId: "run-zt-cold",
      config: {
        inCluster: true,
        egressMode: "cilium",
        sandboxApiVersion: "agents.x-k8s.io/v1beta1",
        expertZeroTrust: {
          enabled: true,
          gatewayProxyUrl: "http://delegra-gateway-proxy.paperclip.svc.cluster.local:8080",
        },
      },
      runGeneration: 3,
      proxySessionToken: "cold-start-lease-token-999",
    } as never);

    expect(createSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            labels: expect.objectContaining({
              "paperclip.io/secret-scope": "agent-session",
            }),
          }),
          stringData: expect.objectContaining({
            DELEGRA_GATEWAY_PROXY_URL: "http://delegra-gateway-proxy.paperclip.svc.cluster.local:8080",
            PAPERCLIP_RUN_ID: "run-zt-cold",
            PAPERCLIP_RUN_GENERATION: "3",
          }),
        }),
      }),
    );
    // Token must NOT be in the K8s Secret when delivered via stdin.
    const secretCallBody = createSecret.mock.calls[0]?.[0]?.body as { stringData?: Record<string, string> };
    expect(secretCallBody.stringData?.PROXY_SESSION_TOKEN).toBeUndefined();
    expect(secretCallBody.stringData?.ANTHROPIC_API_KEY).toBeUndefined();

    // First execute delivers the deferred lease token via stdin before running the command.
    const execResult = await plugin.definition.onEnvironmentExecute!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: {
        inCluster: true,
        sandboxApiVersion: "agents.x-k8s.io/v1beta1",
      },
      lease,
      command: "echo",
      args: ["hello"],
    });

    expect(execResult.exitCode).toBe(0);
    expect(h.deliverLeaseTokenViaStdin).toHaveBeenCalledTimes(1);
    expect(h.deliverLeaseTokenViaStdin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        podName: "pc-zt-pod",
        token: "cold-start-lease-token-999",
        targetPath: "/run/delegra-auth/lease-token",
      }),
    );
  });
});
