import { afterEach, describe, expect, it, vi } from "vitest";
import { createExpertGatewayAuthorizationService } from "./expert-gateway-authorization.js";
import {
  createEnvGatewayRevocationPublisher,
  createHttpGatewayRevocationPublisher,
  getActiveExpertGatewayAuthzService,
  parseGatewayProxyRevocationUrls,
  PROXY_PUSH_REVOCATIONS_PATH,
  registerExpertGatewayAuthzService,
  revokeExpertGatewayRun,
  revokeExpertGatewayUser,
} from "./expert-gateway-revocation-bridge.js";

describe("expert-gateway-revocation-bridge", () => {
  const unregisters: Array<() => void> = [];

  afterEach(() => {
    while (unregisters.length > 0) {
      unregisters.pop()?.();
    }
  });

  it("parses, deduplicates, and filters gateway proxy revocation URLs", () => {
    expect(
      parseGatewayProxyRevocationUrls({
        DELEGRA_GATEWAY_PROXY_URLS:
          "http://proxy-1:8443/, https://proxy-2.paperclip.svc:8443, http://proxy-1:8443, ftp://bad.local, not-a-url",
      }),
    ).toEqual(["http://proxy-1:8443", "https://proxy-2.paperclip.svc:8443"]);

    expect(
      parseGatewayProxyRevocationUrls({
        DELEGRA_GATEWAY_PROXY_URL: "http://delegra-gateway-proxy.paperclip.svc:8443/",
      }),
    ).toEqual(["http://delegra-gateway-proxy.paperclip.svc:8443"]);

    expect(parseGatewayProxyRevocationUrls({})).toEqual([]);
  });

  it("fans out run_revoked events to all proxy replicas and tolerates partial failure", async () => {
    const calls: Array<{ url: string; auth?: string; body: Record<string, unknown> }> = [];
    const errors: string[] = [];

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("proxy-down")) {
        throw new Error("ECONNREFUSED");
      }
      const headers = init?.headers as Record<string, string>;
      calls.push({
        url,
        auth: headers.Authorization,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    });

    const publisher = createHttpGatewayRevocationPublisher({
      proxyBaseUrls: ["http://proxy-down:8443", "http://proxy-healthy:8443"],
      internalToken: "shared-internal-tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onError: (proxyUrl) => errors.push(proxyUrl),
    });

    await publisher.publish({
      type: "run_revoked",
      reason: "cancelled",
      runId: "run-99",
      runGeneration: 2,
      revokedAt: "2026-11-24T00:00:00.000Z",
    });

    expect(errors).toEqual(["http://proxy-down:8443"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://proxy-healthy:8443${PROXY_PUSH_REVOCATIONS_PATH}`);
    expect(calls[0]?.auth).toBe("Bearer shared-internal-tok");
    expect(calls[0]?.body).toMatchObject({
      runId: "run-99",
      runGeneration: 2,
      reason: "cancelled",
    });
  });

  it("wires registerExpertGatewayAuthzService -> revokeExpertGatewayRun/User -> HTTP push publisher", async () => {
    const pushedRunIds: string[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { runId: string };
      pushedRunIds.push(body.runId);
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    });

    const revocationPublisher = createEnvGatewayRevocationPublisher(
      {
        DELEGRA_GATEWAY_PROXY_URL: "http://delegra-gateway-proxy.paperclip.svc:8443",
        DELEGRA_GATEWAY_INTERNAL_TOKEN: "env-internal-tok",
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(revocationPublisher).toBeDefined();

    const service = createExpertGatewayAuthorizationService({ revocationPublisher });
    unregisters.push(registerExpertGatewayAuthzService(service));
    expect(getActiveExpertGatewayAuthzService()).toBe(service);

    await service.issueLease({
      runId: "run-a",
      runGeneration: 1,
      agentId: "agent-1",
      companyId: "co-1",
      userId: "user-1",
      allowedModels: ["gpt-5-mini"],
      resolveUpstreamHeaders: () => ({ Authorization: "Bearer up" }),
    });
    await service.issueLease({
      runId: "run-b",
      runGeneration: 1,
      agentId: "agent-2",
      companyId: "co-1",
      userId: "user-1",
      allowedModels: ["gpt-5-mini"],
      resolveUpstreamHeaders: () => ({ Authorization: "Bearer up" }),
    });

    expect(await revokeExpertGatewayRun("run-a", "cancelled")).toBe(true);
    expect(await revokeExpertGatewayUser("co-1", "user-1", "auth_revoked")).toBe(1);
    expect(pushedRunIds).toEqual(["run-a", "run-b"]);
  });
});
