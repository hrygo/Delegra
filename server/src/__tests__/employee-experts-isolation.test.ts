import { describe, expect, it } from "vitest";
import {
  assertRunGenerationFence,
  buildIsolatedEmployeeTaskExecutionContext,
  createRuntimeIsolationProbe,
  type IsolatedEmployeeTaskExecutionContext,
  type ReadOnlyReuseRefSnapshot,
} from "../services/employee-expert-isolation.js";
import {
  createEmployeeExpertsService,
  type EmployeeCredentialContext,
} from "../services/employee-experts.js";
import { createInMemoryEmployeeExpertsStore } from "../services/employee-experts-store.js";

const CRED: EmployeeCredentialContext = {
  instanceId: "delegra-prod-cn-01",
  orgId: "org_01",
  issuer: "https://iam.corp.example",
  subject: "emp_10086",
  verifiedAt: "2026-11-25T08:00:00Z",
  validUntil: "2026-11-25T08:05:00Z",
  activeOrgIds: ["org_01"],
};

describe("Delegra #96: per-task runner isolation, runGeneration fencing, read-only reuseRefs, and 503 fail-closed probe (CORP-DSH-EXPERT-001 §6.2)", () => {
  function buildService(opts?: {
    isolationVerified?: boolean;
    allowedRefs?: Record<string, { sourceAttribution: string; contentSnapshot: string }>;
  }) {
    const store = createInMemoryEmployeeExpertsStore();
    const allowedRefs = opts?.allowedRefs ?? {
      "ref_doc_allowed": {
        sourceAttribution: "doc:Q4-Finance-Summary",
        contentSnapshot: "Q4 revenue grew 18% YoY.",
      },
    };
    const svc = createEmployeeExpertsService({
      store,
      verifyCredential: () => CRED,
      listOrgExperts: async () => ({
        catalogVersion: "cv_1",
        completeness: "complete",
        items: [
          {
            expertId: "exp_fin_01",
            displayName: "财务分析专家",
            disambiguation: null,
            summary: { disclosureState: "available", responsibility: null, capabilities: [], toolScope: [], updatedAt: null },
            access: { readable: true, callableInOrg: true, callableReason: "granted", authContinuityDigest: "sha256:1" },
            availability: { acceptingTasks: "accepting", reason: null },
          },
        ],
      }),
      isIsolationVerified: () => opts?.isolationVerified ?? true,
      authorizeReuseRef: async (refId) => {
        const entry = allowedRefs[refId];
        return entry ? { allowed: true, ...entry } : { allowed: false };
      },
      now: () => Date.parse("2026-11-25T08:01:00Z"),
    });
    return { svc, store };
  }

  it("isolates two concurrent DSH sessions from the same employee calling the same expert with zero shared thread, workspace, tool cache, or sandbox claim", async () => {
    const { svc, store } = buildService();

    const [t1, t2] = await Promise.all([
      svc.createTask({
        bearerToken: "tok",
        orgId: "org_01",
        expertId: "exp_fin_01",
        delegationScope: "project:proj_A",
        originSessionRef: "dsh_session_alpha",
        requestId: "req_sess_1",
        taskText: "Session Alpha analysis",
        payloadDigest: "sha256:alpha",
      }),
      svc.createTask({
        bearerToken: "tok",
        orgId: "org_01",
        expertId: "exp_fin_01",
        delegationScope: "project:proj_A",
        originSessionRef: "dsh_session_beta",
        requestId: "req_sess_2",
        taskText: "Session Beta analysis",
        payloadDigest: "sha256:beta",
      }),
    ]);

    expect(t1.body.taskId).not.toBe(t2.body.taskId);

    const [intent1] = await store.listDispatchIntents(t1.body.taskId);
    const [intent2] = await store.listDispatchIntents(t2.body.taskId);
    const ctx1 = intent1!.payload.executionContext as IsolatedEmployeeTaskExecutionContext;
    const ctx2 = intent2!.payload.executionContext as IsolatedEmployeeTaskExecutionContext;

    expect(ctx1.shareAgentChatThread).toBe(false);
    expect(ctx2.shareAgentChatThread).toBe(false);
    expect(ctx1.neverReturnToPool).toBe(true);
    expect(ctx2.neverReturnToPool).toBe(true);

    // Zero cross-session overlap
    expect(ctx1.threadId).not.toBe(ctx2.threadId);
    expect(ctx1.workspaceId).not.toBe(ctx2.workspaceId);
    expect(ctx1.toolCacheNamespace).not.toBe(ctx2.toolCacheNamespace);
    expect(ctx1.sandboxClaimName).not.toBe(ctx2.sandboxClaimName);
  });

  it("reuses the same task context serially on followups while incrementing runGeneration and rejecting stale generations", async () => {
    const { svc } = buildService();
    const created = await svc.createTask({
      bearerToken: "tok",
      orgId: "org_01",
      expertId: "exp_fin_01",
      delegationScope: "project:proj_A",
      requestId: "req_gen_1",
      taskText: "Initial",
      payloadDigest: "sha256:g1",
    });

    const ctxGen1 = buildIsolatedEmployeeTaskExecutionContext({
      taskId: created.body.taskId,
      runGeneration: 1,
    });

    const fu = await svc.createFollowup({
      bearerToken: "tok",
      orgId: "org_01",
      taskId: created.body.taskId,
      requestId: "fu_gen_2",
      taskText: "Follow up question",
      payloadDigest: "sha256:g2",
    });
    expect(fu.body.runGeneration).toBe(2);

    const ctxGen2 = buildIsolatedEmployeeTaskExecutionContext({
      taskId: created.body.taskId,
      runGeneration: fu.body.runGeneration,
    });
    expect(ctxGen2.threadId).toBe(ctxGen1.threadId);
    expect(ctxGen2.workspaceId).toBe(ctxGen1.workspaceId);
    expect(ctxGen2.sandboxClaimName).not.toBe(ctxGen1.sandboxClaimName);

    // Stale generation 1 callback rejected by generation fence
    expect(() => assertRunGenerationFence(2, 1)).toThrow(/Stale runGeneration/);
    expect(() =>
      svc.publishTaskResult({
        taskId: created.body.taskId,
        runId: "run_stale_1",
        runGeneration: 1,
        status: "completed",
        result: { answer: "stale" },
      }),
    ).toThrow(/Stale runGeneration/);
  });

  it("rejects unauthorized reuseRefs before task creation and imports authorized reuseRefs as frozen read-only snapshots", async () => {
    const { svc, store } = buildService();

    // Unauthorized reuseRef rejected fail-closed with zero task created
    await expect(
      svc.createTask({
        bearerToken: "tok",
        orgId: "org_01",
        expertId: "exp_fin_01",
        delegationScope: "project:proj_A",
        requestId: "req_bad_ref",
        taskText: "Use secret doc",
        payloadDigest: "sha256:badref",
        reuseRefs: ["ref_secret_other_team"],
      }),
    ).rejects.toMatchObject({ code: "EXPERT_CALL_FORBIDDEN", status: 403 });
    expect(await store.listAllTasks()).toHaveLength(0);

    // Authorized reuseRef imported as frozen read-only snapshot with attribution
    const ok = await svc.createTask({
      bearerToken: "tok",
      orgId: "org_01",
      expertId: "exp_fin_01",
      delegationScope: "project:proj_A",
      requestId: "req_good_ref",
      taskText: "Summarize Q4 doc",
      payloadDigest: "sha256:goodref",
      reuseRefs: ["ref_doc_allowed"],
    });
    expect(ok.httpStatus).toBe(201);
    const [intent] = await store.listDispatchIntents(ok.body.taskId);
    const snapshots = intent!.payload.reuseRefSnapshots as ReadOnlyReuseRefSnapshot[];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({
      refId: "ref_doc_allowed",
      readOnly: true,
      sourceAttribution: "doc:Q4-Finance-Summary",
      contentSnapshot: "Q4 revenue grew 18% YoY.",
    });
    expect(Object.isFrozen(snapshots[0])).toBe(true);
  });

  it("fails closed with 503 EXPERT_ISOLATION_UNVERIFIED and creates zero tasks when runner isolation cannot be verified", async () => {
    const { svc, store } = buildService({ isolationVerified: false });

    await expect(
      svc.createTask({
        bearerToken: "tok",
        orgId: "org_01",
        expertId: "exp_fin_01",
        delegationScope: "project:proj_A",
        requestId: "req_unverified",
        taskText: "Should not run",
        payloadDigest: "sha256:unv",
      }),
    ).rejects.toMatchObject({ code: "EXPERT_ISOLATION_UNVERIFIED", status: 503 });

    expect(await store.listAllTasks()).toHaveLength(0);
    expect(await store.listDispatchIntents()).toHaveLength(0);

    // Runtime probe defaults to fail-closed when env and K8s probe are unset
    expect(createRuntimeIsolationProbe({ env: {} })()).toBe(false);
    expect(createRuntimeIsolationProbe({ env: { DELEGRA_EXPERT_ISOLATION_VERIFIED: "true" } })()).toBe(true);
    expect(createRuntimeIsolationProbe({ env: { DELEGRA_EXPERT_ISOLATION_VERIFIED: "false" } })()).toBe(false);
  });
});
