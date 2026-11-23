import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { randomUUID, timingSafeEqual } from "node:crypto";

export const DEFAULT_GATEWAY_MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MiB
export const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const ALLOWED_PROXY_PATH = "/v1/responses";
export const INTERNAL_REVOCATIONS_PATH = "/internal/revocations";

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

export interface SseUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface SseAuditSummary {
  terminalEvent: string | null;
  truncatedEof: boolean;
  responseId?: string;
  usage?: SseUsageMetrics;
}

export interface ProxyAccessLogEntry {
  clientRequestId: string;
  runId: string;
  runGeneration: number;
  status: number;
  durationMs: number;
  outcome: "allowed" | "denied" | "aborted" | "error";
  code?: string;
  sseSummary?: SseAuditSummary;
}

export interface CreateDelegraGatewayProxyOptions {
  /** Upstream enterprise AI gateway base URL (e.g. `https://ai-gateway.internal`). */
  upstreamGatewayUrl: string;
  /** Per-request control-plane authorization callback. */
  authorize: (input: ProxyAuthorizeInput) => Promise<ProxyAuthorizeResult>;
  /**
   * Optional custom fetch implementation. Defaults to `createLongLivedUpstreamFetch()`,
   * which disables Node/Undici's 300s default headers/body timeout for long reasoning streams.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional shared internal token enabling `POST /internal/revocations` for
   * `<100ms` push revocation from the control plane or a Redis Pub/Sub bridge.
   */
  internalAuthToken?: string;
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

const LONG_LIVED_HTTP_AGENT = new HttpAgent({
  keepAlive: true,
  keepAliveMsecs: 60_000,
});

const LONG_LIVED_HTTPS_AGENT = new HttpsAgent({
  keepAlive: true,
  keepAliveMsecs: 60_000,
});

/**
 * Creates a `fetch`-compatible upstream transport backed by `node:http` /
 * `node:https` with `timeout: 0` (no 300s Undici headersTimeout/bodyTimeout
 * truncation on long reasoning streams), native backpressure (`pause`/`resume`),
 * and immediate `AbortSignal` socket teardown.
 */
export function createLongLivedUpstreamFetch(): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(rawUrl);
    const isHttps = url.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const agent = isHttps ? LONG_LIVED_HTTPS_AGENT : LONG_LIVED_HTTP_AGENT;

    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined;
      if (signal?.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }

      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((value, key) => {
            headers[key] = value;
          });
        } else if (Array.isArray(init.headers)) {
          for (const [key, value] of init.headers) {
            headers[key] = value;
          }
        } else {
          for (const [key, value] of Object.entries(init.headers)) {
            if (value !== undefined) headers[key] = String(value);
          }
        }
      }

      const req = requestFn(
        url,
        {
          method: init?.method ?? "GET",
          headers,
          agent,
          timeout: 0,
        },
        (upstreamRes) => {
          const responseHeaders = new Headers();
          for (const [key, val] of Object.entries(upstreamRes.headers)) {
            if (val === undefined) continue;
            if (Array.isArray(val)) {
              for (const entry of val) responseHeaders.append(key, entry);
            } else {
              responseHeaders.set(key, val);
            }
          }

          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const onAbort = () => {
                upstreamRes.destroy();
                try {
                  controller.error(new DOMException("The operation was aborted.", "AbortError"));
                } catch {
                  // Stream already closed or errored.
                }
              };
              signal?.addEventListener("abort", onAbort, { once: true });

              upstreamRes.on("data", (chunk: Buffer | string) => {
                const bytes = Buffer.isBuffer(chunk) ? new Uint8Array(chunk) : Buffer.from(chunk);
                try {
                  controller.enqueue(bytes);
                  if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                    upstreamRes.pause();
                  }
                } catch {
                  upstreamRes.destroy();
                }
              });

              upstreamRes.once("end", () => {
                signal?.removeEventListener("abort", onAbort);
                try {
                  controller.close();
                } catch {
                  // Stream already closed.
                }
              });

              upstreamRes.once("error", (err) => {
                signal?.removeEventListener("abort", onAbort);
                try {
                  controller.error(err);
                } catch {
                  // Stream already closed.
                }
              });
            },
            pull() {
              upstreamRes.resume();
            },
            cancel() {
              upstreamRes.destroy();
              req.destroy();
            },
          });

          resolve(
            new Response(stream, {
              status: upstreamRes.statusCode ?? 502,
              statusText: upstreamRes.statusMessage ?? "",
              headers: responseHeaders,
            }),
          );
        },
      );

      req.setTimeout(0);

      const onAbortBeforeResponse = () => {
        req.destroy(new DOMException("The operation was aborted.", "AbortError"));
      };
      signal?.addEventListener("abort", onAbortBeforeResponse, { once: true });

      req.once("response", () => {
        signal?.removeEventListener("abort", onAbortBeforeResponse);
      });

      req.once("error", (err) => {
        signal?.removeEventListener("abort", onAbortBeforeResponse);
        reject(err);
      });

      if (init?.body !== undefined && init.body !== null) {
        if (typeof init.body === "string") {
          req.end(Buffer.from(init.body, "utf8"));
        } else if (init.body instanceof Uint8Array) {
          req.end(Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength));
        } else if (init.body instanceof ArrayBuffer) {
          req.end(Buffer.from(init.body));
        } else {
          req.end(String(init.body));
        }
      } else {
        req.end();
      }
    });
  };
}

