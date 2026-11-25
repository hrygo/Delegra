import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createInMemoryEmployeeExpertsStore,
  type DispatchIntentRecord,
  type EmployeeExpertsStore,
} from "./employee-experts-store.js";

export type EmployeeExpertErrorCode =
  | "EXPERT_AUTH_INVALID"
  | "EXPERT_AUTH_REVOKED"
  | "EXPERT_ORG_FORBIDDEN"
  | "EXPERT_SCOPE_MISMATCH"
  | "EXPERT_CALL_FORBIDDEN"
  | "EXPERT_NOT_FOUND"
  | "EXPERT_TASK_NOT_FOUND"
  | "EXPERT_CURSOR_STALE"
  | "EXPERT_SCOPE_UNVERIFIED"
  | "EXPERT_NOT_ACCEPTING"
  | "EXPERT_IDEMPOTENCY_CONFLICT"
  | "EXPERT_TASK_STATE_CONFLICT"
  | "EXPERT_REQUEST_INVALID"
  | "EXPERT_REQUEST_TOO_LARGE"
  | "EXPERT_RATE_LIMITED"
  | "EXPERT_DIRECTORY_UNAVAILABLE"
  | "EXPERT_ISOLATION_UNVERIFIED"
  | "EXPERT_ACCEPTANCE_UNKNOWN"
  | "EXPERT_INTERNAL_ERROR";

export const EMPLOYEE_EXPERT_ERROR_STATUS: Readonly<Record<EmployeeExpertErrorCode, number>> = {
  EXPERT_AUTH_INVALID: 401,
  EXPERT_AUTH_REVOKED: 401,
  EXPERT_ORG_FORBIDDEN: 403,
  EXPERT_SCOPE_MISMATCH: 403,
  EXPERT_CALL_FORBIDDEN: 403,
  EXPERT_NOT_FOUND: 404,
  EXPERT_TASK_NOT_FOUND: 404,
  EXPERT_CURSOR_STALE: 409,
  EXPERT_SCOPE_UNVERIFIED: 409,
  EXPERT_NOT_ACCEPTING: 409,
  EXPERT_IDEMPOTENCY_CONFLICT: 409,
  EXPERT_TASK_STATE_CONFLICT: 409,
  EXPERT_REQUEST_INVALID: 422,
  EXPERT_REQUEST_TOO_LARGE: 413,
  EXPERT_RATE_LIMITED: 429,
  EXPERT_DIRECTORY_UNAVAILABLE: 503,
  EXPERT_ISOLATION_UNVERIFIED: 503,
  EXPERT_ACCEPTANCE_UNKNOWN: 503,
  EXPERT_INTERNAL_ERROR: 500,
};

export class EmployeeExpertsError extends Error {
  readonly code: EmployeeExpertErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestTraceId: string;

  constructor(
    code: EmployeeExpertErrorCode,
    message: string,
    opts?: { status?: number; retryable?: boolean; requestTraceId?: string },
  ) {
    super(message);
    this.name = "EmployeeExpertsError";
    this.code = code;
    this.status = opts?.status ?? EMPLOYEE_EXPERT_ERROR_STATUS[code];
    this.retryable = opts?.retryable ?? (this.status === 429 || this.status === 503);
    this.requestTraceId = opts?.requestTraceId ?? `trace_${randomUUID()}`;
  }

  toEnvelope() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        requestTraceId: this.requestTraceId,
      },
    };
  }
}

export interface EmployeeCredentialContext {
  instanceId: string;
  orgId: string;
  issuer: string;
  subject: string;
  verifiedAt: string;
  validUntil: string;
  activeOrgIds?: readonly string[];
  revoked?: boolean;
  auditAuthorized?: boolean;
}

export interface EmployeeScopeEnvelope {
  instanceId: string;
  orgId: string;
  issuer: string;
  subject: string;
  verifiedAt: string;
  validUntil: string;
}

export type ExpertDisclosureState = "available" | "missing" | "stale" | "restricted";
export type ExpertCallableReason = "granted" | "view_only" | "org_restricted" | "revoked" | "unknown";
export type ExpertAcceptingState = "accepting" | "paused" | "unavailable" | "unknown";
export type CatalogCompleteness = "complete" | "partial" | "truncated" | "unknown";

export interface EmployeeExpertRecord {
  expertId: string;
  displayName: string;
  disambiguation: string | null;
  summary: {
    disclosureState: ExpertDisclosureState;
    responsibility: string | null;
    capabilities: string[];
    toolScope: string[];
    updatedAt: string | null;
  };
  access: {
    readable: boolean;
    callableInOrg: boolean;
    callableReason: ExpertCallableReason;
    authContinuityDigest: string | null;
  };
  availability: {
    acceptingTasks: ExpertAcceptingState;
    reason: string | null;
  };
}

