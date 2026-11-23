import {
  createDelegraGatewayProxy,
  DEFAULT_GATEWAY_MAX_BODY_BYTES,
  DEFAULT_SSE_HEARTBEAT_INTERVAL_MS,
  type DelegraGatewayProxyHandle,
  type ProxyAccessLogEntry,
  type ProxyAuthorizeInput,
  type ProxyAuthorizeResult,
} from "./gateway-proxy.js";

export const GATEWAY_AUTHORIZE_PATH = "/internal/runner/v1/gateway-authorize";
export const GATEWAY_RECONCILE_PATH = "/internal/runner/v1/gateway-reconcile";
export const DEFAULT_GATEWAY_PROXY_PORT = 8443;
export const DEFAULT_GATEWAY_PROXY_HOST = "0.0.0.0";
export const DEFAULT_GATEWAY_RECONCILE_INTERVAL_MS = 30_000;
export const DEFAULT_GATEWAY_AUTHZ_TIMEOUT_MS = 5_000;

export interface GatewayProxyServerConfig {
  port: number;
  host: string;
  paperclipServerUrl: string;
  upstreamGatewayUrl: string;
  internalToken: string;
  maxBodyBytes: number;
  sseHeartbeatIntervalMs: number;
  reconcileIntervalMs: number;
  authzTimeoutMs: number;
}

export interface ActiveLeaseSnapshot {
  runId: string;
  runGeneration: number;
}

export interface ControlPlaneAuthorizerOptions {
  paperclipServerUrl: string;
  internalToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ReconcileActiveLeasesOptions {
  paperclipServerUrl: string;
  internalToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  proxy: Pick<DelegraGatewayProxyHandle, "revokeRun">;
  knownLeases: Map<string, number>;
}

export interface GatewayRevocationMessage {
  runId?: string;
  runGeneration?: number;
}

/**
 * Pluggable real-time revocation subscriber (e.g. Redis Pub/Sub channel
 * `delegra:gateway:revocations`) for `<100ms` in-flight stream termination.
 */
export interface GatewayRevocationSubscriber {
  subscribe(
    onRevoke: (event: GatewayRevocationMessage) => void,
  ): Promise<() => Promise<void> | void> | (() => Promise<void> | void);
}

export interface StartGatewayProxyServerDeps {
  fetchImpl?: typeof fetch;
  revocationSubscriber?: GatewayRevocationSubscriber;
  onAccessLog?: (entry: ProxyAccessLogEntry) => void;
  onError?: (message: string) => void;
}

export interface RunningGatewayProxyServer {
  handle: DelegraGatewayProxyHandle;
  port: number;
  host: string;
  reconcileOnce(): Promise<{ activeCount: number; revokedCount: number }>;
  stop(): Promise<void>;
}

function parseHttpUrl(raw: string | undefined, envName: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new Error(`${envName} is required to start delegra-gateway-proxy.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${envName} must be a valid http(s) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${envName} must use http: or https: protocol.`);
  }
  return trimmed.replace(/\/+$/, "");
}

function parseIntEnv(
  raw: string | undefined,
  envName: string,
  defaultValue: number,
  minValue: number,
  maxValue?: number,
): number {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < minValue || (maxValue !== undefined && parsed > maxValue)) {
    throw new Error(
      `${envName} must be an integer >= ${minValue}${maxValue !== undefined ? ` and <= ${maxValue}` : ""}.`,
    );
  }
  return parsed;
}

/**
 * Parses and fail-closed validates runtime environment variables for
 * `delegra-gateway-proxy`.
 */
