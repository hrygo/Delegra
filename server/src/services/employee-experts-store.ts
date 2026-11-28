import { createHash, randomBytes } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import {
  agentMemberships,
  agents,
  authAccounts,
  employeeExpertAuthContinuity,
  employeeExpertDispatchIntents,
  employeeExpertIdempotencyReceipts,
  employeeExpertTasks,
  principalPermissionGrants,
  projectMemberships,
  type Db,
} from "@paperclipai/db";
import {
  EmployeeExpertsError,
  type CatalogCompleteness,
  type EmployeeExpertRecord,
  type EmployeeExpertTaskRecord,
  type EmployeeExpertTaskStatus,
  type EmployeeScopeCheckItem,
  type ExpertAcceptingState,
  type ExpertCallableReason,
  type ExpertDisclosureState,
} from "./employee-experts.js";
import {
  buildIsolatedEmployeeTaskExecutionContext,
  type IsolatedEmployeeTaskExecutionContext,
  type ReadOnlyReuseRefSnapshot,
} from "./employee-expert-isolation.js";

export interface IdempotencyReceiptRecord {
  orgId: string;
  issuer: string;
  subject: string;
  op: "create_task" | "followup";
  requestId: string;
  taskId: string;
  payloadDigest: string;
  status: EmployeeExpertTaskStatus;
  runGeneration: number;
}

export interface DispatchIntentLeaseMeta {
  attemptCount: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
}

export interface DispatchIntentRecord {
  id?: string;
  taskId: string;
  orgId: string;
  expertId: string;
  runGeneration: number;
  kind: "initial" | "followup" | "cancel";
  payload: Record<string, unknown>;
  status: "pending" | "claimed" | "dispatched" | "completed" | "failed";
  claimedAt?: string | null;
  dispatchedAt?: string | null;
}

