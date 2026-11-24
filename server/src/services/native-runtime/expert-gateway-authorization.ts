import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createEnvGatewayRevocationPublisher } from "./expert-gateway-revocation-bridge.js";

export type GatewayWireApi = "responses" | "chat_completions" | "messages";

export type GatewayDenialCode =
  | "RUN_GENERATION_STALE"
  | "TASK_CANCELLED"
  | "USER_AUTH_REVOKED"
  | "MODEL_NOT_ALLOWED"
  | "BUDGET_EXHAUSTED";

export type GatewayLeaseStatus =
  | "active"
  | "cancelled"
  | "auth_revoked"
  | "budget_exhausted"
  | "expired";

export interface ExpertGatewayLeaseRecord {
  runId: string;
  runGeneration: number;
  agentId: string;
  companyId: string;
  userId: string;
  sessionTokenHash: string;
  allowedModels: string[];
  wireApi: GatewayWireApi;
  status: GatewayLeaseStatus;
  leaseExpiresAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  /**
   * Lazy credential resolver invoked ONLY after all authorization gates pass.
   * Returns per-request upstream headers (e.g. Authorization or RFC 8693
   * sub/act dual-subject token) or null if the user's credentials were revoked.
   */
  resolveUpstreamHeaders: () => Promise<Record<string, string> | null> | Record<string, string> | null;
}

export interface IssueExpertGatewayLeaseInput {
  runId: string;
  runGeneration: number;
  agentId: string;
  companyId: string;
  userId: string;
  allowedModels: string[];
  wireApi?: GatewayWireApi;
  ttlMs?: number;
  resolveUpstreamHeaders: ExpertGatewayLeaseRecord["resolveUpstreamHeaders"];
}

export interface IssuedExpertGatewayLease {
  sessionToken: string;
  runId: string;
  runGeneration: number;
  leaseExpiresAt: string;
}

export interface GatewayAuthorizeRequest {
  runId: string;
  runGeneration: number;
  agentId: string;
  requestedModel: string;
  wireApi: GatewayWireApi;
  clientRequestId: string;
  sessionToken: string;
}

export interface GatewayAuthorizeAllow {
  decision: "allow";
  status: 200;
  runId: string;
  runGeneration: number;
  leaseExpiresAt: string;
  clientRequestId: string;
  upstream: {
    headers: Record<string, string>;
  };
}

export interface GatewayAuthorizeDeny {
  decision: "deny";
  status: 401 | 403 | 409 | 429;
  code: GatewayDenialCode;
  message: string;
  retryable: false;
  runId: string;
  runGeneration: number;
  clientRequestId: string;
}

export type GatewayAuthorizeDecision = GatewayAuthorizeAllow | GatewayAuthorizeDeny;

export interface GatewayAuditEvent {
  runId: string;
  runGeneration: number;
  agentId: string;
  requestedModel: string;
  wireApi: GatewayWireApi;
  clientRequestId: string;
  decision: "allow" | "deny";
  code: GatewayDenialCode | null;
  status: number;
  durationMs: number;
}

export interface GatewayRevocationEvent {
  type: "run_revoked" | "user_revoked";
  reason: "cancelled" | "auth_revoked" | "budget_exhausted" | "expired";
  runId?: string;
  runGeneration?: number;
  companyId?: string;
  userId?: string;
  revokedAt: string;
}

export interface GatewayReconcileLeaseSnapshot {
  runId: string;
  runGeneration: number;
  agentId: string;
  allowedModels: string[];
  wireApi: GatewayWireApi;
  leaseExpiresAt: string;
}

export interface GatewayRevocationPublisher {
  publish(event: GatewayRevocationEvent): Promise<void> | void;
}

export interface ExpertGatewayLeaseStore {
  get(runId: string): Promise<ExpertGatewayLeaseRecord | null> | ExpertGatewayLeaseRecord | null;
  set(record: ExpertGatewayLeaseRecord): Promise<void> | void;
  listAll(): Promise<ExpertGatewayLeaseRecord[]> | ExpertGatewayLeaseRecord[];
  delete(runId: string): Promise<void> | void;
}

export const DEFAULT_GATEWAY_LEASE_TTL_MS = 30 * 60 * 1000;
export const GATEWAY_REVOCATION_CHANNEL = "delegra:gateway:revocations";

export function hashGatewaySessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

export function createInMemoryExpertGatewayLeaseStore(): ExpertGatewayLeaseStore {
  const records = new Map<string, ExpertGatewayLeaseRecord>();
  return {
    get: (runId) => records.get(runId) ?? null,
    set: (record) => {
      records.set(record.runId, record);
    },
    listAll: () => Array.from(records.values()),
    delete: (runId) => {
      records.delete(runId);
    },
  };
}

