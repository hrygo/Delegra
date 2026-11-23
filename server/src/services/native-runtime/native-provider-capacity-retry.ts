import { notifyAttentionRetentionWork } from "../retention-work-notifications.js";
import { notifyScheduledRetryDispatch } from "../run-dispatch-notifications.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { accountingForScheduledRetry, executionFailureRetryCount } from "../execution-recovery-attempt.js";
import { NATIVE_PROVIDER_CAPACITY_MAX_RETRIES, NATIVE_PROVIDER_OVERLOADED_CODE, NATIVE_PROVIDER_OVERLOADED_MESSAGE } from "./native-provider-failure.js";

/** Called under the finalizer's issue/coordinator locks, in the status-effect transaction. */
export async function materializeNativeProviderCapacityRetry(input: {
  tx: Db;
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
}) {
  const [run] = await input.tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.nativeIssueId, input.issueId),
  )).for("update");
  if (!run || run.runtimeMode !== "native") throw new Error("native_capacity_retry_run_binding_mismatch");
  // Share the predecessor claim with every other failure-retry lane.
  const [existing] = await input.tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.retryOfRunId, run.id),
  )).limit(1);
  if (existing) return existing.id;
  const attempt = executionFailureRetryCount(run) + 1;
  if (attempt > NATIVE_PROVIDER_CAPACITY_MAX_RETRIES) throw new Error("native_capacity_retry_exhausted");
  const now = new Date();
  const dueAt = new Date(now.getTime() + 60_000 * 2 ** (attempt - 1));
  const retryId = randomUUID();
  const predecessorContext = { ...run.contextSnapshot };
  // Resume receipts and delivered wake input belong to the failed run. The
  // new turn has ordinary task authority; history comes from retryOfRunId.
  // Match the consumed-input boundary used by native safe replacements.
  for (const key of [
    "explicitUserContinuation", "wakeCommentId", "wakeCommentIds", "commentId",
    "commentIds", "latestCommentId", "resumeIntent", "followUpRequested",
    "paperclipWake", "paperclipWakeComment", "paperclipTaskMarkdown", "paperclipTaskMarkdownCompact",
    "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownAssignmentCompact", "paperclipTurnContext",
  ]) delete predecessorContext[key];
  const contextSnapshot = {
    ...predecessorContext,
    issueId: input.issueId,
    taskId: input.issueId,
    forceFreshSession: true,
    retryOfRunId: run.id,
    retryReason: NATIVE_PROVIDER_OVERLOADED_CODE,
    wakeReason: NATIVE_PROVIDER_OVERLOADED_CODE,
    scheduledRetryAttempt: attempt,
    scheduledRetryAt: dueAt.toISOString(),
    executionRetryAccounting: accountingForScheduledRetry(run, NATIVE_PROVIDER_OVERLOADED_CODE, attempt),
  };
  await notifyAttentionRetentionWork(input.tx, { companyId: input.companyId });
  await notifyScheduledRetryDispatch(input.tx, { companyId: run.companyId });
  const [wake] = await input.tx.insert(agentWakeupRequests).values({
    companyId: run.companyId, agentId: run.agentId, source: "automation", triggerDetail: "system",
    reason: NATIVE_PROVIDER_OVERLOADED_CODE, status: "queued", runId: retryId,
    idempotencyKey: `native-capacity:${run.companyId}:${run.id}`,
    requestedByActorType: "system", requestedByActorId: "native_finalizer",
    payload: contextSnapshot,
  }).returning({ id: agentWakeupRequests.id });
  await input.tx.insert(heartbeatRuns).values({
    id: retryId, companyId: run.companyId, agentId: run.agentId,
    invocationSource: "automation", triggerDetail: "system", status: "scheduled_retry",
    responsibleUserId: run.responsibleUserId, wakeupRequestId: wake.id,
    retryOfRunId: run.id, scheduledRetryReason: NATIVE_PROVIDER_OVERLOADED_CODE,
    scheduledRetryAttempt: attempt, scheduledRetryAt: dueAt,
    error: NATIVE_PROVIDER_OVERLOADED_MESSAGE, errorCode: NATIVE_PROVIDER_OVERLOADED_CODE,
    contextSnapshot,
  });
  return retryId;
}

/**
 * Provider-agnostic capacity backpressure retry classifier and bounded backoff
 * helper for native runtime dispatch.
 *
 * When a sandbox provider (e.g. Kubernetes ResourceQuota watermark or Pending
 * Pod backoff) defers admission, the run stays explicitly in `queued` state
 * for DSH rather than failing or returning stale output.
 */

export type CapacityBackpressureReason =
  | "quota_exhausted"
  | "pending_backoff"
  | "pool_exhausted"
  | "provider_rate_limited";

export interface CapacityBackpressureClassification {
  retryable: true;
  nextState: "queued";
  reason: CapacityBackpressureReason;
  retryAfterMs: number;
}

export interface ComputeBackoffOptions {
  attempt: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Deterministic jitter factor in [0, 1] for tests; defaults to Math.random(). */
  jitterFactor?: number;
}

/**
 * Computes bounded exponential backoff with up to 25% positive jitter.
 */
export function computeCapacityBackoffMs(opts: ComputeBackoffOptions): number {
  const attempt = Math.max(1, Math.floor(opts.attempt));
  const base = Math.max(100, opts.baseDelayMs ?? 2_000);
  const cap = Math.max(base, opts.maxDelayMs ?? 60_000);
  const exp = Math.min(cap, base * Math.pow(2, attempt - 1));
  const jitter = Math.min(1, Math.max(0, opts.jitterFactor ?? Math.random()));
  return Math.min(cap, Math.round(exp * (1 + 0.25 * jitter)));
}

/**
 * Classifies an error or admission response from a sandbox provider into a
 * retryable `queued` backpressure decision, or `null` if the error is fatal.
 */
export function classifyCapacityBackpressureError(
  err: unknown,
  attempt = 1,
  jitterFactor?: number,
): CapacityBackpressureClassification | null {
  if (!err || typeof err !== "object") return null;

  const record = err as {
    reason?: unknown;
    code?: unknown;
    statusCode?: unknown;
    status?: unknown;
    retryAfterMs?: unknown;
    message?: unknown;
  };

  const explicitReason = typeof record.reason === "string" ? record.reason : "";
  const message = typeof record.message === "string" ? record.message : "";
  const status =
    typeof record.statusCode === "number"
      ? record.statusCode
      : typeof record.status === "number"
        ? record.status
        : typeof record.code === "number"
          ? record.code
          : 0;

  let reason: CapacityBackpressureReason | null = null;
  if (explicitReason === "quota_exhausted" || /exceeded quota|quota exhausted/i.test(message)) {
    reason = "quota_exhausted";
  } else if (explicitReason === "pending_backoff" || /pending pod.*backoff/i.test(message)) {
    reason = "pending_backoff";
  } else if (explicitReason === "pool_exhausted" || /warm ?pool.*exhausted/i.test(message)) {
    reason = "pool_exhausted";
  } else if (status === 429 || status === 503) {
    reason = "provider_rate_limited";
  }

  if (!reason) return null;

  const hinted =
    typeof record.retryAfterMs === "number" && record.retryAfterMs > 0
      ? record.retryAfterMs
      : computeCapacityBackoffMs({ attempt, jitterFactor });

  return {
    retryable: true,
    nextState: "queued",
    reason,
    retryAfterMs: hinted,
  };
}

export function isRetryableCapacityError(err: unknown): boolean {
  return classifyCapacityBackpressureError(err) !== null;
}
