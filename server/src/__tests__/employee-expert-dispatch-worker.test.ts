import { describe, expect, it, vi } from "vitest";
import {
  createEmployeeExpertsService,
  EmployeeExpertsError,
  type EmployeeCredentialContext,
} from "../services/employee-experts.js";
import { createInMemoryEmployeeExpertsStore } from "../services/employee-experts-store.js";
import { deriveExpertNativeIssueUuidV5 } from "../services/employee-expert-isolation.js";
import { createEmployeeExpertDispatchWorker } from "../services/employee-expert-dispatch-worker.js";

const ISSUER = "https://iam.corp.example";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const EXPERT_ID = "22222222-2222-4222-8222-222222222222";

const VALID_CRED: EmployeeCredentialContext = {
  instanceId: "inst_b3",
  orgId: ORG_ID,
  issuer: ISSUER,
  subject: "emp_alice",
  verifiedAt: "2026-11-28T08:00:00Z",
  validUntil: "2026-11-28T09:00:00Z",
  activeOrgIds: [ORG_ID],
};

function makeService(store = createInMemoryEmployeeExpertsStore(), now = () => Date.parse("2026-11-28T08:05:00Z")) {
  return createEmployeeExpertsService({
    store,
    verifyCredential: (tok) => (tok === "tok_alice" ? VALID_CRED : null),
    listOrgExperts: async () => ({
      catalogVersion: "cv_b3",
      completeness: "complete",
      items: [
        {
          expertId: EXPERT_ID,
          displayName: "Java Architect",
          disambiguation: null,
          summary: {
            disclosureState: "available",
            responsibility: "Java architecture",
            capabilities: ["java"],
            toolScope: ["read"],
            updatedAt: "2026-11-28T08:00:00Z",
          },
          access: {
            readable: true,
            callableInOrg: true,
            callableReason: "granted",
            authContinuityDigest: "sha256:digest_1",
          },
          availability: { acceptingTasks: "accepting", reason: null },
        },
      ],
    }),
    checkSessionScope: async () => ({
      scopeVerified: true,
      results: [
        {
          expertId: EXPERT_ID,
          callableInScope: true,
          callableReason: "granted",
          acceptingTasks: "accepting",
          authContinuityDigest: "sha256:digest_1",
        },
      ],
    }),
    authorizeReuseRef: async (refId) => ({
      allowed: true,
      sourceAttribution: `doc:${refId}`,
      contentSnapshot: `snapshot-content-for-${refId}`,
    }),
    isIsolationVerified: () => true,
    now,
  });
}

