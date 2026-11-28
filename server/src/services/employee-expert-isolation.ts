import { createHash } from "node:crypto";
import {
  EmployeeExpertsError,
  type EmployeeCredentialContext,
  type EmployeeExpertTaskRecord,
} from "./employee-experts.js";

/** Fixed RFC 4122 UUIDv5 namespace for Delegra employee expert tasks. */
const EMPLOYEE_EXPERT_UUIDV5_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * Derives a deterministic RFC 4122 UUIDv5 from `(orgId, taskId)` for
 * `heartbeat_runs.native_issue_id` and `native_runner_checkpoints.issue_id`.
 *
 * This lets private employee expert runs remain `scope_kind = 'company'` with
 * `issue_id = null` (zero synthetic rows in `issues`, zero extra WS queries on
 * issue-scoped runs) while still satisfying `native_runner_checkpoints`'s
 * `NOT NULL` composite FK to `heartbeat_runs(company_id, native_issue_id, id)`.
 */
export function deriveExpertNativeIssueUuidV5(orgId: string, taskId: string): string {
  const nsBytes = Buffer.from(EMPLOYEE_EXPERT_UUIDV5_NAMESPACE.replace(/-/g, ""), "hex");
  const nameBytes = Buffer.from(`delegra:employee-expert-task:${orgId.trim()}:${taskId.trim()}`, "utf8");
  const hash = createHash("sha1").update(nsBytes).update(nameBytes).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Isolated per-task execution context binding for an employee expert task
 * (CORP-DSH-EXPERT-001 §6.2).
 *
 * Guarantees that two concurrent DSH sessions (or two independent dispatches
 * in the same session) from the same employee to the same expert NEVER share
 * an Agent Chat thread, model context, workspace, tool cache, or sandbox claim.
 */
export interface IsolatedEmployeeTaskExecutionContext {
  taskId: string;
  runGeneration: number;
  threadId: string;
  workspaceId: string;
  toolCacheNamespace: string;
  sandboxClaimName: string;
  neverReturnToPool: true;
  shareAgentChatThread: false;
}

export interface ReadOnlyReuseRefSnapshot {
  refId: string;
  readOnly: true;
  sourceAttribution: string;
  contentSnapshot: string;
}

export type ReuseRefAuthorizer = (
  refId: string,
  cred: EmployeeCredentialContext,
) => Promise<{
  allowed: boolean;
  sourceAttribution?: string;
  contentSnapshot?: string;
}> | {
  allowed: boolean;
  sourceAttribution?: string;
  contentSnapshot?: string;
};

/**
 * Derives a strictly per-task isolated execution context bound to a one-way
 * Kubernetes SandboxClaim (aligned with #82/#85). Followups on the same taskId
 * reuse the task's own thread/workspace while advancing runGeneration and
 * rotating the one-way sandbox claim name.
 */
export function buildIsolatedEmployeeTaskExecutionContext(
  task: Pick<EmployeeExpertTaskRecord, "taskId" | "runGeneration">,
): IsolatedEmployeeTaskExecutionContext {
  const sanitizedTask = task.taskId.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 28);
  return {
    taskId: task.taskId,
    runGeneration: task.runGeneration,
    threadId: `emp_thread_${task.taskId}`,
    workspaceId: `emp_ws_${task.taskId}`,
    toolCacheNamespace: `emp_cache_${task.taskId}`,
    sandboxClaimName: `emp-claim-${sanitizedTask}-g${task.runGeneration}`,
    neverReturnToPool: true,
    shareAgentChatThread: false,
  };
}

/**
 * Validates every explicitly requested `reuseRef` against the employee's
 * current read permissions and returns frozen read-only attributed snapshots.
 * Rejects unauthorized refs fail-closed with 403 EXPERT_CALL_FORBIDDEN (§6.2).
 */
export async function resolveReadOnlyReuseRefs(input: {
  refs: readonly string[];
  cred: EmployeeCredentialContext;
  authorizeRef: ReuseRefAuthorizer;
}): Promise<ReadOnlyReuseRefSnapshot[]> {
  const snapshots: ReadOnlyReuseRefSnapshot[] = [];
  for (const rawRef of input.refs) {
    const refId = rawRef.trim();
    if (!refId) continue;
    const verdict = await input.authorizeRef(refId, input.cred);
    if (!verdict || verdict.allowed !== true) {
      throw new EmployeeExpertsError(
        "EXPERT_CALL_FORBIDDEN",
        "Requested reuseRef is not authorized for the current employee.",
      );
    }
    snapshots.push(
      Object.freeze({
        refId,
        readOnly: true as const,
        sourceAttribution: verdict.sourceAttribution?.trim() || `source:${refId}`,
        contentSnapshot: verdict.contentSnapshot ?? "",
      }),
    );
  }
  return snapshots;
}

/**
 * Enforces monotonic runGeneration fencing (§6.2): rejects any stale callback,
 * result publication, or tool invocation carrying an older generation.
 */
export function assertRunGenerationFence(
  currentGeneration: number,
  incomingGeneration: number,
): void {
  if (!Number.isInteger(incomingGeneration) || incomingGeneration < currentGeneration) {
    throw new EmployeeExpertsError(
      "EXPERT_TASK_STATE_CONFLICT",
      "Stale runGeneration callback rejected by monotonic generation fence.",
    );
  }
}

/**
 * Runtime probe wired into server/src/app.ts to fail closed with
 * `503 EXPERT_ISOLATION_UNVERIFIED` whenever the active runner/sandbox provider
 * cannot prove per-task cross-session isolation (§6.2).
 */
export function createRuntimeIsolationProbe(opts?: {
  env?: NodeJS.ProcessEnv;
  isKubernetesSandboxIsolationActive?: () => boolean;
}): () => boolean {
  const env = opts?.env ?? process.env;
  return () => {
    const explicit = env.DELEGRA_EXPERT_ISOLATION_VERIFIED?.trim().toLowerCase();
    if (explicit === "false" || explicit === "0" || explicit === "no") {
      return false;
    }
    if (explicit === "true" || explicit === "1" || explicit === "yes") {
      return true;
    }
    if (opts?.isKubernetesSandboxIsolationActive) {
      return opts.isKubernetesSandboxIsolationActive() === true;
    }
    // Fail-closed by default when neither explicit verification nor active
    // Kubernetes one-way SandboxClaim isolation is confirmed.
    return false;
  };
}
