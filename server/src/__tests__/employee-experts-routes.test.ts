import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { employeeExpertsRoutes } from "../routes/employee-experts.js";
import {
  createEmployeeExpertsService,
  filterVisibleEmployeeTasks,
  type EmployeeCredentialContext,
  type EmployeeExpertRecord,
} from "../services/employee-experts.js";

const FIXED_NOW = Date.parse("2026-11-24T00:00:00.000Z");

const ALICE_CRED: EmployeeCredentialContext = {
  instanceId: "delegra-prod-cn-01",
  orgId: "org_01",
  issuer: "https://iam.corp.example",
  subject: "emp_alice",
  verifiedAt: "2026-11-24T00:00:00.000Z",
  validUntil: "2026-11-24T00:05:00.000Z",
  activeOrgIds: ["org_01"],
};

const BOB_CRED: EmployeeCredentialContext = {
  ...ALICE_CRED,
  subject: "emp_bob",
};

const AUDITOR_CRED: EmployeeCredentialContext = {
  ...ALICE_CRED,
  subject: "emp_auditor",
  auditAuthorized: true,
};

function makeSampleExperts(callableAlice = true): EmployeeExpertRecord[] {
  return [
    {
      expertId: "exp_finance",
      displayName: "经营分析专家",
      disambiguation: "财务分析组",
      summary: {
        disclosureState: "available",
        responsibility: "月度经营报表分析",
        capabilities: ["经营指标拆解"],
        toolScope: ["bi-report:read"],
        updatedAt: "2026-11-23T08:00:00.000Z",
      },
      access: {
        readable: true,
        callableInOrg: callableAlice,
        callableReason: callableAlice ? "granted" : "revoked",
        authContinuityDigest: callableAlice ? "sha256:digest_1" : null,
      },
      availability: { acceptingTasks: "accepting", reason: null },
    },
    {
      expertId: "exp_paused",
      displayName: "法务审查专家",
      disambiguation: "合规组",
      summary: {
        disclosureState: "available",
        responsibility: "合同审查",
        capabilities: ["条款核验"],
        toolScope: [],
        updatedAt: "2026-11-23T08:00:00.000Z",
      },
      access: {
        readable: true,
        callableInOrg: true,
        callableReason: "granted",
        authContinuityDigest: "sha256:digest_2",
      },
      availability: { acceptingTasks: "paused", reason: "maintenance" },
    },
    {
      expertId: "exp_view_only",
      displayName: "只读架构专家",
      disambiguation: "平台组",
      summary: {
        disclosureState: "restricted",
        responsibility: null,
        capabilities: [],
        toolScope: [],
        updatedAt: null,
      },
      access: {
        readable: true,
        callableInOrg: false,
        callableReason: "view_only",
        authContinuityDigest: null,
      },
      availability: { acceptingTasks: "accepting", reason: null },
    },
  ];
}

