import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, environments, secretAccessEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { requireServerAdapter } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { secretService } from "../services/secrets.js";
import * as environmentTarget from "../services/environment-execution-target.js";
import * as environmentRuntime from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { instanceSettingsService } from "../services/instance-settings.js";

vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: vi.fn() }));

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;

beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-env-save-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "env-save-fixture");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(home, "master.key"));
  database = await startEmbeddedPostgresTestDatabase("paperclip-env-save-db-");
  db = createDb(database.connectionString);
}, 90000);
beforeEach(async () => {
  await instanceSettingsService(db).updateExperimental({ enableManagedSandboxOnly: false });
  await db.update(environments).set({ metadata: { managedByPaperclip: false } }).where(eq(environments.driver, "sandbox"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider network calls are forbidden in this fixture"));
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

async function fixture(adapterType: "codex_local" | "paperclip_runner", savedBinding: boolean) {
  const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Environment save fixture", issuePrefix: `E${companyId.slice(0, 7)}` });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  const [environment] = await db.update(environments).set({
    envVars: { BASE_MARKER: { type: "plain", value: "environment" }, SHARED_MARKER: { type: "plain", value: "environment" } },
  }).where(eq(environments.driver, "local")).returning();
  const account = await aiConnectionService(db).save(companyId, userId, {
    provider: "openai", method: "api_key", ownership: "personal", name: "Synthetic Responses connection",
    apiKey: "fixture-account-key", allAgents: true, agentIds: [],
    routing: { kind: "gateway", protocol: "responses", auth: "bearer", baseUrl: "https://provider.example.test/v1", models: [] },
  }, "fixture-account-key");
  const binding = { provider: "openai", method: "api_key", mode: "delegated", ...account } as const;
  const config = { cwd: home, model: "gpt-6.1-sol", ...(adapterType === "paperclip_runner" ? { provider: "codex" } : { engine: "cli" }),
    env: { PATH: { type: "plain", value: "/fixture/toolchain/bin:/usr/bin:/bin" } },
  };
  await db.insert(agents).values({ id: agentId, companyId, name: "Paused fixture", adapterType, adapterConfig: config,
    defaultEnvironmentId: environment.id, status: "paused", lifecycleState: "paused", pauseReason: "manual",
    runtimeConfig: { heartbeat: { enabled: false }, ...(savedBinding ? { aiConnection: binding } : {}) },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "local_implicit", userId, companyIds: [companyId], isInstanceAdmin: true };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  const readAgent = async () => (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
  return { app, companyId, agentId, userId, environment, binding, config, readAgent };
}

function installSandboxDriver() {
  const createRuntime = environmentRuntime.environmentRuntimeService;
  const environmentsSvc = environmentService(db);
  const driver: environmentRuntime.EnvironmentRuntimeDriver = {
    driver: "sandbox",
    acquireRunLease: vi.fn(async input => environmentsSvc.acquireLease({
      companyId: input.companyId, environmentId: input.environment.id,
      provider: "fixture", metadata: { remoteCwd: "/fixture/sandbox" },
      assertCompanyBinding: input.assertCompanyBinding,
    })),
    releaseRunLease: vi.fn(async input => environmentsSvc.releaseLease(input.lease.id, input.status)),
    realizeWorkspace: vi.fn(async () => ({ cwd: "/fixture/sandbox" })),
    resolveCapabilities: vi.fn(async () => ({ reusableLeases: false, nativeSyncIn: false, nativeSyncOut: false,
      persistentProcessSessions: false, independentControlCommands: false, incrementalSessionOutput: false,
      concurrentSyncOperations: false, duplexCommandStream: false, runnerWebSocketIngress: false })),
  };
  vi.spyOn(environmentRuntime, "environmentRuntimeService").mockImplementation((database, options) =>
    createRuntime(database, { ...options, drivers: [driver] }));
  const target = { kind: "remote" as const, transport: "sandbox" as const, remoteCwd: "/fixture/sandbox",
    providerKey: "fixture", runner: { execute: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" })) } };
  vi.spyOn(environmentTarget, "resolveEnvironmentExecutionTarget").mockResolvedValue(target);
  return { driver, target };
}

async function managedSandboxFixture(adapterType: "codex_local" | "paperclip_runner", missing: "local" | "sandbox") {
  const runtime = installSandboxDriver();
  const f = await fixture(adapterType, false);
  const secrets = secretService(db);
  const localSecret = await secrets.create(f.companyId, { name: "Local fixture secret", provider: "local_encrypted", value: "fixture-local-only" });
  const sandboxSecret = await secrets.create(f.companyId, { name: "Sandbox fixture secret", provider: "local_encrypted", value: "fixture-sandbox-only" });
  const localEnv = { LOCAL_SECRET: { type: "secret_ref", secretId: localSecret.id } };
  await db.update(environments).set({ envVars: localEnv }).where(eq(environments.id, f.environment.id));
  if (missing !== "local") await secrets.syncEnvBindingsForTarget(f.companyId,
    { targetType: "environment", targetId: f.environment.id }, localEnv);
  const sandboxEnv = { SANDBOX_MARKER: { type: "plain", value: "sandbox" },
    SANDBOX_SECRET: { type: "secret_ref", secretId: sandboxSecret.id } };
  const [sandbox] = await db.insert(environments).values({ name: `Managed fixture sandbox ${f.companyId}`, driver: "sandbox",
    status: "active", config: { provider: "fixture" }, metadata: { managedByPaperclip: true }, envVars: sandboxEnv }).returning();
  if (missing !== "sandbox") await secrets.syncEnvBindingsForTarget(f.companyId,
    { targetType: "environment", targetId: sandbox.id }, sandboxEnv);
  await instanceSettingsService(db).updateExperimental({ enableManagedSandboxOnly: true });
  return { ...f, ...runtime, sandbox, localSecret, sandboxSecret };
}

describe("managed agent environment saves", () => {
  for (const adapterType of ["codex_local", "paperclip_runner"] as const) {
    it.each(["test", "save"] as const)(`uses the redirected sandbox environment for ${adapterType} %s validation`, async operation => {
      const f = await managedSandboxFixture(adapterType, "local");
      const probe = vi.spyOn(requireServerAdapter(adapterType), "testEnvironment").mockResolvedValue({
        adapterType, status: "pass", testedAt: new Date().toISOString(),
        checks: [{ code: "codex_hello_probe_passed", level: "info", message: "Synthetic provider" }],
      });
      const response = operation === "test"
        ? await request(f.app).post(`/api/companies/${f.companyId}/adapters/${adapterType}/test-environment`).send({
          agentId: f.agentId, adapterConfig: f.config, aiConnection: f.binding,
        })
        : await request(f.app).patch(`/api/agents/${f.agentId}`).send({ runtimeConfig: { aiConnection: f.binding } });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      if (operation === "test") expect(response.body.status).toBe("pass");
      expect(probe).toHaveBeenCalledOnce();
      expect(probe.mock.calls[0][0]).toMatchObject({ executionTarget: f.target,
        config: { env: { SANDBOX_MARKER: "sandbox", SANDBOX_SECRET: "fixture-sandbox-only" } } });
      expect(probe.mock.calls[0][0].config.env).not.toHaveProperty("LOCAL_SECRET");
      expect(f.driver.acquireRunLease).toHaveBeenCalledWith(expect.objectContaining({ environment: expect.objectContaining({ id: f.sandbox.id }) }));
      expect(f.driver.releaseRunLease).toHaveBeenCalledOnce();
      expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, f.localSecret.id))).toEqual([]);
      expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, f.sandboxSecret.id))).toHaveLength(1);
    });
  }

  it.each(["test", "save"] as const)("rejects the redirected sandbox's missing binding during %s validation", async operation => {
    const f = await managedSandboxFixture("codex_local", "sandbox");
    const before = await f.readAgent();
    const probe = vi.spyOn(requireServerAdapter("codex_local"), "testEnvironment").mockResolvedValue({
      adapterType: "codex_local", status: "pass", testedAt: new Date().toISOString(),
      checks: [{ code: "codex_hello_probe_passed", level: "info", message: "Synthetic provider" }],
    });
    const response = operation === "test"
      ? await request(f.app).post(`/api/companies/${f.companyId}/adapters/codex_local/test-environment`).send({
        agentId: f.agentId, adapterConfig: f.config, aiConnection: f.binding,
      })
      : await request(f.app).patch(`/api/agents/${f.agentId}`).send({ runtimeConfig: { aiConnection: f.binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(operation === "test" ? 200 : 422);
    const checks = operation === "test" ? response.body.checks : response.body.details.checks;
    expect(checks).toContainEqual(expect.objectContaining({ code: "environment_env_binding_missing", level: "error" }));
    if (operation === "test") expect(response.body.status).toBe("fail");
    else expect(probe).not.toHaveBeenCalled();
    expect(await f.readAgent()).toEqual(before);
    expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, f.localSecret.id))).toEqual([]);
    expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, f.sandboxSecret.id))).toEqual([]);
  });

  it("inspects the redirected sandbox metadata without reading secrets when its target is unavailable", async () => {
    const f = await managedSandboxFixture("codex_local", "sandbox");
    vi.mocked(environmentTarget.resolveEnvironmentExecutionTarget).mockResolvedValue(null);
    const probe = vi.spyOn(requireServerAdapter("codex_local"), "testEnvironment");
    const response = await request(f.app).post(`/api/companies/${f.companyId}/adapters/codex_local/test-environment`).send({
      agentId: f.agentId, adapterConfig: f.config, aiConnection: f.binding,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.status).toBe("fail");
    expect(response.body.checks).toContainEqual(expect.objectContaining({ code: "environment_env_binding_missing", message: expect.stringContaining("SANDBOX_SECRET") }));
    expect(probe).not.toHaveBeenCalled();
    expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, f.localSecret.id))).toEqual([]);
    expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, f.sandboxSecret.id))).toEqual([]);
  });

  it.each(["codex_local", "paperclip_runner"] as const)("saves unrelated %s env edits without treating JSONB key order as a connection change", async adapterType => {
    const f = await fixture(adapterType, true);
    const probe = vi.spyOn(requireServerAdapter(adapterType), "testEnvironment").mockResolvedValue({
      adapterType, status: "fail", testedAt: new Date().toISOString(),
      checks: [{ code: "codex_hello_probe_failed", level: "error", message: "This unrelated edit must not start a model probe" }],
    });
    const response = await request(f.app).patch(`/api/agents/${f.agentId}`).send({ adapterConfig: {
      ...f.config,
      env: { ...f.config.env, pnpm_config_store_dir: { type: "plain", value: "/fixture/pnpm-store" } },
    }, runtimeConfig: { heartbeat: { enabled: false }, aiConnection: f.binding }, defaultEnvironmentId: f.environment.id });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(probe).not.toHaveBeenCalled();
    const saved = await f.readAgent();
    expect(saved.runtimeConfig.aiConnection).toEqual(f.binding);
    expect(saved.adapterConfig.env).toMatchObject({ pnpm_config_store_dir: { type: "plain", value: "/fixture/pnpm-store" } });
    expect(saved).toMatchObject({ status: "paused", pauseReason: "manual" });
    expect(JSON.stringify(response.body)).not.toContain("/fixture/pnpm-store");
  });

  it.each(["codex_local", "paperclip_runner"] as const)("resolves the same prospective %s env for connection adoption and independent testing", async adapterType => {
    const f = await fixture(adapterType, false);
    const secret = await secretService(db).create(f.companyId, { name: "Synthetic env secret", provider: "local_encrypted", value: "fixture-business-secret" });
    const config = { ...f.config, env: { ...f.config.env,
      pnpm_config_store_dir: { type: "plain", value: "/fixture/pnpm-store" },
      SHARED_MARKER: { type: "plain", value: "agent" },
      BUSINESS_SECRET: { type: "secret_ref", secretId: secret.id },
    } };
    const expectedEnv = { PATH: "/fixture/toolchain/bin:/usr/bin:/bin", pnpm_config_store_dir: "/fixture/pnpm-store",
      BASE_MARKER: "environment", SHARED_MARKER: "agent", BUSINESS_SECRET: "fixture-business-secret" };
    const probe = vi.spyOn(requireServerAdapter(adapterType), "testEnvironment").mockImplementation(async context => {
      const env = context.config.env as Record<string, unknown>;
      const complete = Object.entries(expectedEnv).every(([key, value]) => env[key] === value);
      return { adapterType, status: complete ? "pass" : "fail", testedAt: new Date().toISOString(),
        checks: [{ code: complete ? "codex_hello_probe_passed" : "codex_hello_probe_failed", level: complete ? "info" : "error", message: "Synthetic env-dependent provider" }] };
    });
    const tested = await request(f.app).post(`/api/companies/${f.companyId}/adapters/${adapterType}/test-environment`).send({
      agentId: f.agentId, adapterConfig: config, aiConnection: f.binding,
    });
    expect(tested.status, JSON.stringify(tested.body)).toBe(200);
    expect(tested.body.status).toBe("pass");
    const saved = await request(f.app).patch(`/api/agents/${f.agentId}`).send({ adapterConfig: config, runtimeConfig: {
      heartbeat: { enabled: false }, aiConnection: f.binding,
    } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(probe).toHaveBeenCalledTimes(2);
    for (const [context] of probe.mock.calls) expect(context.config.env).toMatchObject(expectedEnv);
    expect((await f.readAgent()).runtimeConfig.aiConnection).toEqual(f.binding);
    expect(JSON.stringify(saved.body)).not.toContain("fixture-business-secret");
    expect(JSON.stringify(saved.body)).not.toContain("fixture-account-key");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["connection", "model", "engine"] as const)("keeps a failed hello on a real %s change from persisting any configuration", async change => {
    const f = await fixture("codex_local", change !== "connection");
    const before = await f.readAgent();
    const probe = vi.spyOn(requireServerAdapter("codex_local"), "testEnvironment").mockResolvedValue({
      adapterType: "codex_local", status: "fail", testedAt: new Date().toISOString(),
      checks: [{ code: "codex_hello_probe_failed", level: "error", message: "Synthetic provider rejected the probe" }],
    });
    const response = await request(f.app).patch(`/api/agents/${f.agentId}`).send(change === "connection"
      ? { adapterConfig: { env: {} }, runtimeConfig: { aiConnection: f.binding } }
      : { adapterConfig: change === "model" ? { model: "changed-model" } : { engine: "acp" } });
    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ code: "ai_connection_validation_failed" });
    expect(probe).toHaveBeenCalledOnce();
    expect(await f.readAgent()).toEqual(before);
  });

  it.each(["harness", "provider", "default environment"] as const)("revalidates a real %s change with an unchanged connection", async change => {
    const adapterType = change === "provider" ? "paperclip_runner" : "codex_local";
    const f = await fixture(adapterType, true);
    const before = await f.readAgent();
    const probeAdapterType = change === "harness" ? "paperclip_runner" : adapterType;
    const probe = vi.spyOn(requireServerAdapter(probeAdapterType), "testEnvironment").mockResolvedValue({
      adapterType: probeAdapterType, status: "fail", testedAt: new Date().toISOString(),
      checks: [{ code: "codex_hello_probe_failed", level: "error", message: "Synthetic provider rejected the changed selection" }],
    });
    const patch = change === "harness"
      ? { adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } }
      : change === "provider"
        ? { adapterConfig: { provider: "opencode" } }
        : { defaultEnvironmentId: null };
    const response = await request(f.app).patch(`/api/agents/${f.agentId}`).send(patch);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    if (change === "provider") {
      expect(probe).not.toHaveBeenCalled();
    } else {
      expect(response.body.details).toMatchObject({ code: "ai_connection_validation_failed" });
      expect(probe).toHaveBeenCalledOnce();
    }
    expect(await f.readAgent()).toEqual(before);
  });

  it.each(["test", "save"] as const)("does not read environment secrets or probe when the %s execution target is unavailable", async operation => {
    const f = await fixture("codex_local", operation === "save");
    const secret = await secretService(db).create(f.companyId, { name: "Target-scoped fixture", provider: "local_encrypted", value: "fixture-target-secret" });
    const envVars = { BUSINESS_SECRET: { type: "secret_ref", secretId: secret.id } };
    const [environment] = await db.insert(environments).values({ name: `Unavailable fixture SSH ${operation}`, driver: "ssh", config: {}, envVars }).returning();
    await secretService(db).syncEnvBindingsForTarget(f.companyId, { targetType: "environment", targetId: environment.id }, envVars);
    vi.spyOn(environmentTarget, "resolveEnvironmentExecutionTarget").mockResolvedValue(null);
    const probe = vi.spyOn(requireServerAdapter("codex_local"), "testEnvironment").mockResolvedValue({
      adapterType: "codex_local", status: "pass", testedAt: new Date().toISOString(), checks: [],
    });
    const before = await f.readAgent();
    const response = operation === "test"
      ? await request(f.app).post(`/api/companies/${f.companyId}/adapters/codex_local/test-environment`).send({
        agentId: f.agentId, environmentId: environment.id, adapterConfig: f.config, aiConnection: f.binding,
      })
      : await request(f.app).patch(`/api/agents/${f.agentId}`).send({ defaultEnvironmentId: environment.id, runtimeConfig: { aiConnection: f.binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(operation === "test" ? 200 : 422);
    if (operation === "test") expect(response.body.checks).toEqual(expect.arrayContaining([expect.objectContaining({ code: "environment_target_unavailable" })]));
    expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, secret.id))).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
    expect(await f.readAgent()).toEqual(before);
  });

  it.each([true, false])("resolves prospective user secrets only for the acting owner (own value: %s)", async ownValue => {
    const f = await fixture("codex_local", false);
    const secrets = secretService(db);
    const definition = await secrets.createUserSecretDefinition(f.companyId, { key: "business_token", name: "Synthetic user secret", provider: "local_encrypted" });
    const otherUserId = randomUUID();
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: otherUserId, membershipRole: "member", status: "active" });
    await secrets.createCurrentUserSecretValue(f.companyId, ownValue ? f.userId : otherUserId, { definitionId: definition.id, value: "fixture-owner-value" });
    const probe = vi.spyOn(requireServerAdapter("codex_local"), "testEnvironment").mockResolvedValue({
      adapterType: "codex_local", status: "pass", testedAt: new Date().toISOString(),
      checks: [{ code: "codex_hello_probe_passed", level: "info", message: "Synthetic provider" }],
    });
    const config = { ...f.config, env: { ...f.config.env, BUSINESS_TOKEN: { type: "user_secret_ref", key: "business_token", required: true } } };
    const before = await f.readAgent();
    const response = await request(f.app).patch(`/api/agents/${f.agentId}`).send({ adapterConfig: config, runtimeConfig: { aiConnection: f.binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(ownValue ? 200 : 422);
    if (ownValue) {
      expect(probe).toHaveBeenCalledOnce();
      expect(probe.mock.calls[0][0].config.env).toMatchObject({ BUSINESS_TOKEN: "fixture-owner-value" });
      expect((await f.readAgent()).adapterConfig.env).toMatchObject({ BUSINESS_TOKEN: { type: "user_secret_ref", key: "business_token" } });
    } else {
      expect(probe).not.toHaveBeenCalled();
      expect(await f.readAgent()).toEqual(before);
    }
    expect(JSON.stringify(response.body)).not.toContain("fixture-owner-value");
  });

  it("rejects an environment with an undeclared secret binding before probing or persisting adoption", async () => {
    const f = await fixture("codex_local", false);
    const secret = await secretService(db).create(f.companyId, { name: "Unbound environment fixture", provider: "local_encrypted", value: "fixture-unbound-value" });
    await db.update(environments).set({ envVars: { BUSINESS_SECRET: { type: "secret_ref", secretId: secret.id } } }).where(eq(environments.id, f.environment.id));
    const before = await f.readAgent();
    const probe = vi.spyOn(requireServerAdapter("codex_local"), "testEnvironment").mockResolvedValue({
      adapterType: "codex_local", status: "pass", testedAt: new Date().toISOString(), checks: [],
    });
    const response = await request(f.app).patch(`/api/agents/${f.agentId}`).send({ runtimeConfig: { aiConnection: f.binding } });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.details).toMatchObject({ code: "ai_connection_validation_failed", checks: [{ code: "environment_env_binding_missing", level: "error" }] });
    expect(probe).not.toHaveBeenCalled();
    expect(await f.readAgent()).toEqual(before);
  });

  it("rejects a foreign company secret without probing or persisting adoption", async () => {
    const f = await fixture("codex_local", false);
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Foreign fixture", issuePrefix: `F${otherCompanyId.slice(0, 7)}` });
    const secret = await secretService(db).create(otherCompanyId, { name: "Foreign fixture", provider: "local_encrypted", value: "fixture-foreign-value" });
    const before = await f.readAgent();
    const probe = vi.spyOn(requireServerAdapter("codex_local"), "testEnvironment").mockResolvedValue({
      adapterType: "codex_local", status: "pass", testedAt: new Date().toISOString(), checks: [],
    });
    const response = await request(f.app).patch(`/api/agents/${f.agentId}`).send({ adapterConfig: {
      env: { BUSINESS_SECRET: { type: "secret_ref", secretId: secret.id } },
    }, runtimeConfig: { aiConnection: f.binding } });
    expect(response.status).toBe(422);
    expect(probe).not.toHaveBeenCalled();
    expect(await f.readAgent()).toEqual(before);
    expect(JSON.stringify(response.body)).not.toContain("fixture-foreign-value");
  });
});
