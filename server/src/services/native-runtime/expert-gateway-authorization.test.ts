import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  createExpertGatewayAuthorizationService,
  createInMemoryExpertGatewayLeaseStore,
  createInMemoryRevocationBus,
  type GatewayAuditEvent,
  type GatewayRevocationEvent,
} from "./expert-gateway-authorization.js";
import {
  expertGatewayAuthzRoutes,
  GATEWAY_AUTHORIZE_PATH,
  GATEWAY_RECONCILE_PATH,
} from "../../routes/expert-gateway-authz.js";

describe("expert-gateway-authorization", () => {
  it("issues a one-time session token (storing only its hash) and authorizes valid requests", async () => {
    const store = createInMemoryExpertGatewayLeaseStore();
    const auditEvents: GatewayAuditEvent[] = [];
    const resolveHeaders = vi.fn(() => ({
      Authorization: "Bearer upstream-secret-key",
      "X-Tenant-Sub": "user-1",
    }));
    let nowMs = 1_700_000_000_000;

    const svc = createExpertGatewayAuthorizationService({
      store,
      onAuditEvent: (evt) => auditEvents.push(evt),
      now: () => nowMs,
    });

    const issued = await svc.issueLease({
      runId: "run-1",
      runGeneration: 1,
      agentId: "agent-expert-1",
      companyId: "company-1",
      userId: "user-1",
      allowedModels: ["gpt-5.4", "claude-sonnet-4-6"],
      resolveUpstreamHeaders: resolveHeaders,
    });

    // Raw session token must never be stored in the lease store.
    const stored = await store.get("run-1");
    expect(stored).not.toBeNull();
    expect(stored!.sessionTokenHash).not.toBe(issued.sessionToken);
    expect(stored!.sessionTokenHash).toHaveLength(64);

    const decision = await svc.authorize({
      runId: "run-1",
      runGeneration: 1,
      agentId: "agent-expert-1",
      requestedModel: "gpt-5.4",
      wireApi: "responses",
      clientRequestId: "req-1",
      sessionToken: issued.sessionToken,
    });

    expect(decision.decision).toBe("allow");
    if (decision.decision === "allow") {
      expect(decision.status).toBe(200);
      expect(decision.upstream.headers.Authorization).toBe("Bearer upstream-secret-key");
      expect(decision.leaseExpiresAt).toBe(issued.leaseExpiresAt);
    }

    // Audit event must contain no credentials or tokens.
    expect(auditEvents).toHaveLength(1);
    const serializedAudit = JSON.stringify(auditEvents[0]);
    expect(serializedAudit).not.toContain("upstream-secret-key");
    expect(serializedAudit).not.toContain(issued.sessionToken);
    expect(auditEvents[0].decision).toBe("allow");
    expect(auditEvents[0].code).toBeNull();
  });

  it("enforces all 5 denial error codes without invoking upstream credential resolution", async () => {
    const resolveHeaders = vi.fn(() => ({ Authorization: "Bearer secret" }));
    let nowMs = 1_700_000_000_000;
    const svc = createExpertGatewayAuthorizationService({
      now: () => nowMs,
    });

    const lease = await svc.issueLease({
      runId: "run-5codes",
      runGeneration: 2,
      agentId: "agent-1",
      companyId: "co-1",
      userId: "u-1",
      allowedModels: ["gpt-5.4"],
      resolveUpstreamHeaders: resolveHeaders,
    });

    // 1. RUN_GENERATION_STALE (409)
    const stale = await svc.authorize({
      runId: "run-5codes",
      runGeneration: 1,
      agentId: "agent-1",
      requestedModel: "gpt-5.4",
      wireApi: "responses",
      clientRequestId: "req-stale",
      sessionToken: lease.sessionToken,
    });
    expect(stale).toMatchObject({ decision: "deny", status: 409, code: "RUN_GENERATION_STALE", retryable: false });

    // 2. MODEL_NOT_ALLOWED (403)
    const badModel = await svc.authorize({
      runId: "run-5codes",
      runGeneration: 2,
      agentId: "agent-1",
      requestedModel: "o3-pro-unauthorized",
      wireApi: "responses",
      clientRequestId: "req-model",
      sessionToken: lease.sessionToken,
    });
    expect(badModel).toMatchObject({ decision: "deny", status: 403, code: "MODEL_NOT_ALLOWED", retryable: false });

    // 3. USER_AUTH_REVOKED (401) on wrong token
    const badToken = await svc.authorize({
      runId: "run-5codes",
      runGeneration: 2,
      agentId: "agent-1",
      requestedModel: "gpt-5.4",
      wireApi: "responses",
      clientRequestId: "req-token",
      sessionToken: "wrong-token",
    });
    expect(badToken).toMatchObject({ decision: "deny", status: 401, code: "USER_AUTH_REVOKED", retryable: false });

    // 4. BUDGET_EXHAUSTED (429)
    await svc.revokeRun("run-5codes", "budget_exhausted");
    const budget = await svc.authorize({
      runId: "run-5codes",
      runGeneration: 2,
      agentId: "agent-1",
      requestedModel: "gpt-5.4",
      wireApi: "responses",
      clientRequestId: "req-budget",
      sessionToken: lease.sessionToken,
    });
    expect(budget).toMatchObject({ decision: "deny", status: 429, code: "BUDGET_EXHAUSTED", retryable: false });

    // 5. TASK_CANCELLED (403)
    await svc.revokeRun("run-5codes", "cancelled");
    const cancelled = await svc.authorize({
      runId: "run-5codes",
      runGeneration: 2,
      agentId: "agent-1",
      requestedModel: "gpt-5.4",
      wireApi: "responses",
      clientRequestId: "req-cancel",
      sessionToken: lease.sessionToken,
    });
    expect(cancelled).toMatchObject({ decision: "deny", status: 403, code: "TASK_CANCELLED", retryable: false });

    // None of the denied requests may ever touch upstream credentials.
    expect(resolveHeaders).not.toHaveBeenCalled();
  });

  it("isolates concurrent users on the same expert and publishes revocation events immediately", async () => {
    const bus = createInMemoryRevocationBus();
    const events: GatewayRevocationEvent[] = [];
    bus.subscribe((evt) => events.push(evt));

    const svc = createExpertGatewayAuthorizationService({ revocationPublisher: bus });

    const leaseA = await svc.issueLease({
      runId: "run-user-a",
      runGeneration: 1,
      agentId: "shared-expert",
      companyId: "co-1",
      userId: "user-a",
      allowedModels: ["gpt-5.4"],
      resolveUpstreamHeaders: () => ({ Authorization: "Bearer user-a-key" }),
    });
    const leaseB = await svc.issueLease({
      runId: "run-user-b",
      runGeneration: 1,
      agentId: "shared-expert",
      companyId: "co-1",
      userId: "user-b",
      allowedModels: ["gpt-5.4"],
      resolveUpstreamHeaders: () => ({ Authorization: "Bearer user-b-key" }),
    });

    // Revoke user-a only
    const revokedCount = await svc.revokeUser("co-1", "user-a", "auth_revoked");
    expect(revokedCount).toBe(1);
    expect(events.some((e) => e.type === "run_revoked" && e.runId === "run-user-a")).toBe(true);
    expect(events.some((e) => e.type === "user_revoked" && e.userId === "user-a")).toBe(true);

    const decA = await svc.authorize({
      runId: "run-user-a",
      runGeneration: 1,
      agentId: "shared-expert",
      requestedModel: "gpt-5.4",
      wireApi: "responses",
      clientRequestId: "req-a",
      sessionToken: leaseA.sessionToken,
    });
    expect(decA).toMatchObject({ decision: "deny", status: 401, code: "USER_AUTH_REVOKED" });

    // user-b on the same expert remains authorized with user-b's own credentials
    const decB = await svc.authorize({
      runId: "run-user-b",
      runGeneration: 1,
      agentId: "shared-expert",
      requestedModel: "gpt-5.4",
      wireApi: "responses",
      clientRequestId: "req-b",
      sessionToken: leaseB.sessionToken,
    });
    expect(decB.decision).toBe("allow");
    if (decB.decision === "allow") {
      expect(decB.upstream.headers.Authorization).toBe("Bearer user-b-key");
    }

    // Reconcile snapshot returns only active leases without secrets
    const active = await svc.reconcileActiveLeases();
    expect(active).toHaveLength(1);
    expect(active[0].runId).toBe("run-user-b");
    expect(JSON.stringify(active)).not.toContain("user-b-key");
    expect(JSON.stringify(active)).not.toContain(leaseB.sessionToken);
  });

  it("protects internal HTTP routes with constant-time Bearer auth and Cache-Control: no-store", async () => {
    const svc = createExpertGatewayAuthorizationService();
    const lease = await svc.issueLease({
      runId: "run-http",
      runGeneration: 1,
      agentId: "agent-http",
      companyId: "co-1",
      userId: "u-1",
      allowedModels: ["gpt-5.4"],
      resolveUpstreamHeaders: () => ({ Authorization: "Bearer http-upstream-key" }),
    });

    const app = express();
    app.use(express.json());
    app.use(
      expertGatewayAuthzRoutes({
        service: svc,
        internalToken: "internal-proxy-secret-token",
      }),
    );

    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // Missing internal bearer -> 401
      const unauth = await fetch(`${baseUrl}${GATEWAY_AUTHORIZE_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: "run-http",
          runGeneration: 1,
          agentId: "agent-http",
          requestedModel: "gpt-5.4",
          wireApi: "responses",
          clientRequestId: "req-1",
        }),
      });
      expect(unauth.status).toBe(401);
      expect(unauth.headers.get("cache-control")).toBe("no-store");

      // Valid internal bearer + session token -> 200 allow
      const allowed = await fetch(`${baseUrl}${GATEWAY_AUTHORIZE_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer internal-proxy-secret-token",
          "X-Delegra-Session-Token": lease.sessionToken,
        },
        body: JSON.stringify({
          runId: "run-http",
          runGeneration: 1,
          agentId: "agent-http",
          requestedModel: "gpt-5.4",
          wireApi: "responses",
          clientRequestId: "req-2",
        }),
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("cache-control")).toBe("no-store");
      const allowBody = (await allowed.json()) as { decision: string; upstream: { headers: Record<string, string> } };
      expect(allowBody.decision).toBe("allow");
      expect(allowBody.upstream.headers.Authorization).toBe("Bearer http-upstream-key");

      // Reconcile endpoint returns active leases
      const rec = await fetch(`${baseUrl}${GATEWAY_RECONCILE_PATH}`, {
        headers: { Authorization: "Bearer internal-proxy-secret-token" },
      });
      expect(rec.status).toBe(200);
      const recBody = (await rec.json()) as { leases: Array<{ runId: string }> };
      expect(recBody.leases.map((l) => l.runId)).toEqual(["run-http"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
