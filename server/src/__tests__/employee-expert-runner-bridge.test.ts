import { describe, expect, it, vi } from "vitest";
import { createEmployeeExpertsService, type EmployeeCredentialContext } from "../services/employee-experts.js";
import { createInMemoryEmployeeExpertsStore } from "../services/employee-experts-store.js";
import { createEmployeeExpertDispatchWorker } from "../services/employee-expert-dispatch-worker.js";
import {
  createEmployeeExpertRunnerBridge,
  type PrivateHeartbeatRunLaunchInput,
} from "../services/employee-expert-runner-bridge.js";
import { DELEGRA_READONLY_REFS_DIR } from "../services/employee-expert-context-assembler.js";
import { deriveExpertNativeIssueUuidV5 } from "../services/employee-expert-isolation.js";
import {
  filterPrivateEmployeeExpertRunsFromRecords,
  isPrivateEmployeeExpertEventVisibleToActor,
  type PrivateEmployeeExpertTaskDescriptor,
} from "../services/employee-expert-acl.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const EXPERT_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_CRED: EmployeeCredentialContext = {
  orgId: ORG_ID,
  instanceId: "inst-1",
  issuer: "https://iam.example.com",
  subject: "emp-alice",
  delegationScope: `org:${ORG_ID}`,
};

