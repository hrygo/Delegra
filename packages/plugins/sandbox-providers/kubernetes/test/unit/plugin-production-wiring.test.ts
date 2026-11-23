import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown> }));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

vi.mock("../../src/tenant-orchestrator.js", () => ({
  ensureTenant: vi.fn().mockResolvedValue(undefined),
}));

import plugin, { CapacityAdmissionDeniedError } from "../../src/plugin.js";
import { KataIsolationRequiredError } from "../../src/capacity-admission.js";

function baseClients(overrides: Record<string, unknown> = {}) {
  return {
    core: {
      readNamespacedResourceQuota: vi.fn().mockResolvedValue({
        status: {
          hard: { pods: "20", "requests.cpu": "10", "requests.memory": "20Gi" },
          used: { pods: "1", "requests.cpu": "500m", "requests.memory": "1Gi" },
        },
      }),
      createNamespacedSecret: vi.fn().mockResolvedValue({}),
      readNamespacedPod: vi.fn().mockResolvedValue({
        metadata: { name: "pc-pod-1" },
        spec: { nodeName: "node-arm64-1" },
        status: {
          phase: "Running",
          containerStatuses: [{ name: "agent", restartCount: 0, imageID: "docker-pullable://ghcr.io/org/codex@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
        },
      }),
      deleteNamespacedPod: vi.fn().mockResolvedValue({}),
      deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
    },
    custom: {
      createNamespacedCustomObject: vi.fn().mockResolvedValue({ metadata: { uid: "uid-cr-1" } }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { generation: 1 },
        status: {
          sandbox: { name: "warm-sbx-1" },
          poolHit: true,
          conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
        },
      }),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    },
    networking: {},
    ...overrides,
  };
}

beforeEach(() => {
  h.clients = baseClients();
});

describe("plugin production main-path wiring (#77-#84)", () => {
  it("uses zero-credential createAgentSessionSecret when gatewayProxyUrl is provided", async () => {
    const clients = baseClients();
    h.clients = clients;

    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      runId: "run-zt-1",
      agentId: "agent-1",
      config: {
        inCluster: true,
        backend: "sandbox-cr",
        gatewayProxyUrl: "http://delegra-gateway-proxy.paperclip.svc:8080",
      },
      runGeneration: 3,
      proxySessionToken: "one-time-session-token-xyz",
    } as never);

    expect(lease.metadata?.zeroTrustGateway).toBe(true);
    expect(clients.core.createNamespacedSecret).toHaveBeenCalledTimes(1);
    const secretCall = clients.core.createNamespacedSecret.mock.calls[0]?.[0];
    expect(secretCall.body.metadata.labels["paperclip.io/secret-scope"]).toBe("agent-session");
    expect(secretCall.body.stringData.DELEGRA_GATEWAY_PROXY_URL).toBe(
      "http://delegra-gateway-proxy.paperclip.svc:8080",
    );
    expect(secretCall.body.stringData.PAPERCLIP_RUN_GENERATION).toBe("3");
    expect(secretCall.body.stringData.PROXY_SESSION_TOKEN).toBe("one-time-session-token-xyz");
  });

  it("blocks lease creation with CapacityAdmissionDeniedError when tenant ResourceQuota is exhausted", async () => {
    const clients = baseClients();
    clients.core.readNamespacedResourceQuota = vi.fn().mockResolvedValue({
      status: {
        hard: { pods: "4" },
        used: { pods: "4" },
      },
    });
    h.clients = clients;

    await expect(
      plugin.definition.onEnvironmentAcquireLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        runId: "run-quota-full",
        config: { inCluster: true, backend: "sandbox-cr" },
      } as never),
    ).rejects.toThrow(CapacityAdmissionDeniedError);

    expect(clients.custom.createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("enforces fail-closed Kata-FC isolation for C3/C4 workloads and threads tolerations/annotations into Sandbox CR", async () => {
    const clients = baseClients();
    h.clients = clients;

    // Missing guaranteed memory (requests != limits) must fail closed.
    await expect(
      plugin.definition.onEnvironmentAcquireLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        runId: "run-c3-bad",
        config: { inCluster: true, backend: "sandbox-cr" },
        dataClassification: "C3",
      } as never),
    ).rejects.toThrow(KataIsolationRequiredError);

    // Valid C3 workload with equal requests/limits memory succeeds with kata-fc runtimeClass + tolerations + annotation.
    await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      runId: "run-c3-ok",
      config: {
        inCluster: true,
        backend: "sandbox-cr",
        defaultResources: {
          requests: { cpu: "1", memory: "2Gi" },
          limits: { cpu: "2", memory: "2Gi" },
        },
      },
      dataClassification: "C3",
    } as never);

    const crBody = clients.custom.createNamespacedCustomObject.mock.calls[0]?.[0]?.body;
    expect(crBody.spec.podTemplate.spec.runtimeClassName).toBe("kata-fc");
    expect(crBody.spec.podTemplate.spec.tolerations).toEqual([
      {
        key: "paperclip.io/runtime",
        operator: "Equal",
        value: "kata-fc",
        effect: "NoSchedule",
      },
    ]);
    expect(
      crBody.spec.podTemplate.metadata.annotations[
        "io.katacontainers.config.hypervisor.default_memory_offset_mb"
      ],
    ).toBe("512");
  });

  it("acquires v1beta1 SandboxClaim from warm pool and tears down strictly one-way on release", async () => {
    const clients = baseClients();
    h.clients = clients;

    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      runId: "run-warm-1",
      config: {
        inCluster: true,
        backend: "sandbox-cr",
        sandboxApiVersion: "agents.x-k8s.io/v1beta1",
        warmPool: {
          enabled: true,
          templateName: "warm-pool-light",
          claimTimeoutMs: 5000,
          defaultTtlSeconds: 1800,
        },
      },
    } as never);

    expect(lease.providerLeaseId).toBe("warm-sbx-1");
    expect(lease.metadata?.poolHit).toBe(true);
    expect(lease.metadata?.sandboxClaimName).toMatch(/^pc-/);

    const claimCall = clients.custom.createNamespacedCustomObject.mock.calls[0]?.[0];
    expect(claimCall.group).toBe("extensions.agents.x-k8s.io");
    expect(claimCall.version).toBe("v1beta1");
    expect(claimCall.plural).toBe("sandboxclaims");
    expect(claimCall.body.spec.warmPoolRef).toEqual({ name: "warm-pool-light" });

    // Release destroys SandboxClaim + Sandbox CR + Pod + Secret (never returns to warm pool).
    await plugin.definition.onEnvironmentReleaseLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: {
        inCluster: true,
        backend: "sandbox-cr",
        sandboxApiVersion: "agents.x-k8s.io/v1beta1",
      },
      providerLeaseId: lease.providerLeaseId,
      leaseMetadata: lease.metadata,
    });

    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        group: "extensions.agents.x-k8s.io",
        plural: "sandboxclaims",
        name: lease.metadata?.sandboxClaimName,
      }),
    );
    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        group: "agents.x-k8s.io",
        version: "v1beta1",
        plural: "sandboxes",
        name: "warm-sbx-1",
      }),
    );
    expect(clients.core.deleteNamespacedPod).toHaveBeenCalled();
    expect(clients.core.deleteNamespacedSecret).toHaveBeenCalled();
  });
});
