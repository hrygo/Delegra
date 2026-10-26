import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, numeric, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Operator reference scenarios; never part of the invoice/budget ledger. */
export const modelReferenceRates = pgTable("model_reference_rates", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputUsdPerMillion: numeric("input_usd_per_million", { precision: 18, scale: 9 }),
  cachedInputUsdPerMillion: numeric("cached_input_usd_per_million", { precision: 18, scale: 9 }),
  outputUsdPerMillion: numeric("output_usd_per_million", { precision: 18, scale: 9 }),
  cacheWriteUsdPerMillion: numeric("cache_write_usd_per_million", { precision: 18, scale: 9 }),
  sourceUrl: text("source_url"),
  verifiedAt: text("verified_at").notNull(),
  notes: text("notes").notNull().default(""),
  revision: integer("revision").notNull().default(0),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  identity: uniqueIndex("model_reference_rates_company_model_idx").on(table.companyId, table.provider, table.model),
  valid: check("model_reference_rates_nonnegative", sql`${table.revision} >= 0 and (${table.inputUsdPerMillion} is null or ${table.inputUsdPerMillion} >= 0) and (${table.cachedInputUsdPerMillion} is null or ${table.cachedInputUsdPerMillion} >= 0) and (${table.outputUsdPerMillion} is null or ${table.outputUsdPerMillion} >= 0) and (${table.cacheWriteUsdPerMillion} is null or ${table.cacheWriteUsdPerMillion} >= 0)`),
}));
