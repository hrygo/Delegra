import { aiBillingConfigurationSchema } from "@paperclipai/shared";
import type { AdapterUsageCheckpoint } from "./types.js";

function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function inferOpenAiCompatibleBiller(
  env: NodeJS.ProcessEnv,
  fallback: string | null = "openai",
): string | null {
  const explicitOpenRouterKey = readEnv(env, "OPENROUTER_API_KEY");
  if (explicitOpenRouterKey) return "openrouter";

  const baseUrl =
    readEnv(env, "OPENAI_BASE_URL") ??
    readEnv(env, "OPENAI_API_BASE") ??
    readEnv(env, "OPENAI_API_BASE_URL");
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol === "https:" && url.hostname === "openrouter.ai") return "openrouter";
      // An OpenAI-compatible endpoint does not imply OpenAI prices. Do not
      // assign direct-provider estimates to a proxy or an unknown endpoint.
      if (url.protocol !== "https:" || url.hostname !== "api.openai.com") return "unknown";
    } catch {
      return "unknown";
    }
  }

  return fallback;
}

/** Managed Responses routes use their own credentials and prices, including
 * no-auth endpoints. Absence of OPENAI_API_KEY never makes them ChatGPT plans. */
export function resolveManagedOpenAiBilling(routing: unknown, billing?: unknown) {
  if (!routing || typeof routing !== "object") return undefined;
  const parsed = aiBillingConfigurationSchema.safeParse(billing);
  const declaration = parsed.success ? parsed.data.declaration : null;
  if (declaration) return {
    provider: "openai", biller: declaration.biller, billingType: "subscription_included" as const,
    costUsd: 0, pricingProvenance: declaration.pricingProvenance, billingDeclaration: declaration,
  };
  return {
    provider: "openai",
    biller: (routing as { kind?: unknown }).kind === "openrouter" ? "openrouter" : "unknown",
    billingType: "api" as const,
  };
}

/** Consume trusted declarations before journaling. Positive provider charges win.
 * The canonical receipt retains only fields understood by earlier releases. */
export function normalizeDeclaredBilling<T extends Partial<AdapterUsageCheckpoint>>(receipt: T): T {
  if (!receipt.billingDeclaration) return receipt;
  const { billingDeclaration, ...rest } = receipt;
  const charged = [receipt.cacheAdjustedCostUsd, receipt.costUsdExact, receipt.costUsd]
    .some(value => value != null && Number.isFinite(Number(value)) && Number(value) > 0);
  return { ...rest, ...(charged ? {
    // Zero placeholders must not mask another explicitly reported positive cost.
    ...(receipt.cacheAdjustedCostUsd != null && receipt.cacheAdjustedCostUsd === 0 ? { cacheAdjustedCostUsd: undefined } : {}),
    ...(receipt.costUsdExact != null && Number(receipt.costUsdExact) === 0 ? { costUsdExact: undefined } : {}),
    billingType: "metered_api", costStatus: receipt.costStatus === "estimated" ? "estimated" : "reported",
    pricingProvenance: receipt.pricingProvenance?.source === "provider_reported" || receipt.pricingProvenance?.source === "provider_invoice"
      ? receipt.pricingProvenance : { source: "provider_reported", evidence: "Reported provider charge takes precedence over a connection subscription declaration." },
  } : {
    billingType: "subscription_included", biller: billingDeclaration.biller, costUsd: 0, costUsdExact: "0",
    costStatus: "reported", pricingProvenance: billingDeclaration.pricingProvenance,
  }) } as T;
}