describe("Delegra #101 Stage B3-1: Dispatch Intent Worker, lease heartbeat, and followup snapshots", () => {
  it("derives a deterministic RFC 4122 UUIDv5 native_issue_id scoped to (orgId, taskId)", () => {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const a1 = deriveExpertNativeIssueUuidV5(ORG_ID, "task_abc123");
    const a2 = deriveExpertNativeIssueUuidV5(ORG_ID, "task_abc123");
    const b = deriveExpertNativeIssueUuidV5(ORG_ID, "task_xyz789");

    expect(a1).toMatch(uuidRe);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("freezes reuseRefSnapshots and rotated executionContext into followup dispatch intent payload", async () => {
    const store = createInMemoryEmployeeExpertsStore();
    const svc = makeService(store);

    const created = await svc.createTask({
      bearerToken: "tok_alice",
      orgId: ORG_ID,
      expertId: EXPERT_ID,
      delegationScope: `org:${ORG_ID}`,
      requestId: "req_init_1",
      taskText: "Review service A",
      payloadDigest: "sha256:init_1",
      reuseRefs: ["ref_1"],
    });

    await svc.createFollowup({
      bearerToken: "tok_alice",
      orgId: ORG_ID,
      taskId: created.body.taskId,
      requestId: "req_fu_1",
      taskText: "Also check service B",
      payloadDigest: "sha256:fu_1",
      reuseRefs: ["ref_2"],
    });

    const intents = await store.listDispatchIntents(created.body.taskId);
    const followup = intents.find((i) => i.kind === "followup");
    expect(followup).toBeDefined();
    expect(followup?.runGeneration).toBe(2);
    expect(followup?.payload.reuseRefSnapshots).toEqual([
      {
        refId: "ref_2",
        readOnly: true,
        sourceAttribution: "doc:ref_2",
        contentSnapshot: "snapshot-content-for-ref_2",
      },
    ]);
    expect(followup?.payload.executionContext).toMatchObject({
      taskId: created.body.taskId,
      runGeneration: 2,
      neverReturnToPool: true,
      shareAgentChatThread: false,
    });
    expect(String((followup?.payload.executionContext as { sandboxClaimName: string }).sandboxClaimName)).toMatch(
      /-g2$/,
    );
  });

  it("prevents concurrent double-claiming and supports lease heartbeat renewal and expiry reclaim", async () => {
    let clockMs = Date.parse("2026-11-28T08:05:00Z");
    const now = () => clockMs;
    const store = createInMemoryEmployeeExpertsStore();
    const svc = makeService(store, now);

    const created = await svc.createTask({
      bearerToken: "tok_alice",
      orgId: ORG_ID,
      expertId: EXPERT_ID,
      delegationScope: `org:${ORG_ID}`,
      requestId: "req_lease_1",
      taskText: "Run long build",
      payloadDigest: "sha256:lease_1",
    });

    const claimA = await store.claimNextDispatchIntents({
      workerId: "worker-A",
      leaseDurationMs: 90_000,
      now,
    });
    expect(claimA.claimed).toHaveLength(1);

    // Concurrent worker B sees 0 claimable intents while worker A holds a valid lease.
    const claimB1 = await store.claimNextDispatchIntents({
      workerId: "worker-B",
      leaseDurationMs: 90_000,
      now,
    });
    expect(claimB1.claimed).toHaveLength(0);

    // Advance 60s and renew worker A's lease (+90s -> expires at +150s).
    clockMs += 60_000;
    const renewed = await store.renewDispatchIntentLease({
      taskId: created.body.taskId,
      runGeneration: 1,
      kind: "initial",
      workerId: "worker-A",
      leaseDurationMs: 90_000,
      now,
    });
    expect(renewed).toBe(true);

    // At +100s (past original 90s, but inside renewed 150s), worker B still cannot steal the lease.
    clockMs += 40_000;
    const claimB2 = await store.claimNextDispatchIntents({
      workerId: "worker-B",
      leaseDurationMs: 90_000,
      now,
    });
    expect(claimB2.claimed).toHaveLength(0);

    // Once worker A crashes and fails to renew past +150s, worker B reclaims cleanly.
    clockMs += 60_000;
    const claimB3 = await store.claimNextDispatchIntents({
      workerId: "worker-B",
      leaseDurationMs: 90_000,
      now,
    });
    expect(claimB3.claimed).toHaveLength(1);
    expect((claimB3.claimed[0]!.payload._dispatchMeta as { leaseOwner: string }).leaseOwner).toBe("worker-B");
  });

  it("enforces exponential backoff and converges poison-pill intents to terminal failed after maxAttempts", async () => {
    let clockMs = Date.parse("2026-11-28T08:05:00Z");
    const now = () => clockMs;
    const store = createInMemoryEmployeeExpertsStore();
    const svc = makeService(store, now);

    const created = await svc.createTask({
      bearerToken: "tok_alice",
      orgId: ORG_ID,
      expertId: EXPERT_ID,
      delegationScope: `org:${ORG_ID}`,
      requestId: "req_poison_1",
      taskText: "Flaky runner",
      payloadDigest: "sha256:poison_1",
    });

    const worker = createEmployeeExpertDispatchWorker({
      store,
      workerId: "worker-poison",
      maxAttempts: 2,
      backoffBaseMs: 5_000,
      isIsolationVerified: () => true,
      dispatchRun: async () => {
        throw new EmployeeExpertsError("EXPERT_ACCEPTANCE_UNKNOWN", "Transient runner outage", { retryable: true });
      },
      now,
    });

    // Attempt 1 fails transiently -> requeued with 5s backoff.
    const r1 = await worker.pollOnce();
    expect(r1).toMatchObject({ claimed: 1, requeued: 1, failed: 0 });

    // Before backoff elapses -> not re-claimed.
    clockMs += 2_000;
    const rEarly = await worker.pollOnce();
    expect(rEarly.claimed).toBe(0);

    // After backoff elapses -> Attempt 2 hits maxAttempts=2 -> terminal failed.
    clockMs += 5_000;
    const r2 = await worker.pollOnce();
    expect(r2).toMatchObject({ claimed: 1, failed: 1, requeued: 0 });

    const task = await store.findTaskById(created.body.taskId);
    expect(task?.status).toBe("failed");
  });

  it("short-circuits cancel intents without invoking dispatchRun and discards stale runGeneration intents", async () => {
    const store = createInMemoryEmployeeExpertsStore();
    const svc = makeService(store);

    const created = await svc.createTask({
      bearerToken: "tok_alice",
      orgId: ORG_ID,
      expertId: EXPERT_ID,
      delegationScope: `org:${ORG_ID}`,
      requestId: "req_cancel_1",
      taskText: "Cancel me",
      payloadDigest: "sha256:cancel_1",
    });

    await svc.cancelTask({
      bearerToken: "tok_alice",
      orgId: ORG_ID,
      taskId: created.body.taskId,
    });

    const dispatchRun = vi.fn(async () => ({ runId: "run_should_not_start" }));
    const onCancelRun = vi.fn(async () => undefined);

    const worker = createEmployeeExpertDispatchWorker({
      store,
      workerId: "worker-cancel",
      isIsolationVerified: () => true,
      dispatchRun,
      onCancelRun,
    });

    const res = await worker.pollOnce();
    expect(dispatchRun).not.toHaveBeenCalled();
    expect(onCancelRun).toHaveBeenCalledTimes(1);
    expect(res.completed).toBe(1);
    expect(res.failed).toBe(1); // initial intent discarded because cancelRequested=true

    const task = await store.findTaskById(created.body.taskId);
    expect(task?.status).toBe("cancelled");
  });
});
