import { z } from "zod";
import { centsToUsd, unitsToCents, usdToUnits } from "./money.js";

const usdRate = z.string().regex(/^\d{1,7}(?:\.\d{1,9})?$/).refine(value => { try { return usdToUnits(value) <= 1_000_000_000_000_000n; } catch { return false; } }, "Rate must not exceed 1,000,000 USD").nullable();
const publicUrl = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}, "Use a public HTTPS source URL").nullable();
export const modelReferenceRateInputSchema = z.object({
  provider: z.string().trim().min(1).max(250),
  model: z.string().trim().min(1).max(250),
  inputUsdPerMillion: usdRate,
  cachedInputUsdPerMillion: usdRate,
  outputUsdPerMillion: usdRate,
  cacheWriteUsdPerMillion: usdRate,
  sourceUrl: publicUrl,
  verifiedAt: z.iso.date(),
  notes: z.string().trim().max(1000),
  expectedRevision: z.number().int().nonnegative().max(2_147_483_646).nullable(),
}).strict().superRefine((value, ctx) => {
  if ([value.inputUsdPerMillion, value.cachedInputUsdPerMillion, value.outputUsdPerMillion, value.cacheWriteUsdPerMillion].some(rate => rate !== null) && !value.sourceUrl) {
    ctx.addIssue({ code: "custom", path: ["sourceUrl"], message: "A priced model requires its public source" });
  }
});
export type ModelReferenceRateInput = z.infer<typeof modelReferenceRateInputSchema>;
export type ModelReferenceRate = Omit<ModelReferenceRateInput, "expectedRevision"> & { revision: number; updatedAt: string };
export type ReferenceRates = Pick<ModelReferenceRate, "inputUsdPerMillion" | "cachedInputUsdPerMillion" | "outputUsdPerMillion">;
export type ReferenceUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number };
export interface ModelReferenceEstimateRow extends ReferenceUsage {
  provider: string; model: string; eventCount: number; rate: ModelReferenceRate | null;
  knownUsd: string; complete: boolean;
}
export interface ModelReferenceReport {
  rates: ModelReferenceRate[]; rows: ModelReferenceEstimateRow[];
  knownUsd: string; incompleteRowCount: number; canEdit: boolean;
}

/** Ledger input excludes cached reads. Current reference prices are scenarios,
 * not invoice evidence. Missing prices preserve known category subtotals. */
export function estimateReferenceUsage(usage: ReferenceUsage, rates: ReferenceRates | null) {
  let numerator = 0n;
  let complete = true;
  for (const [tokens, rate] of [
    [usage.inputTokens, rates?.inputUsdPerMillion],
    [usage.cachedInputTokens, rates?.cachedInputUsdPerMillion],
    [usage.outputTokens, rates?.outputUsdPerMillion],
  ] as const) {
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("Invalid reference token count");
    if (!tokens) continue;
    if (rate == null) complete = false;
    else numerator += BigInt(tokens) * usdToUnits(rate);
  }
  return { knownUsd: centsToUsd(unitsToCents((numerator + 500_000n) / 1_000_000n)), complete };
}

/** Explicit operator choices. Never infer a gateway alias or an account's plan. */
export const MODEL_REFERENCE_PRESETS = [
  { label: "OpenAI · GPT-6.1 Sol · Standard / short", input: "2", cached: "0.1", output: "10", write: "2.5", sourceUrl: "https://developers.openai.com/api/docs/pricing", notes: "Standard short context. 30-minute cache write reference; 12-hour writes cost $5/M. Other tiers and long context differ." },
  { label: "OpenAI · GPT-6 Luna · Standard / short", input: "0.1", cached: "0.01", output: "0.5", write: "0.125", sourceUrl: "https://developers.openai.com/api/docs/pricing", notes: "Standard short context. 30-minute cache write reference; 12-hour writes cost $0.25/M. Other tiers and long context differ." },
  { label: "OpenCode Go · MiMo V2.6 Pro", input: "0.435", cached: "0.003625", output: "0.87", write: null, sourceUrl: "https://opencode.ai/v2/docs/console/go/", notes: "Public allowance valuation, not an additional per-token subscription invoice." },
  { label: "OpenCode Go · DeepSeek V4.1 Flash · Peak", input: "0.30", cached: "0.006", output: "1.20", write: null, sourceUrl: "https://opencode.ai/v2/docs/console/go/", notes: "Conservative peak-rate scenario for mixed-time usage. Peak Mon–Fri 01:00–04:00 / 06:00–10:00 UTC. Off-peak is half price; not an invoice." },
  { label: "OpenCode Go · DeepSeek V4.1 Flash · Off-peak", input: "0.15", cached: "0.003", output: "0.60", write: null, sourceUrl: "https://opencode.ai/v2/docs/console/go/", notes: "Off-peak scenario only. Actual peak usage costs twice these rates; not an invoice." },
] as const;
export const MODEL_REFERENCE_PRESETS_VERIFIED_AT = "2026-10-26";
