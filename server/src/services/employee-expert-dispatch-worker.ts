import { randomUUID } from "node:crypto";
import {
  EmployeeExpertsError,
  type EmployeeExpertTaskRecord,
} from "./employee-experts.js";
import {
  buildIsolatedEmployeeTaskExecutionContext,
  deriveExpertNativeIssueUuidV5,
  type IsolatedEmployeeTaskExecutionContext,
  type ReadOnlyReuseRefSnapshot,
} from "./employee-expert-isolation.js";
import {
  DEFAULT_DISPATCH_LEASE_DURATION_MS,
  DEFAULT_DISPATCH_MAX_ATTEMPTS,
  type DispatchIntentRecord,
  type EmployeeExpertsStore,
} from "./employee-experts-store.js";

export const DEFAULT_WORKER_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_BACKOFF_BASE_MS = 5_000;

export interface DispatchRunRequest {
  task: EmployeeExpertTaskRecord;
  intent: DispatchIntentRecord;
  nativeIssueId: string;
  executionContext: IsolatedEmployeeTaskExecutionContext;
  reuseRefSnapshots: readonly ReadOnlyReuseRefSnapshot[];
}

export interface CancelRunRequest {
  task: EmployeeExpertTaskRecord;
  intent: DispatchIntentRecord;
  nativeIssueId: string;
}

export interface DispatchWorkerPollResult {
  claimed: number;
  dispatched: number;
  completed: number;
  requeued: number;
  deadLettered: number;
  failed: number;
}

export interface EmployeeExpertDispatchWorkerOptions {
  store: EmployeeExpertsStore;
  workerId?: string;
  batchSize?: number;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  isIsolationVerified?: () => boolean;
  /** Dispatches a private isolated expert run and returns its created heartbeat_runs.id. */
  dispatchRun: (request: DispatchRunRequest) => Promise<{ runId: string }>;
  /** Stops an active run and revokes its zero-trust gateway proxy lease on cancel. */
  onCancelRun?: (request: CancelRunRequest) => Promise<void> | void;
  /** Optional classifier for transient vs. permanent dispatch errors. */
  isTransientError?: (error: unknown) => boolean;
  now?: () => number;
}

function defaultIsTransientError(error: unknown): boolean {
  if (error instanceof EmployeeExpertsError) {
    return error.retryable;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "EXPERT_NOT_FOUND" || code === "EXPERT_CALL_FORBIDDEN" || code === "EXPERT_TASK_STATE_CONFLICT") {
    return false;
  }
  return true;
}

function readAttemptCount(intent: DispatchIntentRecord): number {
  const meta = intent.payload?._dispatchMeta as { attemptCount?: unknown } | undefined;
  return typeof meta?.attemptCount === "number" && Number.isInteger(meta.attemptCount) && meta.attemptCount >= 1
    ? meta.attemptCount
    : 1;
}

function readReuseRefSnapshots(intent: DispatchIntentRecord): ReadOnlyReuseRefSnapshot[] {
  const raw = intent.payload?.reuseRefSnapshots;
  if (!Array.isArray(raw)) return [];
  const out: ReadOnlyReuseRefSnapshot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.refId !== "string" || !rec.refId.trim()) continue;
    out.push(
      Object.freeze({
        refId: rec.refId.trim(),
        readOnly: true as const,
        sourceAttribution:
          typeof rec.sourceAttribution === "string" && rec.sourceAttribution.trim()
            ? rec.sourceAttribution.trim()
            : `source:${rec.refId.trim()}`,
        contentSnapshot: typeof rec.contentSnapshot === "string" ? rec.contentSnapshot : "",
      }),
    );
  }
  return out;
}

function readExecutionContext(
  intent: DispatchIntentRecord,
  task: EmployeeExpertTaskRecord,
): IsolatedEmployeeTaskExecutionContext {
  const raw = intent.payload?.executionContext;
  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    if (
      rec.taskId === task.taskId &&
      rec.runGeneration === intent.runGeneration &&
      typeof rec.threadId === "string" &&
      typeof rec.workspaceId === "string" &&
      typeof rec.toolCacheNamespace === "string" &&
      typeof rec.sandboxClaimName === "string"
    ) {
      return {
        taskId: task.taskId,
        runGeneration: intent.runGeneration,
        threadId: rec.threadId,
        workspaceId: rec.workspaceId,
        toolCacheNamespace: rec.toolCacheNamespace,
        sandboxClaimName: rec.sandboxClaimName,
        neverReturnToPool: true,
        shareAgentChatThread: false,
      };
    }
  }
  return buildIsolatedEmployeeTaskExecutionContext({
    taskId: task.taskId,
    runGeneration: intent.runGeneration,
  });
}

