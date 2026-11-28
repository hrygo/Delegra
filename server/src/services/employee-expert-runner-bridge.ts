import { and, eq } from "drizzle-orm";
import { agents, agentTaskSessions, heartbeatRuns, type Db } from "@paperclipai/db";
import {
  EmployeeExpertsError,
  type EmployeeExpertTaskRecord,
  type EmployeeExpertTaskStatus,
} from "./employee-experts.js";
import type { EmployeeExpertsStore } from "./employee-experts-store.js";
import type { CancelRunRequest, DispatchRunRequest } from "./employee-expert-dispatch-worker.js";
import {
  assembleExpertSessionContext,
  type AssembledExpertSessionContext,
  type CompactedExpertTaskState,
  type ContextBudgetPolicy,
  type ExpertStaticProfile,
} from "./employee-expert-context-assembler.js";
import type { ExpertGatewayAuthorizationService } from "./native-runtime/expert-gateway-authorization.js";

export interface LoadedExpertRuntimeProfile {
  profile: ExpertStaticProfile;
  adapterType: string;
  harnessSupportsResume: boolean;
}

export interface PrivateHeartbeatRunLaunchInput {
  companyId: string;
  agentId: string;
  scopeKind: "company";
  issueId: null;
  nativeIssueId: string;
  responsibleUserId: string;
  contextSnapshot: Record<string, unknown>;
}

export interface EmployeeExpertRunnerBridgeDeps {
  store: EmployeeExpertsStore;
  loadExpertProfile: (input: {
    orgId: string;
    expertId: string;
    delegationScope: string;
  }) => Promise<LoadedExpertRuntimeProfile | null>;
  loadTaskSessionParams: (input: {
    orgId: string;
    expertId: string;
    adapterType: string;
    taskKey: string;
  }) => Promise<Record<string, unknown> | null>;
  launchPrivateHeartbeatRun: (input: PrivateHeartbeatRunLaunchInput) => Promise<{ runId: string }>;
  cancelHeartbeatRun: (runId: string, reason: string) => Promise<void> | void;
  revokeGatewayRun?: (
    runId: string,
    reason: "cancelled" | "auth_revoked" | "budget_exhausted" | "expired",
  ) => Promise<unknown> | unknown;
  budget?: Partial<ContextBudgetPolicy>;
  now?: () => number;
}

export interface TerminalSourceInput {
  id?: string;
  label?: string;
  url?: string;
  value?: string;
  authorized?: boolean;
}

export interface TerminalArtifactInput {
  id: string;
  label?: string;
  url?: string;
  authorized?: boolean;
}

export interface HandleRunTerminalOutcomeInput {
  taskId: string;
  runId: string;
  runGeneration: number;
  intentKind: "initial" | "followup";
  outcome: "completed" | "waiting_user" | "failed" | "cancelled";
  result: unknown;
  sources?: readonly (string | TerminalSourceInput)[];
  artifacts?: readonly TerminalArtifactInput[];
  errorMessage?: string;
}

export interface ProjectedEmployeeExpertResultEnvelope {
  taskId: string;
  expertId: string;
  status: EmployeeExpertTaskStatus;
  runGeneration: number;
  resultVersion: number;
  rawResultCollapsed: true;
  synthesizedByMainAssistant: false;
  result: unknown;
  sources: string[];
  artifacts: Array<{ id: string; label?: string; url?: string }>;
  waitingUserNotice: string | null;
}

/**
 * Filters attributed sources fail-closed (Layer 5 synthesis guard):
 * entries carrying `authorized === false` (or lacking `authorized === true` when
 * structured authorization metadata is present) are stripped completely.
 */
export function filterAuthorizedSources(
  sources: readonly (string | TerminalSourceInput)[] | undefined,
): string[] {
  if (!Array.isArray(sources)) return [];
  const out: string[] = [];
  for (const item of sources) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) out.push(trimmed);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (item.authorized !== true) continue;
    const text = (item.value ?? item.url ?? item.label ?? item.id ?? "").trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * Filters attributed artifacts fail-closed (Layer 5 synthesis guard):
 * only artifacts explicitly marked `authorized === true` pass through.
 */
export function filterAuthorizedArtifacts(
  artifacts: readonly TerminalArtifactInput[] | undefined,
): Array<{ id: string; label?: string; url?: string }> {
  if (!Array.isArray(artifacts)) return [];
  const out: Array<{ id: string; label?: string; url?: string }> = [];
  for (const item of artifacts) {
    if (!item || typeof item !== "object" || item.authorized !== true) continue;
    const id = item.id?.trim();
    if (!id) continue;
    out.push({
      id,
      ...(item.label?.trim() ? { label: item.label.trim() } : {}),
      ...(item.url?.trim() ? { url: item.url.trim() } : {}),
    });
  }
  return out;
}

/**
 * Layer 5 Reverse Projection to DSH Main Assistant:
 * guarantees raw expert output stays collapsed and distinct from main assistant
 * synthesis, with an explicit read-only `waitingUserNotice` when `waiting_user`.
 */