export interface ClaimDispatchIntentsOptions {
  workerId: string;
  limit?: number;
  leaseDurationMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

export interface ClaimDispatchIntentsResult {
  claimed: DispatchIntentRecord[];
  deadLettered: DispatchIntentRecord[];
}

export interface DispatchIntentKey {
  taskId: string;
  runGeneration: number;
  kind: "initial" | "followup" | "cancel";
}

export const DEFAULT_DISPATCH_LEASE_DURATION_MS = 90_000;
export const DEFAULT_DISPATCH_MAX_ATTEMPTS = 3;

export interface EmployeeExpertsStore {
  findIdempotencyReceipt(key: {
    orgId: string;
    issuer: string;
    subject: string;
    op: "create_task" | "followup";
    requestId: string;
  }): Promise<IdempotencyReceiptRecord | null>;
  findTaskById(taskId: string): Promise<EmployeeExpertTaskRecord | null>;
  acceptTaskAtomically(input: {
    task: EmployeeExpertTaskRecord;
    receipt: IdempotencyReceiptRecord;
    dispatchIntent: DispatchIntentRecord;
    beforeCommitHook?: () => Promise<void> | void;
  }): Promise<{ created: boolean; receipt: IdempotencyReceiptRecord; task: EmployeeExpertTaskRecord }>;
  createFollowupAtomically(input: {
    taskId: string;
    receipt: Omit<IdempotencyReceiptRecord, "status" | "runGeneration">;
    taskText: string;
    reuseRefs: string[];
    reuseRefSnapshots?: readonly ReadOnlyReuseRefSnapshot[];
    executionContext?: IsolatedEmployeeTaskExecutionContext;
    beforeCommitHook?: () => Promise<void> | void;
  }): Promise<{ created: boolean; receipt: IdempotencyReceiptRecord; task: EmployeeExpertTaskRecord }>;
  cancelTask(input: {
    taskId: string;
    orgId: string;
    expertId: string;
  }): Promise<EmployeeExpertTaskRecord | null>;
  publishTaskResult(input: {
    taskId: string;
    runId: string;
    runGeneration: number;
    status: EmployeeExpertTaskStatus;
    result: unknown;
    sources?: string[];
    artifacts?: Array<{ id: string; label?: string; url?: string }>;
  }): Promise<EmployeeExpertTaskRecord>;
  claimNextDispatchIntents(options: ClaimDispatchIntentsOptions): Promise<ClaimDispatchIntentsResult>;
  renewDispatchIntentLease(
    input: DispatchIntentKey & {
      workerId: string;
      leaseDurationMs?: number;
      now?: () => number;
    },
  ): Promise<boolean>;
  markDispatchIntentDispatched(
    input: DispatchIntentKey & {
      workerId: string;
      runId: string;
      now?: () => number;
    },
  ): Promise<boolean>;
  completeDispatchIntent(
    input: DispatchIntentKey & {
      status: "completed" | "failed";
      lastError?: string;
      now?: () => number;
    },
  ): Promise<void>;
  requeueDispatchIntentWithBackoff(
    input: DispatchIntentKey & {
      workerId: string;
      nextAttemptAt: string;
      lastError: string;
      now?: () => number;
    },
  ): Promise<void>;
  listDispatchIntents(taskId?: string): Promise<DispatchIntentRecord[]>;
  listAllTasks(): Promise<EmployeeExpertTaskRecord[]>;
}

const TERMINAL_STATUSES = new Set<EmployeeExpertTaskStatus>(["completed", "failed", "cancelled"]);

function idempMapKey(k: {
  orgId: string;
  issuer: string;
  subject: string;
  op: "create_task" | "followup";
  requestId: string;
}): string {
  return JSON.stringify([k.orgId, k.issuer, k.subject, k.op, k.requestId]);
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

function readDispatchMeta(
  payload: Record<string, unknown> | null | undefined,
  defaultMaxAttempts: number,
): DispatchIntentLeaseMeta {
  const raw =
    payload && typeof payload._dispatchMeta === "object" && payload._dispatchMeta !== null
      ? (payload._dispatchMeta as Record<string, unknown>)
      : {};
  return {
    attemptCount:
      typeof raw.attemptCount === "number" && Number.isInteger(raw.attemptCount) && raw.attemptCount >= 0
        ? raw.attemptCount
        : 0,
    maxAttempts:
      typeof raw.maxAttempts === "number" && Number.isInteger(raw.maxAttempts) && raw.maxAttempts >= 1
        ? raw.maxAttempts
        : defaultMaxAttempts,
    leaseOwner: typeof raw.leaseOwner === "string" && raw.leaseOwner.trim() ? raw.leaseOwner : null,
    leaseExpiresAt: typeof raw.leaseExpiresAt === "string" && raw.leaseExpiresAt.trim() ? raw.leaseExpiresAt : null,
    nextAttemptAt: typeof raw.nextAttemptAt === "string" && raw.nextAttemptAt.trim() ? raw.nextAttemptAt : null,
    lastError: typeof raw.lastError === "string" && raw.lastError.trim() ? raw.lastError : null,
  };
}

function withDispatchMeta(
  payload: Record<string, unknown> | null | undefined,
  meta: DispatchIntentLeaseMeta,
): Record<string, unknown> {
  return {
    ...(payload ?? {}),
    _dispatchMeta: meta,
  };
}

function matchesIntentKey(intent: DispatchIntentRecord, key: DispatchIntentKey): boolean {
  return (
    intent.taskId === key.taskId &&
    intent.runGeneration === key.runGeneration &&
    intent.kind === key.kind
  );
}

function extractExecuteRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function rowToTaskRecord(row: typeof employeeExpertTasks.$inferSelect): EmployeeExpertTaskRecord {
  return {
    taskId: row.taskId,
    orgId: row.orgId,
    instanceId: row.instanceId,
    issuer: row.issuer,
    responsibleUserId: row.responsibleUserId,
    visibility: "private",
    originClient: "dsh",
    originSessionRef: row.originSessionRef ?? null,
    expertId: row.expertId,
    delegationScope: row.delegationScope,
    requestId: row.requestId,
    payloadDigest: row.payloadDigest,
    taskText: row.taskText,
    reuseRefs: Array.isArray(row.reuseRefs) ? row.reuseRefs : [],
    status: row.status as EmployeeExpertTaskStatus,
    acceptedAt: row.acceptedAt instanceof Date ? row.acceptedAt.toISOString() : String(row.acceptedAt),
    runId: row.runId ?? null,
    runGeneration: row.runGeneration,
    resultVersion: row.resultVersion,
    cancelRequested: row.cancelRequested,
    result: row.result ?? null,
    sources: Array.isArray(row.sources) ? row.sources : [],
    artifacts: Array.isArray(row.artifacts) ? row.artifacts : [],
  };
}

/**
 * In-memory store implementation preserving lightweight unit-test ergonomics
 * while mirroring single-transaction rollback, lease heartbeat, & idempotency semantics.
 */
export function createInMemoryEmployeeExpertsStore(): EmployeeExpertsStore {
  const tasks = new Map<string, EmployeeExpertTaskRecord>();
  const receipts = new Map<string, IdempotencyReceiptRecord>();
  const intents: DispatchIntentRecord[] = [];

  return {
    async findIdempotencyReceipt(key) {
      return receipts.get(idempMapKey(key)) ?? null;
    },
    async findTaskById(taskId) {
      return tasks.get(taskId) ?? null;
    },
    async acceptTaskAtomically(input) {
      const k = idempMapKey(input.receipt);
      const existing = receipts.get(k);
      if (existing) {
        const existingTask = tasks.get(existing.taskId);
        if (!existingTask) {
          throw new EmployeeExpertsError("EXPERT_TASK_NOT_FOUND", "Task is not accessible.");
        }
        return { created: false, receipt: existing, task: existingTask };
      }
      if (input.beforeCommitHook) {
        await input.beforeCommitHook();
      }
      tasks.set(input.task.taskId, { ...input.task });
      receipts.set(k, { ...input.receipt });
      intents.push({ ...input.dispatchIntent, payload: { ...(input.dispatchIntent.payload ?? {}) } });
      return { created: true, receipt: input.receipt, task: tasks.get(input.task.taskId)! };
    },
    async createFollowupAtomically(input) {
      const task = tasks.get(input.taskId);
      if (!task) {
        throw new EmployeeExpertsError("EXPERT_TASK_NOT_FOUND", "Task not found.");
      }
      const k = idempMapKey(input.receipt);
      const existing = receipts.get(k);
      if (existing) {
        return { created: false, receipt: existing, task };
      }
      if (TERMINAL_STATUSES.has(task.status)) {
        throw new EmployeeExpertsError("EXPERT_TASK_STATE_CONFLICT", "Cannot submit a followup to a terminal task.");
      }
      if (input.beforeCommitHook) {
        await input.beforeCommitHook();
      }
      task.runGeneration += 1;
      task.status = "queued";
      const receipt: IdempotencyReceiptRecord = {
        ...input.receipt,
        status: task.status,
        runGeneration: task.runGeneration,
      };
      receipts.set(k, receipt);
      const executionContext =
        input.executionContext ??
        buildIsolatedEmployeeTaskExecutionContext({
          taskId: task.taskId,
          runGeneration: task.runGeneration,
        });
      intents.push({
        taskId: task.taskId,
        orgId: task.orgId,
        expertId: task.expertId,
        runGeneration: task.runGeneration,
        kind: "followup",
        payload: {
          taskText: input.taskText,
          reuseRefs: [...input.reuseRefs],
          reuseRefSnapshots: input.reuseRefSnapshots ? [...input.reuseRefSnapshots] : [],
          executionContext,
          requestId: input.receipt.requestId,
        },
        status: "pending",
      });
      return { created: true, receipt, task };
    },
    async cancelTask(input) {
      const task = tasks.get(input.taskId);
      if (!task) return null;
      if (!TERMINAL_STATUSES.has(task.status)) {
        task.cancelRequested = true;
        if (!intents.some((i) => i.taskId === task.taskId && i.runGeneration === task.runGeneration && i.kind === "cancel")) {
          intents.push({
            taskId: task.taskId,
            orgId: input.orgId,
            expertId: input.expertId,
            runGeneration: task.runGeneration,
            kind: "cancel",
            payload: {},
            status: "pending",
          });
        }
      }
      return task;
    },
    async publishTaskResult(input) {
      const task = tasks.get(input.taskId);
      if (!task) {
        throw new EmployeeExpertsError("EXPERT_TASK_NOT_FOUND", "Task not found.");
      }
      if (input.runGeneration < task.runGeneration) {
        throw new EmployeeExpertsError(
          "EXPERT_TASK_STATE_CONFLICT",
          "Stale runGeneration update rejected by generation fence.",
        );
      }
      task.runId = input.runId;
      task.runGeneration = input.runGeneration;
      task.status = input.status;
      task.result = input.result;
      task.resultVersion += 1;
      if (input.sources) task.sources = [...input.sources];
      if (input.artifacts) task.artifacts = [...input.artifacts];
      return task;
    },
    async claimNextDispatchIntents(options) {
      const nowMs = (options.now ?? (() => Date.now()))();
      const limit = Math.max(1, options.limit ?? 10);
      const leaseDurationMs = Math.max(1_000, options.leaseDurationMs ?? DEFAULT_DISPATCH_LEASE_DURATION_MS);
      const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_DISPATCH_MAX_ATTEMPTS);
      const claimed: DispatchIntentRecord[] = [];
      const deadLettered: DispatchIntentRecord[] = [];

      for (const intent of intents) {
        if (claimed.length + deadLettered.length >= limit) break;
        const meta = readDispatchMeta(intent.payload, maxAttempts);
        const isPendingReady =
          intent.status === "pending" &&
          (!meta.nextAttemptAt || Date.parse(meta.nextAttemptAt) <= nowMs);
        const claimedExpiryMs = meta.leaseExpiresAt
          ? Date.parse(meta.leaseExpiresAt)
          : intent.claimedAt
            ? Date.parse(intent.claimedAt) + leaseDurationMs
            : 0;
        const isExpiredClaim = intent.status === "claimed" && claimedExpiryMs <= nowMs;
        if (!isPendingReady && !isExpiredClaim) continue;

        const nextAttempt = meta.attemptCount + 1;
        const effectiveMax = meta.maxAttempts || maxAttempts;
        if (nextAttempt > effectiveMax) {
          intent.status = "failed";
          intent.payload = withDispatchMeta(intent.payload, {
            ...meta,
            attemptCount: nextAttempt,
            maxAttempts: effectiveMax,
            leaseOwner: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            lastError: meta.lastError ?? "EXPERT_DISPATCH_MAX_ATTEMPTS_EXCEEDED",
          });
          deadLettered.push({ ...intent, payload: { ...intent.payload } });
          continue;
        }

        const nowIso = new Date(nowMs).toISOString();
        const leaseExpiresAt = new Date(nowMs + leaseDurationMs).toISOString();
        intent.status = "claimed";
        intent.claimedAt = nowIso;
        intent.payload = withDispatchMeta(intent.payload, {
          ...meta,
          attemptCount: nextAttempt,
          maxAttempts: effectiveMax,
          leaseOwner: options.workerId,
          leaseExpiresAt,
          nextAttemptAt: null,
        });
        claimed.push({ ...intent, payload: { ...intent.payload } });
      }
      return { claimed, deadLettered };
    },
    async renewDispatchIntentLease(input) {
      const nowMs = (input.now ?? (() => Date.now()))();
      const leaseDurationMs = Math.max(1_000, input.leaseDurationMs ?? DEFAULT_DISPATCH_LEASE_DURATION_MS);
      const intent = intents.find((i) => matchesIntentKey(i, input));
      if (!intent || intent.status !== "claimed") return false;
      const meta = readDispatchMeta(intent.payload, DEFAULT_DISPATCH_MAX_ATTEMPTS);
      if (meta.leaseOwner !== input.workerId) return false;
      intent.payload = withDispatchMeta(intent.payload, {
        ...meta,
        leaseExpiresAt: new Date(nowMs + leaseDurationMs).toISOString(),
      });
      return true;
    },
    async markDispatchIntentDispatched(input) {
      const nowMs = (input.now ?? (() => Date.now()))();
      const intent = intents.find((i) => matchesIntentKey(i, input));
      const task = tasks.get(input.taskId);
      if (!intent || !task || intent.status !== "claimed") return false;
      const meta = readDispatchMeta(intent.payload, DEFAULT_DISPATCH_MAX_ATTEMPTS);
      if (meta.leaseOwner !== input.workerId) return false;
      if (task.runGeneration !== input.runGeneration || task.cancelRequested) return false;

      intent.status = "dispatched";
      intent.dispatchedAt = new Date(nowMs).toISOString();
      intent.payload = withDispatchMeta(intent.payload, {
        ...meta,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      task.runId = input.runId;
      task.status = "running";
      return true;
    },
    async completeDispatchIntent(input) {
      const intent = intents.find((i) => matchesIntentKey(i, input));
      if (!intent) return;
      const meta = readDispatchMeta(intent.payload, DEFAULT_DISPATCH_MAX_ATTEMPTS);
      intent.status = input.status;
      intent.payload = withDispatchMeta(intent.payload, {
        ...meta,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        ...(input.lastError ? { lastError: input.lastError } : {}),
      });
    },
    async requeueDispatchIntentWithBackoff(input) {
      const intent = intents.find((i) => matchesIntentKey(i, input));
      if (!intent || intent.status !== "claimed") return;
      const meta = readDispatchMeta(intent.payload, DEFAULT_DISPATCH_MAX_ATTEMPTS);
      if (meta.leaseOwner !== input.workerId) return;
      intent.status = "pending";
      intent.payload = withDispatchMeta(intent.payload, {
        ...meta,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: input.nextAttemptAt,
        lastError: input.lastError,
      });
    },
    async listDispatchIntents(taskId) {
      return taskId ? intents.filter((i) => i.taskId === taskId) : [...intents];
    },
    async listAllTasks() {
      return Array.from(tasks.values());
    },
  };
}

/**
 * Production PostgreSQL single-transaction store for CORP-DSH-EXPERT-001 §7.1–§7.2
 * and Stage B3-1 Dispatch Intent Worker leasing (`FOR UPDATE SKIP LOCKED`).
 */
export function createPgEmployeeExpertsStore(db: Db): EmployeeExpertsStore {
  async function findReceiptTx(
    tx: Pick<Db, "select">,
    key: {
      orgId: string;
      issuer: string;
      subject: string;
      op: "create_task" | "followup";
      requestId: string;
    },
  ): Promise<IdempotencyReceiptRecord | null> {
    const rows = await tx
      .select()
      .from(employeeExpertIdempotencyReceipts)
      .where(
        and(
          eq(employeeExpertIdempotencyReceipts.orgId, key.orgId),
          eq(employeeExpertIdempotencyReceipts.issuer, key.issuer),
          eq(employeeExpertIdempotencyReceipts.subject, key.subject),
          eq(employeeExpertIdempotencyReceipts.op, key.op),
          eq(employeeExpertIdempotencyReceipts.requestId, key.requestId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      orgId: row.orgId,
      issuer: row.issuer,
      subject: row.subject,
      op: row.op as "create_task" | "followup",
      requestId: row.requestId,
      taskId: row.taskId,
      payloadDigest: row.payloadDigest,
      status: row.status as EmployeeExpertTaskStatus,
      runGeneration: row.runGeneration,
    };
  }

  return {
    async findIdempotencyReceipt(key) {
      return findReceiptTx(db, key);
    },

    async findTaskById(taskId) {
      const rows = await db
        .select()
        .from(employeeExpertTasks)
        .where(eq(employeeExpertTasks.taskId, taskId))
        .limit(1);
      return rows[0] ? rowToTaskRecord(rows[0]) : null;
    },

    async acceptTaskAtomically(input) {
      try {
        return await db.transaction(async (tx) => {
          const existing = await findReceiptTx(tx, input.receipt);
          if (existing) {
            const taskRows = await tx
              .select()
              .from(employeeExpertTasks)
              .where(eq(employeeExpertTasks.taskId, existing.taskId))
              .limit(1);
            if (!taskRows[0]) {
              throw new EmployeeExpertsError("EXPERT_TASK_NOT_FOUND", "Task is not accessible.");
            }
            return { created: false, receipt: existing, task: rowToTaskRecord(taskRows[0]) };
          }

          await tx.insert(employeeExpertTasks).values({
            taskId: input.task.taskId,
            orgId: input.task.orgId,
            instanceId: input.task.instanceId,
            issuer: input.task.issuer,
            responsibleUserId: input.task.responsibleUserId,
            visibility: "private",
            originClient: "dsh",
            originSessionRef: input.task.originSessionRef,
            expertId: input.task.expertId,
            delegationScope: input.task.delegationScope,
            requestId: input.task.requestId,
            payloadDigest: input.task.payloadDigest,
            taskText: input.task.taskText,
            reuseRefs: input.task.reuseRefs,
            status: input.task.status,
            acceptedAt: new Date(input.task.acceptedAt),
            runId: input.task.runId,
            runGeneration: input.task.runGeneration,
            resultVersion: input.task.resultVersion,
            cancelRequested: input.task.cancelRequested,
            result: input.task.result,
            sources: input.task.sources,
            artifacts: input.task.artifacts,
          });

          await tx.insert(employeeExpertIdempotencyReceipts).values({
            orgId: input.receipt.orgId,
            issuer: input.receipt.issuer,
            subject: input.receipt.subject,
            op: input.receipt.op,
            requestId: input.receipt.requestId,
            taskId: input.receipt.taskId,
            payloadDigest: input.receipt.payloadDigest,
            status: input.receipt.status,
            runGeneration: input.receipt.runGeneration,
          });

          await tx.insert(employeeExpertDispatchIntents).values({
            taskId: input.dispatchIntent.taskId,
            orgId: input.dispatchIntent.orgId,
            expertId: input.dispatchIntent.expertId,
            runGeneration: input.dispatchIntent.runGeneration,
            kind: input.dispatchIntent.kind,
            payload: input.dispatchIntent.payload,
            status: input.dispatchIntent.status,
          });

          if (input.beforeCommitHook) {
            await input.beforeCommitHook();
          }

          return { created: true, receipt: input.receipt, task: input.task };
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          const existing = await findReceiptTx(db, input.receipt);
          if (existing) {
            const taskRows = await db
              .select()
              .from(employeeExpertTasks)
              .where(eq(employeeExpertTasks.taskId, existing.taskId))
              .limit(1);
            if (taskRows[0]) {
              return { created: false, receipt: existing, task: rowToTaskRecord(taskRows[0]) };
            }
          }
        }
        throw err;
      }
    },

    async createFollowupAtomically(input) {
      try {
        return await db.transaction(async (tx) => {
          const existing = await findReceiptTx(tx, input.receipt);
          const taskRows = await tx
            .select()
            .from(employeeExpertTasks)
            .where(eq(employeeExpertTasks.taskId, input.taskId))
            .limit(1);
          const row = taskRows[0];
          if (!row) {
            throw new EmployeeExpertsError("EXPERT_TASK_NOT_FOUND", "Task not found.");
          }
          if (existing) {
            return { created: false, receipt: existing, task: rowToTaskRecord(row) };
          }
          if (TERMINAL_STATUSES.has(row.status as EmployeeExpertTaskStatus)) {
            throw new EmployeeExpertsError(
              "EXPERT_TASK_STATE_CONFLICT",
              "Cannot submit a followup to a terminal task.",
            );
          }

          const nextGeneration = row.runGeneration + 1;
          const [updated] = await tx
            .update(employeeExpertTasks)
            .set({
              runGeneration: nextGeneration,
              status: "queued",
              updatedAt: new Date(),
            })
            .where(eq(employeeExpertTasks.taskId, input.taskId))
            .returning();

          const receipt: IdempotencyReceiptRecord = {
            ...input.receipt,
            status: "queued",
            runGeneration: nextGeneration,
          };

          await tx.insert(employeeExpertIdempotencyReceipts).values({
            orgId: receipt.orgId,
            issuer: receipt.issuer,
            subject: receipt.subject,
            op: receipt.op,
            requestId: receipt.requestId,
            taskId: receipt.taskId,
            payloadDigest: receipt.payloadDigest,
            status: receipt.status,
            runGeneration: receipt.runGeneration,
          });

          const executionContext =
            input.executionContext ??
            buildIsolatedEmployeeTaskExecutionContext({
              taskId: input.taskId,
              runGeneration: nextGeneration,
            });

          await tx.insert(employeeExpertDispatchIntents).values({
            taskId: input.taskId,
            orgId: row.orgId,
            expertId: row.expertId,
            runGeneration: nextGeneration,
            kind: "followup",
            payload: {
              taskText: input.taskText,
              reuseRefs: [...input.reuseRefs],
              reuseRefSnapshots: input.reuseRefSnapshots ? [...input.reuseRefSnapshots] : [],
              executionContext,
              requestId: input.receipt.requestId,
            },
            status: "pending",
          });

          if (input.beforeCommitHook) {
            await input.beforeCommitHook();
          }

          return { created: true, receipt, task: rowToTaskRecord(updated ?? row) };
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          const existing = await findReceiptTx(db, input.receipt);
          if (existing) {
            const task = await db
              .select()
              .from(employeeExpertTasks)
              .where(eq(employeeExpertTasks.taskId, existing.taskId))
              .limit(1);
            if (task[0]) {
              return { created: false, receipt: existing, task: rowToTaskRecord(task[0]) };
            }
          }
        }
        throw err;
      }
    },

    async cancelTask(input) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(employeeExpertTasks)
          .where(eq(employeeExpertTasks.taskId, input.taskId))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        if (TERMINAL_STATUSES.has(row.status as EmployeeExpertTaskStatus)) {
          return rowToTaskRecord(row);
        }
        const [updated] = await tx
          .update(employeeExpertTasks)
          .set({ cancelRequested: true, updatedAt: new Date() })
          .where(eq(employeeExpertTasks.taskId, input.taskId))
          .returning();

        await tx
          .insert(employeeExpertDispatchIntents)
          .values({
            taskId: input.taskId,
            orgId: input.orgId,
            expertId: input.expertId,
            runGeneration: row.runGeneration,
            kind: "cancel",
            payload: {},
            status: "pending",
          })
          .onConflictDoNothing();

        return rowToTaskRecord(updated ?? row);
      });
    },

    async publishTaskResult(input) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(employeeExpertTasks)
          .where(eq(employeeExpertTasks.taskId, input.taskId))
          .limit(1);
        const row = rows[0];
        if (!row) {
          throw new EmployeeExpertsError("EXPERT_TASK_NOT_FOUND", "Task not found.");
        }
        if (input.runGeneration < row.runGeneration) {
          throw new EmployeeExpertsError(
            "EXPERT_TASK_STATE_CONFLICT",
            "Stale runGeneration update rejected by generation fence.",
          );
        }
        const [updated] = await tx
          .update(employeeExpertTasks)
          .set({
            runId: input.runId,
            runGeneration: input.runGeneration,
            status: input.status,
            result: input.result,
            resultVersion: row.resultVersion + 1,
            ...(input.sources ? { sources: [...input.sources] } : {}),
            ...(input.artifacts ? { artifacts: [...input.artifacts] } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(employeeExpertTasks.taskId, input.taskId),
              lte(employeeExpertTasks.runGeneration, input.runGeneration),
            ),
          )
          .returning();
        if (!updated) {
          throw new EmployeeExpertsError(
            "EXPERT_TASK_STATE_CONFLICT",
            "Stale runGeneration update rejected by generation fence.",
          );
        }
        return rowToTaskRecord(updated);
      });
    },

    async claimNextDispatchIntents(options) {
      const nowMs = (options.now ?? (() => Date.now()))();
      const nowDate = new Date(nowMs);
      const nowIso = nowDate.toISOString();
      const limit = Math.max(1, options.limit ?? 10);
      const leaseDurationMs = Math.max(1_000, options.leaseDurationMs ?? DEFAULT_DISPATCH_LEASE_DURATION_MS);
      const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_DISPATCH_MAX_ATTEMPTS);
      const expiredClaimBeforeIso = new Date(nowMs - leaseDurationMs).toISOString();

      return db.transaction(async (tx) => {
        const raw = await tx.execute(sql`
          SELECT id, task_id, org_id, expert_id, run_generation, kind, payload, status, claimed_at, dispatched_at
          FROM employee_expert_dispatch_intents
          WHERE (
            status = 'pending'
            AND (
              (payload->'_dispatchMeta'->>'nextAttemptAt') IS NULL
              OR (payload->'_dispatchMeta'->>'nextAttemptAt')::timestamptz <= ${nowIso}::timestamptz
            )
          ) OR (
            status = 'claimed'
            AND (
              CASE
                WHEN (payload->'_dispatchMeta'->>'leaseExpiresAt') IS NOT NULL
                  THEN (payload->'_dispatchMeta'->>'leaseExpiresAt')::timestamptz <= ${nowIso}::timestamptz
                ELSE claimed_at IS NULL OR claimed_at <= ${expiredClaimBeforeIso}::timestamptz
              END
            )
          )
          ORDER BY created_at ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        `);

        type SelectedIntentRow = {
          id: string;
          task_id: string;
          org_id: string;
          expert_id: string;
          run_generation: number;
          kind: "initial" | "followup" | "cancel";
          payload: Record<string, unknown> | null;
          status: DispatchIntentRecord["status"];
          claimed_at: Date | string | null;
          dispatched_at: Date | string | null;
        };

        const rows = extractExecuteRows<SelectedIntentRow>(raw);
        const claimed: DispatchIntentRecord[] = [];
        const deadLettered: DispatchIntentRecord[] = [];

        for (const row of rows) {
          const basePayload = (row.payload ?? {}) as Record<string, unknown>;
          const meta = readDispatchMeta(basePayload, maxAttempts);
          const nextAttempt = meta.attemptCount + 1;
          const effectiveMax = meta.maxAttempts || maxAttempts;

          if (nextAttempt > effectiveMax) {
            const updatedPayload = withDispatchMeta(basePayload, {
              ...meta,
              attemptCount: nextAttempt,
              maxAttempts: effectiveMax,
              leaseOwner: null,
              leaseExpiresAt: null,
              nextAttemptAt: null,
              lastError: meta.lastError ?? "EXPERT_DISPATCH_MAX_ATTEMPTS_EXCEEDED",
            });
            await tx
              .update(employeeExpertDispatchIntents)
              .set({ status: "failed", payload: updatedPayload, updatedAt: nowDate })
              .where(eq(employeeExpertDispatchIntents.id, row.id));
            deadLettered.push({
              id: row.id,
              taskId: row.task_id,
              orgId: row.org_id,
              expertId: row.expert_id,
              runGeneration: row.run_generation,
              kind: row.kind,
              payload: updatedPayload,
              status: "failed",
              claimedAt: row.claimed_at instanceof Date ? row.claimed_at.toISOString() : (row.claimed_at ?? null),
              dispatchedAt:
                row.dispatched_at instanceof Date ? row.dispatched_at.toISOString() : (row.dispatched_at ?? null),
            });
            continue;
          }

          const leaseExpiresAt = new Date(nowMs + leaseDurationMs).toISOString();
          const updatedPayload = withDispatchMeta(basePayload, {
            ...meta,
            attemptCount: nextAttempt,
            maxAttempts: effectiveMax,
            leaseOwner: options.workerId,
            leaseExpiresAt,
            nextAttemptAt: null,
          });
          await tx
            .update(employeeExpertDispatchIntents)
            .set({
              status: "claimed",
              claimedAt: nowDate,
              payload: updatedPayload,
              updatedAt: nowDate,
            })
            .where(eq(employeeExpertDispatchIntents.id, row.id));
          claimed.push({
            id: row.id,
            taskId: row.task_id,
            orgId: row.org_id,
            expertId: row.expert_id,
            runGeneration: row.run_generation,
            kind: row.kind,
            payload: updatedPayload,
            status: "claimed",
            claimedAt: nowIso,
            dispatchedAt:
              row.dispatched_at instanceof Date ? row.dispatched_at.toISOString() : (row.dispatched_at ?? null),
          });
        }

        return { claimed, deadLettered };
      });
    },

    async renewDispatchIntentLease(input) {
      const nowMs = (input.now ?? (() => Date.now()))();
      const leaseDurationMs = Math.max(1_000, input.leaseDurationMs ?? DEFAULT_DISPATCH_LEASE_DURATION_MS);
      const nextExpiryIso = new Date(nowMs + leaseDurationMs).toISOString();

      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(employeeExpertDispatchIntents)
          .where(
            and(
              eq(employeeExpertDispatchIntents.taskId, input.taskId),
              eq(employeeExpertDispatchIntents.runGeneration, input.runGeneration),
              eq(employeeExpertDispatchIntents.kind, input.kind),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row || row.status !== "claimed") return false;
        const meta = readDispatchMeta(row.payload, DEFAULT_DISPATCH_MAX_ATTEMPTS);
        if (meta.leaseOwner !== input.workerId) return false;
        const updatedPayload = withDispatchMeta(row.payload, {
          ...meta,
          leaseExpiresAt: nextExpiryIso,
        });
        await tx
          .update(employeeExpertDispatchIntents)
          .set({ payload: updatedPayload, updatedAt: new Date(nowMs) })
          .where(eq(employeeExpertDispatchIntents.id, row.id));
        return true;
      });
    },

    async markDispatchIntentDispatched(input) {
      const nowMs = (input.now ?? (() => Date.now()))();
      const nowDate = new Date(nowMs);
      return db.transaction(async (tx) => {
        const intentRows = await tx
          .select()
          .from(employeeExpertDispatchIntents)
          .where(
            and(
              eq(employeeExpertDispatchIntents.taskId, input.taskId),
              eq(employeeExpertDispatchIntents.runGeneration, input.runGeneration),
              eq(employeeExpertDispatchIntents.kind, input.kind),
            ),
          )
          .limit(1);
        const intentRow = intentRows[0];
        if (!intentRow || intentRow.status !== "claimed") return false;
        const meta = readDispatchMeta(intentRow.payload, DEFAULT_DISPATCH_MAX_ATTEMPTS);
        if (meta.leaseOwner !== input.workerId) return false;

        const [updatedTask] = await tx
          .update(employeeExpertTasks)
          .set({ runId: input.runId, status: "running", updatedAt: nowDate })
          .where(
            and(
              eq(employeeExpertTasks.taskId, input.taskId),
              eq(employeeExpertTasks.runGeneration, input.runGeneration),
              eq(employeeExpertTasks.cancelRequested, false),
            ),
          )
          .returning();
        if (!updatedTask) return false;

        const updatedPayload = withDispatchMeta(intentRow.payload, {
          ...meta,
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        await tx
          .update(employeeExpertDispatchIntents)
          .set({
            status: "dispatched",
            dispatchedAt: nowDate,
            payload: updatedPayload,
            updatedAt: nowDate,
          })
          .where(eq(employeeExpertDispatchIntents.id, intentRow.id));
        return true;
      });
    },

    async completeDispatchIntent(input) {
      const nowMs = (input.now ?? (() => Date.now()))();
      await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(employeeExpertDispatchIntents)
          .where(
            and(
              eq(employeeExpertDispatchIntents.taskId, input.taskId),
              eq(employeeExpertDispatchIntents.runGeneration, input.runGeneration),
              eq(employeeExpertDispatchIntents.kind, input.kind),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row) return;
        const meta = readDispatchMeta(row.payload, DEFAULT_DISPATCH_MAX_ATTEMPTS);
        const updatedPayload = withDispatchMeta(row.payload, {
          ...meta,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          ...(input.lastError ? { lastError: input.lastError } : {}),
        });
        await tx
          .update(employeeExpertDispatchIntents)
          .set({
            status: input.status,
            payload: updatedPayload,
            updatedAt: new Date(nowMs),
          })
          .where(eq(employeeExpertDispatchIntents.id, row.id));
      });
    },

    async requeueDispatchIntentWithBackoff(input) {
      const nowMs = (input.now ?? (() => Date.now()))();
      await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(employeeExpertDispatchIntents)
          .where(
            and(
              eq(employeeExpertDispatchIntents.taskId, input.taskId),
              eq(employeeExpertDispatchIntents.runGeneration, input.runGeneration),
              eq(employeeExpertDispatchIntents.kind, input.kind),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row || row.status !== "claimed") return;
        const meta = readDispatchMeta(row.payload, DEFAULT_DISPATCH_MAX_ATTEMPTS);
        if (meta.leaseOwner !== input.workerId) return;
        const updatedPayload = withDispatchMeta(row.payload, {
          ...meta,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: input.nextAttemptAt,
          lastError: input.lastError,
        });
        await tx
          .update(employeeExpertDispatchIntents)
          .set({
            status: "pending",
            payload: updatedPayload,
            updatedAt: new Date(nowMs),
          })
          .where(eq(employeeExpertDispatchIntents.id, row.id));
      });
    },

    async listDispatchIntents(taskId) {
      const rows = taskId
        ? await db
            .select()
            .from(employeeExpertDispatchIntents)
            .where(eq(employeeExpertDispatchIntents.taskId, taskId))
        : await db.select().from(employeeExpertDispatchIntents);
      return rows.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        orgId: row.orgId,
        expertId: row.expertId,
        runGeneration: row.runGeneration,
        kind: row.kind as "initial" | "followup" | "cancel",
        payload: (row.payload ?? {}) as Record<string, unknown>,
        status: row.status as DispatchIntentRecord["status"],
        claimedAt: row.claimedAt instanceof Date ? row.claimedAt.toISOString() : null,
        dispatchedAt: row.dispatchedAt instanceof Date ? row.dispatchedAt.toISOString() : null,
      }));
    },

    async listAllTasks() {
      const rows = await db.select().from(employeeExpertTasks);
      return rows.map(rowToTaskRecord);
    },
  };
}

