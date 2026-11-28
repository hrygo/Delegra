import express, { Router, type Request, type Response } from "express";
import {
  EmployeeExpertsError,
  type EmployeeExpertsService,
} from "../services/employee-experts.js";
import {
  EMPLOYEE_TOKEN_EXCHANGE_PATH,
  type EmployeeTokenExchangeService,
} from "../services/employee-token-exchange.js";

export const EMPLOYEE_EXPERTS_API_PREFIX = "/api/v1/employee";

export interface EmployeeExpertsRoutesOptions {
  service: EmployeeExpertsService;
  tokenExchange?: EmployeeTokenExchangeService;
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

function sendError(res: Response, error: unknown): void {
  applyNoStoreHeaders(res);
  if (error instanceof EmployeeExpertsError) {
    res.status(error.status).json(error.toEnvelope());
    return;
  }
  const fallback = new EmployeeExpertsError("EXPERT_INTERNAL_ERROR", "Internal employee expert service error.", {
    retryable: false,
  });
  res.status(fallback.status).json(fallback.toEnvelope());
}

function queryString(req: Request, key: string): string {
  const value = req.query[key];
  return typeof value === "string" ? value : "";
}

/**
 * Restricted employee-scoped expert directory and private task acceptance API
 * implementing CORP-DSH-EXPERT-001 (§2.3, §3, §4, §6, §7, §8).
 */
export function employeeExpertsRoutes(options: EmployeeExpertsRoutesOptions) {
  const router = Router();
  const { service, tokenExchange } = options;

  router.post(
    EMPLOYEE_TOKEN_EXCHANGE_PATH,
    express.urlencoded({ extended: false, limit: "16kb" }),
    async (req, res) => {
      try {
        applyNoStoreHeaders(res);
        if (!tokenExchange) {
          throw new EmployeeExpertsError(
            "EXPERT_AUTH_INVALID",
            "Employee token exchange is not enabled on this instance.",
          );
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        const result = await tokenExchange.exchangeToken({
          grant_type: typeof body.grant_type === "string" ? body.grant_type : undefined,
          subject_token: typeof body.subject_token === "string" ? body.subject_token : undefined,
          subject_token_type:
            typeof body.subject_token_type === "string" ? body.subject_token_type : undefined,
          audience: typeof body.audience === "string" ? body.audience : undefined,
          resource: typeof body.resource === "string" ? body.resource : undefined,
          scope: typeof body.scope === "string" ? body.scope : undefined,
          org_id: typeof body.org_id === "string" ? body.org_id : undefined,
          orgId: typeof body.orgId === "string" ? body.orgId : undefined,
        });
        res.status(200).json(result);
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.get(`${EMPLOYEE_EXPERTS_API_PREFIX}/experts`, async (req, res) => {
    try {
      applyNoStoreHeaders(res);
      const rawLimit = queryString(req, "limit");
      const limit = rawLimit ? Number(rawLimit) : undefined;
      const result = await service.listExperts({
        bearerToken: extractBearerToken(req.headers.authorization),
        orgId: queryString(req, "orgId"),
        view: queryString(req, "view"),
        query: queryString(req, "query") || undefined,
        cursor: queryString(req, "cursor") || undefined,
        limit,
      });
      res.status(200).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post(`${EMPLOYEE_EXPERTS_API_PREFIX}/experts/scope-check`, async (req, res) => {
    try {
      applyNoStoreHeaders(res);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await service.scopeCheck({
        bearerToken: extractBearerToken(req.headers.authorization),
        orgId: typeof body.orgId === "string" ? body.orgId : "",
        delegationScope: typeof body.delegationScope === "string" ? body.delegationScope : "",
        expertIds: body.expertIds,
      });
      res.status(200).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post(`${EMPLOYEE_EXPERTS_API_PREFIX}/expert-tasks`, async (req, res) => {
    try {
      applyNoStoreHeaders(res);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await service.createTask({
        bearerToken: extractBearerToken(req.headers.authorization),
        orgId: typeof body.orgId === "string" ? body.orgId : "",
        expertId: typeof body.expertId === "string" ? body.expertId : "",
        delegationScope: typeof body.delegationScope === "string" ? body.delegationScope : "",
        requestId: typeof body.requestId === "string" ? body.requestId : "",
        originSessionRef: typeof body.originSessionRef === "string" ? body.originSessionRef : undefined,
        taskText: typeof body.taskText === "string" ? body.taskText : "",
        payloadDigest: typeof body.payloadDigest === "string" ? body.payloadDigest : "",
        reuseRefs: Array.isArray(body.reuseRefs) ? (body.reuseRefs as string[]) : undefined,
      });
      res.status(result.httpStatus).json(result.body);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get(`${EMPLOYEE_EXPERTS_API_PREFIX}/expert-tasks/by-request/:requestId`, async (req, res) => {
    try {
      applyNoStoreHeaders(res);
      const result = await service.getTaskByRequest({
        bearerToken: extractBearerToken(req.headers.authorization),
        orgId: queryString(req, "orgId"),
        requestId: req.params.requestId ?? "",
      });
      res.status(200).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get(`${EMPLOYEE_EXPERTS_API_PREFIX}/expert-tasks/:taskId`, async (req, res) => {
    try {
      applyNoStoreHeaders(res);
      const result = await service.getTask({
        bearerToken: extractBearerToken(req.headers.authorization),
        orgId: queryString(req, "orgId"),
        taskId: req.params.taskId ?? "",
      });
      res.status(200).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get(`${EMPLOYEE_EXPERTS_API_PREFIX}/expert-tasks/:taskId/result`, async (req, res) => {
    try {
      applyNoStoreHeaders(res);
      const result = await service.getTaskResult({
        bearerToken: extractBearerToken(req.headers.authorization),
        orgId: queryString(req, "orgId"),
        taskId: req.params.taskId ?? "",
      });
      res.status(200).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post(`${EMPLOYEE_EXPERTS_API_PREFIX}/expert-tasks/:taskId/followups`, async (req, res) => {
    try {
      applyNoStoreHeaders(res);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await service.createFollowup({
        bearerToken: extractBearerToken(req.headers.authorization),
        orgId: typeof body.orgId === "string" ? body.orgId : "",
        taskId: req.params.taskId ?? "",
        requestId: typeof body.requestId === "string" ? body.requestId : "",
        taskText: typeof body.taskText === "string" ? body.taskText : "",
        payloadDigest: typeof body.payloadDigest === "string" ? body.payloadDigest : "",
        reuseRefs: Array.isArray(body.reuseRefs) ? (body.reuseRefs as string[]) : undefined,
      });
      res.status(result.httpStatus).json(result.body);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post(`${EMPLOYEE_EXPERTS_API_PREFIX}/expert-tasks/:taskId/cancel`, async (req, res) => {
    try {
      applyNoStoreHeaders(res);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await service.cancelTask({
        bearerToken: extractBearerToken(req.headers.authorization),
        orgId: typeof body.orgId === "string" ? body.orgId : "",
        taskId: req.params.taskId ?? "",
      });
      res.status(200).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