export function projectEmployeeExpertResultEnvelope(
  task: Pick<
    EmployeeExpertTaskRecord,
    "taskId" | "expertId" | "status" | "runGeneration" | "resultVersion" | "result" | "sources" | "artifacts"
  >,
): ProjectedEmployeeExpertResultEnvelope {
  return {
    taskId: task.taskId,
    expertId: task.expertId,
    status: task.status,
    runGeneration: task.runGeneration,
    resultVersion: task.resultVersion,
    rawResultCollapsed: true,
    synthesizedByMainAssistant: false,
    result: task.result,
    sources: [...task.sources],
    artifacts: task.artifacts.map((a) => ({ ...a })),
    waitingUserNotice:
      task.status === "waiting_user"
        ? "Expert task is waiting for employee follow-up input; submit a followup on the same taskId to resume."
        : null,
  };
}

function readCompactionHints(
  payload: Record<string, unknown> | undefined,
): Partial<Omit<CompactedExpertTaskState, "taskId" | "runGeneration" | "objective">> | undefined {
  const raw = payload?.compactionHints;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Partial<Omit<CompactedExpertTaskState, "taskId" | "runGeneration" | "objective">>;
}

/**
 * Builds the private `heartbeat_runs.context_snapshot` payload carrying
 * Stage B3-2 assembled prompt context, one-way SandboxClaim metadata,
 * `/run/delegra-refs/` staged read-only ref files, and Stage B2 ACL markers.
 */
export function buildPrivateExpertRunContextSnapshot(input: {
  task: EmployeeExpertTaskRecord;
  assembled: AssembledExpertSessionContext;
}): Record<string, unknown> {
  const { task, assembled } = input;
  return {
    // Stage B2 ACL defense-in-depth markers (checked by employee-expert-acl.ts).
    employeeExpertTaskId: task.taskId,
    responsibleUserId: task.responsibleUserId,
    visibility: "private",
    originClient: "dsh",
    // Stage B3 session/isolation/context binding.
    taskId: task.taskId,
    taskKey: assembled.taskKey,
    nativeIssueId: assembled.nativeIssueId,
    runGeneration: assembled.runGeneration,
    contextMode: assembled.mode,
    delegationScope: task.delegationScope,
    shareAgentChatThread: false,
    neverReturnToPool: true,
    sandboxClaimName: assembled.executionContext.sandboxClaimName,
    workspaceId: assembled.executionContext.workspaceId,
    toolCacheNamespace: assembled.executionContext.toolCacheNamespace,
    prompt: assembled.composedPrompt,
    ...(assembled.resumeSessionParams ? { resumeSessionParams: assembled.resumeSessionParams } : {}),
    stagedReadOnlyRefFiles: assembled.stagedReadOnlyRefFiles,
    demotedToIndexRefs: assembled.demotedToIndexRefs,
    estimatedInputTokens: assembled.estimatedInputTokens,
  };
}

/**
 * Stage B3-3 End-to-End Runner Bridge connecting the Stage B3-1 Dispatch Worker
 * and Stage B3-2 Context Assembler to Delegra's private `heartbeat_runs`,
 * `agent_task_sessions`, zero-trust gateway proxy revocation, and `publishTaskResult`.
 */
export function createEmployeeExpertRunnerBridge(deps: EmployeeExpertRunnerBridgeDeps) {
  const now = deps.now ?? (() => Date.now());

  async function dispatchRun(request: DispatchRunRequest): Promise<{ runId: string }> {
    const { task, intent, executionContext, reuseRefSnapshots } = request;
    if (intent.kind === "cancel") {
      throw new EmployeeExpertsError(
        "EXPERT_TASK_STATE_CONFLICT",
        "Cancel intents must short-circuit via onCancelRun.",
      );
    }

    const loaded = await deps.loadExpertProfile({
      orgId: task.orgId,
      expertId: task.expertId,
      delegationScope: task.delegationScope,
    });
    if (!loaded) {
      throw new EmployeeExpertsError("EXPERT_NOT_FOUND", "Target expert agent was not found.");
    }

    const existingSessionParams =
      intent.kind === "followup"
        ? await deps.loadTaskSessionParams({
            orgId: task.orgId,
            expertId: task.expertId,
            adapterType: loaded.adapterType,
            taskKey: executionContext.threadId,
          })
        : null;

    const currentTurnTaskText =
      typeof intent.payload?.taskText === "string" && intent.payload.taskText.trim()
        ? intent.payload.taskText
        : task.taskText;

    const assembled = assembleExpertSessionContext({
      task: {
        ...task,
        runGeneration: intent.runGeneration,
      },
      intentKind: intent.kind,
      currentTurnTaskText,
      expertProfile: loaded.profile,
      executionContext,
      existingSessionParams,
      harnessSupportsResume: loaded.harnessSupportsResume,
      reuseRefSnapshots,
      compactionHints: readCompactionHints(intent.payload),
      budget: deps.budget,
    });

    const contextSnapshot = buildPrivateExpertRunContextSnapshot({ task, assembled });

    return deps.launchPrivateHeartbeatRun({
      companyId: task.orgId,
      agentId: task.expertId,
      scopeKind: "company",
      issueId: null,
      nativeIssueId: assembled.nativeIssueId,
      responsibleUserId: task.responsibleUserId,
      contextSnapshot,
    });
  }

  async function onCancelRun(request: CancelRunRequest): Promise<void> {
    const runId = request.task.runId;
    if (!runId) return;
    await Promise.resolve(deps.cancelHeartbeatRun(runId, "Employee expert task cancelled")).catch(
      () => undefined,
    );
    if (deps.revokeGatewayRun) {
      await Promise.resolve(deps.revokeGatewayRun(runId, "cancelled")).catch(() => undefined);
    }
  }

  async function handleRunTerminalOutcome(
    input: HandleRunTerminalOutcomeInput,
  ): Promise<EmployeeExpertTaskRecord> {
    const sources = filterAuthorizedSources(input.sources);
    const artifacts = filterAuthorizedArtifacts(input.artifacts);

    const updated = await deps.store.publishTaskResult({
      taskId: input.taskId,
      runId: input.runId,
      runGeneration: input.runGeneration,
      status: input.outcome,
      result: input.result,
      sources,
      artifacts,
    });

    await deps.store.completeDispatchIntent({
      taskId: input.taskId,
      runGeneration: input.runGeneration,
      kind: input.intentKind,
      status: input.outcome === "failed" ? "failed" : "completed",
      ...(input.errorMessage ? { lastError: input.errorMessage } : {}),
      now,
    });

    return updated;
  }

  return {
    dispatchRun,
    onCancelRun,
    handleRunTerminalOutcome,
    projectEnvelope: projectEmployeeExpertResultEnvelope,
  };
}