export function parseGatewayProxyConfig(
  env: Record<string, string | undefined>,
): GatewayProxyServerConfig {
  const paperclipServerUrl = parseHttpUrl(env.PAPERCLIP_SERVER_URL, "PAPERCLIP_SERVER_URL");
  const upstreamGatewayUrl = parseHttpUrl(env.UPSTREAM_GATEWAY_URL, "UPSTREAM_GATEWAY_URL");
  const internalToken = env.DELEGRA_GATEWAY_INTERNAL_TOKEN?.trim() ?? "";
  if (!internalToken) {
    throw new Error("DELEGRA_GATEWAY_INTERNAL_TOKEN is required to start delegra-gateway-proxy.");
  }

  return {
    port: parseIntEnv(env.PORT, "PORT", DEFAULT_GATEWAY_PROXY_PORT, 0, 65535),
    host: env.HOST?.trim() || DEFAULT_GATEWAY_PROXY_HOST,
    paperclipServerUrl,
    upstreamGatewayUrl,
    internalToken,
    maxBodyBytes: parseIntEnv(
      env.GATEWAY_MAX_BODY_BYTES,
      "GATEWAY_MAX_BODY_BYTES",
      DEFAULT_GATEWAY_MAX_BODY_BYTES,
      1024,
    ),
    sseHeartbeatIntervalMs: parseIntEnv(
      env.GATEWAY_SSE_HEARTBEAT_MS,
      "GATEWAY_SSE_HEARTBEAT_MS",
      DEFAULT_SSE_HEARTBEAT_INTERVAL_MS,
      0,
    ),
    reconcileIntervalMs: parseIntEnv(
      env.GATEWAY_RECONCILE_INTERVAL_MS,
      "GATEWAY_RECONCILE_INTERVAL_MS",
      DEFAULT_GATEWAY_RECONCILE_INTERVAL_MS,
      0,
    ),
    authzTimeoutMs: parseIntEnv(
      env.GATEWAY_AUTHZ_TIMEOUT_MS,
      "GATEWAY_AUTHZ_TIMEOUT_MS",
      DEFAULT_GATEWAY_AUTHZ_TIMEOUT_MS,
      100,
    ),
  };
}

/**
 * Creates a per-request control-plane authorizer calling
 * `POST /internal/runner/v1/gateway-authorize` on `paperclip-server`.
 */
export function createControlPlaneAuthorizer(
  options: ControlPlaneAuthorizerOptions,
): (input: ProxyAuthorizeInput) => Promise<ProxyAuthorizeResult> {
  const fetchFn = options.fetchImpl ?? fetch;
  const baseUrl = options.paperclipServerUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_AUTHZ_TIMEOUT_MS;

  return async (input: ProxyAuthorizeInput): Promise<ProxyAuthorizeResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(`${baseUrl}${GATEWAY_AUTHORIZE_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.internalToken}`,
          "X-Delegra-Session-Token": input.sessionToken,
        },
        body: JSON.stringify({
          runId: input.runId,
          runGeneration: input.runGeneration,
          agentId: input.agentId,
          requestedModel: input.requestedModel,
          wireApi: input.wireApi,
          clientRequestId: input.clientRequestId,
        }),
        signal: controller.signal,
      });

      if (response.status >= 500) {
        throw new Error(`Control-plane gateway-authorize returned HTTP ${response.status}.`);
      }

      const payload = (await response.json()) as Record<string, unknown>;
      if (payload.decision === "allow") {
        const upstream = payload.upstream as { headers?: Record<string, unknown> } | undefined;
        const rawHeaders = upstream?.headers ?? {};
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawHeaders)) {
          if (typeof v === "string") headers[k] = v;
        }
        return {
          decision: "allow",
          leaseExpiresAt:
            typeof payload.leaseExpiresAt === "string" ? payload.leaseExpiresAt : "",
          upstream: { headers },
        };
      }

      if (payload.decision === "deny") {
        const status =
          typeof payload.status === "number" && Number.isInteger(payload.status)
            ? payload.status
            : response.status >= 400
              ? response.status
              : 403;
        return {
          decision: "deny",
          status,
          code: typeof payload.code === "string" ? payload.code : "POLICY_OR_SCOPE_DENIED",
          message:
            typeof payload.message === "string"
              ? payload.message
              : "Request denied by control plane.",
          retryable: false,
        };
      }

      throw new Error("Control-plane gateway-authorize returned malformed decision payload.");
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Fetches active leases from `GET /internal/runner/v1/gateway-reconcile` and
 * revokes any previously known lease that has disappeared or been superseded
 * by a newer `runGeneration`.
 */
