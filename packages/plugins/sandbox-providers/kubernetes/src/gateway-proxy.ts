import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export const DEFAULT_GATEWAY_MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MiB
export const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const ALLOWED_PROXY_PATH = "/v1/responses";

export interface ProxyAuthorizeInput {
  runId: string;
  runGeneration: number;
  agentId: string;
  requestedModel: string;
  wireApi: "responses";
  clientRequestId: string;
  sessionToken: string;
}

export type ProxyAuthorizeResult =
  | {
      decision: "allow";
      leaseExpiresAt: string;
      upstream: { headers: Record<string, string> };
    }
  | {
      decision: "deny";
      status: number;
      code: string;
      message: string;
      retryable: false;
    };

export interface ProxyAccessLogEntry {
  clientRequestId: string;
  runId: string;
  runGeneration: number;
  status: number;
  durationMs: number;
  outcome: "allowed" | "denied" | "aborted" | "error";
  code?: string;
}

export interface CreateDelegraGatewayProxyOptions {
  /** Upstream enterprise AI gateway base URL (e.g. `https://ai-gateway.internal`). */
  upstreamGatewayUrl: string;
  /** Per-request control-plane authorization callback. */
  authorize: (input: ProxyAuthorizeInput) => Promise<ProxyAuthorizeResult>;
  /** Optional custom fetch implementation (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Maximum accepted request payload size in bytes (defaults to 16 MiB). */
  maxBodyBytes?: number;
  /** SSE keep-alive comment interval in ms (defaults to 15s; 0 disables). */
  sseHeartbeatIntervalMs?: number;
  /** Zero-credential structured access log sink (never receives tokens or bodies). */
  onAccessLog?: (entry: ProxyAccessLogEntry) => void;
}

export interface DelegraGatewayProxyHandle {
  server: Server;
  /**
   * Immediately revokes a run (and optionally a specific generation) and aborts
   * all in-flight upstream requests for that run (<100ms stream termination).
   */
  revokeRun(runId: string, runGeneration?: number): number;
  /** Returns count of currently active in-flight streams. */
  activeStreamCount(): number;
  listen(port: number, host?: string): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
}

function extractBearer(headerValue: string | string[] | undefined): string | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() || null;
}

function readSingleHeader(headerValue: string | string[] | undefined): string {
  if (Array.isArray(headerValue)) return (headerValue[0] ?? "").trim();
  return typeof headerValue === "string" ? headerValue.trim() : "";
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  requestId?: string,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (requestId) {
    res.setHeader("X-Gateway-Request-Id", requestId);
  }
  res.end(JSON.stringify(body));
}

async function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

class PayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeded ${maxBytes} byte limit.`);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Erases sensitive header values from the per-request upstream header map in
 * place so credentials do not linger on the heap after request completion.
 */
function scrubHeaders(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    headers[key] = "";
    delete headers[key];
  }
}

/**
 * Cluster-level zero-trust HTTP proxy (`delegra-gateway-proxy`) deployed in the
 * `paperclip` namespace.
 *
 * - Accepts only `POST /v1/responses` (plus `/healthz` and `/readyz`).
 * - Enforces a strict 16 MiB request body cap before JSON parsing.
 * - Requires `Authorization: Bearer <PROXY_SESSION_TOKEN>`,
 *   `X-Paperclip-Run-Id`, and `X-Paperclip-Run-Generation`.
 * - Calls control-plane per-request authorization before forwarding; denied or
 *   revoked requests produce zero upstream gateway traffic.
 * - Attaches ephemeral `upstream.headers` in request-local memory only, streams
 *   SSE responses verbatim with `X-Gateway-Request-Id` and 15s keep-alive
 *   heartbeats, and scrubs credentials immediately on completion or abort.
 */
export function createDelegraGatewayProxy(
  options: CreateDelegraGatewayProxyOptions,
): DelegraGatewayProxyHandle {
  const fetchFn = options.fetchImpl ?? fetch;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_GATEWAY_MAX_BODY_BYTES;
  const heartbeatMs = options.sseHeartbeatIntervalMs ?? DEFAULT_SSE_HEARTBEAT_INTERVAL_MS;
  const upstreamBase = options.upstreamGatewayUrl.replace(/\/+$/, "");

  const revokedRuns = new Map<string, number | "all">();
  const inFlightByRun = new Map<string, Set<AbortController>>();

  function isLocallyRevoked(runId: string, runGeneration: number): boolean {
    const entry = revokedRuns.get(runId);
    if (entry === undefined) return false;
    if (entry === "all") return true;
    return runGeneration <= entry;
  }

  function trackController(runId: string, controller: AbortController): () => void {
    let set = inFlightByRun.get(runId);
    if (!set) {
      set = new Set<AbortController>();
      inFlightByRun.set(runId, set);
    }
    set.add(controller);
    return () => {
      set?.delete(controller);
      if (set && set.size === 0) {
        inFlightByRun.delete(runId);
      }
    };
  }

  function emitLog(entry: ProxyAccessLogEntry): void {
    options.onAccessLog?.(entry);
  }

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const urlPath = (req.url ?? "/").split("?")[0];

    if (req.method === "GET" && (urlPath === "/healthz" || urlPath === "/readyz")) {
      writeJson(res, 200, { status: "ok" });
      return;
    }

    if (urlPath !== ALLOWED_PROXY_PATH) {
      writeJson(res, 404, {
        error: { code: "NOT_FOUND", message: "Path not allowed by delegra-gateway-proxy." },
      });
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      writeJson(res, 405, {
        error: { code: "METHOD_NOT_ALLOWED", message: "Only POST /v1/responses is allowed." },
      });
      return;
    }

    const clientRequestId = readSingleHeader(req.headers["x-client-request-id"]) || randomUUID();
    const sessionToken = extractBearer(req.headers.authorization);
    const runId = readSingleHeader(req.headers["x-paperclip-run-id"]);
    const rawGen = readSingleHeader(req.headers["x-paperclip-run-generation"]);
    const agentId = readSingleHeader(req.headers["x-paperclip-agent-id"]) || "unknown";
    const runGeneration = rawGen ? Number(rawGen) : NaN;

    if (!sessionToken || !runId || !Number.isInteger(runGeneration) || runGeneration < 1) {
      writeJson(
        res,
        401,
        {
          error: {
            code: "USER_AUTH_REVOKED",
            message:
              "Missing or invalid Authorization Bearer token, X-Paperclip-Run-Id, or X-Paperclip-Run-Generation.",
            retryable: false,
            clientRequestId,
          },
        },
        clientRequestId,
      );
      emitLog({
        clientRequestId,
        runId: runId || "unknown",
        runGeneration: Number.isInteger(runGeneration) ? runGeneration : 0,
        status: 401,
        durationMs: Date.now() - startedAt,
        outcome: "denied",
        code: "USER_AUTH_REVOKED",
      });
      return;
    }

    if (isLocallyRevoked(runId, runGeneration)) {
      writeJson(
        res,
        403,
        {
          error: {
            code: "TASK_CANCELLED",
            message: "Run lease was locally revoked.",
            retryable: false,
            clientRequestId,
          },
        },
        clientRequestId,
      );
      emitLog({
        clientRequestId,
        runId,
        runGeneration,
        status: 403,
        durationMs: Date.now() - startedAt,
        outcome: "denied",
        code: "TASK_CANCELLED",
      });
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readBoundedBody(req, maxBodyBytes);
    } catch (err) {
      const status = err instanceof PayloadTooLargeError ? 413 : 400;
      writeJson(
        res,
        status,
        {
          error: {
            code: status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
            message: err instanceof Error ? err.message : "Failed to read request body.",
            retryable: false,
            clientRequestId,
          },
        },
        clientRequestId,
      );
      emitLog({
        clientRequestId,
        runId,
        runGeneration,
        status,
        durationMs: Date.now() - startedAt,
        outcome: "denied",
        code: status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
      });
      return;
    }

    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      writeJson(
        res,
        400,
        {
          error: {
            code: "BAD_REQUEST",
            message: "Request body must be valid JSON.",
            retryable: false,
            clientRequestId,
          },
        },
        clientRequestId,
      );
      return;
    }

    const requestedModel = typeof parsedBody.model === "string" ? parsedBody.model.trim() : "";
    if (!requestedModel) {
      writeJson(
        res,
        400,
        {
          error: {
            code: "MODEL_NOT_ALLOWED",
            message: "Request JSON must include a non-empty `model` field.",
            retryable: false,
            clientRequestId,
          },
        },
        clientRequestId,
      );
      return;
    }

    let authz: ProxyAuthorizeResult;
    try {
      authz = await options.authorize({
        runId,
        runGeneration,
        agentId,
        requestedModel,
        wireApi: "responses",
        clientRequestId,
        sessionToken,
      });
    } catch {
      writeJson(
        res,
        503,
        {
          error: {
            code: "AUTHZ_UNAVAILABLE",
            message: "Control-plane gateway authorization failed.",
            retryable: true,
            clientRequestId,
          },
        },
        clientRequestId,
      );
      emitLog({
        clientRequestId,
        runId,
        runGeneration,
        status: 503,
        durationMs: Date.now() - startedAt,
        outcome: "error",
        code: "AUTHZ_UNAVAILABLE",
      });
      return;
    }

    if (authz.decision === "deny") {
      if (authz.code === "TASK_CANCELLED" || authz.code === "RUN_GENERATION_STALE") {
        revokedRuns.set(runId, runGeneration);
      }
      writeJson(
        res,
        authz.status,
        {
          error: {
            code: authz.code,
            message: authz.message,
            retryable: false,
            clientRequestId,
          },
        },
        clientRequestId,
      );
      emitLog({
        clientRequestId,
        runId,
        runGeneration,
        status: authz.status,
        durationMs: Date.now() - startedAt,
        outcome: "denied",
        code: authz.code,
      });
      return;
    }

    // Per-request ephemeral credential headers; scrubbed in finally.
    const ephemeralHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Gateway-Request-Id": clientRequestId,
      ...authz.upstream.headers,
    };

    const controller = new AbortController();
    const untrack = trackController(runId, controller);
    const onClientClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once("close", onClientClose);

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    try {
      const upstreamRes = await fetchFn(`${upstreamBase}${ALLOWED_PROXY_PATH}`, {
        method: "POST",
        headers: ephemeralHeaders,
        body: new Uint8Array(rawBody),
        signal: controller.signal,
      });

      const contentType = upstreamRes.headers.get("content-type") ?? "application/json";
      const gatewayReqId = upstreamRes.headers.get("x-gateway-request-id") ?? clientRequestId;
      res.statusCode = upstreamRes.status;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Gateway-Request-Id", gatewayReqId);

      const isSse = contentType.toLowerCase().includes("text/event-stream");
      if (isSse && heartbeatMs > 0) {
        heartbeatTimer = setInterval(() => {
          if (!res.writableEnded && !controller.signal.aborted) {
            res.write(": keep-alive\n\n");
          }
        }, heartbeatMs);
      }

      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (controller.signal.aborted) {
            await reader.cancel().catch(() => undefined);
            break;
          }
          if (value && value.byteLength > 0) {
            res.write(Buffer.from(value));
          }
        }
      }
      if (!res.writableEnded) {
        res.end();
      }
      emitLog({
        clientRequestId,
        runId,
        runGeneration,
        status: upstreamRes.status,
        durationMs: Date.now() - startedAt,
        outcome: controller.signal.aborted ? "aborted" : "allowed",
      });
    } catch {
      if (!res.headersSent) {
        const aborted = controller.signal.aborted;
        writeJson(
          res,
          aborted ? 499 : 502,
          {
            error: {
              code: aborted ? "TASK_CANCELLED" : "UPSTREAM_GATEWAY_ERROR",
              message: aborted
                ? "Stream terminated due to run revocation or client disconnect."
                : "Upstream AI gateway request failed.",
              retryable: false,
              clientRequestId,
            },
          },
          clientRequestId,
        );
      } else if (!res.writableEnded) {
        res.end();
      }
      emitLog({
        clientRequestId,
        runId,
        runGeneration,
        status: controller.signal.aborted ? 499 : 502,
        durationMs: Date.now() - startedAt,
        outcome: controller.signal.aborted ? "aborted" : "error",
      });
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      req.off("close", onClientClose);
      untrack();
      scrubHeaders(ephemeralHeaders);
      scrubHeaders(authz.upstream.headers);
    }
  });

  return {
    server,
    revokeRun(runId: string, runGeneration?: number): number {
      revokedRuns.set(runId, runGeneration ?? "all");
      const active = inFlightByRun.get(runId);
      if (!active) return 0;
      let aborted = 0;
      for (const controller of active) {
        if (!controller.signal.aborted) {
          controller.abort();
          aborted += 1;
        }
      }
      return aborted;
    },
    activeStreamCount(): number {
      let total = 0;
      for (const set of inFlightByRun.values()) total += set.size;
      return total;
    },
    listen(port: number, host = "127.0.0.1"): Promise<{ port: number; host: string }> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const addr = server.address();
          const boundPort = typeof addr === "object" && addr ? addr.port : port;
          resolve({ port: boundPort, host });
        });
      });
    },
    close(): Promise<void> {
      for (const set of inFlightByRun.values()) {
        for (const controller of set) controller.abort();
      }
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