/**
 * Generates a non-reusable SHA-256 authContinuityDigest for (org, issuer, subject, expert, epoch).
 */
export function mintAuthContinuityDigest(input: {
  orgId: string;
  issuer: string;
  subject: string;
  expertId: string;
  epoch: number;
  nonce?: string;
}): string {
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  const digest = createHash("sha256")
    .update(`${input.orgId}|${input.issuer}|${input.subject}|${input.expertId}|${input.epoch}|${nonce}`)
    .digest("hex")
    .slice(0, 32);
  return `sha256:${digest}`;
}

/**
 * Maintains per-(orgId, issuer, subject, expertId) authContinuityDigest semantics (§5):
 * - Stable across single-project scope changes while org-level callable remains true.
 * - Invalidated (active=false, returns null) when org-level callable is revoked.
 * - Rotated to a fresh, non-reusable digest when re-granted after full revocation.
 */
export async function reconcileAuthContinuityDigest(
  db: Db,
  input: {
    orgId: string;
    issuer: string;
    subject: string;
    expertId: string;
    callableInOrg: boolean;
  },
): Promise<string | null> {
  const existingRows = await db
    .select()
    .from(employeeExpertAuthContinuity)
    .where(
      and(
        eq(employeeExpertAuthContinuity.orgId, input.orgId),
        eq(employeeExpertAuthContinuity.issuer, input.issuer),
        eq(employeeExpertAuthContinuity.subject, input.subject),
        eq(employeeExpertAuthContinuity.expertId, input.expertId),
      ),
    )
    .limit(1);
  const existing = existingRows[0];

  if (!input.callableInOrg) {
    if (existing && existing.active) {
      await db
        .update(employeeExpertAuthContinuity)
        .set({ active: false, revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(employeeExpertAuthContinuity.id, existing.id));
    }
    return null;
  }

  if (existing && existing.active) {
    return existing.continuityDigest;
  }

  if (existing && !existing.active) {
    const nextEpoch = existing.epoch + 1;
    const rotatedDigest = mintAuthContinuityDigest({ ...input, epoch: nextEpoch });
    await db
      .update(employeeExpertAuthContinuity)
      .set({
        active: true,
        epoch: nextEpoch,
        continuityDigest: rotatedDigest,
        revokedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(employeeExpertAuthContinuity.id, existing.id));
    return rotatedDigest;
  }

  const initialDigest = mintAuthContinuityDigest({ ...input, epoch: 1 });
  await db
    .insert(employeeExpertAuthContinuity)
    .values({
      orgId: input.orgId,
      issuer: input.issuer,
      subject: input.subject,
      expertId: input.expertId,
      continuityDigest: initialDigest,
      active: true,
      epoch: 1,
    })
    .onConflictDoNothing();

  const reread = await db
    .select()
    .from(employeeExpertAuthContinuity)
    .where(
      and(
        eq(employeeExpertAuthContinuity.orgId, input.orgId),
        eq(employeeExpertAuthContinuity.issuer, input.issuer),
        eq(employeeExpertAuthContinuity.subject, input.subject),
        eq(employeeExpertAuthContinuity.expertId, input.expertId),
      ),
    )
    .limit(1);
  return reread[0]?.active ? reread[0].continuityDigest : initialDigest;
}

function mapAgentAcceptingState(agent: typeof agents.$inferSelect): {
  acceptingTasks: ExpertAcceptingState;
  reason: string | null;
} {
  if (agent.status === "paused" || agent.pausedAt) {
    return { acceptingTasks: "paused", reason: agent.pauseReason ?? "Agent is paused" };
  }
  if (agent.status === "terminated" || agent.status === "error" || agent.lifecycleState !== "ready") {
    return {
      acceptingTasks: "unavailable",
      reason: agent.errorReason ?? `Agent lifecycle is ${agent.lifecycleState}`,
    };
  }
  return { acceptingTasks: "accepting", reason: null };
}

function mapAgentSummary(agent: typeof agents.$inferSelect): EmployeeExpertRecord["summary"] {
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  const rawDisclosure = metadata.disclosureState;
  const disclosureState: ExpertDisclosureState =
    rawDisclosure === "available" ||
    rawDisclosure === "missing" ||
    rawDisclosure === "stale" ||
    rawDisclosure === "restricted"
      ? rawDisclosure
      : agent.capabilities
        ? "available"
        : "missing";
  const toolScope = Array.isArray(metadata.toolScope)
    ? metadata.toolScope.filter((x): x is string => typeof x === "string")
    : [];
  const capabilityList = Array.isArray(metadata.capabilityTags)
    ? metadata.capabilityTags.filter((x): x is string => typeof x === "string")
    : agent.capabilities
      ? [agent.capabilities]
      : [];

  return {
    disclosureState,
    responsibility: disclosureState === "restricted" ? null : (agent.capabilities ?? agent.title ?? null),
    capabilities: disclosureState === "restricted" ? [] : capabilityList,
    toolScope: disclosureState === "restricted" ? [] : toolScope,
    updatedAt: agent.updatedAt instanceof Date ? agent.updatedAt.toISOString() : null,
  };
}

/**
 * Creates production PostgreSQL-backed listOrgExperts and checkSessionScope
 * adapters implementing CORP-DSH-EXPERT-001 §3–§5.
 */
export function createPgEmployeeExpertsAdapters(db: Db) {
  async function resolveUserId(issuer: string, subject: string): Promise<string> {
    const rows = await db
      .select({ userId: authAccounts.userId })
      .from(authAccounts)
      .where(and(eq(authAccounts.issuer, issuer), eq(authAccounts.accountId, subject)))
      .limit(1);
    return rows[0]?.userId ?? subject;
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  async function listOrgExperts(params: {
    orgId: string;
    issuer: string;
    subject: string;
  }): Promise<{ catalogVersion: string; completeness: CatalogCompleteness; items: EmployeeExpertRecord[] }> {
    if (!UUID_RE.test(params.orgId)) {
      return { catalogVersion: "cv_empty", completeness: "complete", items: [] };
    }
    const userId = await resolveUserId(params.issuer, params.subject);

    const [orgAgents, memberships, grants] = await Promise.all([
      db.select().from(agents).where(eq(agents.companyId, params.orgId)),
      db
        .select()
        .from(agentMemberships)
        .where(
          and(
            eq(agentMemberships.companyId, params.orgId),
            eq(agentMemberships.userId, userId),
          ),
        ),
      db
        .select()
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, params.orgId),
            eq(principalPermissionGrants.principalType, "user"),
            eq(principalPermissionGrants.principalId, userId),
          ),
        ),
    ]);

    const joinedAgentIds = new Set(
      memberships.filter((m) => m.state === "joined").map((m) => m.agentId),
    );
    const hasOrgAssignGrant = grants.some(
      (g) => g.permissionKey === "tasks:assign" || g.permissionKey === "agents:invoke",
    );
    const hasOrgReadGrant =
      hasOrgAssignGrant || grants.some((g) => g.permissionKey === "agents:read");

    const nameCounts = new Map<string, number>();
    for (const a of orgAgents) {
      nameCounts.set(a.name, (nameCounts.get(a.name) ?? 0) + 1);
    }

    const items: EmployeeExpertRecord[] = [];
    for (const agent of orgAgents) {
      const isJoined = joinedAgentIds.has(agent.id);
      const readable = isJoined || hasOrgReadGrant;
      if (!readable) continue;

      const callableInOrg = isJoined || hasOrgAssignGrant;
      const callableReason: ExpertCallableReason = callableInOrg ? "granted" : "view_only";
      const authContinuityDigest = await reconcileAuthContinuityDigest(db, {
        orgId: params.orgId,
        issuer: params.issuer,
        subject: params.subject,
        expertId: agent.id,
        callableInOrg,
      });

      const needsDisambiguation = (nameCounts.get(agent.name) ?? 0) > 1;
      const disambiguation =
        agent.title?.trim() || (needsDisambiguation ? `${agent.role} · ${agent.id.slice(0, 8)}` : null);

      items.push({
        expertId: agent.id,
        displayName: agent.name,
        disambiguation,
        summary: mapAgentSummary(agent),
        access: {
          readable: true,
          callableInOrg,
          callableReason,
          authContinuityDigest,
        },
        availability: mapAgentAcceptingState(agent),
      });
    }

    const versionHash = createHash("sha256")
      .update(
        items
          .map((i) => `${i.expertId}:${i.displayName}:${i.access.callableInOrg}:${i.availability.acceptingTasks}`)
          .sort()
          .join("|"),
      )
      .digest("hex")
      .slice(0, 12);

    return {
      catalogVersion: `cv_${versionHash}`,
      completeness: "complete",
      items,
    };
  }

  async function checkSessionScope(params: {
    orgId: string;
    issuer: string;
    subject: string;
    delegationScope: string;
    expertIds: string[];
  }): Promise<{ scopeVerified: boolean; results: EmployeeScopeCheckItem[] }> {
    const cleanScope = params.delegationScope.trim();
    if (!cleanScope) {
      return { scopeVerified: false, results: [] };
    }

    const userId = await resolveUserId(params.issuer, params.subject);
    const projectMatch = /^project:(.+)$/i.exec(cleanScope);
    const isOrgDefaultScope = cleanScope === `org:${params.orgId}`;

    if (!UUID_RE.test(params.orgId)) {
      return { scopeVerified: false, results: [] };
    }
    if (projectMatch) {
      const projectId = projectMatch[1]!.trim();
      if (!UUID_RE.test(projectId)) {
        return { scopeVerified: false, results: [] };
      }
      const projMember = await db
        .select({ id: projectMemberships.id })
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.companyId, params.orgId),
            eq(projectMemberships.projectId, projectId),
            eq(projectMemberships.userId, userId),
          ),
        )
        .limit(1);
      if (projMember.length === 0) {
        return { scopeVerified: false, results: [] };
      }
    } else if (!isOrgDefaultScope) {
      // Fail-closed: unknown or unverified delegationScope evidence never falls back to org-wide allow.
      return { scopeVerified: false, results: [] };
    }

    const catalog = await listOrgExperts({
      orgId: params.orgId,
      issuer: params.issuer,
      subject: params.subject,
    });
    const byId = new Map(catalog.items.map((item) => [item.expertId, item]));
    const results: EmployeeScopeCheckItem[] = params.expertIds.map((expertId) => {
      const found = byId.get(expertId);
      if (!found) {
        return {
          expertId,
          callableInScope: false,
          callableReason: "org_restricted",
          acceptingTasks: "unknown",
          authContinuityDigest: null,
        };
      }
      return {
        expertId,
        callableInScope: found.access.callableInOrg,
        callableReason: found.access.callableReason,
        acceptingTasks: found.availability.acceptingTasks,
        authContinuityDigest: found.access.authContinuityDigest,
      };
    });

    return { scopeVerified: true, results };
  }

  return {
    listOrgExperts,
    checkSessionScope,
  };
}
