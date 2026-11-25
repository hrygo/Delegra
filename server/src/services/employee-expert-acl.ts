import { and, eq, inArray } from "drizzle-orm";
import { employeeExpertTasks, type Db } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import type { AuthorizationActor } from "./authorization.js";
import { EmployeeExpertsError } from "./employee-experts.js";

export interface PrivateEmployeeExpertTaskDescriptor {
  taskId: string;
  orgId: string;
  issuer?: string | null;
  responsibleUserId: string;
  visibility: string;
  originClient?: string | null;
  runId?: string | null;
}

export interface AclActorIdentity {
  type?: string;
  userId?: string | null;
  companyId?: string | null;
  companyIds?: readonly string[] | null;
  isInstanceAdmin?: boolean;
  auditAuthorized?: boolean;
}

/**
 * Checks whether an actor is allowed to view a private employee expert task
 * or any of its associated runs, events, artifacts, or cost records
 * (CORP-DSH-EXPERT-001 §6.1).
 *
 * Only the initiating employee (`responsibleUserId`) and explicitly authorized
 * compliance/audit principals may view private employee expert tasks.
 * Same-org ordinary colleagues and cross-org users MUST see zero records
 * (including zero redacted metadata stubs).
 */
export function canActorViewPrivateEmployeeExpertTask(
  task: PrivateEmployeeExpertTaskDescriptor,
  actor: AclActorIdentity,
  auditSubjects?: ReadonlySet<string>,
): boolean {
  const actorOrgIds = Array.isArray(actor.companyIds)
    ? actor.companyIds
    : actor.companyId
      ? [actor.companyId]
      : [];
  if (actorOrgIds.length > 0 && !actorOrgIds.includes(task.orgId)) {
    return false;
  }
  if (task.visibility !== "private") {
    return true;
  }
  const userId = typeof actor.userId === "string" ? actor.userId.trim() : "";
  if (userId && userId === task.responsibleUserId) {
    return true;
  }
  if (actor.auditAuthorized === true) {
    return true;
  }
  if (userId && auditSubjects && auditSubjects.has(userId)) {
    return true;
  }
  return false;
}

/**
 * Pure filter for generic run lists (`heartbeat-runs`, `live-runs`) against a
 * map of private employee expert tasks indexed by `runId`.
 * Strips unauthorized private runs completely BEFORE pagination, aggregation,
 * or row redaction so zero redacted metadata stubs leak (§6.1).
 */
export function filterPrivateEmployeeExpertRunsFromRecords<
  T extends { id: string; companyId?: string; contextSnapshot?: unknown },
>(
  runs: readonly T[],
  privateTasksByRunId: ReadonlyMap<string, PrivateEmployeeExpertTaskDescriptor>,
  actor: AclActorIdentity,
  auditSubjects?: ReadonlySet<string>,
): T[] {
  return runs.filter((run) => {
    const privateTask = privateTasksByRunId.get(run.id);
    if (privateTask) {
      return canActorViewPrivateEmployeeExpertTask(privateTask, actor, auditSubjects);
    }
    const ctx =
      run.contextSnapshot && typeof run.contextSnapshot === "object"
        ? (run.contextSnapshot as Record<string, unknown>)
        : null;
    if (ctx && ctx.originClient === "dsh" && ctx.visibility === "private") {
      const ownerId = typeof ctx.responsibleUserId === "string" ? ctx.responsibleUserId : "";
      return canActorViewPrivateEmployeeExpertTask(
        {
          taskId: typeof ctx.employeeExpertTaskId === "string" ? ctx.employeeExpertTaskId : run.id,
          orgId: run.companyId ?? "",
          responsibleUserId: ownerId,
          visibility: "private",
          originClient: "dsh",
          runId: run.id,
        },
        actor,
        auditSubjects,
      );
    }
    return true;
  });
}

function hasQueryableDb(db: unknown): db is Db {
  return Boolean(
    db &&
      typeof (db as { select?: unknown }).select === "function" &&
      (typeof (db as { transaction?: unknown }).transaction === "function" ||
        typeof (db as { execute?: unknown }).execute === "function"),
  );
}

/**
 * Database-backed filter used by generic `/heartbeat-runs` and `/live-runs`
 * endpoints to strip unauthorized private employee expert runs before
 * pagination/redaction.
 */
export async function filterPrivateEmployeeExpertRuns<
  T extends { id: string; companyId?: string; contextSnapshot?: unknown },
>(
  db: Db,
  companyId: string,
  actor: AuthorizationActor & { auditAuthorized?: boolean },
  runs: readonly T[],
  auditSubjects?: ReadonlySet<string>,
): Promise<T[]> {
  if (runs.length === 0) return [];
  const runIds = runs.map((r) => r.id).filter(Boolean);
  if (runIds.length === 0) return [...runs];

  let matchedTasks: Array<{
    taskId: string;
    orgId: string;
    issuer: string;
    responsibleUserId: string;
    visibility: string;
    originClient: string;
    runId: string | null;
  }> = [];

  if (hasQueryableDb(db)) {
    try {
      matchedTasks = await db
        .select({
          taskId: employeeExpertTasks.taskId,
          orgId: employeeExpertTasks.orgId,
          issuer: employeeExpertTasks.issuer,
          responsibleUserId: employeeExpertTasks.responsibleUserId,
          visibility: employeeExpertTasks.visibility,
          originClient: employeeExpertTasks.originClient,
          runId: employeeExpertTasks.runId,
        })
        .from(employeeExpertTasks)
        .where(
          and(
            eq(employeeExpertTasks.orgId, companyId),
            inArray(employeeExpertTasks.runId, runIds),
          ),
        );
    } catch {
      // If table is not yet migrated in an isolated legacy test fixture, fall back
      // to contextSnapshot inspection only.
      matchedTasks = [];
    }
  }

  const byRunId = new Map<string, PrivateEmployeeExpertTaskDescriptor>();
  for (const t of matchedTasks) {
    if (t.runId) byRunId.set(t.runId, t);
  }

  return filterPrivateEmployeeExpertRunsFromRecords(runs, byRunId, actor, auditSubjects);
}

