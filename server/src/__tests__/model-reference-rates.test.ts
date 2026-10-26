import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, closeRegisteredClients, companies, agents, costEvents, activityLog } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { modelReferenceRateService } from "../services/model-reference-rates.js";
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-model-rates-"); db = createDb(database.connectionString); }, 90000);
afterAll(async () => { if (database) { await closeRegisteredClients(database.connectionString); await database.cleanup(); } });
const actor = { userId: "fixture-operator", canEdit: true };
const data = { provider: "openai", model: "gpt-6.1-sol", inputUsdPerMillion: "2", cachedInputUsdPerMillion: "0.1", outputUsdPerMillion: "10", cacheWriteUsdPerMillion: "2.5", sourceUrl: "https://developers.openai.com/api/docs/pricing", verifiedAt: "2026-10-26", notes: "Standard reference", expectedRevision: null };
async function company() {
  const id = randomUUID();
  await db.insert(companies).values({ id, name: "Rate fixture", issuePrefix: `R${id.slice(0, 7).toUpperCase()}` });
  return id;
}
describe("durable company reference rates", () => {
  it("round trips prices, rejects stale edits and isolates companies and providers", async () => {
    const c = await company(), other = await company(), service = modelReferenceRateService(db);
    const saved = await service.save(c, data, actor);
    expect(saved.inputUsdPerMillion).toBe("2.000000000");
    expect(saved.revision).toBe(0);
    await expect(service.save(c, data, actor)).rejects.toMatchObject({ status: 409 });
    await expect(service.save(c, { ...data, expectedRevision: 5 }, actor)).rejects.toMatchObject({ status: 409 });
    await expect(service.save(c, data, { ...actor, canEdit: false })).rejects.toMatchObject({ status: 403 });
    expect((await service.report(other, { allTime: true }, true)).rates).toHaveLength(0);
    const updated = await service.save(c, { ...data, inputUsdPerMillion: "3", expectedRevision: 0 }, actor);
    expect(updated.revision).toBe(1);
    const audits = await db.select().from(activityLog).where(eq(activityLog.companyId, c));
    expect(audits.filter(row => row.action === "model_reference_rate.saved")).toHaveLength(2);
    const changes = await Promise.allSettled([1, 2].map(() => service.save(c, { ...data, expectedRevision: 1 }, actor)));
    expect(changes.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(changes.filter(row => row.status === "rejected")).toHaveLength(1);
  });
  it("values subscription and API usage, normalizes legacy cache once, preserves ledger and dates", async () => {
    const c = await company(), service = modelReferenceRateService(db);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: c, name: "Agent", role: "engineer", adapterType: "codex_local" });
    await service.save(c, data, actor);
    const base = { companyId: c, agentId, provider: "openai", model: "gpt-6.1-sol", costCents: 0, inputTokens: 1000000, cachedInputTokens: 500000, outputTokens: 100000, occurredAt: new Date("2026-10-10T00:00:00Z") };
    await db.insert(costEvents).values([
      { ...base, billingType: "subscription_included", receiptHash: "normalized" },
      { ...base, billingType: "metered_api" }, // Legacy input includes cached.
      { ...base, provider: "anthropic", receiptHash: "normalized" }, // Same model is not same provider.
      { ...base, occurredAt: new Date("2026-09-01T00:00:00Z"), receiptHash: "normalized" },
    ]);
    const report = await service.report(c, { from: new Date("2026-10-01"), to: new Date("2026-10-31") }, true);
    const row = report.rows.find(row => row.provider === "openai")!;
    expect(row.inputTokens).toBe(1500000);
    expect(row.cachedInputTokens).toBe(1000000);
    expect(row.knownUsd).toBe("5.100000000");
    expect(report.incompleteRowCount).toBe(1);
    expect(report.knownUsd).toBe("5.100000000");
    const ledger = await db.select().from(costEvents).where(eq(costEvents.companyId, c));
    expect(ledger).toHaveLength(4);
    expect(ledger.every(row => row.costCents === 0)).toBe(true);
  });
});
