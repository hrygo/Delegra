import { describe, expect, it } from "vitest";
import { estimateReferenceUsage, modelReferenceRateInputSchema } from "./model-reference-rates.js";

const rate = { inputUsdPerMillion: "2", cachedInputUsdPerMillion: "0.1", outputUsdPerMillion: "10" };
describe("public reference token prices", () => {
  it("prices exclusive input, cached reads and output once with exact decimal arithmetic", () => {
    expect(estimateReferenceUsage({ inputTokens: 1000000, cachedInputTokens: 2000000, outputTokens: 100000 }, rate))
      .toEqual({ knownUsd: "3.200000000", complete: true });
    expect(estimateReferenceUsage({ inputTokens: 0, cachedInputTokens: 1, outputTokens: 0 }, { ...rate, cachedInputUsdPerMillion: "0.003625" }).knownUsd)
      .toBe("0.000000004");
  });
  it("retains known subtotals while unknown categories and models stay incomplete", () => {
    expect(estimateReferenceUsage({ inputTokens: 1000000, cachedInputTokens: 10, outputTokens: 0 }, { ...rate, cachedInputUsdPerMillion: null }))
      .toEqual({ knownUsd: "2.000000000", complete: false });
    expect(estimateReferenceUsage({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }, null).complete).toBe(false);
    expect(estimateReferenceUsage({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }, { ...rate, inputUsdPerMillion: "0" }))
      .toEqual({ knownUsd: "0.000000000", complete: true });
  });
  it("rejects invalid tokens, prices, unsafe URLs, extra fields and negative revisions", () => {
    expect(() => estimateReferenceUsage({ inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 }, rate)).toThrow();
    const input = { provider: "openai", model: "gpt-6.1-sol", ...rate, cacheWriteUsdPerMillion: null,
      sourceUrl: "https://developers.openai.com/api/docs/pricing", verifiedAt: "2026-10-26", notes: "Standard, short context", expectedRevision: null };
    expect(modelReferenceRateInputSchema.safeParse(input).success).toBe(true);
    for (const bad of ["-1", "NaN", "1e3", "1000001", "0.1234567891"]) {
      expect(modelReferenceRateInputSchema.safeParse({ ...input, inputUsdPerMillion: bad }).success, bad).toBe(false);
    }
    expect(modelReferenceRateInputSchema.safeParse({ ...input, sourceUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(modelReferenceRateInputSchema.safeParse({ ...input, expectedRevision: -1 }).success).toBe(false);
    expect(modelReferenceRateInputSchema.safeParse({ ...input, companyId: "other" }).success).toBe(false);
  });
});
