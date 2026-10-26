import { describe, expect, it } from "vitest";
import { inferOpenAiCompatibleBiller, resolveManagedOpenAiBilling, normalizeDeclaredBilling } from "./billing.js";

describe("inferOpenAiCompatibleBiller", () => {
  it("returns openrouter when OPENROUTER_API_KEY is present", () => {
    expect(
      inferOpenAiCompatibleBiller({ OPENROUTER_API_KEY: "sk-or-123" } as NodeJS.ProcessEnv, "openai"),
    ).toBe("openrouter");
  });

  it("returns openrouter when OPENAI_BASE_URL points at OpenRouter", () => {
    expect(
      inferOpenAiCompatibleBiller(
        { OPENAI_BASE_URL: "https://openrouter.ai/api/v1" } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openrouter");
  });

  it("returns fallback when no OpenRouter markers are present", () => {
    expect(
      inferOpenAiCompatibleBiller(
        { OPENAI_BASE_URL: "https://api.openai.com/v1" } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openai");
  });

  it.each(["https://proxy.example/v1", "https://openrouter.ai.example/v1", "https://example.org/openrouter.ai", "http://api.openai.com/v1", "invalid"])("does not apply direct provider prices to %s", (baseUrl) => {
    expect(inferOpenAiCompatibleBiller({ OPENAI_BASE_URL: baseUrl }, "openai")).toBe("unknown");
  });

  it("recognizes each supported base URL override", () => {
    expect(inferOpenAiCompatibleBiller({ OPENAI_API_BASE: "https://proxy.example" })).toBe("unknown");
    expect(inferOpenAiCompatibleBiller({ OPENAI_API_BASE_URL: "https://proxy.example" })).toBe("unknown");
    expect(inferOpenAiCompatibleBiller({}, null)).toBeNull();
  });
});

describe("managed Responses routing", () => {
  const billing = {
    revision: 1,
    declaration: { billingType: "subscription_included", biller: "unknown", pricingProvenance: {
      source: "operator", version: "included-fixture/v1", evidence: "The account owner confirmed fixed subscription coverage; no additional usage charge.",
    } },
    updatedAt: "2026-10-26T00:00:00.000Z", updatedByUserId: "fixture-owner",
  };
  it("separates an audited subscription declaration from API-key authentication", () => {
    expect(resolveManagedOpenAiBilling({ kind: "local" }, billing)).toMatchObject({
      provider: "openai", biller: "unknown", billingType: "subscription_included", costUsd: 0,
      pricingProvenance: billing.declaration.pricingProvenance,
    });
  });
  it("clearing the declaration restores unknown proxy prices", () => {
    expect(resolveManagedOpenAiBilling({ kind: "local" }, { ...billing, revision: 2, declaration: null }))
      .toEqual({ provider: "openai", biller: "unknown", billingType: "api" });
  });
  it.each([["openrouter", "api_key", "openrouter"], ["custom", "api_key", "unknown"], ["local", "none", "unknown"]])("keeps %s/%s usage outside direct OpenAI pricing", (kind, auth, biller) => {
    expect(resolveManagedOpenAiBilling({ kind, auth })).toEqual({ provider: "openai", biller, billingType: "api" });
  });
  it("leaves ordinary direct API and subscription detection unchanged", () => {
    expect(resolveManagedOpenAiBilling(undefined)).toBeUndefined();
  });
});

const included = { billingType: "subscription_included", biller: "unknown", pricingProvenance: { source: "operator", version: "included/v1", evidence: "Synthetic fixed subscription confirmation" } } as const;
describe("declared billing canonicalization", () => {
  it("retains clear zero provenance using only the old receipt fields", () => {
    expect(normalizeDeclaredBilling({ billingDeclaration: included, costUsd: null, complete: true })).toEqual({ billingType: "subscription_included", biller: "unknown", costUsd: 0, costUsdExact: "0", costStatus: "reported", pricingProvenance: included.pricingProvenance, complete: true });
  });
  it.each([{ costUsd: 0.25 }, { costUsd: 0.25, costUsdExact: "0", cacheAdjustedCostUsd: 0 }, { costUsd: null, costUsdExact: "0.123456789" }])("lets actual reported charges win: %j", cost => {
    const canonical = normalizeDeclaredBilling({ ...cost, billingDeclaration: included, billingType: "subscription_included", pricingProvenance: included.pricingProvenance });
    expect(canonical).toMatchObject({ billingType: "metered_api", costStatus: "reported", pricingProvenance: { source: "provider_reported" } });
    expect(canonical).not.toHaveProperty("billingDeclaration");
    expect(Number(canonical.cacheAdjustedCostUsd ?? canonical.costUsdExact ?? canonical.costUsd)).toBeGreaterThan(0);
  });
  it("does not reinterpret an undeclared subscription estimate", () => {
    const original = { billingType: "subscription_included", costUsd: 0.25 } as const;
    expect(normalizeDeclaredBilling(original)).toBe(original);
  });
});