export interface EmployeeScopeCheckItem {
  expertId: string;
  callableInScope: boolean;
  callableReason: ExpertCallableReason;
  acceptingTasks: ExpertAcceptingState;
  authContinuityDigest: string | null;
}

export type EmployeeExpertTaskStatus =
  | "accepted"
  | "queued"
  | "running"
  | "waiting_user"
  | "completed"
  | "failed"
  | "cancelled";

export interface EmployeeExpertTaskRecord {
  taskId: string;
  orgId: string;
  instanceId: string;
  issuer: string;
  responsibleUserId: string;
  visibility: "private";
  originClient: "dsh";
  originSessionRef: string | null;
  expertId: string;
  delegationScope: string;
  requestId: string;
  payloadDigest: string;
  taskText: string;
  reuseRefs: string[];
  status: EmployeeExpertTaskStatus;
  acceptedAt: string;
  runId: string | null;
  runGeneration: number;
  resultVersion: number;
  cancelRequested: boolean;
  result: unknown;
  sources: string[];
  artifacts: Array<{ id: string; label?: string; url?: string }>;
}

export interface EmployeeExpertsServiceOptions {
  /** Verifies an RFC 8693 exchanged employee bearer token. Fail-closed when unset. */
  verifyCredential?: (bearerToken: string) => Promise<EmployeeCredentialContext | null> | EmployeeCredentialContext | null;
  /** Returns experts visible to the employee in the requested organization. */
  listOrgExperts?: (params: {
    orgId: string;
    issuer: string;
    subject: string;
  }) => Promise<{ catalogVersion?: string; completeness?: CatalogCompleteness; items: EmployeeExpertRecord[] }>;
  /** Verifies session-level delegation scope eligibility for the given expertIds. */
  checkSessionScope?: (params: {
    orgId: string;
    issuer: string;
    subject: string;
    delegationScope: string;
    expertIds: string[];
  }) => Promise<{ scopeVerified: boolean; results: EmployeeScopeCheckItem[] }>;
  /** Returns true when cross-task context isolation is verified by the target runner. */
  isIsolationVerified?: () => boolean;
  /** Optional durable persistence store (PostgreSQL in production; in-memory by default). */
  store?: EmployeeExpertsStore;
  /** Optional durable dispatch callback executed after atomic task commit. */
  onTaskAccepted?: (task: EmployeeExpertTaskRecord) => Promise<void> | void;
  /** Optional hook injected before transaction commit (for rollback fault-injection tests). */
  beforeTaskCommit?: () => Promise<void> | void;
  /** Optional explicit audit subjects allowed to read private tasks under compliance policy. */
  auditSubjects?: ReadonlySet<string>;
  /** Optional HMAC secret for signing opaque pagination cursors. */
  cursorSecret?: string;
  /** Clock override for deterministic testing. */
  now?: () => number;
}

