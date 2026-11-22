import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import {
  type ExpertGatewayAuthorizationService,
  type GatewayWireApi,
} from "../services/native-runtime/expert-gateway-authorization.js";

export const GATEWAY_AUTHORIZE_PATH = "/internal/runner/v1/gateway-authorize";
export const GATEWAY_RECONCILE_PATH = "/internal/runner/v1/gateway-reconcile";

export interface ExpertGatewayAuthzRoutesOptions {
  service: ExpertGatewayAuthorizationService;
  /**
   * Optional verifier for proxy-to-control-plane internal authentication.
   * Defaults to constant-time Bearer token comparison against
   * `process.env.DELEGRA_GATEWAY_INTERNAL_TOKEN` (fail-closed when unset).
   */
  verifyProxyAuth?: (req: Request) => Promise<boolean> | boolean;
  /** Optional explicit internal token override for tests. */
  internalToken?: string | null;
}

const VALID_WIRE_APIS = new Set<GatewayWireApi>(["responses", "chat_completions", "messages"]);

function constantTimeCompareStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function extractBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match?.[1]?.trim() || null;
}

function applyNoStoreHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

/**
 * Internal routes called exclusively by `delegra-gateway-proxy` for
 * per-request authorization (`POST /internal/runner/v1/gateway-authorize`)
 * and startup/reconnect active-lease reconciliation
 * (`GET /internal/runner/v1/gateway-reconcile`).
 */
export function expertGatewayAuthzRoutes(options: ExpertGatewayAuthzRoutesOptions) {
  const router = Router();

  async function authenticateProxy(req: Request, res: Response): Promise<boolean> {
    if (options.verifyProxyAuth) {
      const ok = await options.verifyProxyAuth(req);
      if (!ok) {
        applyNoStoreHeaders(res);
        res.status(401).json({
          decision: "deny",
          code: "USER_AUTH_REVOKED",
          message: "Unauthorized gateway proxy request.",
          retryable: false,
        });
        return false;
      }
      return true;
    }

    const expectedToken =
      options.internalToken !== undefined
        ? options.internalToken
        : process.env.DELEGRA_GATEWAY_INTERNAL_TOKEN?.trim() || null;

    if (!expectedToken) {
      applyNoStoreHeaders(res);
      res.status(503).json({
        decision: "deny",
        code: "TASK_CANCELLED",
        message: "Expert gateway internal authorization is not configured.",
        retryable: false,
      });
      return false;
    }

    const presented = extractBearerToken(req.headers.authorization);
    if (!presented || !constantTimeCompareStrings(presented, expectedToken)) {
      applyNoStoreHeaders(res);
      res.status(401).json({
        decision: "deny",
        code: "USER_AUTH_REVOKED",
        message: "Invalid gateway proxy internal credentials.",
        retryable: false,
      });
      return false;
    }
    return true;
  }

  router.post(GATEWAY_AUTHORIZE_PATH, async (req, res, next) => {
    try {
      applyNoStoreHeaders(res);
      if (!(await authenticateProxy(req, res))) return;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const runId = typeof body.runId === "string" ? body.runId.trim() : "";
      const runGeneration =
        typeof body.runGeneration === "number" ? body.runGeneration : Number(body.runGeneration);
      const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
      const requestedModel =
        typeof body.requestedModel === "string" ? body.requestedModel.trim() : "";
      const wireApi = (typeof body.wireApi === "string" ? body.wireApi.trim() : "responses") as GatewayWireApi;
      const clientRequestId =
        typeof body.clientRequestId === "string" ? body.clientRequestId.trim() : "";
      const headerSessionToken =
        typeof req.headers["x-delegra-session-token"] === "string"
          ? req.headers["x-delegra-session-token"].trim()
          : "";
      const bodySessionToken =
        typeof body.sessionToken === "string" ? body.sessionToken.trim() : "";
      const sessionToken = headerSessionToken || bodySessionToken;

      if (
        !runId ||
        !Number.isInteger(runGeneration) ||
        runGeneration < 1 ||
        !agentId ||
        !requestedModel ||
        !clientRequestId ||
        !VALID_WIRE_APIS.has(wireApi)
      ) {
        res.status(400).json({
          decision: "deny",
          code: "TASK_CANCELLED",
          message:
            "Invalid gateway-authorize payload: runId, positive integer runGeneration, agentId, requestedModel, valid wireApi, and clientRequestId are required.",
          retryable: false,
        });
        return;
      }

      const decision = await options.service.authorize({
        runId,
        runGeneration,
        agentId,
        requestedModel,
        wireApi,
        clientRequestId,
        sessionToken,
      });

      res.status(decision.status).json(decision);
    } catch (error) {
      next(error);
    }
  });

  router.get(GATEWAY_RECONCILE_PATH, async (req, res, next) => {
    try {
      applyNoStoreHeaders(res);
      if (!(await authenticateProxy(req, res))) return;

      const leases = await options.service.reconcileActiveLeases();
      res.status(200).json({
        leases,
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
