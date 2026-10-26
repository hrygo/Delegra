import { and, eq, inArray } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { taskInterruptionPresentations } from "../task-interruption-presentation.js";

const FAILED_HEARTBEAT_RUN_STATUSES = new Set(["failed", "timed_out"]);

type RunIssueReference = { status: string; issueId?: string | null };
type InterruptionStateById = ReadonlyMap<string, { state: string } | null | undefined>;

export function isResolvedFailedRun(run: RunIssueReference, interruptionByIssueId: InterruptionStateById) {
  if (!FAILED_HEARTBEAT_RUN_STATUSES.has(run.status) || !run.issueId) return false;
  return interruptionByIssueId.get(run.issueId)?.state === "resolved";
}

export function filterResolvedFailedRuns<T extends RunIssueReference>(
  runs: T[],
  interruptionByIssueId: InterruptionStateById,
): T[] {
  return runs.filter((run) => !isResolvedFailedRun(run, interruptionByIssueId));
}

export async function excludeResolvedFailedRuns<T extends RunIssueReference>(
  db: Db,
  companyId: string,
  runs: T[],
): Promise<T[]> {
  const issueIds = [
    ...new Set(
      runs
        .filter((run) => FAILED_HEARTBEAT_RUN_STATUSES.has(run.status) && run.issueId)
        .map((run) => run.issueId as string),
    ),
  ];
  if (issueIds.length === 0) return runs;

  const rows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
  if (rows.length === 0) return runs;

  const interruptions = await taskInterruptionPresentations(db, companyId, rows);
  return filterResolvedFailedRuns(runs, interruptions);
}