export const MAX_SCOPE_CHECK_EXPERTS = 100;
const TERMINAL_TASK_STATUSES = new Set<EmployeeExpertTaskStatus>(["completed", "failed", "cancelled"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toScopeEnvelope(cred: EmployeeCredentialContext): EmployeeScopeEnvelope {
  return {
    instanceId: cred.instanceId,
    orgId: cred.orgId,
    issuer: cred.issuer,
    subject: cred.subject,
    verifiedAt: cred.verifiedAt,
    validUntil: cred.validUntil,
  };
}

/**
 * Private task ACL predicate enforced across both employee-scoped and generic
 * list/detail/event surfaces (CORP-DSH-EXPERT-001 §6.1).
 */
export function isPrivateTaskVisibleTo(
  task: Pick<EmployeeExpertTaskRecord, "visibility" | "orgId" | "issuer" | "responsibleUserId">,
  viewer: Pick<EmployeeCredentialContext, "orgId" | "issuer" | "subject" | "auditAuthorized">,
  auditSubjects?: ReadonlySet<string>,
): boolean {
  if (task.orgId !== viewer.orgId) return false;
  if (task.visibility !== "private") return true;
  if (task.issuer === viewer.issuer && task.responsibleUserId === viewer.subject) return true;
  if (viewer.auditAuthorized === true) return true;
  if (auditSubjects && auditSubjects.has(viewer.subject)) return true;
  return false;
}

export function filterVisibleEmployeeTasks<
  T extends Pick<EmployeeExpertTaskRecord, "visibility" | "orgId" | "issuer" | "responsibleUserId">,
>(
  tasks: readonly T[],
  viewer: Pick<EmployeeCredentialContext, "orgId" | "issuer" | "subject" | "auditAuthorized">,
  auditSubjects?: ReadonlySet<string>,
): T[] {
  return tasks.filter((task) => isPrivateTaskVisibleTo(task, viewer, auditSubjects));
}

export function createEmployeeExpertsService(options: EmployeeExpertsServiceOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const cursorSecret = options.cursorSecret ?? randomUUID();
  const auditSubjects = options.auditSubjects;
  const store = options.store ?? createInMemoryEmployeeExpertsStore();

  // In-memory mirror kept in sync for synchronous unit-test helpers.
  const tasksById = new Map<string, EmployeeExpertTaskRecord>();

  function signCursor(payload: Record<string, unknown>): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = createHmac("sha256", cursorSecret).update(encoded).digest("base64url");
    return `${encoded}.${sig}`;
  }

  function verifyCursor(
    cursor: string,
    expected: {
      instanceId: string;
      orgId: string;
      issuer: string;
      subject: string;
      view: string;
      query: string;
      catalogVersion: string;
    },
  ): number {
    const dot = cursor.indexOf(".");
    if (dot <= 0) {
      throw new EmployeeExpertsError("EXPERT_CURSOR_STALE", "Catalog cursor is invalid or stale.");
    }
    const encoded = cursor.slice(0, dot);
    const sig = cursor.slice(dot + 1);
    const expectedSig = createHmac("sha256", cursorSecret).update(encoded).digest("base64url");
    const bufA = Buffer.from(sig, "utf8");
    const bufB = Buffer.from(expectedSig, "utf8");
    if (bufA.length !== bufB.length || !timingSafeEqual(bufA, bufB)) {
      throw new EmployeeExpertsError("EXPERT_CURSOR_STALE", "Catalog cursor signature is invalid.");
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new EmployeeExpertsError("EXPERT_CURSOR_STALE", "Catalog cursor payload is malformed.");
    }
    if (
      parsed.instanceId !== expected.instanceId ||
      parsed.orgId !== expected.orgId ||
      parsed.issuer !== expected.issuer ||
      parsed.subject !== expected.subject ||
      parsed.view !== expected.view ||
      parsed.query !== expected.query ||
      parsed.catalogVersion !== expected.catalogVersion ||
      typeof parsed.offset !== "number" ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new EmployeeExpertsError(
        "EXPERT_CURSOR_STALE",
        "Catalog cursor does not match the active scope, query, or catalog version.",
      );
    }
    return parsed.offset;
  }

  /**
   * Fixed verification order per CORP-DSH-EXPERT-001 §2.1:
   * 1) issuer/audience & signature -> 401 EXPERT_AUTH_INVALID
   * 2) expiry & revocation         -> 401 EXPERT_AUTH_REVOKED
   * 3) org membership              -> 403 EXPERT_ORG_FORBIDDEN
   * 4) instance & org binding      -> 403 EXPERT_SCOPE_MISMATCH
   */
  async function authenticate(
    bearerToken: string | null,
    requestedOrgId: string | undefined,
  ): Promise<EmployeeCredentialContext> {
    if (!bearerToken || !options.verifyCredential) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "Valid employee bearer credential is required.");
    }
    let cred: EmployeeCredentialContext | null;
    try {
      cred = await options.verifyCredential(bearerToken);
    } catch (err) {
      if (err instanceof EmployeeExpertsError) throw err;
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "Unable to verify employee credential.");
    }
    if (
      !cred ||
      !isNonEmptyString(cred.instanceId) ||
      !isNonEmptyString(cred.orgId) ||
      !isNonEmptyString(cred.issuer) ||
      !isNonEmptyString(cred.subject)
    ) {
      throw new EmployeeExpertsError("EXPERT_AUTH_INVALID", "Employee credential is invalid.");
    }
    if (cred.revoked === true) {
      throw new EmployeeExpertsError("EXPERT_AUTH_REVOKED", "Employee credential has been revoked.");
    }
    const validUntilMs = Date.parse(cred.validUntil);
    if (!Number.isFinite(validUntilMs) || validUntilMs <= now()) {
      throw new EmployeeExpertsError("EXPERT_AUTH_REVOKED", "Employee credential has expired.");
    }
    if (requestedOrgId !== undefined) {
      const cleanOrgId = requestedOrgId.trim();
      if (!cleanOrgId) {
        throw new EmployeeExpertsError("EXPERT_REQUEST_INVALID", "orgId must be a non-empty string.");
      }
      if (Array.isArray(cred.activeOrgIds) && !cred.activeOrgIds.includes(cleanOrgId)) {
        throw new EmployeeExpertsError("EXPERT_ORG_FORBIDDEN", "Employee is not a member of the requested organization.");
      }
      if (cleanOrgId !== cred.orgId) {
        throw new EmployeeExpertsError(
          "EXPERT_SCOPE_MISMATCH",
          "Credential organization scope does not match the requested orgId.",
        );
      }
    }
    return cred;
  }

  async function listExperts(input: {
    bearerToken: string | null;
    orgId: string;
    view: string;
    query?: string;
    cursor?: string;
    limit?: number;
  }) {
    const cred = await authenticate(input.bearerToken, input.orgId);
    if (input.view !== "directory" && input.view !== "callable") {
      throw new EmployeeExpertsError("EXPERT_REQUEST_INVALID", "view must be 'directory' or 'callable'.");
    }
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new EmployeeExpertsError("EXPERT_REQUEST_INVALID", "limit must be an integer between 1 and 100.");
    }
    if (!options.listOrgExperts) {
      throw new EmployeeExpertsError("EXPERT_DIRECTORY_UNAVAILABLE", "Expert directory source is not configured.");
    }

    const rawCatalog = await options.listOrgExperts({
      orgId: cred.orgId,
      issuer: cred.issuer,
      subject: cred.subject,
    });
    const catalogVersion = rawCatalog.catalogVersion ?? "cv_default";
    const cleanQuery = (input.query ?? "").trim();

    let offset = 0;
    if (isNonEmptyString(input.cursor)) {
      offset = verifyCursor(input.cursor.trim(), {
        instanceId: cred.instanceId,
        orgId: cred.orgId,
        issuer: cred.issuer,
        subject: cred.subject,
        view: input.view,
        query: cleanQuery,
        catalogVersion,
      });
    }

    const authorized = rawCatalog.items.filter((item) => {
      if (!item.access.readable) return false;
      if (input.view === "callable" && !item.access.callableInOrg) return false;
      if (cleanQuery) {
        const q = cleanQuery.toLowerCase();
        const haystack = [
          item.expertId,
          item.displayName,
          item.disambiguation ?? "",
          item.summary.responsibility ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    const pageItems = authorized.slice(offset, offset + limit);
    const nextOffset = offset + pageItems.length;
    const hasMore = nextOffset < authorized.length;
    const nextCursor = hasMore
      ? signCursor({
          instanceId: cred.instanceId,
          orgId: cred.orgId,
          issuer: cred.issuer,
          subject: cred.subject,
          view: input.view,
          query: cleanQuery,
          catalogVersion,
          offset: nextOffset,
        })
      : null;

    return {
      scope: toScopeEnvelope(cred),
      catalogVersion,
      completeness: rawCatalog.completeness ?? "complete",
      coveredScopes: [cred.orgId],
      items: pageItems,
      page: {
        nextCursor,
        hasMore,
      },
    };
  }

  async function scopeCheck(input: {
    bearerToken: string | null;
    orgId: string;
    delegationScope: string;
    expertIds: unknown;
  }) {
    const cred = await authenticate(input.bearerToken, input.orgId);
    if (!isNonEmptyString(input.delegationScope)) {
      throw new EmployeeExpertsError("EXPERT_SCOPE_UNVERIFIED", "delegationScope evidence is missing or unverified.");
    }
    if (!Array.isArray(input.expertIds) || input.expertIds.some((id) => !isNonEmptyString(id))) {
      throw new EmployeeExpertsError("EXPERT_REQUEST_INVALID", "expertIds must be an array of non-empty strings.");
    }
    if (input.expertIds.length > MAX_SCOPE_CHECK_EXPERTS) {
      throw new EmployeeExpertsError(
        "EXPERT_REQUEST_TOO_LARGE",
        `scope-check accepts at most ${MAX_SCOPE_CHECK_EXPERTS} expertIds.`,
      );
    }
    if (!options.checkSessionScope) {
      throw new EmployeeExpertsError("EXPERT_DIRECTORY_UNAVAILABLE", "Session scope verifier is not configured.");
    }

    const result = await options.checkSessionScope({
      orgId: cred.orgId,
      issuer: cred.issuer,
      subject: cred.subject,
      delegationScope: input.delegationScope.trim(),
      expertIds: (input.expertIds as string[]).map((id) => id.trim()),
    });
    if (result.scopeVerified !== true) {
      throw new EmployeeExpertsError("EXPERT_SCOPE_UNVERIFIED", "Session delegation scope could not be verified.");
    }

    return {
      scope: toScopeEnvelope(cred),
      scopeVerified: true as const,
      results: result.results,
    };
  }

  async function createTask(input: {
    bearerToken: string | null;
    orgId: string;
    expertId: string;
    delegationScope: string;
    requestId: string;
    originSessionRef?: string;
    taskText: string;
    payloadDigest: string;
    reuseRefs?: string[];
  }) {
    const cred = await authenticate(input.bearerToken, input.orgId);
    if (
      !isNonEmptyString(input.expertId) ||
      !isNonEmptyString(input.requestId) ||
      !isNonEmptyString(input.taskText) ||
      !isNonEmptyString(input.payloadDigest)
    ) {
      throw new EmployeeExpertsError(
        "EXPERT_REQUEST_INVALID",
        "expertId, requestId, taskText, and payloadDigest are required.",
      );
    }
    if (!isNonEmptyString(input.delegationScope)) {
      throw new EmployeeExpertsError("EXPERT_SCOPE_UNVERIFIED", "delegationScope evidence is required.");
    }
    if (options.isIsolationVerified && !options.isIsolationVerified()) {
      throw new EmployeeExpertsError(
        "EXPERT_ISOLATION_UNVERIFIED",
        "Target runner cannot verify cross-session context isolation.",
      );
    }

    const cleanExpertId = input.expertId.trim();
    const cleanScope = input.delegationScope.trim();
    const cleanRequestId = input.requestId.trim();
    const cleanDigest = input.payloadDigest.trim();

    // Evaluate current expert visibility & callable authorization BEFORE idempotent replay
    // so revoked replay returns 404 EXPERT_TASK_NOT_FOUND with zero taskId leakage (§7.1).
    let expertVisible = false;
    let expertCallable = false;
    let expertAccepting: ExpertAcceptingState = "unknown";

    if (options.listOrgExperts) {
      const cat = await options.listOrgExperts({
        orgId: cred.orgId,
        issuer: cred.issuer,
        subject: cred.subject,
      });
      const found = cat.items.find((item) => item.expertId === cleanExpertId && item.access.readable);
      if (found) {
        expertVisible = true;
        expertCallable = found.access.callableInOrg;
        expertAccepting = found.availability.acceptingTasks;
      }
    }

    if (options.checkSessionScope && expertVisible && expertCallable) {
      const sc = await options.checkSessionScope({
        orgId: cred.orgId,
        issuer: cred.issuer,
        subject: cred.subject,
        delegationScope: cleanScope,
        expertIds: [cleanExpertId],
      });
      if (!sc.scopeVerified) {
        throw new EmployeeExpertsError("EXPERT_SCOPE_UNVERIFIED", "Session delegation scope could not be verified.");
      }
      const row = sc.results.find((r) => r.expertId === cleanExpertId);
      if (!row || !row.callableInScope) {
        expertCallable = false;
      } else {
        expertAccepting = row.acceptingTasks;
      }
    }

    const existingReceipt = await store.findIdempotencyReceipt({
      orgId: cred.orgId,
      issuer: cred.issuer,
      subject: cred.subject,
      op: "create_task",
      requestId: cleanRequestId,
    });
    if (existingReceipt) {
      if (existingReceipt.payloadDigest !== cleanDigest) {
        throw new EmployeeExpertsError(
          "EXPERT_IDEMPOTENCY_CONFLICT",
          "requestId was already used with a different payloadDigest.",
        );
      }
      const existingTask = await store.findTaskById(existingReceipt.taskId);
      if (!existingTask || !expertVisible || !expertCallable || !isPrivateTaskVisibleTo(existingTask, cred, auditSubjects)) {
        throw new EmployeeExpertsError("EXPERT_TASK_NOT_FOUND", "Task is not accessible.");
      }
      tasksById.set(existingTask.taskId, existingTask);
      return {
        httpStatus: 200 as const,
        body: {
          scope: toScopeEnvelope(cred),
          taskId: existingTask.taskId,
          requestId: existingTask.requestId,
          status: existingTask.status,
          acceptedAt: existingTask.acceptedAt,
          runGeneration: existingTask.runGeneration,
          resultVersion: existingTask.resultVersion,
          idempotentReplay: true,
        },
      };
    }

    if (!expertVisible) {
      throw new EmployeeExpertsError("EXPERT_NOT_FOUND", "Expert does not exist or is not visible.");
    }
    if (!expertCallable) {
      throw new EmployeeExpertsError("EXPERT_CALL_FORBIDDEN", "Employee does not have permission to call this expert.");
    }
    if (expertAccepting !== "accepting") {
      throw new EmployeeExpertsError("EXPERT_NOT_ACCEPTING", "Expert is currently not accepting tasks.");
    }

    const task: EmployeeExpertTaskRecord = {
      taskId: `task_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      orgId: cred.orgId,
      instanceId: cred.instanceId,
      issuer: cred.issuer,
      responsibleUserId: cred.subject,
      visibility: "private",
      originClient: "dsh",
      originSessionRef: isNonEmptyString(input.originSessionRef) ? input.originSessionRef.trim() : null,
      expertId: cleanExpertId,
      delegationScope: cleanScope,
      requestId: cleanRequestId,
      payloadDigest: cleanDigest,
      taskText: input.taskText,
      reuseRefs: Array.isArray(input.reuseRefs) ? input.reuseRefs.filter(isNonEmptyString) : [],
      status: "accepted",
      acceptedAt: new Date(now()).toISOString(),
      runId: null,
      runGeneration: 1,
      resultVersion: 0,
      cancelRequested: false,
      result: null,
      sources: [],
      artifacts: [],
    };

    const atomicResult = await store.acceptTaskAtomically({
      task,
      receipt: {
        orgId: cred.orgId,
        issuer: cred.issuer,
        subject: cred.subject,
        op: "create_task",
        requestId: cleanRequestId,
        taskId: task.taskId,
        payloadDigest: cleanDigest,
        status: task.status,
        runGeneration: task.runGeneration,
      },
      dispatchIntent: {
        taskId: task.taskId,
        orgId: task.orgId,
        expertId: task.expertId,
        runGeneration: task.runGeneration,
        kind: "initial",
        payload: {
          delegationScope: task.delegationScope,
          originSessionRef: task.originSessionRef,
          taskText: task.taskText,
          reuseRefs: task.reuseRefs,
          requestId: task.requestId,
        },
        status: "pending",
      },
      beforeCommitHook: options.beforeTaskCommit,
    });

    if (!atomicResult.created) {
      if (atomicResult.receipt.payloadDigest !== cleanDigest) {
        throw new EmployeeExpertsError(
          "EXPERT_IDEMPOTENCY_CONFLICT",
          "requestId was already used with a different payloadDigest.",
        );
      }
      tasksById.set(atomicResult.task.taskId, atomicResult.task);
      return {
        httpStatus: 200 as const,
        body: {
          scope: toScopeEnvelope(cred),
          taskId: atomicResult.task.taskId,
          requestId: atomicResult.task.requestId,
          status: atomicResult.task.status,
          acceptedAt: atomicResult.task.acceptedAt,
          runGeneration: atomicResult.task.runGeneration,
          resultVersion: atomicResult.task.resultVersion,
          idempotentReplay: true,
        },
      };
    }

    tasksById.set(atomicResult.task.taskId, atomicResult.task);

    if (options.onTaskAccepted) {
      try {
        await options.onTaskAccepted(atomicResult.task);
      } catch {
        throw new EmployeeExpertsError(
          "EXPERT_ACCEPTANCE_UNKNOWN",
          "Task acceptance outcome is unknown; reconcile via by-request.",
        );
      }
    }

    return {
      httpStatus: 201 as const,
      body: {
        scope: toScopeEnvelope(cred),
        taskId: atomicResult.task.taskId,
        requestId: atomicResult.task.requestId,
        status: atomicResult.task.status,
        acceptedAt: atomicResult.task.acceptedAt,
        runGeneration: atomicResult.task.runGeneration,
        resultVersion: atomicResult.task.resultVersion,
        idempotentReplay: false,
      },
    };
  }

  async function requireVisibleTask(taskId: string, cred: EmployeeCredentialContext): Promise<EmployeeExpertTaskRecord> {
    const task = await store.findTaskById(taskId.trim());
    if (!task || !isPrivateTaskVisibleTo(task, cred, auditSubjects)) {
      throw new EmployeeExpertsError("EXPERT_TASK_NOT_FOUND", "Task does not exist or is not accessible.");
    }
    tasksById.set(task.taskId, task);
    return task;
  }

  async function getTaskByRequest(input: { bearerToken: string | null; orgId: string; requestId: string }) {
    const cred = await authenticate(input.bearerToken, input.orgId);
    if (!isNonEmptyString(input.requestId)) {
      throw new EmployeeExpertsError("EXPERT_REQUEST_INVALID", "requestId is required.");
    }
    const receipt = await store.findIdempotencyReceipt({
      orgId: cred.orgId,
      issuer: cred.issuer,
      subject: cred.subject,
      op: "create_task",
      requestId: input.requestId.trim(),
    });
    if (!receipt) {
      throw new EmployeeExpertsError("EXPERT_TASK_NOT_FOUND", "Task request does not exist or is not accessible.");
    }
    const task = await requireVisibleTask(receipt.taskId, cred);
    return {
      scope: toScopeEnvelope(cred),
      taskId: task.taskId,
      requestId: task.requestId,
      status: task.status,
      acceptedAt: task.acceptedAt,
      runId: task.runId,
      runGeneration: task.runGeneration,
      resultVersion: task.resultVersion,
    };
  }

  async function getTask(input: { bearerToken: string | null; orgId: string; taskId: string }) {
    const cred = await authenticate(input.bearerToken, input.orgId);
    if (!isNonEmptyString(input.taskId)) {
      throw new EmployeeExpertsError("EXPERT_REQUEST_INVALID", "taskId is required.");
    }
    const task = await requireVisibleTask(input.taskId, cred);
    return {
      scope: toScopeEnvelope(cred),
      taskId: task.taskId,
      status: task.status,
      runId: task.runId,
      runGeneration: task.runGeneration,
      resultVersion: task.resultVersion,
      cancelRequested: task.cancelRequested,
    };
  }

  async function getTaskResult(input: { bearerToken: string | null; orgId: string; taskId: string }) {
    const cred = await authenticate(input.bearerToken, input.orgId);
    if (!isNonEmptyString(input.taskId)) {
      throw new EmployeeExpertsError("EXPERT_REQUEST_INVALID", "taskId is required.");
    }
    const task = await requireVisibleTask(input.taskId, cred);
    return {
      scope: toScopeEnvelope(cred),
      taskId: task.taskId,
      runId: task.runId,
      runGeneration: task.runGeneration,
      resultVersion: task.resultVersion,
      status: task.status,
      result: task.result,
      sources: task.sources,
      artifacts: task.artifacts,
    };
  }

  async function createFollowup(input: {
    bearerToken: string | null;
    orgId: string;
    taskId: string;
    requestId: string;
    taskText: string;
    payloadDigest: string;
    reuseRefs?: string[];
  }) {
    const cred = await authenticate(input.bearerToken, input.orgId);
    if (
      !isNonEmptyString(input.taskId) ||
      !isNonEmptyString(input.requestId) ||
      !isNonEmptyString(input.taskText) ||
      !isNonEmptyString(input.payloadDigest)
    ) {
      throw new EmployeeExpertsError(
        "EXPERT_REQUEST_INVALID",
        "taskId, requestId, taskText, and payloadDigest are required.",
      );
    }
    const task = await requireVisibleTask(input.taskId, cred);
    if (task.responsibleUserId !== cred.subject || task.issuer !== cred.issuer) {
      throw new EmployeeExpertsError("EXPERT_TASK_NOT_FOUND", "Task does not exist or is not accessible.");
    }

    // Re-check employee callable permission and expert acceptingTasks === 'accepting'
    // BEFORE enqueuing a followup (CORP-DSH-EXPERT-001 §7.2).
    if (options.listOrgExperts) {
      const cat = await options.listOrgExperts({
        orgId: cred.orgId,
        issuer: cred.issuer,
        subject: cred.subject,
      });
      const found = cat.items.find((item) => item.expertId === task.expertId && item.access.readable);
      if (!found) {
        throw new EmployeeExpertsError("EXPERT_NOT_FOUND", "Expert does not exist or is not visible.");
      }
      if (!found.access.callableInOrg) {
        throw new EmployeeExpertsError("EXPERT_CALL_FORBIDDEN", "Employee no longer has permission to call this expert.");
      }
      if (found.availability.acceptingTasks !== "accepting") {
        throw new EmployeeExpertsError("EXPERT_NOT_ACCEPTING", "Expert is currently not accepting followups.");
      }
    }
    if (options.checkSessionScope) {
      const sc = await options.checkSessionScope({
        orgId: cred.orgId,
        issuer: cred.issuer,
        subject: cred.subject,
        delegationScope: task.delegationScope,
        expertIds: [task.expertId],
      });
      if (!sc.scopeVerified) {
        throw new EmployeeExpertsError("EXPERT_SCOPE_UNVERIFIED", "Session delegation scope could not be verified.");
      }
      const row = sc.results.find((r) => r.expertId === task.expertId);
      if (!row || !row.callableInScope) {
        throw new EmployeeExpertsError("EXPERT_CALL_FORBIDDEN", "Employee no longer has permission to call this expert in scope.");
      }
      if (row.acceptingTasks !== "accepting") {
        throw new EmployeeExpertsError("EXPERT_NOT_ACCEPTING", "Expert is currently not accepting followups.");
      }
    }

    const cleanReqId = input.requestId.trim();
    const cleanDigest = input.payloadDigest.trim();
    const followupKey = {
      orgId: cred.orgId,
      issuer: cred.issuer,
      subject: cred.subject,
      op: "followup" as const,
      requestId: `${task.taskId}:${cleanReqId}`,
    };
    const existing = await store.findIdempotencyReceipt(followupKey);
    if (existing) {
      if (existing.payloadDigest !== cleanDigest) {
        throw new EmployeeExpertsError(
          "EXPERT_IDEMPOTENCY_CONFLICT",
          "Followup requestId was already used with a different payloadDigest.",
        );
      }
      return {
        httpStatus: 200 as const,
        body: {
          scope: toScopeEnvelope(cred),
          taskId: existing.taskId,
          requestId: cleanReqId,
          status: existing.status,
          runGeneration: existing.runGeneration,
          idempotentReplay: true,
        },
      };
    }

    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new EmployeeExpertsError("EXPERT_TASK_STATE_CONFLICT", "Cannot submit a followup to a terminal task.");
    }

    const atomic = await store.createFollowupAtomically({
      taskId: task.taskId,
      receipt: {
        ...followupKey,
        taskId: task.taskId,
        payloadDigest: cleanDigest,
      },
      taskText: input.taskText,
      reuseRefs: Array.isArray(input.reuseRefs) ? input.reuseRefs.filter(isNonEmptyString) : [],
    });
    tasksById.set(atomic.task.taskId, atomic.task);

    if (!atomic.created) {
      if (atomic.receipt.payloadDigest !== cleanDigest) {
        throw new EmployeeExpertsError(
          "EXPERT_IDEMPOTENCY_CONFLICT",
          "Followup requestId was already used with a different payloadDigest.",
        );
      }
      return {
        httpStatus: 200 as const,
        body: {
          scope: toScopeEnvelope(cred),
          taskId: atomic.receipt.taskId,
          requestId: cleanReqId,
          status: atomic.receipt.status,
          runGeneration: atomic.receipt.runGeneration,
          idempotentReplay: true,
        },
      };
    }

    return {
      httpStatus: 201 as const,
      body: {
        scope: toScopeEnvelope(cred),
        taskId: atomic.receipt.taskId,
        requestId: cleanReqId,
        status: atomic.receipt.status,
        runGeneration: atomic.receipt.runGeneration,
        idempotentReplay: false,
      },
    };
  }

  async function cancelTask(input: { bearerToken: string | null; orgId: string; taskId: string }) {
    const cred = await authenticate(input.bearerToken, input.orgId);
    if (!isNonEmptyString(input.taskId)) {
      throw new EmployeeExpertsError("EXPERT_REQUEST_INVALID", "taskId is required.");
    }
    const task = await requireVisibleTask(input.taskId, cred);
    if (task.responsibleUserId !== cred.subject || task.issuer !== cred.issuer) {
      throw new EmployeeExpertsError("EXPERT_TASK_NOT_FOUND", "Task does not exist or is not accessible.");
    }
    const updated = await store.cancelTask({
      taskId: task.taskId,
      orgId: task.orgId,
      expertId: task.expertId,
    });
    const finalTask = updated ?? task;
    tasksById.set(finalTask.taskId, finalTask);
    return {
      scope: toScopeEnvelope(cred),
      taskId: finalTask.taskId,
      cancelRequested: finalTask.cancelRequested,
      status: finalTask.status,
    };
  }

  /** Synchronous helper for in-memory tests with runGeneration fencing (§6.2). */
  function publishTaskResult(input: {
    taskId: string;
    runId: string;
    runGeneration: number;
    status: EmployeeExpertTaskStatus;
    result: unknown;
    sources?: string[];
    artifacts?: Array<{ id: string; label?: string; url?: string }>;
  }): EmployeeExpertTaskRecord {
    const task = tasksById.get(input.taskId);
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
    void store.publishTaskResult(input).catch(() => undefined);
    return task;
  }

  async function publishTaskResultAsync(input: {
    taskId: string;
    runId: string;
    runGeneration: number;
    status: EmployeeExpertTaskStatus;
    result: unknown;
    sources?: string[];
    artifacts?: Array<{ id: string; label?: string; url?: string }>;
  }): Promise<EmployeeExpertTaskRecord> {
    const updated = await store.publishTaskResult(input);
    tasksById.set(updated.taskId, updated);
    return updated;
  }

  function listAllTasksForAclAudit(): EmployeeExpertTaskRecord[] {
    return Array.from(tasksById.values());
  }

  async function listDispatchIntents(taskId?: string): Promise<DispatchIntentRecord[]> {
    return store.listDispatchIntents(taskId);
  }

  return {
    listExperts,
    scopeCheck,
    createTask,
    getTaskByRequest,
    getTask,
    getTaskResult,
    createFollowup,
    cancelTask,
    publishTaskResult,
    publishTaskResultAsync,
    listAllTasksForAclAudit,
    listDispatchIntents,
  };
}

export type EmployeeExpertsService = ReturnType<typeof createEmployeeExpertsService>;