/**
 * Durable Stage B3-1 Dispatch Intent Worker for `employee_expert_dispatch_intents`.
 *
 * Implements:
 * - Concurrent-safe claiming (`FOR UPDATE SKIP LOCKED`) with 30s/90s lease heartbeat renewal.
 * - Poison-pill protection (`maxAttempts = 3` + exponential backoff -> terminal `failed`).
 * - `cancel` short-circuit stopping active runs and revoking gateway leases.
 * - Monotonic `runGeneration` fencing and `isIsolationVerified()` fail-closed enforcement.
 */
export function createEmployeeExpertDispatchWorker(options: EmployeeExpertDispatchWorkerOptions) {
  const workerId = options.workerId?.trim() || `emp-worker-${randomUUID().slice(0, 8)}`;
  const batchSize = Math.max(1, options.batchSize ?? 10);
  const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS);
  const leaseDurationMs = Math.max(1_000, options.leaseDurationMs ?? DEFAULT_DISPATCH_LEASE_DURATION_MS);
  const heartbeatIntervalMs = Math.max(
    100,
    Math.min(options.heartbeatIntervalMs ?? DEFAULT_LEASE_HEARTBEAT_INTERVAL_MS, Math.floor(leaseDurationMs / 2)),
  );
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_DISPATCH_MAX_ATTEMPTS);
  const backoffBaseMs = Math.max(100, options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS);
  const isTransientError = options.isTransientError ?? defaultIsTransientError;
  const now = options.now ?? (() => Date.now());

  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  async function safePublishTerminal(input: {
    task: EmployeeExpertTaskRecord;
    runGeneration: number;
    status: "cancelled" | "failed";
    result: unknown;
  }): Promise<void> {
    try {
      await options.store.publishTaskResult({
        taskId: input.task.taskId,
        runId: input.task.runId ?? "",
        runGeneration: input.runGeneration,
        status: input.status,
        result: input.result,
      });
    } catch (err) {
      if (err instanceof EmployeeExpertsError && err.code === "EXPERT_TASK_STATE_CONFLICT") {
        // Newer generation already superseded this callback; discard safely.
        return;
      }
      throw err;
    }
  }

  async function processIntent(
    intent: DispatchIntentRecord,
    counters: DispatchWorkerPollResult,
  ): Promise<void> {
    const intentKey = {
      taskId: intent.taskId,
      runGeneration: intent.runGeneration,
      kind: intent.kind,
    };
    const task = await options.store.findTaskById(intent.taskId);
    if (!task) {
      await options.store.completeDispatchIntent({
        ...intentKey,
        status: "failed",
        lastError: "EXPERT_TASK_NOT_FOUND",
        now,
      });
      counters.failed += 1;
      return;
    }

    const nativeIssueId = deriveExpertNativeIssueUuidV5(task.orgId, task.taskId);

    // 1. Short-circuit `cancel` intents before any session/context lookup.
    if (intent.kind === "cancel") {
      try {
        if (options.onCancelRun) {
          await options.onCancelRun({ task, intent, nativeIssueId });
        }
        await safePublishTerminal({
          task,
          runGeneration: Math.max(task.runGeneration, intent.runGeneration),
          status: "cancelled",
          result: { cancelled: true, externalActionsNotReverted: true },
        });
        await options.store.completeDispatchIntent({ ...intentKey, status: "completed", now });
        counters.completed += 1;
      } catch (err) {
        await handleIntentFailure(task, intent, err, counters);
      }
      return;
    }

    // 2. Fence stale generations and already-cancelled tasks before execution.
    if (intent.runGeneration < task.runGeneration || task.cancelRequested) {
      await options.store.completeDispatchIntent({
        ...intentKey,
        status: "failed",
        lastError: task.cancelRequested ? "EXPERT_TASK_CANCELLED" : "EXPERT_RUN_GENERATION_STALE",
        now,
      });
      counters.failed += 1;
      return;
    }

    // 3. Enforce fail-closed isolation verification before starting any run.
    if (options.isIsolationVerified && !options.isIsolationVerified()) {
      const err = new EmployeeExpertsError(
        "EXPERT_ISOLATION_UNVERIFIED",
        "Target runner cannot verify cross-session context isolation.",
      );
      await handleIntentFailure(task, intent, err, counters);
      return;
    }

    // 4. Keep lease alive via 30s/90s heartbeat while dispatching.
    const heartbeat = setInterval(() => {
      void options.store
        .renewDispatchIntentLease({
          ...intentKey,
          workerId,
          leaseDurationMs,
          now,
        })
        .catch(() => undefined);
    }, heartbeatIntervalMs);
    heartbeat.unref?.();

    try {
      const executionContext = readExecutionContext(intent, task);
      const reuseRefSnapshots = readReuseRefSnapshots(intent);
      const { runId } = await options.dispatchRun({
        task,
        intent,
        nativeIssueId,
        executionContext,
        reuseRefSnapshots,
      });
      const marked = await options.store.markDispatchIntentDispatched({
        ...intentKey,
        workerId,
        runId,
        now,
      });
      if (marked) {
        counters.dispatched += 1;
      } else {
        await options.store.completeDispatchIntent({
          ...intentKey,
          status: "failed",
          lastError: "EXPERT_RUN_GENERATION_STALE",
          now,
        });
        counters.failed += 1;
      }
    } catch (err) {
      await handleIntentFailure(task, intent, err, counters);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function handleIntentFailure(
    task: EmployeeExpertTaskRecord,
    intent: DispatchIntentRecord,
    error: unknown,
    counters: DispatchWorkerPollResult,
  ): Promise<void> {
    const intentKey = {
      taskId: intent.taskId,
      runGeneration: intent.runGeneration,
      kind: intent.kind,
    };
    const message = error instanceof Error ? error.message : String(error);
    const attemptCount = readAttemptCount(intent);

    if (isTransientError(error) && attemptCount < maxAttempts) {
      const delayMs = backoffBaseMs * 2 ** Math.max(0, attemptCount - 1);
      const nextAttemptAt = new Date(now() + delayMs).toISOString();
      await options.store.requeueDispatchIntentWithBackoff({
        ...intentKey,
        workerId,
        nextAttemptAt,
        lastError: message,
        now,
      });
      counters.requeued += 1;
      return;
    }

    await options.store.completeDispatchIntent({
      ...intentKey,
      status: "failed",
      lastError: message,
      now,
    });
    if (intent.kind !== "cancel") {
      await safePublishTerminal({
        task,
        runGeneration: intent.runGeneration,
        status: "failed",
        result: {
          error: error instanceof EmployeeExpertsError ? error.code : "EXPERT_DISPATCH_FAILED",
          message,
        },
      });
    }
    counters.failed += 1;
  }

  async function pollOnce(): Promise<DispatchWorkerPollResult> {
    const counters: DispatchWorkerPollResult = {
      claimed: 0,
      dispatched: 0,
      completed: 0,
      requeued: 0,
      deadLettered: 0,
      failed: 0,
    };

    const { claimed, deadLettered } = await options.store.claimNextDispatchIntents({
      workerId,
      limit: batchSize,
      leaseDurationMs,
      maxAttempts,
      now,
    });
    counters.claimed = claimed.length;
    counters.deadLettered = deadLettered.length;

    for (const dead of deadLettered) {
      const task = await options.store.findTaskById(dead.taskId);
      if (task && dead.kind !== "cancel") {
        await safePublishTerminal({
          task,
          runGeneration: dead.runGeneration,
          status: "failed",
          result: {
            error: "EXPERT_DISPATCH_MAX_ATTEMPTS_EXCEEDED",
            message: "Dispatch intent exceeded maximum retry attempts.",
          },
        });
      }
    }

    for (const intent of claimed) {
      await processIntent(intent, counters);
    }

    return counters;
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void pollOnce().finally(() => {
        polling = false;
      });
    }, pollIntervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    workerId,
    pollOnce,
    start,
    stop,
  };
}

export type EmployeeExpertDispatchWorker = ReturnType<typeof createEmployeeExpertDispatchWorker>;