export function createInMemoryRevocationBus(): GatewayRevocationPublisher & {
  subscribe(listener: (event: GatewayRevocationEvent) => void): () => void;
} {
  const listeners = new Set<(event: GatewayRevocationEvent) => void>();
  return {
    publish(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface CreateExpertGatewayAuthorizationServiceOptions {
  store?: ExpertGatewayLeaseStore;
  revocationPublisher?: GatewayRevocationPublisher;
  onAuditEvent?: (event: GatewayAuditEvent) => void;
  now?: () => number;
}

export interface ExpertGatewayAuthorizationService {
  issueLease(input: IssueExpertGatewayLeaseInput): Promise<IssuedExpertGatewayLease>;
  authorize(request: GatewayAuthorizeRequest): Promise<GatewayAuthorizeDecision>;
  revokeRun(
    runId: string,
    reason: "cancelled" | "auth_revoked" | "budget_exhausted" | "expired",
  ): Promise<boolean>;
  revokeUser(
    companyId: string,
    userId: string,
    reason?: "auth_revoked" | "budget_exhausted",
  ): Promise<number>;
  reconcileActiveLeases(): Promise<GatewayReconcileLeaseSnapshot[]>;
}

function isModelAllowed(allowedModels: readonly string[], requestedModel: string): boolean {
  const normalized = requestedModel.trim();
  if (normalized.length === 0) return false;
  for (const allowed of allowedModels) {
    if (allowed === "*" || allowed === normalized) return true;
  }
  return false;
}

/**
 * Control-plane per-request authorization service for `delegra-gateway-proxy`.
 *
 * Agent sandboxes never hold user model credentials; they hold only a one-time
 * session token bound to `(runId, runGeneration)`. Before forwarding any
 * `/v1/responses` call to the enterprise AI gateway, the cluster proxy invokes
 * `authorize()` to verify token, generation, cancellation, model scope, and
 * budget, receiving ephemeral upstream headers only when all checks pass.
 */
export function createExpertGatewayAuthorizationService(
  options: CreateExpertGatewayAuthorizationServiceOptions = {},
): ExpertGatewayAuthorizationService {
  const store = options.store ?? createInMemoryExpertGatewayLeaseStore();
  const revocationPublisher =
    options.revocationPublisher ?? createEnvGatewayRevocationPublisher(process.env);
  const onAuditEvent = options.onAuditEvent;
  const nowFn = options.now ?? Date.now;

  function emitAudit(
    request: GatewayAuthorizeRequest,
    decision: GatewayAuthorizeDecision,
    startedAtMs: number,
  ): void {
    if (!onAuditEvent) return;
    onAuditEvent({
      runId: request.runId,
      runGeneration: request.runGeneration,
      agentId: request.agentId,
      requestedModel: request.requestedModel,
      wireApi: request.wireApi,
      clientRequestId: request.clientRequestId,
      decision: decision.decision,
      code: decision.decision === "deny" ? decision.code : null,
      status: decision.status,
      durationMs: Math.max(0, nowFn() - startedAtMs),
    });
  }

  function deny(
    request: GatewayAuthorizeRequest,
    status: 401 | 403 | 409 | 429,
    code: GatewayDenialCode,
    message: string,
    startedAtMs: number,
  ): GatewayAuthorizeDeny {
    const result: GatewayAuthorizeDeny = {
      decision: "deny",
      status,
      code,
      message,
      retryable: false,
      runId: request.runId,
      runGeneration: request.runGeneration,
      clientRequestId: request.clientRequestId,
    };
    emitAudit(request, result, startedAtMs);
    return result;
  }

  return {
    async issueLease(input) {
      if (!Number.isInteger(input.runGeneration) || input.runGeneration < 1) {
        throw new Error("runGeneration must be a positive integer");
      }
      const nowMs = nowFn();
      const ttlMs = input.ttlMs ?? DEFAULT_GATEWAY_LEASE_TTL_MS;
      const sessionToken = randomBytes(32).toString("hex");
      const record: ExpertGatewayLeaseRecord = {
        runId: input.runId,
        runGeneration: input.runGeneration,
        agentId: input.agentId,
        companyId: input.companyId,
        userId: input.userId,
        sessionTokenHash: hashGatewaySessionToken(sessionToken),
        allowedModels: [...input.allowedModels],
        wireApi: input.wireApi ?? "responses",
        status: "active",
        leaseExpiresAtMs: nowMs + ttlMs,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        resolveUpstreamHeaders: input.resolveUpstreamHeaders,
      };
      await store.set(record);
      return {
        sessionToken,
        runId: record.runId,
        runGeneration: record.runGeneration,
        leaseExpiresAt: new Date(record.leaseExpiresAtMs).toISOString(),
      };
    },

    async authorize(request) {
      const startedAtMs = nowFn();

      if (!request.sessionToken || request.sessionToken.trim().length === 0) {
        return deny(request, 401, "USER_AUTH_REVOKED", "Missing proxy session token.", startedAtMs);
      }

      const record = await store.get(request.runId);
      if (!record) {
        return deny(
          request,
          403,
          "TASK_CANCELLED",
          "Run lease is not active or has already been released.",
          startedAtMs,
        );
      }

      if (record.agentId !== request.agentId) {
        return deny(
          request,
          401,
          "USER_AUTH_REVOKED",
          "Agent identity does not match the active gateway lease.",
          startedAtMs,
        );
      }

      const presentedHash = hashGatewaySessionToken(request.sessionToken);
      if (!constantTimeEqualHex(presentedHash, record.sessionTokenHash)) {
        return deny(
          request,
          401,
          "USER_AUTH_REVOKED",
          "Proxy session token is invalid or revoked.",
          startedAtMs,
        );
      }

      if (request.runGeneration !== record.runGeneration) {
        return deny(
          request,
          409,
          "RUN_GENERATION_STALE",
          `Run generation ${request.runGeneration} has been superseded by generation ${record.runGeneration}.`,
          startedAtMs,
        );
      }

      if (record.status === "cancelled" || record.status === "expired") {
        return deny(
          request,
          403,
          "TASK_CANCELLED",
          "Task was cancelled or its gateway lease expired.",
          startedAtMs,
        );
      }

      if (record.status === "auth_revoked") {
        return deny(
          request,
          401,
          "USER_AUTH_REVOKED",
          "User authorization has been revoked.",
          startedAtMs,
        );
      }

      if (record.status === "budget_exhausted") {
        return deny(
          request,
          429,
          "BUDGET_EXHAUSTED",
          "User or team AI budget is exhausted.",
          startedAtMs,
        );
      }

      if (record.leaseExpiresAtMs <= startedAtMs) {
        return deny(
          request,
          403,
          "TASK_CANCELLED",
          "Gateway lease has expired.",
          startedAtMs,
        );
      }

      if (!isModelAllowed(record.allowedModels, request.requestedModel)) {
        return deny(
          request,
          403,
          "MODEL_NOT_ALLOWED",
          `Model "${request.requestedModel}" is not authorized for this expert run.`,
          startedAtMs,
        );
      }

      const upstreamHeaders = await record.resolveUpstreamHeaders();
      if (!upstreamHeaders || Object.keys(upstreamHeaders).length === 0) {
        return deny(
          request,
          401,
          "USER_AUTH_REVOKED",
          "User upstream gateway credentials are no longer valid.",
          startedAtMs,
        );
      }

      const result: GatewayAuthorizeAllow = {
        decision: "allow",
        status: 200,
        runId: record.runId,
        runGeneration: record.runGeneration,
        leaseExpiresAt: new Date(record.leaseExpiresAtMs).toISOString(),
        clientRequestId: request.clientRequestId,
        upstream: {
          headers: { ...upstreamHeaders },
        },
      };
      emitAudit(request, result, startedAtMs);
      return result;
    },

    async revokeRun(runId, reason) {
      const record = await store.get(runId);
      if (!record) return false;
      const nowMs = nowFn();
      await store.set({
        ...record,
        status: reason,
        updatedAtMs: nowMs,
      });
      await revocationPublisher?.publish({
        type: "run_revoked",
        reason,
        runId: record.runId,
        runGeneration: record.runGeneration,
        companyId: record.companyId,
        userId: record.userId,
        revokedAt: new Date(nowMs).toISOString(),
      });
      return true;
    },

    async revokeUser(companyId, userId, reason = "auth_revoked") {
      const all = await store.listAll();
      const nowMs = nowFn();
      const revokedAt = new Date(nowMs).toISOString();
      let count = 0;

      for (const record of all) {
        if (record.companyId === companyId && record.userId === userId && record.status === "active") {
          await store.set({
            ...record,
            status: reason,
            updatedAtMs: nowMs,
          });
          await revocationPublisher?.publish({
            type: "run_revoked",
            reason,
            runId: record.runId,
            runGeneration: record.runGeneration,
            companyId: record.companyId,
            userId: record.userId,
            revokedAt,
          });
          count += 1;
        }
      }

      await revocationPublisher?.publish({
        type: "user_revoked",
        reason,
        companyId,
        userId,
        revokedAt,
      });

      return count;
    },

    async reconcileActiveLeases() {
      const nowMs = nowFn();
      const all = await store.listAll();
      const active: GatewayReconcileLeaseSnapshot[] = [];
      for (const record of all) {
        if (record.status === "active" && record.leaseExpiresAtMs > nowMs) {
          active.push({
            runId: record.runId,
            runGeneration: record.runGeneration,
            agentId: record.agentId,
            allowedModels: [...record.allowedModels],
            wireApi: record.wireApi,
            leaseExpiresAt: new Date(record.leaseExpiresAtMs).toISOString(),
          });
        }
      }
      return active;
    },
  };
}