describe("Stage B3-3: end-to-end employee expert runner bridge + ACL isolation", () => {
  it("runs full lifecycle: cold_start (with /run/delegra-refs/) -> waiting_user -> followup hot_resume -> session-loss cold_rebuild -> attributed completed envelope + 4-role ACL", async () => {
    const store = createInMemoryEmployeeExpertsStore();
    const launchedRuns: Array<{ runId: string; input: PrivateHeartbeatRunLaunchInput }> = [];
    const cancelledRuns: Array<{ runId: string; reason: string }> = [];
    const revokedGatewayRuns: Array<{ runId: string; reason: string }> = [];
    let sessionParams: Record<string, unknown> | null = null;
    let runCounter = 0;

    const largeDocContent = "K8s WarmPool Benchmark Line.\n".repeat(250); // > 4 KiB
    const service = createEmployeeExpertsService({
      store,
      isIsolationVerified: () => true,
      authorizeReuseRef: (refId) => ({
        allowed: true,
        sourceAttribution: `kb:${refId}`,
        contentSnapshot: refId === "ref-large-spec" ? largeDocContent : "Small inline note",
      }),
      listOrgExperts: async () => ({
        catalogVersion: "cv_1",
        completeness: "complete",
        items: [
          {
            expertId: EXPERT_ID,
            displayName: "K8s Architect",
            disambiguation: null,
            summary: {
              disclosureState: "available",
              responsibility: "Kubernetes scheduling",
              capabilities: ["k8s", "kata"],
              toolScope: ["read_file"],
              updatedAt: "2026-11-28T00:00:00Z",
            },
            access: {
              readable: true,
              callableInOrg: true,
              callableReason: "granted",
              authContinuityDigest: "sha256:abc",
            },
            availability: { acceptingTasks: "accepting", reason: null },
          },
        ],
      }),
      checkSessionScope: async ({ expertIds }) => ({
        scopeVerified: true,
        results: expertIds.map((id) => ({
          expertId: id,
          callableInScope: true,
          callableReason: "granted",
          acceptingTasks: "accepting",
          authContinuityDigest: "sha256:abc",
        })),
      }),
    });

    const bridge = createEmployeeExpertRunnerBridge({
      store,
      loadExpertProfile: async ({ orgId, expertId, delegationScope }) => ({
        adapterType: "paperclip_runner",
        harnessSupportsResume: true,
        profile: {
          orgId,
          expertId,
          expertName: "K8s Architect",
          persona: "You are a Kubernetes scheduling specialist.",
          capabilities: ["k8s", "kata"],
          delegationScope,
        },
      }),
      loadTaskSessionParams: async () => sessionParams,
      launchPrivateHeartbeatRun: async (input) => {
        runCounter += 1;
        const runId = `run_${runCounter}`;
        launchedRuns.push({ runId, input });
        return { runId };
      },
      cancelHeartbeatRun: (runId, reason) => {
        cancelledRuns.push({ runId, reason });
      },
      revokeGatewayRun: (runId, reason) => {
        revokedGatewayRuns.push({ runId, reason });
      },
    });

    const worker = createEmployeeExpertDispatchWorker({
      store,
      isIsolationVerified: () => true,
      dispatchRun: bridge.dispatchRun,
      onCancelRun: bridge.onCancelRun,
    });

    // 1. Initial task creation with both small & large (> 4 KiB) reuseRefs -> cold_start.
    const created = await service.createTaskAsync(OWNER_CRED, {
      requestId: "req-e2e-1",
      expertId: EXPERT_ID,
      taskText: "Evaluate warm-pool latency and Kata-FC overhead.",
      reuseRefs: ["ref-small", "ref-large-spec"],
    });
    const poll1 = await worker.pollOnce();
    expect(poll1.dispatched).toBe(1);
    expect(launchedRuns).toHaveLength(1);

    const launch1 = launchedRuns[0]!;
    const expectedNativeIssueId = deriveExpertNativeIssueUuidV5(ORG_ID, created.taskId);
    expect(launch1.input.scopeKind).toBe("company");
    expect(launch1.input.issueId).toBeNull();
    expect(launch1.input.nativeIssueId).toBe(expectedNativeIssueId);
    expect(launch1.input.contextSnapshot.contextMode).toBe("cold_start");
    expect(launch1.input.contextSnapshot.shareAgentChatThread).toBe(false);
    expect(launch1.input.contextSnapshot.neverReturnToPool).toBe(true);
    expect(launch1.input.contextSnapshot.sandboxClaimName).toContain("-g1");
    expect(launch1.input.contextSnapshot.demotedToIndexRefs).toEqual(["ref-large-spec"]);
    const stagedFiles = launch1.input.contextSnapshot.stagedReadOnlyRefFiles as Array<{
      refId: string;
      readOnlyPath: string;
    }>;
    expect(stagedFiles).toHaveLength(1);
    expect(stagedFiles[0]!.readOnlyPath.startsWith(`${DELEGRA_READONLY_REFS_DIR}/`)).toBe(true);

    // Runner reaches waiting_user -> Layer 5 projection emits waitingUserNotice.
    const waitingTask = await bridge.handleRunTerminalOutcome({
      taskId: created.taskId,
      runId: launch1.runId,
      runGeneration: 1,
      intentKind: "initial",
      outcome: "waiting_user",
      result: { question: "Which cluster tier should we target?" },
    });
    const waitingEnvelope = bridge.projectEnvelope(waitingTask);
    expect(waitingEnvelope.status).toBe("waiting_user");
    expect(waitingEnvelope.rawResultCollapsed).toBe(true);
    expect(waitingEnvelope.synthesizedByMainAssistant).toBe(false);
    expect(waitingEnvelope.waitingUserNotice).toContain("waiting for employee follow-up");

    // 2. Follow-up with live agent_task_sessions -> hot_resume skips L1/L2 & rotates sandboxClaimName (-g2).
    sessionParams = { sessionId: "native-sess-001", provider: "codex" };
    await service.followupTaskAsync(OWNER_CRED, created.taskId, {
      requestId: "req-e2e-2",
      taskText: "Target the Medium ARM64 tenant tier.",
      reuseRefs: ["ref-small"],
    });
    const poll2 = await worker.pollOnce();
    expect(poll2.dispatched).toBe(1);
    expect(launchedRuns).toHaveLength(2);

    const launch2 = launchedRuns[1]!;
    expect(launch2.input.nativeIssueId).toBe(expectedNativeIssueId);
    expect(launch2.input.contextSnapshot.contextMode).toBe("hot_resume");
    expect(launch2.input.contextSnapshot.runGeneration).toBe(2);
    expect(launch2.input.contextSnapshot.sandboxClaimName).toContain("-g2");
    expect(launch2.input.contextSnapshot.resumeSessionParams).toEqual(sessionParams);
    expect(String(launch2.input.contextSnapshot.prompt)).not.toContain("[DELEGRA_EXPERT_STATIC_PREFIX]");

    // Stale generation 1 callback must be rejected by monotonic runGeneration fence.
    await expect(
      bridge.handleRunTerminalOutcome({
        taskId: created.taskId,
        runId: launch1.runId,
        runGeneration: 1,
        intentKind: "initial",
        outcome: "completed",
        result: { stale: true },
      }),
    ).rejects.toThrow(/Stale runGeneration/);

    // 3. Simulated session loss -> next follow-up falls back to deterministic cold_rebuild + fail-closed sources/artifacts.
    sessionParams = null;
    await service.followupTaskAsync(OWNER_CRED, created.taskId, {
      requestId: "req-e2e-3",
      taskText: "Produce the final recommendation.",
    });
    const poll3 = await worker.pollOnce();
    expect(poll3.dispatched).toBe(1);
    const launch3 = launchedRuns[2]!;
    expect(launch3.input.contextSnapshot.contextMode).toBe("cold_rebuild");
    expect(launch3.input.contextSnapshot.runGeneration).toBe(3);
    expect(launch3.input.contextSnapshot.sandboxClaimName).toContain("-g3");
    expect(String(launch3.input.contextSnapshot.prompt)).toContain("[DELEGRA_EXPERT_STATIC_PREFIX]");
    expect(String(launch3.input.contextSnapshot.prompt)).toContain("<delegra_state>");

    const finalTask = await bridge.handleRunTerminalOutcome({
      taskId: created.taskId,
      runId: launch3.runId,
      runGeneration: 3,
      intentKind: "followup",
      outcome: "completed",
      result: { summary: "Use Medium ARM64 WarmPool + Kata-FC for C3/C4." },
      sources: [
        { label: "Authorized KB", url: "https://kb.internal/k8s", authorized: true },
        { label: "Unauthorized Secret Doc", url: "https://secret.internal/x", authorized: false },
      ],
      artifacts: [
        { id: "art-ok", label: "Benchmark CSV", authorized: true },
        { id: "art-denied", label: "Private Dump", authorized: false },
      ],
    });
    const finalEnvelope = bridge.projectEnvelope(finalTask);
    expect(finalEnvelope.status).toBe("completed");
    expect(finalEnvelope.sources).toEqual(["https://kb.internal/k8s"]);
    expect(finalEnvelope.artifacts).toEqual([{ id: "art-ok", label: "Benchmark CSV" }]);
    expect(finalEnvelope.waitingUserNotice).toBeNull();

    // 4. 4-role ACL negative check on the private run & WebSocket event.
    const privateRunRow = {
      id: launch3.runId,
      companyId: ORG_ID,
      contextSnapshot: launch3.input.contextSnapshot,
    };
    const taskDesc: PrivateEmployeeExpertTaskDescriptor = {
      taskId: created.taskId,
      orgId: ORG_ID,
      responsibleUserId: OWNER_CRED.subject,
      visibility: "private",
      originClient: "dsh",
      runId: launch3.runId,
    };
    const byRunId = new Map([[launch3.runId, taskDesc]]);

    // Owner allowed; authorized auditor allowed; same-org colleague & cross-org user see ZERO rows/events.
    expect(
      filterPrivateEmployeeExpertRunsFromRecords([privateRunRow], byRunId, {
        userId: "emp-alice",
        companyId: ORG_ID,
      }),
    ).toHaveLength(1);
    expect(
      filterPrivateEmployeeExpertRunsFromRecords([privateRunRow], byRunId, {
        userId: "auditor-1",
        companyId: ORG_ID,
        auditAuthorized: true,
      }),
    ).toHaveLength(1);
    expect(
      filterPrivateEmployeeExpertRunsFromRecords([privateRunRow], byRunId, {
        userId: "emp-bob-colleague",
        companyId: ORG_ID,
      }),
    ).toHaveLength(0);
    expect(
      filterPrivateEmployeeExpertRunsFromRecords([privateRunRow], byRunId, {
        userId: "emp-alice",
        companyId: "99999999-9999-4999-8999-999999999999",
      }),
    ).toHaveLength(0);

    const wsEvent = { companyId: ORG_ID, type: "heartbeat.run.status", payload: { runId: launch3.runId } };
    expect(isPrivateEmployeeExpertEventVisibleToActor(wsEvent, taskDesc, { userId: "emp-alice", companyId: ORG_ID })).toBe(true);
    expect(isPrivateEmployeeExpertEventVisibleToActor(wsEvent, taskDesc, { userId: "emp-bob-colleague", companyId: ORG_ID })).toBe(false);
    expect(cancelledRuns).toHaveLength(0);
    expect(revokedGatewayRuns).toHaveLength(0);
  });

  it("cancels active heartbeat run and revokes zero-trust gateway proxy lease on cancel intent", async () => {
    const store = createInMemoryEmployeeExpertsStore();
    const cancelHeartbeatRun = vi.fn();
    const revokeGatewayRun = vi.fn();

    const service = createEmployeeExpertsService({
      store,
      isIsolationVerified: () => true,
      listOrgExperts: async () => ({
        catalogVersion: "cv_1",
        completeness: "complete",
        items: [
          {
            expertId: EXPERT_ID,
            displayName: "K8s Architect",
            disambiguation: null,
            summary: { disclosureState: "available", responsibility: null, capabilities: [], toolScope: [], updatedAt: null },
            access: { readable: true, callableInOrg: true, callableReason: "granted", authContinuityDigest: "sha256:1" },
            availability: { acceptingTasks: "accepting", reason: null },
          },
        ],
      }),
      checkSessionScope: async ({ expertIds }) => ({
        scopeVerified: true,
        results: expertIds.map((id) => ({
          expertId: id,
          callableInScope: true,
          callableReason: "granted",
          acceptingTasks: "accepting",
          authContinuityDigest: "sha256:1",
        })),
      }),
    });

    const bridge = createEmployeeExpertRunnerBridge({
      store,
      loadExpertProfile: async ({ orgId, expertId, delegationScope }) => ({
        adapterType: "paperclip_runner",
        harnessSupportsResume: true,
        profile: { orgId, expertId, delegationScope },
      }),
      loadTaskSessionParams: async () => null,
      launchPrivateHeartbeatRun: async () => ({ runId: "run_cancel_target" }),
      cancelHeartbeatRun,
      revokeGatewayRun,
    });

    const worker = createEmployeeExpertDispatchWorker({
      store,
      isIsolationVerified: () => true,
      dispatchRun: bridge.dispatchRun,
      onCancelRun: bridge.onCancelRun,
    });

    const created = await service.createTaskAsync(OWNER_CRED, {
      requestId: "req-cancel-1",
      expertId: EXPERT_ID,
      taskText: "Long running analysis",
    });
    await worker.pollOnce();

    await service.cancelTaskAsync(OWNER_CRED, created.taskId);
    const cancelPoll = await worker.pollOnce();
    expect(cancelPoll.completed).toBe(1);
    expect(cancelHeartbeatRun).toHaveBeenCalledWith("run_cancel_target", "Employee expert task cancelled");
    expect(revokeGatewayRun).toHaveBeenCalledWith("run_cancel_target", "cancelled");

    const cancelledTask = await store.findTaskById(created.taskId);
    expect(cancelledTask?.status).toBe("cancelled");
  });
});