const SSE_TERMINAL_EVENT_TYPES = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

/**
 * Zero-body incremental SSE audit accumulator:
 * - Never retains prompt, delta, or assistant content.
 * - Extracts only terminal event name, responseId, and numeric token usage.
 * - Flags `truncatedEof: true` when an HTTP 200 SSE stream closes without a
 *   terminal event (`[DONE]` or `response.completed`/`incomplete`/`failed`).
 */
export function createSseAuditAccumulator() {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let lineBuffer = "";
  let terminalEvent: string | null = null;
  let responseId: string | undefined;
  let usage: SseUsageMetrics | undefined;

  function processLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      if (terminalEvent === null) terminalEvent = "[DONE]";
      return;
    }
    if (!data.startsWith("{")) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    const eventType = typeof parsed.type === "string" ? parsed.type : "";
    if (!SSE_TERMINAL_EVENT_TYPES.has(eventType)) return;

    terminalEvent = eventType;
    const responseObj =
      parsed.response && typeof parsed.response === "object"
        ? (parsed.response as Record<string, unknown>)
        : parsed;

    if (typeof responseObj.id === "string" && responseObj.id.trim().length > 0) {
      responseId = responseObj.id.trim();
    }

    const usageObj =
      responseObj.usage && typeof responseObj.usage === "object"
        ? (responseObj.usage as Record<string, unknown>)
        : undefined;
    if (usageObj) {
      const extracted: SseUsageMetrics = {};
      if (typeof usageObj.input_tokens === "number") extracted.inputTokens = usageObj.input_tokens;
      if (typeof usageObj.output_tokens === "number") extracted.outputTokens = usageObj.output_tokens;
      if (typeof usageObj.total_tokens === "number") extracted.totalTokens = usageObj.total_tokens;
      if (Object.keys(extracted).length > 0) usage = extracted;
    }
  }

  return {
    feed(chunk: Uint8Array): void {
      lineBuffer += decoder.decode(chunk, { stream: true });
      let newlineIdx = lineBuffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = lineBuffer.slice(0, newlineIdx);
        lineBuffer = lineBuffer.slice(newlineIdx + 1);
        processLine(line);
        newlineIdx = lineBuffer.indexOf("\n");
      }
      // Cap residual partial line buffer to prevent unbounded growth on huge non-newline frames.
      if (lineBuffer.length > 64 * 1024) {
        lineBuffer = "";
      }
    },
    finish(statusCode: number, aborted: boolean): SseAuditSummary {
      lineBuffer += decoder.decode();
      if (lineBuffer.length > 0) {
        processLine(lineBuffer);
        lineBuffer = "";
      }
      const truncatedEof = statusCode === 200 && !aborted && terminalEvent === null;
      return {
        terminalEvent,
        truncatedEof,
        ...(responseId ? { responseId } : {}),
        ...(usage ? { usage } : {}),
      };
    },
  };
}

function constantTimeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
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

