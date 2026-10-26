import { and, eq, sql } from "drizzle-orm";
import { modelReferenceRates, type Db } from "@paperclipai/db";
import { centsToUsd, unitsToCents, usdToUnits, estimateReferenceUsage, modelReferenceRateInputSchema,
  type ModelReferenceRate, type ModelReferenceRateInput, type ModelReferenceEstimateRow, type ModelReferenceReport } from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { costService } from "./costs.js";
import type { CostDateRange } from "./cost-date-range.js";

type Stored = typeof modelReferenceRates.$inferSelect;
function present(row: Stored): ModelReferenceRate {
  return { provider: row.provider, model: row.model, inputUsdPerMillion: row.inputUsdPerMillion,
    cachedInputUsdPerMillion: row.cachedInputUsdPerMillion, outputUsdPerMillion: row.outputUsdPerMillion,
    cacheWriteUsdPerMillion: row.cacheWriteUsdPerMillion, sourceUrl: row.sourceUrl, verifiedAt: row.verifiedAt,
    notes: row.notes, revision: row.revision, updatedAt: row.updatedAt.toISOString() };
}
const key = (provider: string, model: string) => JSON.stringify([provider, model]);

export function modelReferenceRateService(db: Db) {
  return {
    async save(companyId: string, raw: ModelReferenceRateInput, actor: { userId: string; canEdit: boolean }) {
      if (!actor.canEdit) throw forbidden("Managing reference rates requires connection management permission");
      const input = modelReferenceRateInputSchema.parse(raw);
      // Reuse the company NO KEY UPDATE lock and audit publication boundary.
      // No provider calls, file I/O or usage-ledger mutations occur under it.
      return withAccountingTransaction(db, companyId, async (tx, publications) => {
        const identity = and(eq(modelReferenceRates.companyId, companyId), eq(modelReferenceRates.provider, input.provider), eq(modelReferenceRates.model, input.model));
        const [previous] = await tx.select().from(modelReferenceRates).where(identity);
        if ((previous?.revision ?? null) !== input.expectedRevision) throw conflict("Reference rate changed. Reload before saving.");
        const { expectedRevision: _, ...values } = input;
        let saved: Stored;
        if (previous) {
          [saved] = await tx.update(modelReferenceRates).set({ ...values, revision: previous.revision + 1, updatedAt: new Date(), updatedByUserId: actor.userId }).where(identity).returning();
        } else {
          const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(modelReferenceRates).where(eq(modelReferenceRates.companyId, companyId));
          if (count.total >= 1000) throw conflict("Company reference rate limit reached");
          [saved] = await tx.insert(modelReferenceRates).values({ ...values, companyId, updatedByUserId: actor.userId }).returning();
        }
        await logActivity(tx, { companyId, actorType: "user", actorId: actor.userId, action: "model_reference_rate.saved", entityType: "model_reference_rate", entityId: saved.id,
          details: { previous: previous ? present(previous) : null, current: present(saved) } }, publications);
        return present(saved);
      });
    },
    async report(companyId: string, range: CostDateRange | undefined, canEdit: boolean): Promise<ModelReferenceReport> {
      // One grouped ledger read plus one company-indexed config read, independent
      // of the number of model groups. Both are local database operations.
      const [stored, usage] = await Promise.all([
        db.select().from(modelReferenceRates).where(eq(modelReferenceRates.companyId, companyId)).orderBy(modelReferenceRates.provider, modelReferenceRates.model),
        costService(db).byProvider(companyId, range),
      ]);
      const rates = stored.map(present);
      const config = new Map(rates.map(rate => [key(rate.provider, rate.model), rate]));
      const grouped = new Map<string, Omit<ModelReferenceEstimateRow, "knownUsd" | "complete">>();
      for (const rate of rates) grouped.set(key(rate.provider, rate.model), { provider: rate.provider, model: rate.model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, eventCount: 0, rate });
      for (const row of usage) {
        const id = key(row.provider, row.model);
        const target = grouped.get(id) ?? { provider: row.provider, model: row.model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, eventCount: 0, rate: config.get(id) ?? null };
        target.inputTokens += row.inputTokens; target.cachedInputTokens += row.cachedInputTokens; target.outputTokens += row.outputTokens; target.eventCount += row.eventCount;
        grouped.set(id, target);
      }
      const rows = [...grouped.values()].map(row => ({ ...row, ...estimateReferenceUsage(row, row.rate) }));
      const total = rows.reduce((sum, row) => sum + usdToUnits(row.knownUsd), 0n);
      return { rates, rows, canEdit, knownUsd: centsToUsd(unitsToCents(total)), incompleteRowCount: rows.filter(row => !row.complete).length };
    },
  };
}
