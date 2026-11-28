import { describe, expect, it } from "vitest";
import {
  createEmployeeExpertsService,
  EmployeeExpertsError,
  type EmployeeCredentialContext,
  type EmployeeExpertRecord,
  type ExpertAcceptingState,
} from "../services/employee-experts.js";
import {
  createInMemoryEmployeeExpertsStore,
  mintAuthContinuityDigest,
} from "../services/employee-experts-store.js";

const VALID_CRED: EmployeeCredentialContext = {
  instanceId: "delegra-prod-cn-01",
  orgId: "org_01",
  issuer: "https://iam.corp.example",
  subject: "emp_10086",
  verifiedAt: "2026-11-25T08:00:00Z",
  validUntil: "2026-11-25T08:05:00Z",
  activeOrgIds: ["org_01"],
};

describe("Delegra #98: atomic persistence, fault injection, authContinuityDigest, and followup re-verification", () => {
  it("rolls back cleanly on pre-commit transaction failure leaving zero dangling tasks, receipts, or dispatch intents", async () => {
    const store = createInMemoryEmployeeExpertsStore();
    let shouldFailBeforeCommit = true;

    const svc = createEmployeeExpertsService({
      store,
      verifyCredential: () => VALID_CRED,
      listOrgExperts: async () => ({
        catalogVersion: "cv_1",
        completeness: "complete",
        items: [
          {
            expertId: "exp_1",
            displayName: "财务分析专家",
            disambiguation: null,
            summary: {
              disclosureState: "available",
              responsibility: "报表解读",
              capabilities: ["报表解读"],
              toolScope: ["bi:read"],
              updatedAt: "2026-11-25T00:00:00Z",
            },
            access: {
              readable: true,
              callableInOrg: true,
              callableReason: "granted",
              authContinuityDigest: "sha256:stable_01",
            },
            availability: { acceptingTasks: "accepting", reason: null },
          },
        ],
      }),
      beforeTaskCommit: async () => {
        if (shouldFailBeforeCommit) {
          throw new Error("simulated DB transaction rollback");
        }
      },
      now: () => Date.parse("2026-11-25T08:01:00Z"),
    });

    await expect(
      svc.createTask({
        bearerToken: "tok",
        orgId: "org_01",
        expertId: "exp_1",
        delegationScope: "project:proj_A",
        requestId: "req_rollback_01",
        taskText: "Analyze Q4 margin",
        payloadDigest: "sha256:aaa",
      }),
    ).rejects.toThrow("simulated DB transaction rollback");

    // Zero dangling rows after rollback
    expect(await store.listAllTasks()).toHaveLength(0);
    expect(await store.listDispatchIntents()).toHaveLength(0);
    expect(
      await store.findIdempotencyReceipt({
        orgId: "org_01",
        issuer: VALID_CRED.issuer,
        subject: VALID_CRED.subject,
        op: "create_task",
        requestId: "req_rollback_01",
      }),
    ).toBeNull();

    // Retry with same requestId succeeds cleanly once DB recovers
    shouldFailBeforeCommit = false;
    const ok = await svc.createTask({
      bearerToken: "tok",
      orgId: "org_01",
      expertId: "exp_1",
      delegationScope: "project:proj_A",
      requestId: "req_rollback_01",
      taskText: "Analyze Q4 margin",
      payloadDigest: "sha256:aaa",
    });
    expect(ok.httpStatus).toBe(201);
    expect(await store.listAllTasks()).toHaveLength(1);
    expect(await store.listDispatchIntents()).toHaveLength(1);
  });

  it("reconciles cleanly via by-request after post-commit lost receipt (503 EXPERT_ACCEPTANCE_UNKNOWN) and enforces at-most-once dispatch", async () => {
    const store = createInMemoryEmployeeExpertsStore();
    const svc = createEmployeeExpertsService({
      store,
      verifyCredential: () => VALID_CRED,
      listOrgExperts: async () => ({
        catalogVersion: "cv_1",
        completeness: "complete",
        items: [
          {
            expertId: "exp_1",
            displayName: "财务分析专家",
            disambiguation: null,
            summary: {
              disclosureState: "available",
              responsibility: "报表解读",
              capabilities: ["报表解读"],
              toolScope: [],
              updatedAt: "2026-11-25T00:00:00Z",
            },
            access: {
              readable: true,
              callableInOrg: true,
              callableReason: "granted",
              authContinuityDigest: "sha256:stable_01",
            },
            availability: { acceptingTasks: "accepting", reason: null },
          },
        ],
      }),
      onTaskAccepted: async () => {
        throw new Error("simulated post-commit network drop");
      },
      now: () => Date.parse("2026-11-25T08:01:00Z"),
    });

    await expect(
      svc.createTask({
        bearerToken: "tok",
        orgId: "org_01",
        expertId: "exp_1",
        delegationScope: "project:proj_A",
        requestId: "req_lost_receipt",
        taskText: "Reconcile me",
        payloadDigest: "sha256:bbb",
      }),
    ).rejects.toMatchObject({ code: "EXPERT_ACCEPTANCE_UNKNOWN", status: 503 });

    // Reconcile via by-request returns the committed task
    const reconciled = await svc.getTaskByRequest({
      bearerToken: "tok",
      orgId: "org_01",
      requestId: "req_lost_receipt",
    });
    expect(reconciled.requestId).toBe("req_lost_receipt");
    expect(reconciled.status).toBe("accepted");

    // Replaying with same key + same digest returns 200 idempotentReplay without creating a 2nd dispatch intent
    const replay = await svc.createTask({
      bearerToken: "tok",
      orgId: "org_01",
      expertId: "exp_1",
      delegationScope: "project:proj_A",
      requestId: "req_lost_receipt",
      taskText: "Reconcile me",
      payloadDigest: "sha256:bbb",
    });
    expect(replay.httpStatus).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.taskId).toBe(reconciled.taskId);
    expect(await store.listDispatchIntents(reconciled.taskId)).toHaveLength(1);

    // Same key + different digest returns 409 EXPERT_IDEMPOTENCY_CONFLICT
    await expect(
      svc.createTask({
        bearerToken: "tok",
        orgId: "org_01",
        expertId: "exp_1",
        delegationScope: "project:proj_A",
        requestId: "req_lost_receipt",
        taskText: "Tampered body",
        payloadDigest: "sha256:different",
      }),
    ).rejects.toMatchObject({ code: "EXPERT_IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("rejects revoked employee or paused expert BEFORE createFollowup enqueues a dispatch intent", async () => {
    const store = createInMemoryEmployeeExpertsStore();
    let callableInOrg = true;
    let acceptingTasks: ExpertAcceptingState = "accepting";

    const svc = createEmployeeExpertsService({
      store,
      verifyCredential: () => VALID_CRED,
      listOrgExperts: async () => ({
        catalogVersion: "cv_1",
        completeness: "complete",
        items: [
          {
            expertId: "exp_1",
            displayName: "财务分析专家",
            disambiguation: null,
            summary: {
              disclosureState: "available",
              responsibility: "报表解读",
              capabilities: [],
              toolScope: [],
              updatedAt: "2026-11-25T00:00:00Z",
            },
            access: {
              readable: true,
              callableInOrg,
              callableReason: callableInOrg ? "granted" : "revoked",
              authContinuityDigest: callableInOrg ? "sha256:stable_01" : null,
            },
            availability: { acceptingTasks, reason: acceptingTasks === "paused" ? "maintenance" : null },
          } satisfies EmployeeExpertRecord,
        ],
      }),
      now: () => Date.parse("2026-11-25T08:01:00Z"),
    });

    const created = await svc.createTask({
      bearerToken: "tok",
      orgId: "org_01",
      expertId: "exp_1",
      delegationScope: "project:proj_A",
      requestId: "req_fu_base",
      taskText: "Initial task",
      payloadDigest: "sha256:init",
    });
    expect(await store.listDispatchIntents(created.body.taskId)).toHaveLength(1);

    // Pause expert -> followup must be rejected with 409 EXPERT_NOT_ACCEPTING and zero new dispatch intent
    acceptingTasks = "paused";
    await expect(
      svc.createFollowup({
        bearerToken: "tok",
        orgId: "org_01",
        taskId: created.body.taskId,
        requestId: "fu_paused",
        taskText: "Follow up while paused",
        payloadDigest: "sha256:fu1",
      }),
    ).rejects.toMatchObject({ code: "EXPERT_NOT_ACCEPTING", status: 409 });
    expect(await store.listDispatchIntents(created.body.taskId)).toHaveLength(1);

    // Unpause expert, revoke employee -> followup must be rejected with 403 EXPERT_CALL_FORBIDDEN
    acceptingTasks = "accepting";
    callableInOrg = false;
    await expect(
      svc.createFollowup({
        bearerToken: "tok",
        orgId: "org_01",
        taskId: created.body.taskId,
        requestId: "fu_revoked",
        taskText: "Follow up while revoked",
        payloadDigest: "sha256:fu2",
      }),
    ).rejects.toMatchObject({ code: "EXPERT_CALL_FORBIDDEN", status: 403 });
    expect(await store.listDispatchIntents(created.body.taskId)).toHaveLength(1);
  });

  it("rotates authContinuityDigest to a non-reusable value across epochs", () => {
    const d1 = mintAuthContinuityDigest({
      orgId: "org_01",
      issuer: "https://iam.corp.example",
      subject: "emp_10086",
      expertId: "exp_1",
      epoch: 1,
    });
    const d2 = mintAuthContinuityDigest({
      orgId: "org_01",
      issuer: "https://iam.corp.example",
      subject: "emp_10086",
      expertId: "exp_1",
      epoch: 2,
    });
    expect(d1).toMatch(/^sha256:[a-f0-9]{32}$/);
    expect(d2).toMatch(/^sha256:[a-f0-9]{32}$/);
    expect(d1).not.toBe(d2);
  });
});
