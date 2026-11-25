import { describe, expect, it } from "vitest";
import {
  assertPrivateEmployeeExpertMutationAllowed,
  canActorViewPrivateEmployeeExpertTask,
  filterPrivateEmployeeExpertRunsFromRecords,
  isPrivateEmployeeExpertEventVisibleToActor,
  type PrivateEmployeeExpertTaskDescriptor,
} from "../services/employee-expert-acl.js";
import {
  createEmployeeExpertsService,
  filterVisibleEmployeeTasks,
  type EmployeeCredentialContext,
} from "../services/employee-experts.js";

const ISSUER = "https://iam.corp.example";
const ORG_A = "org_a";
const ORG_B = "org_b";

const PRIVATE_TASK: PrivateEmployeeExpertTaskDescriptor = {
  taskId: "task_priv_01",
  orgId: ORG_A,
  issuer: ISSUER,
  responsibleUserId: "emp_owner",
  visibility: "private",
  originClient: "dsh",
  runId: "run_priv_01",
};

const AUDIT_SUBJECTS = new Set(["emp_auditor"]);

describe("Delegra #97: 4-role + auditor private task ACL negative matrix (CORP-DSH-EXPERT-001 §6.1)", () => {
  const roles = {
    initiatingEmployee: { userId: "emp_owner", companyId: ORG_A },
    viewOnlyEmployee: { userId: "emp_view_only", companyId: ORG_A },
    sameOrgColleague: { userId: "emp_colleague", companyId: ORG_A },
    crossOrgUser: { userId: "emp_other_org", companyId: ORG_B },
    authorizedAuditor: { userId: "emp_auditor", companyId: ORG_A, auditAuthorized: true },
  };

  it("enforces zero-record visibility for unauthorized same-org colleagues and cross-org users on generic heartbeat-runs and live-runs (zero redacted stubs)", () => {
    const genericRuns = [
      { id: "run_public_01", companyId: ORG_A, status: "running", costUsd: 0.12 },
      { id: "run_priv_01", companyId: ORG_A, status: "running", costUsd: 1.45 },
    ];
    const privateByRun = new Map([[PRIVATE_TASK.runId!, PRIVATE_TASK]]);

    // Owner sees both
    expect(
      filterPrivateEmployeeExpertRunsFromRecords(genericRuns, privateByRun, roles.initiatingEmployee, AUDIT_SUBJECTS).map((r) => r.id),
    ).toEqual(["run_public_01", "run_priv_01"]);

    // Authorized auditor sees both
    expect(
      filterPrivateEmployeeExpertRunsFromRecords(genericRuns, privateByRun, roles.authorizedAuditor, AUDIT_SUBJECTS).map((r) => r.id),
    ).toEqual(["run_public_01", "run_priv_01"]);

    // View-only employee, same-org colleague, and cross-org user see ZERO private runs (no redacted stub!)
    for (const unauthorized of [roles.viewOnlyEmployee, roles.sameOrgColleague, roles.crossOrgUser]) {
      const visible = filterPrivateEmployeeExpertRunsFromRecords(genericRuns, privateByRun, unauthorized, AUDIT_SUBJECTS);
      expect(visible.map((r) => r.id)).not.toContain("run_priv_01");
      expect(canActorViewPrivateEmployeeExpertTask(PRIVATE_TASK, unauthorized, AUDIT_SUBJECTS)).toBe(false);
    }
  });

  it("suppresses WebSocket broadcast events for private employee expert runs for unauthorized colleagues and cross-org users", () => {
    const wsEvent = {
      companyId: ORG_A,
      type: "heartbeat.run.status" as const,
      payload: { runId: "run_priv_01", status: "running" },
    };

    expect(isPrivateEmployeeExpertEventVisibleToActor(wsEvent, PRIVATE_TASK, roles.initiatingEmployee, AUDIT_SUBJECTS)).toBe(true);
    expect(isPrivateEmployeeExpertEventVisibleToActor(wsEvent, PRIVATE_TASK, roles.authorizedAuditor, AUDIT_SUBJECTS)).toBe(true);
    expect(isPrivateEmployeeExpertEventVisibleToActor(wsEvent, PRIVATE_TASK, roles.viewOnlyEmployee, AUDIT_SUBJECTS)).toBe(false);
    expect(isPrivateEmployeeExpertEventVisibleToActor(wsEvent, PRIVATE_TASK, roles.sameOrgColleague, AUDIT_SUBJECTS)).toBe(false);
    expect(isPrivateEmployeeExpertEventVisibleToActor(wsEvent, PRIVATE_TASK, roles.crossOrgUser, AUDIT_SUBJECTS)).toBe(false);
  });

  it("enforces 404 EXPERT_TASK_NOT_FOUND on direct ID access across /api/v1/employee/* and blocks write/cancel for non-owners", async () => {
    const credsByToken: Record<string, EmployeeCredentialContext> = {
      tok_owner: {
        instanceId: "inst_1",
        orgId: ORG_A,
        issuer: ISSUER,
        subject: "emp_owner",
        verifiedAt: "2026-11-25T08:00:00Z",
        validUntil: "2026-11-25T08:05:00Z",
        activeOrgIds: [ORG_A],
      },
      tok_colleague: {
        instanceId: "inst_1",
        orgId: ORG_A,
        issuer: ISSUER,
        subject: "emp_colleague",
        verifiedAt: "2026-11-25T08:00:00Z",
        validUntil: "2026-11-25T08:05:00Z",
        activeOrgIds: [ORG_A],
      },
      tok_cross_org: {
        instanceId: "inst_1",
        orgId: ORG_B,
        issuer: ISSUER,
        subject: "emp_other_org",
        verifiedAt: "2026-11-25T08:00:00Z",
        validUntil: "2026-11-25T08:05:00Z",
        activeOrgIds: [ORG_B],
      },
      tok_auditor: {
        instanceId: "inst_1",
        orgId: ORG_A,
        issuer: ISSUER,
        subject: "emp_auditor",
        verifiedAt: "2026-11-25T08:00:00Z",
        validUntil: "2026-11-25T08:05:00Z",
        activeOrgIds: [ORG_A],
        auditAuthorized: true,
      },
    };

    const svc = createEmployeeExpertsService({
      verifyCredential: (tok) => credsByToken[tok] ?? null,
      listOrgExperts: async () => ({
        catalogVersion: "cv_1",
        completeness: "complete",
        items: [
          {
            expertId: "exp_1",
            displayName: "财务专家",
            disambiguation: null,
            summary: { disclosureState: "available", responsibility: null, capabilities: [], toolScope: [], updatedAt: null },
            access: { readable: true, callableInOrg: true, callableReason: "granted", authContinuityDigest: "sha256:1" },
            availability: { acceptingTasks: "accepting", reason: null },
          },
        ],
      }),
      auditSubjects: AUDIT_SUBJECTS,
      now: () => Date.parse("2026-11-25T08:01:00Z"),
    });

    const created = await svc.createTask({
      bearerToken: "tok_owner",
      orgId: ORG_A,
      expertId: "exp_1",
      delegationScope: "project:p1",
      requestId: "req_acl_1",
      taskText: "Confidential report",
      payloadDigest: "sha256:conf",
    });
    const taskId = created.body.taskId;

    // Same-org colleague direct ID access -> 404 EXPERT_TASK_NOT_FOUND
    await expect(
      svc.getTask({ bearerToken: "tok_colleague", orgId: ORG_A, taskId }),
    ).rejects.toMatchObject({ code: "EXPERT_TASK_NOT_FOUND", status: 404 });
    await expect(
      svc.getTaskResult({ bearerToken: "tok_colleague", orgId: ORG_A, taskId }),
    ).rejects.toMatchObject({ code: "EXPERT_TASK_NOT_FOUND", status: 404 });

    // Cross-org user direct ID access -> 404 EXPERT_TASK_NOT_FOUND (or 403 org forbidden)
    await expect(
      svc.getTask({ bearerToken: "tok_cross_org", orgId: ORG_B, taskId }),
    ).rejects.toMatchObject({ code: "EXPERT_TASK_NOT_FOUND", status: 404 });

    // Authorized auditor can read, but cannot mutate (cancel)
    const auditView = await svc.getTask({ bearerToken: "tok_auditor", orgId: ORG_A, taskId });
    expect(auditView.taskId).toBe(taskId);
    await expect(
      svc.cancelTask({ bearerToken: "tok_auditor", orgId: ORG_A, taskId }),
    ).rejects.toMatchObject({ code: "EXPERT_TASK_NOT_FOUND", status: 404 });

    // Generic list filter returns 0 for colleague, 1 for owner & auditor
    const allTasks = svc.listAllTasksForAclAudit();
    expect(filterVisibleEmployeeTasks(allTasks, credsByToken.tok_colleague, AUDIT_SUBJECTS)).toHaveLength(0);
    expect(filterVisibleEmployeeTasks(allTasks, credsByToken.tok_owner, AUDIT_SUBJECTS)).toHaveLength(1);
    expect(filterVisibleEmployeeTasks(allTasks, credsByToken.tok_auditor, AUDIT_SUBJECTS)).toHaveLength(1);
  });

  it("rejects share and reassign mutations that attempt to widen visibility or alter responsibleUserId", () => {
    expect(() =>
      assertPrivateEmployeeExpertMutationAllowed(PRIVATE_TASK, { action: "share" }),
    ).toThrow(/cannot be shared/i);

    expect(() =>
      assertPrivateEmployeeExpertMutationAllowed(PRIVATE_TASK, { visibility: "company" }),
    ).toThrow(/widen visibility/i);

    expect(() =>
      assertPrivateEmployeeExpertMutationAllowed(PRIVATE_TASK, {
        action: "reassign",
        responsibleUserId: "emp_colleague",
      }),
    ).toThrow(/reassign/i);
  });
});