async function startTestServer(service: ReturnType<typeof createEmployeeExpertsService>) {
  const app = express();
  app.use(express.json());
  app.use(employeeExpertsRoutes({ service }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("employeeExpertsRoutes (CORP-DSH-EXPERT-001)", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop();
      if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it("enforces fail-closed auth order (401 invalid, 401 revoked, 403 org forbidden, 403 scope mismatch)", async () => {
    const svc = createEmployeeExpertsService({
      now: () => FIXED_NOW,
      verifyCredential: (token) => {
        if (token === "tok-alice") return ALICE_CRED;
        if (token === "tok-revoked") return { ...ALICE_CRED, revoked: true };
        if (token === "tok-expired") return { ...ALICE_CRED, validUntil: "2026-11-23T23:59:59.000Z" };
        if (token === "tok-multi") return { ...ALICE_CRED, activeOrgIds: ["org_01", "org_02"] };
        return null;
      },
      listOrgExperts: async () => ({ catalogVersion: "cv_1", items: makeSampleExperts() }),
    });
    const { server, baseUrl } = await startTestServer(svc);
    servers.push(server);

    const noAuth = await fetch(`${baseUrl}/api/v1/employee/experts?orgId=org_01&view=directory`);
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("cache-control")).toBe("no-store");
    expect((await noAuth.json()).error.code).toBe("EXPERT_AUTH_INVALID");

    const revoked = await fetch(`${baseUrl}/api/v1/employee/experts?orgId=org_01&view=directory`, {
      headers: { authorization: "Bearer tok-revoked" },
    });
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).error.code).toBe("EXPERT_AUTH_REVOKED");

    const expired = await fetch(`${baseUrl}/api/v1/employee/experts?orgId=org_01&view=directory`, {
      headers: { authorization: "Bearer tok-expired" },
    });
    expect(expired.status).toBe(401);
    expect((await expired.json()).error.code).toBe("EXPERT_AUTH_REVOKED");

    const orgForbidden = await fetch(`${baseUrl}/api/v1/employee/experts?orgId=org_other&view=directory`, {
      headers: { authorization: "Bearer tok-alice" },
    });
    expect(orgForbidden.status).toBe(403);
    expect((await orgForbidden.json()).error.code).toBe("EXPERT_ORG_FORBIDDEN");

    const scopeMismatch = await fetch(`${baseUrl}/api/v1/employee/experts?orgId=org_02&view=directory`, {
      headers: { authorization: "Bearer tok-multi" },
    });
    expect(scopeMismatch.status).toBe(403);
    expect((await scopeMismatch.json()).error.code).toBe("EXPERT_SCOPE_MISMATCH");
  });

  it("serves directory/callable pagination with bound cursors and validates session scope-check", async () => {
    let catalogVersion = "cv_1";
    const svc = createEmployeeExpertsService({
      now: () => FIXED_NOW,
      verifyCredential: (token) => (token === "tok-alice" ? ALICE_CRED : token === "tok-bob" ? BOB_CRED : null),
      listOrgExperts: async () => ({ catalogVersion, completeness: "complete", items: makeSampleExperts() }),
      checkSessionScope: async ({ delegationScope, expertIds }) => {
        if (delegationScope === "unverified") return { scopeVerified: false, results: [] };
        return {
          scopeVerified: true,
          results: expertIds.map((id) => ({
            expertId: id,
            callableInScope: delegationScope === "proj_a" && id === "exp_finance",
            callableReason: delegationScope === "proj_a" && id === "exp_finance" ? "granted" : "view_only",
            acceptingTasks: id === "exp_paused" ? "paused" : "accepting",
            authContinuityDigest: id === "exp_finance" ? "sha256:digest_1" : null,
          })),
        };
      },
    });
    const { server, baseUrl } = await startTestServer(svc);
    servers.push(server);

    const p1 = await fetch(`${baseUrl}/api/v1/employee/experts?orgId=org_01&view=directory&limit=2`, {
      headers: { authorization: "Bearer tok-alice" },
    });
    expect(p1.status).toBe(200);
    const body1 = await p1.json();
    expect(body1.scope.subject).toBe("emp_alice");
    expect(body1.items).toHaveLength(2);
    expect(body1.page.hasMore).toBe(true);
    expect(typeof body1.page.nextCursor).toBe("string");

    const p2 = await fetch(
      `${baseUrl}/api/v1/employee/experts?orgId=org_01&view=directory&limit=2&cursor=${encodeURIComponent(body1.page.nextCursor)}`,
      { headers: { authorization: "Bearer tok-alice" } },
    );
    expect(p2.status).toBe(200);
    expect((await p2.json()).items).toHaveLength(1);

    // Cross-account cursor reuse -> 409 EXPERT_CURSOR_STALE
    const crossUser = await fetch(
      `${baseUrl}/api/v1/employee/experts?orgId=org_01&view=directory&limit=2&cursor=${encodeURIComponent(body1.page.nextCursor)}`,
      { headers: { authorization: "Bearer tok-bob" } },
    );
    expect(crossUser.status).toBe(409);
    expect((await crossUser.json()).error.code).toBe("EXPERT_CURSOR_STALE");

    // Version drift invalidates cursor -> 409 EXPERT_CURSOR_STALE
    catalogVersion = "cv_2";
    const staleVersion = await fetch(
      `${baseUrl}/api/v1/employee/experts?orgId=org_01&view=directory&limit=2&cursor=${encodeURIComponent(body1.page.nextCursor)}`,
      { headers: { authorization: "Bearer tok-alice" } },
    );
    expect(staleVersion.status).toBe(409);
    expect((await staleVersion.json()).error.code).toBe("EXPERT_CURSOR_STALE");

    // Scope check valid, unverified, and >100 oversized
    const scOk = await fetch(`${baseUrl}/api/v1/employee/experts/scope-check`, {
      method: "POST",
      headers: { authorization: "Bearer tok-alice", "content-type": "application/json" },
      body: JSON.stringify({ orgId: "org_01", delegationScope: "proj_a", expertIds: ["exp_finance", "exp_paused"] }),
    });
    expect(scOk.status).toBe(200);
    const scBody = await scOk.json();
    expect(scBody.scopeVerified).toBe(true);
    expect(scBody.results[0].callableInScope).toBe(true);
    expect(scBody.results[1].callableInScope).toBe(false);

    const scUnverified = await fetch(`${baseUrl}/api/v1/employee/experts/scope-check`, {
      method: "POST",
      headers: { authorization: "Bearer tok-alice", "content-type": "application/json" },
      body: JSON.stringify({ orgId: "org_01", delegationScope: "unverified", expertIds: ["exp_finance"] }),
    });
    expect(scUnverified.status).toBe(409);
    expect((await scUnverified.json()).error.code).toBe("EXPERT_SCOPE_UNVERIFIED");

    const scTooLarge = await fetch(`${baseUrl}/api/v1/employee/experts/scope-check`, {
      method: "POST",
      headers: { authorization: "Bearer tok-alice", "content-type": "application/json" },
      body: JSON.stringify({
        orgId: "org_01",
        delegationScope: "proj_a",
        expertIds: Array.from({ length: 101 }, (_, i) => `exp_${i}`),
      }),
    });
    expect(scTooLarge.status).toBe(413);
    expect((await scTooLarge.json()).error.code).toBe("EXPERT_REQUEST_TOO_LARGE");
  });

  it("enforces atomic idempotent task creation, revoked replay concealment, private ACL isolation, followups, generation fencing, and cancel", async () => {
    let aliceCallable = true;
    let isolationOk = true;

    const svc = createEmployeeExpertsService({
      now: () => FIXED_NOW,
      verifyCredential: (token) => {
        if (token === "tok-alice") return ALICE_CRED;
        if (token === "tok-bob") return BOB_CRED;
        if (token === "tok-auditor") return AUDITOR_CRED;
        return null;
      },
      listOrgExperts: async () => ({ catalogVersion: "cv_1", items: makeSampleExperts(aliceCallable) }),
      checkSessionScope: async ({ expertIds }) => ({
        scopeVerified: true,
        results: expertIds.map((id) => ({
          expertId: id,
          callableInScope: id === "exp_finance" ? aliceCallable : id === "exp_paused",
          callableReason: id === "exp_finance" && aliceCallable ? "granted" : "view_only",
          acceptingTasks: id === "exp_paused" ? "paused" : "accepting",
          authContinuityDigest: "sha256:digest_1",
        })),
      }),
      isIsolationVerified: () => isolationOk,
    });
    const { server, baseUrl } = await startTestServer(svc);
    servers.push(server);

    // Fail closed when runner isolation is unverified
    isolationOk = false;
    const unverifiedIso = await fetch(`${baseUrl}/api/v1/employee/expert-tasks`, {
      method: "POST",
      headers: { authorization: "Bearer tok-alice", "content-type": "application/json" },
      body: JSON.stringify({
        orgId: "org_01",
        expertId: "exp_finance",
        delegationScope: "proj_a",
        requestId: "req-iso",
        taskText: "test",
        payloadDigest: "sha256:iso",
      }),
    });
    expect(unverifiedIso.status).toBe(503);
    expect((await unverifiedIso.json()).error.code).toBe("EXPERT_ISOLATION_UNVERIFIED");
    isolationOk = true;

    // View-only -> 403 EXPERT_CALL_FORBIDDEN; paused -> 409 EXPERT_NOT_ACCEPTING
    const viewOnly = await fetch(`${baseUrl}/api/v1/employee/expert-tasks`, {
      method: "POST",
      headers: { authorization: "Bearer tok-alice", "content-type": "application/json" },
      body: JSON.stringify({
        orgId: "org_01",
        expertId: "exp_view_only",
        delegationScope: "proj_a",
        requestId: "req-vo",
        taskText: "test",
        payloadDigest: "sha256:vo",
      }),
    });
    expect(viewOnly.status).toBe(403);
    expect((await viewOnly.json()).error.code).toBe("EXPERT_CALL_FORBIDDEN");

    const paused = await fetch(`${baseUrl}/api/v1/employee/expert-tasks`, {
      method: "POST",
      headers: { authorization: "Bearer tok-alice", "content-type": "application/json" },
      body: JSON.stringify({
        orgId: "org_01",
        expertId: "exp_paused",
        delegationScope: "proj_a",
        requestId: "req-paused",
        taskText: "test",
        payloadDigest: "sha256:paused",
      }),
    });
    expect(paused.status).toBe(409);
    expect((await paused.json()).error.code).toBe("EXPERT_NOT_ACCEPTING");

    // Atomic creation (201) + idempotent replay (200) + digest conflict (409)
    const createPayload = {
      orgId: "org_01",
      expertId: "exp_finance",
      delegationScope: "proj_a",
      requestId: "req-001",
      originSessionRef: "dsh-sess-1",
      taskText: "分析 Q4 营收",
      payloadDigest: "sha256:aaa",
    };
    const createdRes = await fetch(`${baseUrl}/api/v1/employee/expert-tasks`, {
      method: "POST",
      headers: { authorization: "Bearer tok-alice", "content-type": "application/json" },
      body: JSON.stringify(createPayload),
    });
    expect(createdRes.status).toBe(201);
    const created = await createdRes.json();
    expect(created.idempotentReplay).toBe(false);
    expect(created.runGeneration).toBe(1);

    const replayRes = await fetch(`${baseUrl}/api/v1/employee/expert-tasks`, {
      method: "POST",
      headers: { authorization: "Bearer tok-alice", "content-type": "application/json" },
      body: JSON.stringify(createPayload),
    });
    expect(replayRes.status).toBe(200);
    const replayed = await replayRes.json();
    expect(replayed.idempotentReplay).toBe(true);
    expect(replayed.taskId).toBe(created.taskId);

    const conflictRes = await fetch(`${baseUrl}/api/v1/employee/expert-tasks`, {
      method: "POST",
      headers: { authorization: "Bearer tok-alice", "content-type": "application/json" },
      body: JSON.stringify({ ...createPayload, payloadDigest: "sha256:bbb" }),
    });
    expect(conflictRes.status).toBe(409);
    expect((await conflictRes.json()).error.code).toBe("EXPERT_IDEMPOTENCY_CONFLICT");

    // Private ACL: Bob in the SAME org gets 404 EXPERT_TASK_NOT_FOUND across all endpoints
    for (const path of [
      `/api/v1/employee/expert-tasks/by-request/req-001?orgId=org_01`,
      `/api/v1/employee/expert-tasks/${created.taskId}?orgId=org_01`,
      `/api/v1/employee/expert-tasks/${created.taskId}/result?orgId=org_01`,
    ]) {
      const denied = await fetch(`${baseUrl}${path}`, { headers: { authorization: "Bearer tok-bob" } });
      expect(denied.status).toBe(404);
      expect((await denied.json()).error.code).toBe("EXPERT_TASK_NOT_FOUND");
    }
    expect(filterVisibleEmployeeTasks(svc.listAllTasksForAclAudit(), BOB_CRED)).toHaveLength(0);
    expect(filterVisibleEmployeeTasks(svc.listAllTasksForAclAudit(), AUDITOR_CRED)).toHaveLength(1);

    // Authorized auditor can inspect result, but Bob cannot
    const auditRes = await fetch(`${baseUrl}/api/v1/employee/expert-tasks/${created.taskId}?orgId=org_01`, {
      headers: { authorization: "Bearer tok-auditor" },
    });
    expect(auditRes.status).toBe(200);

    // Followup increments runGeneration and is idempotent
    const fu1 = await fetch(`${baseUrl}/api/v1/employee/expert-tasks/${created.taskId}/followups`, {
      method: "POST",
      headers: { authorization: "Bearer tok-alice", "content-type": "application/json" },
      body: JSON.stringify({
        orgId: "org_01",
        requestId: "req-fu-1",
        taskText: "补充华东区",
        payloadDigest: "sha256:fu1",
      }),
    });
    expect(fu1.status).toBe(201);
    expect((await fu1.json()).runGeneration).toBe(2);

    // Generation fence rejects stale runGeneration=1 update
    expect(() =>
      svc.publishTaskResult({
        taskId: created.taskId,
        runId: "run_old",
        runGeneration: 1,
        status: "completed",
        result: { stale: true },
      }),
    ).toThrow(/Stale runGeneration/);

    // Current runGeneration=2 completes task; resultVersion increments
    svc.publishTaskResult({
      taskId: created.taskId,
      runId: "run_2",
      runGeneration: 2,
      status: "completed",
      result: { summary: "完成" },
      sources: ["bi:q4"],
    });
    const resRead = await fetch(`${baseUrl}/api/v1/employee/expert-tasks/${created.taskId}/result?orgId=org_01`, {
      headers: { authorization: "Bearer tok-alice" },
    });
    expect(resRead.status).toBe(200);
    const resBody = await resRead.json();
    expect(resBody.resultVersion).toBe(1);
    expect(resBody.status).toBe("completed");

    // Cancel after completion preserves terminal 'completed' state (§7.2)
    const cancelCompleted = await fetch(`${baseUrl}/api/v1/employee/expert-tasks/${created.taskId}/cancel`, {
      method: "POST",
      headers: { authorization: "Bearer tok-alice", "content-type": "application/json" },
      body: JSON.stringify({ orgId: "org_01" }),
    });
    expect(cancelCompleted.status).toBe(200);
    expect((await cancelCompleted.json()).status).toBe("completed");

    // Revoked replay conceals taskId with 404 EXPERT_TASK_NOT_FOUND (§7.1)
    aliceCallable = false;
    const revokedReplay = await fetch(`${baseUrl}/api/v1/employee/expert-tasks`, {
      method: "POST",
      headers: { authorization: "Bearer tok-alice", "content-type": "application/json" },
      body: JSON.stringify(createPayload),
    });
    expect(revokedReplay.status).toBe(404);
    const revokedText = await revokedReplay.text();
    expect(revokedText).toContain("EXPERT_TASK_NOT_FOUND");
    expect(revokedText).not.toContain(created.taskId);
  });
});
