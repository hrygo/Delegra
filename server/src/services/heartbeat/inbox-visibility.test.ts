import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import {
  excludeResolvedFailedRuns,
  filterResolvedFailedRuns,
  isResolvedFailedRun,
} from "./inbox-visibility.js";

vi.mock("../task-interruption-presentation.js", () => ({
  taskInterruptionPresentations: vi.fn(async (_db: unknown, _companyId: string, issueRows: Array<{ id: string }>) =>
    new Map(issueRows.map((issue) => [issue.id, { state: issue.id === "issue-1" ? "resolved" : "failed" }])),
  ),
}));

const resolved = new Map([["issue-1", { state: "resolved" }]]);

describe("heartbeat inbox visibility", () => {
  it("drops a failed run once the task interruption is resolved", () => {
    expect(isResolvedFailedRun({ status: "failed", issueId: "issue-1" }, resolved)).toBe(true);
    expect(isResolvedFailedRun({ status: "timed_out", issueId: "issue-1" }, resolved)).toBe(true);
  });

  it("keeps failures that still need attention", () => {
    const pending = new Map([["issue-1", { state: "failed" }]]);
    const waiting = new Map([["issue-1", { state: "waiting_for_user" }]]);
    const missing = new Map<string, { state: string }>();

    expect(isResolvedFailedRun({ status: "failed", issueId: "issue-1" }, pending)).toBe(false);
    expect(isResolvedFailedRun({ status: "failed", issueId: "issue-1" }, waiting)).toBe(false);
    expect(isResolvedFailedRun({ status: "failed", issueId: "issue-2" }, missing)).toBe(false);
    expect(isResolvedFailedRun({ status: "failed", issueId: null }, resolved)).toBe(false);
  });

  it("does not drop successful or running runs", () => {
    expect(isResolvedFailedRun({ status: "succeeded", issueId: "issue-1" }, resolved)).toBe(false);
    expect(isResolvedFailedRun({ status: "running", issueId: "issue-1" }, resolved)).toBe(false);
  });

  it("filters only the resolved failures out of a run list", () => {
    const runs = [
      { id: "run-1", status: "failed", issueId: "issue-1" },
      { id: "run-2", status: "failed", issueId: "issue-2" },
      { id: "run-3", status: "succeeded", issueId: "issue-1" },
    ];
    expect(filterResolvedFailedRuns(runs, resolved).map((run) => run.id)).toEqual(["run-2", "run-3"]);
  });

  it("loads task interruptions before filtering a run list", async () => {
    const issueRows = [
      { id: "issue-1", companyId: "company-1", status: "done", assigneeAgentId: null, projectId: null },
      { id: "issue-2", companyId: "company-1", status: "blocked", assigneeAgentId: null, projectId: null },
    ];
    const db = { select: () => ({ from: () => ({ where: async () => issueRows }) }) } as unknown as Db;
    const runs = [
      { id: "run-1", status: "failed", issueId: "issue-1" },
      { id: "run-2", status: "failed", issueId: "issue-2" },
      { id: "run-3", status: "succeeded", issueId: "issue-1" },
    ];

    await expect(excludeResolvedFailedRuns(db, "company-1", runs)).resolves.toEqual([runs[1], runs[2]]);
  });
});
