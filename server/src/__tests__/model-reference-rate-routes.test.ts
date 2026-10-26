import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/error-handler.js";
const mocks = vi.hoisted(() => ({ report: vi.fn(), save: vi.fn(), decide: vi.fn(), manage: vi.fn() }));
vi.mock("../services/model-reference-rates.js", () => ({ modelReferenceRateService: () => mocks }));
vi.mock("../routes/ai-connections.js", () => ({ canManageAiConnections: mocks.manage }));
vi.mock("../services/index.js", () => ({ heartbeatService: () => ({}), costService: () => ({}), financeService: () => ({}), budgetService: () => ({}), companyService: () => ({}), agentService: () => ({}), issueService: () => ({}), accessService: () => ({ decide: mocks.decide }) }));
vi.mock("../services/accounting-integrity.js", () => ({ accountingIntegrityService: () => ({}) }));
vi.mock("../services/billing-reconciliation.js", () => ({ billingReconciliationService: () => ({}) }));
const companyId = "11111111-1111-4111-8111-111111111111";
const path = `/api/companies/${companyId}/costs/model-reference-rates`;
const data = { provider: "openai", model: "gpt-6.1-sol", inputUsdPerMillion: "2", cachedInputUsdPerMillion: "0.1", outputUsdPerMillion: "10", cacheWriteUsdPerMillion: null, sourceUrl: "https://developers.openai.com/api/docs/pricing", verifiedAt: "2026-10-26", notes: "", expectedRevision: null };
function app(type = "board", role = "member") {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = type === "board" ? { type: "board", source: "session", userId: "alice", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: role }] } as typeof req.actor : { type: "agent", agentId: "agent", companyId } as typeof req.actor; next(); });
  app.use("/api", costRoutes({} as Db)); app.use(errorHandler); return app;
}
beforeEach(() => { vi.clearAllMocks(); mocks.manage.mockResolvedValue(true); mocks.decide.mockResolvedValue({ allowed: true }); mocks.report.mockResolvedValue({ rows: [], rates: [] }); mocks.save.mockResolvedValue({ revision: 0 }); });
describe("reference pricing authorization", () => {
  it("reads only authorized board company costs and validates dates", async () => {
    expect((await request(app()).get(path)).status).toBe(200);
    expect((await request(app("agent")).get(path)).status).toBe(403);
    expect((await request(app()).get(path.replace(companyId, "other"))).status).toBe(403);
    expect((await request(app()).get(`${path}?from=bad`)).status).toBe(400);
    mocks.decide.mockResolvedValue({ allowed: false });
    expect((await request(app()).get(path)).status).toBe(403);
  });
  it("gates edits by configuration permission and revision, rejects viewers and injection", async () => {
    expect((await request(app()).put(path).send(data)).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(companyId, data, { userId: "alice", canEdit: true });
    expect((await request(app("board", "viewer")).put(path).send(data)).status).toBe(403);
    expect((await request(app("agent")).put(path).send(data)).status).toBe(403);
    expect((await request(app()).put(path).send({ ...data, inputUsdPerMillion: "-1" })).status).toBe(400);
    expect((await request(app()).put(path).send({ ...data, companyId: "other" })).status).toBe(400);
    mocks.manage.mockResolvedValue(false);
    expect((await request(app()).put(path).send(data)).status).toBe(403);
    mocks.manage.mockResolvedValue(true); mocks.decide.mockResolvedValue({ allowed: false });
    expect((await request(app()).put(path).send(data)).status).toBe(403);
  });
});