function waitForDrain(res: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted || res.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const onDone = () => {
      res.off("drain", onDone);
      res.off("close", onDone);
      signal.removeEventListener("abort", onDone);
      resolve();
    };
    res.once("drain", onDone);
    res.once("close", onDone);
    signal.addEventListener("abort", onDone, { once: true });
  });
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
 * - Accepts only `POST /v1/responses` (plus `/healthz`, `/readyz`, and optional
 *   internal-token-authenticated `POST /internal/revocations`).
 * - Enforces a strict 16 MiB request body cap before JSON parsing.
 * - Requires `Authorization: Bearer <PROXY_SESSION_TOKEN>`,
 *   `X-Paperclip-Run-Id`, and `X-Paperclip-Run-Generation`.
 * - Calls control-plane per-request authorization before forwarding; denied or
 *   revoked requests produce zero upstream gateway traffic.
 * - Defaults to `createLongLivedUpstreamFetch()` (`timeout: 0`, no 300s Undici
 *   truncation), applies backpressure on slow consumers, tracks zero-body SSE
 *   completion/truncation (`STREAM_TRUNCATED_EOF`), sends 15s keep-alive
 *   heartbeats, and scrubs credentials immediately on completion or abort.
 */
export function createDelegraGatewayProxy(
  options: CreateDelegraGatewayProxyOptions,
): DelegraGatewayProxyHandle {
  const fetchFn = options.fetchImpl ?? createLongLivedUpstreamFetch();
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_GATEWAY_MAX_BODY_BYTES;
  const heartbeatMs = options.sseHeartbeatIntervalMs ?? DEFAULT_SSE_HEARTBEAT_INTERVAL_MS;
  const upstreamBase = options.upstreamGatewayUrl.replace(/\/+$/, "");
  const internalAuthToken = options.internalAuthToken?.trim() || null;

  const revokedRuns = new Map<string, number | "all">();
  const inFlightByRun = new Map<string, Set<AbortController>>();

  function isLocallyRevoked(runId: string, runGeneration: number): boolean {
    const entry = revokedRuns.get(runId);
    if (entry === undefined) return false;
    if (entry === "all") return true;
    return runGeneration <= entry;
  }

  function revokeRunInternal(runId: string, runGeneration?: number): number {
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

    if (urlPath === INTERNAL_REVOCATIONS_PATH && internalAuthToken) {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        writeJson(res, 405, {
          error: { code: "METHOD_NOT_ALLOWED", message: "Only POST /internal/revocations is allowed." },
        });
        return;
      }
      const presented = extractBearer(req.headers.authorization);
      if (!presented || !constantTimeEqualStrings(presented, internalAuthToken)) {
        writeJson(res, 401, {
          error: { code: "UNAUTHORIZED", message: "Invalid internal revocation credentials." },
        });
        return;
      }
      let revBody: Record<string, unknown>;
      try {
        const raw = await readBoundedBody(req, 64 * 1024);
        revBody = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        writeJson(res, 400, {
          error: { code: "BAD_REQUEST", message: "Revocation payload must be valid JSON." },
        });
        return;
      }
      const targetRunId = typeof revBody.runId === "string" ? revBody.runId.trim() : "";
      const targetGen =
        typeof revBody.runGeneration === "number" && Number.isInteger(revBody.runGeneration) && revBody.runGeneration >= 1
          ? revBody.runGeneration
          : undefined;
      if (!targetRunId) {
        writeJson(res, 400, {
          error: { code: "BAD_REQUEST", message: "runId is required." },
        });
        return;
      }
      const abortedStreams = revokeRunInternal(targetRunId, targetGen);
      writeJson(res, 200, {
        revoked: true,
        runId: targetRunId,
        ...(targetGen !== undefined ? { runGeneration: targetGen } : {}),
        abortedStreams,
      });
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
      const sseAudit = isSse ? createSseAuditAccumulator() : null;
      if (isSse) {
        res.setHeader("X-Accel-Buffering", "no");
        res.setHeader("Connection", "keep-alive");
      }
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
            sseAudit?.feed(value);
            const canContinue = res.write(Buffer.from(value));
            if (!canContinue) {
              await waitForDrain(res, controller.signal);
            }
          }
        }
      }
      if (!res.writableEnded) {
        res.end();
      }
      const sseSummary = sseAudit?.finish(upstreamRes.status, controller.signal.aborted);
      emitLog({
        clientRequestId,
        runId,
        runGeneration,
        status: upstreamRes.status,
        durationMs: Date.now() - startedAt,
        outcome: controller.signal.aborted ? "aborted" : "allowed",
        ...(sseSummary?.truncatedEof ? { code: "STREAM_TRUNCATED_EOF" } : {}),
        ...(sseSummary ? { sseSummary } : {}),
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
    revokeRun: revokeRunInternal,
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