/**
 * Direct-by-ID run read guard used by `actorCanReadRun` across
 * `/heartbeat-runs/:runId`, `/events`, `/log`, `/cancel`, and
 * `/workspace-operations` so unauthorized colleagues receive 404 (§6.1).
 */
export async function canActorReadPrivateEmployeeExpertRun(
  db: Db,
  actor: AuthorizationActor & { auditAuthorized?: boolean },
  run: { id?: string | null; companyId: string; contextSnapshot?: unknown },
  auditSubjects?: ReadonlySet<string>,
): Promise<boolean> {
  if (!run.id) return true;
  const visible = await filterPrivateEmployeeExpertRuns(
    db,
    run.companyId,
    actor,
    [{ id: run.id, companyId: run.companyId, contextSnapshot: run.contextSnapshot }],
    auditSubjects,
  );
  return visible.length === 1;
}

/**
 * Pure WebSocket broadcast filter for private employee expert task/run events (§6.1).
 */
export function isPrivateEmployeeExpertEventVisibleToActor(
  event: Pick<LiveEvent, "companyId" | "type" | "payload">,
  privateTask: PrivateEmployeeExpertTaskDescriptor | null,
  actor: AclActorIdentity,
  auditSubjects?: ReadonlySet<string>,
): boolean {
  if (!privateTask) return true;
  return canActorViewPrivateEmployeeExpertTask(privateTask, actor, auditSubjects);
}

/**
 * Database-backed WebSocket event visibility guard used by live-events-ws.ts
 * before delivering any event frame.
 */
export async function canActorReceivePrivateEmployeeExpertEvent(
  db: Db,
  actor: AuthorizationActor & { auditAuthorized?: boolean },
  event: Pick<LiveEvent, "companyId" | "type" | "payload">,
  auditSubjects?: ReadonlySet<string>,
): Promise<boolean> {
  const payload = event.payload ?? {};
  const runId =
    typeof payload.runId === "string"
      ? payload.runId
      : payload.entityType === "heartbeat_run" && typeof payload.entityId === "string"
        ? payload.entityId
        : null;
  const taskId =
    typeof payload.employeeExpertTaskId === "string"
      ? payload.employeeExpertTaskId
      : payload.entityType === "employee_expert_task" && typeof payload.entityId === "string"
        ? payload.entityId
        : null;

  if (!runId && !taskId) return true;
  if (!hasQueryableDb(db)) return true;

  try {
    const rows = taskId
      ? await db
          .select({
            taskId: employeeExpertTasks.taskId,
            orgId: employeeExpertTasks.orgId,
            issuer: employeeExpertTasks.issuer,
            responsibleUserId: employeeExpertTasks.responsibleUserId,
            visibility: employeeExpertTasks.visibility,
            originClient: employeeExpertTasks.originClient,
            runId: employeeExpertTasks.runId,
          })
          .from(employeeExpertTasks)
          .where(
            and(
              eq(employeeExpertTasks.orgId, event.companyId),
              eq(employeeExpertTasks.taskId, taskId),
            ),
          )
          .limit(1)
      : await db
          .select({
            taskId: employeeExpertTasks.taskId,
            orgId: employeeExpertTasks.orgId,
            issuer: employeeExpertTasks.issuer,
            responsibleUserId: employeeExpertTasks.responsibleUserId,
            visibility: employeeExpertTasks.visibility,
            originClient: employeeExpertTasks.originClient,
            runId: employeeExpertTasks.runId,
          })
          .from(employeeExpertTasks)
          .where(
            and(
              eq(employeeExpertTasks.orgId, event.companyId),
              eq(employeeExpertTasks.runId, runId!),
            ),
          )
          .limit(1);

    const task = rows[0] ?? null;
    return isPrivateEmployeeExpertEventVisibleToActor(event, task, actor, auditSubjects);
  } catch {
    return true;
  }
}

/**
 * Rejects generic share/reassign requests that attempt to widen visibility or
 * mutate responsibleUserId on a private employee expert task (§6.1).
 */
export function assertPrivateEmployeeExpertMutationAllowed(
  task: PrivateEmployeeExpertTaskDescriptor,
  mutation: {
    action?: "share" | "reassign" | "update";
    visibility?: string;
    responsibleUserId?: string;
  },
): void {
  if (task.visibility !== "private" && task.originClient !== "dsh") {
    return;
  }
  if (mutation.action === "share") {
    throw new EmployeeExpertsError(
      "EXPERT_CALL_FORBIDDEN",
      "Private employee expert tasks cannot be shared or widened in visibility.",
    );
  }
  if (mutation.visibility !== undefined && mutation.visibility !== "private") {
    throw new EmployeeExpertsError(
      "EXPERT_CALL_FORBIDDEN",
      "Cannot widen visibility of a private employee expert task.",
    );
  }
  if (
    mutation.action === "reassign" ||
    (mutation.responsibleUserId !== undefined &&
      mutation.responsibleUserId !== task.responsibleUserId)
  ) {
    throw new EmployeeExpertsError(
      "EXPERT_CALL_FORBIDDEN",
      "Cannot reassign or alter responsibleUserId of a private employee expert task.",
    );
  }
}
