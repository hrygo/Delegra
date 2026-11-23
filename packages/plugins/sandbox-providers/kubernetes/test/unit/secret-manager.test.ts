import { describe, it, expect, vi } from "vitest";
import {
  assertNoUserCredentialsInEnv,
  createAgentSessionSecret,
  createPerRunSecret,
  createProxyAuthSecret,
} from "../../src/secret-manager.js";

describe("createPerRunSecret", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    secretName: "r-abcd-env",
    runId: "r-abcd",
    ownerKind: "Job",
    ownerApiVersion: "batch/v1",
    ownerName: "r-abcd",
    ownerUid: "11111111-1111-1111-1111-111111111111",
    bootstrapToken: "tok-xyz",
    adapterEnv: { ANTHROPIC_API_KEY: "sk-test" },
  };

  it("creates a Secret with the correct name and namespace", async () => {
    const created: { body: Record<string, unknown> }[] = [];
    const clients = {
      core: { createNamespacedSecret: vi.fn(async (args: { body: Record<string, unknown> }) => { created.push(args); }) },
    };
    await createPerRunSecret(clients as never, baseInput);
    expect(clients.core.createNamespacedSecret).toHaveBeenCalledOnce();
    const body = created[0].body as { metadata: { name: string; namespace: string } };
    expect(body.metadata.name).toBe("r-abcd-env");
    expect(body.metadata.namespace).toBe("paperclip-acme");
  });

  it("includes BOOTSTRAP_TOKEN and adapter env keys in stringData", async () => {
    const created: { body: Record<string, unknown> }[] = [];
    const clients = {
      core: { createNamespacedSecret: vi.fn(async (args: { body: Record<string, unknown> }) => { created.push(args); }) },
    };
    await createPerRunSecret(clients as never, baseInput);
    const body = created[0].body as { stringData: Record<string, string> };
    expect(body.stringData.BOOTSTRAP_TOKEN).toBe("tok-xyz");
    expect(body.stringData.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  it("sets ownerReferences to the owner resource for cascade delete", async () => {
    const created: { body: Record<string, unknown> }[] = [];
    const clients = {
      core: { createNamespacedSecret: vi.fn(async (args: { body: Record<string, unknown> }) => { created.push(args); }) },
    };
    await createPerRunSecret(clients as never, baseInput);
    const body = created[0].body as { metadata: { ownerReferences: { uid: string; controller: boolean }[] } };
    expect(body.metadata.ownerReferences).toHaveLength(1);
    expect(body.metadata.ownerReferences[0].uid).toBe("11111111-1111-1111-1111-111111111111");
    expect(body.metadata.ownerReferences[0].controller).toBe(true);
  });

  it("throws if adapterEnv contains BOOTSTRAP_TOKEN", async () => {
    const clients = { core: { createNamespacedSecret: vi.fn() } };
    await expect(
      createPerRunSecret(clients as never, {
        ...baseInput,
        adapterEnv: { BOOTSTRAP_TOKEN: "evil" },
      }),
    ).rejects.toThrow(/BOOTSTRAP_TOKEN/);
  });

  it("throws if ownerUid is empty", async () => {
    const clients = { core: { createNamespacedSecret: vi.fn() } };
    await expect(
      createPerRunSecret(clients as never, { ...baseInput, ownerUid: "" }),
    ).rejects.toThrow(/ownerUid/);
  });
});

describe("zero-credential Secret split (createAgentSessionSecret & createProxyAuthSecret)", () => {
  const baseAgentInput = {
    namespace: "paperclip-acme",
    secretName: "pc-01-agent-env",
    runId: "r-01",
    runGeneration: 2,
    ownerKind: "Sandbox",
    ownerApiVersion: "agents.x-k8s.io/v1alpha1",
    ownerName: "pc-01",
    ownerUid: "22222222-2222-2222-2222-222222222222",
    bootstrapToken: "boot-1",
    gatewayProxyUrl: "http://delegra-gateway-proxy.paperclip.svc.cluster.local:8443",
  };

  it("rejects any user API key or IAM credential in runtimeEnv", () => {
    expect(() => assertNoUserCredentialsInEnv({ OPENAI_API_KEY: "sk-1" })).toThrow(/delegra-gateway-proxy/);
    expect(() => assertNoUserCredentialsInEnv({ ANTHROPIC_API_KEY: "sk-ant" })).toThrow(/delegra-gateway-proxy/);
    expect(() => assertNoUserCredentialsInEnv({ CUSTOM_ACCESS_TOKEN: "tok" })).toThrow(/delegra-gateway-proxy/);
    expect(() => assertNoUserCredentialsInEnv({ LOG_LEVEL: "info" })).not.toThrow();
  });

  it("creates an agent-session Secret with zero user credentials", async () => {
    const created: { body: Record<string, unknown> }[] = [];
    const clients = {
      core: { createNamespacedSecret: vi.fn(async (args: { body: Record<string, unknown> }) => { created.push(args); }) },
    };
    await createAgentSessionSecret(clients as never, {
      ...baseAgentInput,
      runtimeEnv: { CODEX_WIRE_API: "responses" },
    });

    const body = created[0].body as {
      metadata: { labels: Record<string, string> };
      stringData: Record<string, string>;
    };
    expect(body.metadata.labels["paperclip.io/secret-scope"]).toBe("agent-session");
    expect(body.stringData).toEqual({
      CODEX_WIRE_API: "responses",
      BOOTSTRAP_TOKEN: "boot-1",
      DELEGRA_GATEWAY_PROXY_URL: "http://delegra-gateway-proxy.paperclip.svc.cluster.local:8443",
      PAPERCLIP_RUN_ID: "r-01",
      PAPERCLIP_RUN_GENERATION: "2",
    });
    expect(body.stringData.OPENAI_API_KEY).toBeUndefined();
    expect(body.stringData.PROXY_SESSION_TOKEN).toBeUndefined();
  });

  it("refuses to create an agent-session Secret if runtimeEnv leaks a model API key", async () => {
    const clients = { core: { createNamespacedSecret: vi.fn() } };
    await expect(
      createAgentSessionSecret(clients as never, {
        ...baseAgentInput,
        runtimeEnv: { OPENAI_API_KEY: "sk-leak" },
      }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
    expect(clients.core.createNamespacedSecret).not.toHaveBeenCalled();
  });

  it("creates a separate proxy-auth Secret with control-plane callback credentials", async () => {
    const created: { body: Record<string, unknown> }[] = [];
    const clients = {
      core: { createNamespacedSecret: vi.fn(async (args: { body: Record<string, unknown> }) => { created.push(args); }) },
    };
    await createProxyAuthSecret(clients as never, {
      namespace: "paperclip",
      secretName: "pc-01-proxy-env",
      runId: "r-01",
      ownerKind: "Sandbox",
      ownerApiVersion: "agents.x-k8s.io/v1alpha1",
      ownerName: "pc-01",
      ownerUid: "22222222-2222-2222-2222-222222222222",
      controlPlaneUrl: "http://paperclip-server.paperclip.svc.cluster.local:3100",
      internalAuthToken: "internal-gw-tok",
    });
    const body = created[0].body as {
      metadata: { labels: Record<string, string> };
      stringData: Record<string, string>;
    };
    expect(body.metadata.labels["paperclip.io/secret-scope"]).toBe("proxy-auth");
    expect(body.stringData).toEqual({
      DELEGRA_CONTROL_PLANE_URL: "http://paperclip-server.paperclip.svc.cluster.local:3100",
      DELEGRA_GATEWAY_INTERNAL_TOKEN: "internal-gw-tok",
    });
  });
});