export async function reconcileActiveLeasesOnce(
  options: ReconcileActiveLeasesOptions,
): Promise<{ activeCount: number; revokedCount: number }> {
  const fetchFn = options.fetchImpl ?? fetch;
  const baseUrl = options.paperclipServerUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_AUTHZ_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(`${baseUrl}${GATEWAY_RECONCILE_PATH}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${options.internalToken}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Control-plane gateway-reconcile returned HTTP ${response.status}.`);
    }

    const payload = (await response.json()) as { leases?: unknown };
    const leases = Array.isArray(payload.leases) ? payload.leases : [];
    const currentActive = new Map<string, number>();

    for (const item of leases) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const runId = typeof rec.runId === "string" ? rec.runId.trim() : "";
      const runGeneration =
        typeof rec.runGeneration === "number" && Number.isInteger(rec.runGeneration)
          ? rec.runGeneration
          : NaN;
      if (runId && runGeneration >= 1) {
        const existing = currentActive.get(runId) ?? 0;
        if (runGeneration > existing) {
          currentActive.set(runId, runGeneration);
        }
      }
    }

    let revokedCount = 0;
    for (const [knownRunId, knownGen] of options.knownLeases.entries()) {
      const currentGen = currentActive.get(knownRunId);
      if (currentGen === undefined) {
        options.proxy.revokeRun(knownRunId);
        revokedCount += 1;
      } else if (currentGen > knownGen) {
        options.proxy.revokeRun(knownRunId, currentGen - 1);
        revokedCount += 1;
      }
    }

    options.knownLeases.clear();
    for (const [runId, gen] of currentActive.entries()) {
      options.knownLeases.set(runId, gen);
    }

    return { activeCount: currentActive.size, revokedCount };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts the runnable cluster-level `delegra-gateway-proxy` HTTP server wired
 * to `paperclip-server` per-request authorization, real-time push/PubSub
 * revocation, and periodic lease reconciliation.
 */
export async function startDelegraGatewayProxyServer(
  config: GatewayProxyServerConfig,
  deps: StartGatewayProxyServerDeps = {},
): Promise<RunningGatewayProxyServer> {
  const knownLeases = new Map<string, number>();
  const baseAuthorizer = createControlPlaneAuthorizer({
    paperclipServerUrl: config.paperclipServerUrl,
    internalToken: config.internalToken,
    timeoutMs: config.authzTimeoutMs,
    fetchImpl: deps.fetchImpl,
  });

  const handle = createDelegraGatewayProxy({
    upstreamGatewayUrl: config.upstreamGatewayUrl,
    internalAuthToken: config.internalToken,
    maxBodyBytes: config.maxBodyBytes,
    sseHeartbeatIntervalMs: config.sseHeartbeatIntervalMs,
    fetchImpl: deps.fetchImpl,
    onAccessLog:
      deps.onAccessLog ??
      ((entry) => {
        process.stdout.write(`${JSON.stringify({ event: "gateway_proxy_access", ...entry })}\n`);
      }),
    authorize: async (input) => {
      const result = await baseAuthorizer(input);
      if (result.decision === "allow") {
        const prev = knownLeases.get(input.runId) ?? 0;
        if (input.runGeneration > prev) {
          knownLeases.set(input.runId, input.runGeneration);
        }
      }
      return result;
    },
  });

  let unsubscribeRevocations: (() => Promise<void> | void) | null = null;
  if (deps.revocationSubscriber) {
    unsubscribeRevocations = await deps.revocationSubscriber.subscribe((event) => {
      const runId = event.runId?.trim();
      if (!runId) return;
      handle.revokeRun(runId, event.runGeneration);
    });
  }

  const bound = await handle.listen(config.port, config.host);

  const reconcileOnce = () =>
    reconcileActiveLeasesOnce({
      paperclipServerUrl: config.paperclipServerUrl,
      internalToken: config.internalToken,
      timeoutMs: config.authzTimeoutMs,
      fetchImpl: deps.fetchImpl,
      proxy: handle,
      knownLeases,
    });

  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  if (config.reconcileIntervalMs > 0) {
    reconcileTimer = setInterval(() => {
      void reconcileOnce().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (deps.onError) {
          deps.onError(message);
        } else {
          process.stderr.write(
            `${JSON.stringify({ event: "gateway_proxy_reconcile_error", message })}\n`,
          );
        }
      });
    }, config.reconcileIntervalMs);
    reconcileTimer.unref();
  }

  return {
    handle,
    port: bound.port,
    host: bound.host,
    reconcileOnce,
    async stop() {
      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
      }
      if (unsubscribeRevocations) {
        await unsubscribeRevocations();
        unsubscribeRevocations = null;
      }
      await handle.close();
    },
  };
}
