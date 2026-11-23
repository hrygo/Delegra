import type {
  ExpertGatewayAuthorizationService,
  GatewayRevocationEvent,
  GatewayRevocationPublisher,
} from "./expert-gateway-authorization.js";

export const PROXY_PUSH_REVOCATIONS_PATH = "/internal/revocations";
export const DEFAULT_REVOCATION_PUSH_TIMEOUT_MS = 2_000;

export interface HttpGatewayRevocationPublisherOptions {
  proxyBaseUrls: readonly string[];
  internalToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (proxyUrl: string, error: unknown) => void;
}

/**
 * Parses comma-separated `DELEGRA_GATEWAY_PROXY_URLS` (or single
 * `DELEGRA_GATEWAY_PROXY_URL`) into deduplicated http(s) base URLs.
 */
export function parseGatewayProxyRevocationUrls(
  env: Record<string, string | undefined>,
): string[] {
  const raw = env.DELEGRA_GATEWAY_PROXY_URLS ?? env.DELEGRA_GATEWAY_PROXY_URL ?? "";
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const part of raw.split(",")) {
    const trimmed = part.trim().replace(/\/+$/, "");
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        urls.push(trimmed);
      }
    } catch {
      // Ignore malformed entries rather than crashing control-plane startup.
    }
  }

  return urls;
}

/**
 * Creates a best-effort HTTP fan-out `GatewayRevocationPublisher` that pushes
 * `run_revoked` events directly to each configured `delegra-gateway-proxy`
 * `POST /internal/revocations` endpoint for `<100ms` stream termination.
 */
export function createHttpGatewayRevocationPublisher(
  options: HttpGatewayRevocationPublisherOptions,
): GatewayRevocationPublisher {
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REVOCATION_PUSH_TIMEOUT_MS;
  const targets = options.proxyBaseUrls
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter((u) => u.length > 0);
  const internalToken = options.internalToken.trim();

  return {
    async publish(event: GatewayRevocationEvent): Promise<void> {
      if (event.type !== "run_revoked" || !event.runId || targets.length === 0 || !internalToken) {
        return;
      }

      const payload = JSON.stringify({
        runId: event.runId,
        ...(event.runGeneration !== undefined ? { runGeneration: event.runGeneration } : {}),
        reason: event.reason,
        revokedAt: event.revokedAt,
      });

      await Promise.allSettled(
        targets.map(async (baseUrl) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetchFn(`${baseUrl}${PROXY_PUSH_REVOCATIONS_PATH}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${internalToken}`,
              },
              body: payload,
              signal: controller.signal,
            });
            if (!res.ok) {
              options.onError?.(baseUrl, new Error(`HTTP ${res.status}`));
            }
          } catch (err) {
            options.onError?.(baseUrl, err);
          } finally {
            clearTimeout(timer);
          }
        }),
      );
    },
  };
}

/**
 * Builds an HTTP revocation publisher from process environment variables when
 * both proxy URL(s) and `DELEGRA_GATEWAY_INTERNAL_TOKEN` are configured.
 */
export function createEnvGatewayRevocationPublisher(
  env: Record<string, string | undefined>,
  deps: {
    fetchImpl?: typeof fetch;
    onError?: (proxyUrl: string, error: unknown) => void;
  } = {},
): GatewayRevocationPublisher | undefined {
  const proxyBaseUrls = parseGatewayProxyRevocationUrls(env);
  const internalToken = env.DELEGRA_GATEWAY_INTERNAL_TOKEN?.trim() ?? "";
  if (proxyBaseUrls.length === 0 || !internalToken) {
    return undefined;
  }
  return createHttpGatewayRevocationPublisher({
    proxyBaseUrls,
    internalToken,
    fetchImpl: deps.fetchImpl,
    onError: deps.onError,
  });
}

let activeExpertGatewayAuthzService: ExpertGatewayAuthorizationService | null = null;

/**
 * Registers the active control-plane `ExpertGatewayAuthorizationService` so
 * run-cancellation and user-revocation paths can terminate in-flight proxy
 * streams without introducing circular module dependencies.
 */
export function registerExpertGatewayAuthzService(
  service: ExpertGatewayAuthorizationService,
): () => void {
  activeExpertGatewayAuthzService = service;
  return () => {
    if (activeExpertGatewayAuthzService === service) {
      activeExpertGatewayAuthzService = null;
    }
  };
}

export function getActiveExpertGatewayAuthzService(): ExpertGatewayAuthorizationService | null {
  return activeExpertGatewayAuthzService;
}

/**
 * Safe lifecycle hook for revoking a run's expert gateway lease (no-op if no
 * authorization service is registered in this process).
 */
export async function revokeExpertGatewayRun(
  runId: string,
  reason: "cancelled" | "auth_revoked" | "budget_exhausted" | "expired" = "cancelled",
): Promise<boolean> {
  if (!activeExpertGatewayAuthzService || !runId.trim()) return false;
  try {
    return await activeExpertGatewayAuthzService.revokeRun(runId.trim(), reason);
  } catch {
    return false;
  }
}

/**
 * Safe lifecycle hook for revoking all active expert gateway leases for a user
 * (no-op if no authorization service is registered in this process).
 */
export async function revokeExpertGatewayUser(
  companyId: string,
  userId: string,
  reason: "auth_revoked" | "budget_exhausted" = "auth_revoked",
): Promise<number> {
  if (!activeExpertGatewayAuthzService || !companyId.trim() || !userId.trim()) return 0;
  try {
    return await activeExpertGatewayAuthzService.revokeUser(companyId.trim(), userId.trim(), reason);
  } catch {
    return 0;
  }
}
