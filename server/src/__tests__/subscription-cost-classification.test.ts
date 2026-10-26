import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveManagedOpenAiBilling } from "@paperclipai/adapter-utils";
import { createRunUsageRecorder } from "../services/usage-receipts.js";
import { accountRunCost } from "../services/run-cost-accounting.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, approvals, companies, costAdjustments, costEvents, createDb, heartbeatRuns, projects, runUsageReceipts } from "@paperclipai/db";
import { aiConnectionBillingService, effectiveAiBilling, freezeAiBillingSnapshot } from "../services/ai-connection-billing.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { toolAccessService } from "../services/tool-access.js";
import { activityLog, companyMemberships, companySecrets, connectionGrants, toolApplications, toolConnections } from "@paperclipai/db";
import { costService } from "../services/costs.js";
import { budgetService } from "../services/budgets.js";
import { billingReconciliationService } from "../services/billing-reconciliation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
describePg("audited subscription classification", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let testHome: string;
  beforeAll(async () => { testHome = await mkdtemp(join(tmpdir(), "paperclip-subscription-home-")); vi.stubEnv("PAPERCLIP_HOME", testHome); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "subscription-fixture"); temp = await startEmbeddedPostgresTestDatabase("paperclip-subscription-cost-"); db = createDb(temp.connectionString); }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temp?.cleanup(); vi.unstubAllEnvs(); if (testHome) await rm(testHome, { recursive: true, force: true }); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic subscription", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Paused fixture", role: "engineer", status: "paused", pauseReason: "manual", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(projects).values({ id: projectId, companyId, name: "Fixture" });
    const usageJson = { provider: "openai", biller: "unknown", model: "fixture-model", billingType: "metered_api", inputTokens: 10, outputTokens: 2, accountingReceiptReady: true, ledgerScope: { projectId } };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", invocationSource: "on_demand", triggerDetail: "manual", usageJson, costAccountingPending: false, costAccountedAt: new Date(), accountingProjectionVersion: "v2" });
    const receiptId = randomUUID(), sourceId = randomUUID();
    await db.insert(runUsageReceipts).values({ id: receiptId, companyId, runId, sourceId, sequence: 1, receiptHash: "a".repeat(64), receiptJson: { synthetic: true, usageJson }, complete: true, receivedAt: new Date() });
    const budgets = budgetService(db);
    await budgets.upsertPolicy(companyId, { scopeType: "project", scopeId: projectId, metric: "billed_cents", windowKind: "lifetime", amount: 10000, warnPercent: 80, hardStopEnabled: true, notifyEnabled: true, unpricedUsagePolicy: "block" }, "fixture-owner");
    const event = await costService(db).createEvent(companyId, { agentId, heartbeatRunId: runId, projectId, idempotencyKey: `fixture:${runId}`, provider: "openai", biller: "unknown", billingType: "metered_api", costStatus: "unpriced", model: "fixture-model", inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, costCents: "0", occurredAt: new Date() });
    return { companyId, agentId, projectId, runId, receiptId, usageJson, event, budgets };
  }
  const correction = () => ({ idempotencyKey: randomUUID(), expectedCents: "0", correctedCents: "0", reason: "Owner confirmed that the fixed subscription covers this run.",
    pricing: { source: "operator", version: "subscription-inclusion/v1", evidence: "Synthetic owner confirmation: no additional per-run charge." },
    billingClassification: { expected: { billingType: "metered_api", biller: "unknown" }, corrected: { billingType: "subscription_included", biller: "unknown" } },
  });

  it("appends the correction, retains original receipts, and reconciles only the budget hold", async () => {
    const f = await fixture();
    const evidence = await billingReconciliationService(db).event(f.companyId, f.event.id);
    expect(evidence).toMatchObject({ id: f.event.id, costCentsExact: "0.0000000", receiptHash: f.event.receiptHash });
    await expect(billingReconciliationService(db).event(randomUUID(), f.event.id)).rejects.toThrow(/not found/i);
    const before = await f.budgets.overview(f.companyId);
    expect(before.policies[0]).toMatchObject({ status: "hard_stop", unpricedEventCount: 1 });
    const input = correction();
    const service = billingReconciliationService(db);
    const adjusted = await service.adjust(f.companyId, f.event.id, input as never, "fixture-owner");
    expect(await service.adjust(f.companyId, f.event.id, input as never, "fixture-owner")).toEqual(adjusted);
    const [event] = await db.select().from(costEvents).where(eq(costEvents.id, f.event.id));
    expect(event).toMatchObject({ billingType: "subscription_included", biller: "unknown", costStatus: "reported", costCents: 0, receiptHash: f.event.receiptHash, inputTokens: 10, outputTokens: 2 });
    const [audit] = await db.select().from(costAdjustments).where(eq(costAdjustments.id, adjusted.id));
    expect(audit.previousPricing.billingClassification).toEqual(input.billingClassification.expected);
    expect(audit.pricing.billingClassification).toEqual(input.billingClassification.corrected);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.usageJson).toEqual(f.usageJson);
    const [receipt] = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.id, f.receiptId));
    expect(receipt).toMatchObject({ receiptHash: "a".repeat(64), receiptJson: { synthetic: true, usageJson: f.usageJson } });
    const after = await f.budgets.overview(f.companyId);
    expect(after.policies[0]).toMatchObject({ unpricedEventCount: 0, amount: 10000, unpricedUsagePolicy: "block", paused: false });
    expect(after.activeIncidents).toEqual([]);
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent).toMatchObject({ status: "paused", pauseReason: "manual" });
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, before.activeIncidents[0].approvalId!));
    expect(approval.status).toBe("approved");
    await expect(service.adjust(f.companyId, f.event.id, correction() as never, "fixture-owner")).rejects.toThrow(/classification changed/i);
  });

  async function connectionFixture() {
    const f = await fixture();
    const owner = `owner-${f.companyId}`, other = `other-${f.companyId}`, admin = `admin-${f.companyId}`;
    await db.insert(companyMemberships).values([{ companyId: f.companyId, principalType: "user", principalId: owner, status: "active", membershipRole: "member" }, { companyId: f.companyId, principalType: "user", principalId: other, status: "active", membershipRole: "member" }, { companyId: f.companyId, principalType: "user", principalId: admin, status: "active", membershipRole: "admin" }]);
    const [app] = await db.insert(toolApplications).values({ companyId: f.companyId, applicationKey: `fixture-${f.companyId}`, name: "Synthetic Responses", type: "mcp_http", ownerUserId: owner }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: app.id, name: "Synthetic proxy", uid: `fixture-${f.companyId}`, connectionPurpose: "ai", transport: "runtime_auth", authKind: "api_key", enabled: true, status: "active", healthStatus: "ok", createdByUserId: owner,
      config: { ai: { provider: "openai", method: "api_key", routing: { kind: "local", protocol: "responses", baseUrl: "http://127.0.0.1:19999/v1", auth: "none", models: [] } } } }).returning();
    await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: connection.id, kind: "user", subjectUserId: owner, status: "active" });
    return { ...f, connection, owner, other, admin };
  }
  const declaration = { billingType: "subscription_included", biller: "unknown", pricingProvenance: { source: "operator", version: "included/v1", evidence: "Synthetic owner-confirmed subscription" } } as const;
  it("restricts declarations to the owner/admin, enforces CAS and retains clear tombstones", async () => {
    const f = await connectionFixture(), service = aiConnectionBillingService(db);
    await expect(service.get(f.companyId, f.connection.id, f.other)).rejects.toThrow(/owner|administrator/i);
    await expect(service.put(f.companyId, f.connection.id, { expectedRevision: null, declaration }, f.other)).rejects.toThrow(/owner|administrator/i);
    const initial = await service.put(f.companyId, f.connection.id, { expectedRevision: null, declaration }, f.owner);
    expect(initial.configuration).toMatchObject({ revision: 1, declaration });
    await expect(service.put(f.companyId, f.connection.id, { expectedRevision: null, declaration }, f.owner)).rejects.toThrow(/changed/i);
    const frozen = structuredClone(initial.effective);
    const cleared = await service.put(f.companyId, f.connection.id, { expectedRevision: 1, declaration: null }, f.admin);
    expect(cleared.effective).toMatchObject({ revision: 2, declaration: null });
    expect(freezeAiBillingSnapshot(cleared.effective, true, frozen)).toMatchObject({ revision: 1, declaration });
    expect(freezeAiBillingSnapshot(initial.effective, true, undefined)).toBeNull();
    expect(freezeAiBillingSnapshot(initial.effective, true, cleared.effective)).toMatchObject({ revision: 2, declaration: null });
    const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, f.connection.id));
    expect(audit.map(entry => entry.details)).toEqual(expect.arrayContaining([expect.objectContaining({ before: expect.objectContaining({ revision: 1 }), after: expect.objectContaining({ revision: 2, declaration: null }) })]));
  });
  it("preserves declarations on ordinary edits, hides evidence and prevents config bypass", async () => {
    const f = await connectionFixture(), billing = aiConnectionBillingService(db);
    await billing.put(f.companyId, f.connection.id, { expectedRevision: null, declaration }, f.owner);
    const tools = toolAccessService(db);
    const renamed = await tools.updateConnection(f.connection.id, { name: "Renamed synthetic proxy" });
    expect(renamed.config).not.toHaveProperty("aiBilling");
    expect((await billing.get(f.companyId, f.connection.id, f.owner)).effective).toMatchObject({ declaration });
    await expect(tools.updateConnection(f.connection.id, { config: { ...f.connection.config } })).rejects.toThrow(/reconnect/i);
    await expect(tools.updateConnection(f.connection.id, { config: { aiBilling: { declaration: null } } })).rejects.toThrow(/billing declaration/i);
  });
  it("rejects declarations for Chat routes outside the supported Responses paths", async () => {
    const f = await connectionFixture();
    const ai = f.connection.config.ai as Record<string, unknown>;
    await db.update(toolConnections).set({ config: { ai: { ...ai, routing: { ...(ai.routing as object), protocol: "chat" } } } }).where(eq(toolConnections.id, f.connection.id));
    await expect(aiConnectionBillingService(db).put(f.companyId, f.connection.id, { expectedRevision: null, declaration }, f.owner)).rejects.toThrow(/Responses/);
  });
  it("invalidates a declaration when routing or credential metadata changes", async () => {
    const f = await connectionFixture(), service = aiConnectionBillingService(db);
    await service.put(f.companyId, f.connection.id, { expectedRevision: null, declaration }, f.owner);
    const [changed] = await db.update(toolConnections).set({ authKind: "none" }).where(eq(toolConnections.id, f.connection.id)).returning();
    expect(await effectiveAiBilling(db, changed)).toMatchObject({ revision: 1, declaration: null });
  });

  it.each(["native", "legacy"].flatMap(runtimeMode => ["included", "undeclared", "charged"].map(scenario => ({ runtimeMode, scenario }))))("journals and settles $runtimeMode/$scenario using the canonical receipt", async ({ runtimeMode, scenario }) => {
    const f = await fixture();
    await billingReconciliationService(db).adjust(f.companyId, f.event.id, correction() as never, "fixture-owner");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "succeeded", runtimeMode, invocationSource: "on_demand", triggerDetail: "manual", costAccountingPending: true, usageJson: { ledgerScope: { projectId: f.projectId } } });
    const directory = await mkdtemp(join(tmpdir(), "paperclip-included-receipt-"));
    try {
      const recorder = await createRunUsageRecorder(db, { companyId: f.companyId, runId, adapterType: "codex_local" }, directory);
      const billing = resolveManagedOpenAiBilling({ kind: "local" }, scenario === "undeclared" ? null : { revision: 1, declaration, updatedAt: "2026-10-26T12:00:00Z", updatedByUserId: "fixture-owner" });
      await recorder.complete({ exitCode: 0, signal: null, timedOut: false, ...billing, model: "synthetic-model", usage: { inputTokens: 10, outputTokens: 2 }, usageBasis: "per_run", costUsd: scenario === "charged" ? 0.25 : null });
      expect(await accountRunCost(db, runId)).toBe(true);
      const [event] = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
      expect(event).toMatchObject({ billingType: scenario === "included" ? "subscription_included" : "metered_api", costStatus: scenario === "undeclared" ? "unpriced" : "reported", costCents: scenario === "charged" ? 25 : 0, inputTokens: 10, outputTokens: 2 });
      const [receipt] = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, runId));
      expect(JSON.stringify(receipt.receiptJson)).not.toContain("billingDeclaration");
      const receiptHash = receipt.receiptHash;
      expect(await accountRunCost(db, runId)).toBe(false);
      const [afterReceipt] = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.id, receipt.id));
      expect(afterReceipt.receiptHash).toBe(receiptHash);
      const overview = await f.budgets.overview(f.companyId);
      expect(overview.policies[0].unpricedEventCount).toBe(scenario === "undeclared" ? 1 : 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("can revoke mistaken inclusion with a new unknown adjustment and restore the budget hold", async () => {
    const f = await fixture(), service = billingReconciliationService(db);
    await service.adjust(f.companyId, f.event.id, correction() as never, "fixture-owner");
    const revoke = { ...correction(), reason: "Synthetic revocation: the original inclusion confirmation is disputed.", billingClassification: { expected: { billingType: "subscription_included", biller: "unknown" }, corrected: { billingType: "unknown", biller: "unknown" } } };
    await service.adjust(f.companyId, f.event.id, revoke as never, "fixture-owner");
    const event = await service.event(f.companyId, f.event.id);
    expect(event).toMatchObject({ billingType: "unknown", costStatus: "unpriced", receiptHash: f.event.receiptHash, inputTokens: 10, outputTokens: 2 });
    expect(await service.adjustments(f.companyId, f.event.id)).toHaveLength(2);
    expect((await f.budgets.overview(f.companyId)).policies[0]).toMatchObject({ status: "hard_stop", unpricedEventCount: 1, unpricedUsagePolicy: "block" });
  });

  it("does not accept a subscription classification with a nonzero per-run charge", async () => {
    const f = await fixture();
    await expect(billingReconciliationService(db).adjust(f.companyId, f.event.id, { ...correction(), correctedCents: "1" } as never, "fixture-owner")).rejects.toThrow(/subscription/i);
  });
});