export type EmployeeExpertRunnerBridge = ReturnType<typeof createEmployeeExpertRunnerBridge>;

/**
 * Production PostgreSQL + Heartbeat + Zero-Trust Gateway Proxy wiring for Stage B3-3.
 */
export function createPgEmployeeExpertRunnerBridge(deps: {
  db: Db;
  store: EmployeeExpertsStore;
  heartbeat: {
    cancelRun: (runId: string, reason?: string) => Promise<unknown>;
    resumeQueuedRunsForAgent: (companyId: string, agentId: string) => Promise<unknown>;
  };
  expertGatewayAuthz?: Pick<ExpertGatewayAuthorizationService, "revokeRun">;
  budget?: Partial<ContextBudgetPolicy>;
}): EmployeeExpertRunnerBridge {
  return createEmployeeExpertRunnerBridge({
    store: deps.store,
    budget: deps.budget,
    async loadExpertProfile({ orgId, expertId, delegationScope }) {
      const [agent] = await deps.db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, orgId), eq(agents.id, expertId)))
        .limit(1);
      if (!agent) return null;
      const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
      const capabilities = Array.isArray(metadata.capabilityTags)
        ? metadata.capabilityTags.filter((x): x is string => typeof x === "string")
        : agent.capabilities
          ? [agent.capabilities]
          : [];
      return {
        adapterType: agent.adapterType,
        harnessSupportsResume: agent.adapterType === "paperclip_runner" || agent.adapterType === "codex_local" || agent.adapterType === "claude_local",
        profile: {
          orgId,
          expertId,
          expertName: agent.name,
          persona: agent.title ?? agent.capabilities ?? undefined,
          capabilities,
          delegationScope,
        },
      };
    },
    async loadTaskSessionParams({ orgId, expertId, adapterType, taskKey }) {
      const [session] = await deps.db
        .select({ sessionParamsJson: agentTaskSessions.sessionParamsJson })
        .from(agentTaskSessions)
        .where(
          and(
            eq(agentTaskSessions.companyId, orgId),
            eq(agentTaskSessions.agentId, expertId),
            eq(agentTaskSessions.adapterType, adapterType),
            eq(agentTaskSessions.taskKey, taskKey),
          ),
        )
        .limit(1);
      return session?.sessionParamsJson ?? null;
    },
    async launchPrivateHeartbeatRun(input) {
      const [run] = await deps.db
        .insert(heartbeatRuns)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          scopeKind: input.scopeKind,
          issueId: null,
          nativeIssueId: input.nativeIssueId,
          invocationSource: "on_demand",
          triggerDetail: "system",
          status: "queued",
          responsibleUserId: input.responsibleUserId,
          contextSnapshot: input.contextSnapshot,
        })
        .returning({ id: heartbeatRuns.id });
      if (!run) {
        throw new Error("Failed to insert private employee expert heartbeat_run row.");
      }
      // Best-effort wake of the agent's run queue; durable row stays queued even if wake defers.
      void deps.heartbeat.resumeQueuedRunsForAgent(input.companyId, input.agentId).catch(() => undefined);
      return { runId: run.id };
    },
    async cancelHeartbeatRun(runId, reason) {
      await deps.heartbeat.cancelRun(runId, reason);
    },
    revokeGatewayRun: deps.expertGatewayAuthz
      ? (runId, reason) => deps.expertGatewayAuthz!.revokeRun(runId, reason)
      : undefined,
  });
}
