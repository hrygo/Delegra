import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { runProcess, prepareCommand, prepareRemoteCommand } = vi.hoisted(() => ({ runProcess: vi.fn(), prepareCommand: vi.fn(), prepareRemoteCommand: vi.fn(async () => {}) }));
vi.mock("@paperclipai/adapter-utils/execution-target", async () => ({
  ...await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target"),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: prepareRemoteCommand,
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: runProcess,
}));
vi.mock("./sandbox-cli-version.js", () => ({ prepareCompatibleClaudeCommand: prepareCommand }));
vi.mock("./probe-env.js", () => ({ buildLocalAdapterTestProbeEnv: async () => ({ command: "claude", env: {} }) }));
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

let cwd: string;
const sessionId = "11111111-1111-4111-8111-111111111111";
beforeEach(async () => {
  vi.clearAllMocks();
  cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-policy-integration-")));
  vi.stubEnv("PAPERCLIP_HOME", cwd);
  prepareCommand.mockImplementation(async (input) => ({ command: input.command, version: "2.1.310", check: null }));
  runProcess.mockImplementation(async (...args) => {
    args[4].onProcessStopped?.();
    return { exitCode: 0, signal: null, timedOut: false, stdout: JSON.stringify({ type: "result", subtype: "success", result: "hello", session_id: sessionId }), stderr: "", pid: 1, startedAt: new Date().toISOString() };
  });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(cwd, { recursive: true, force: true }); });
function config(profile = "workspace-build") {
  return { engine: "cli", cwd, model: "custom-alias(max)", effort: "high", dangerouslySkipPermissions: false, claudeSafetyPolicy: { version: 1, profile } };
}
function context(profile?: string) {
  return {
    runId: "policy-run", agent: { id: "policy-agent", companyId: "policy-company", name: "test", adapterType: "claude_local", adapterConfig: {} },
    config: config(profile), context: {}, onLog: vi.fn(async (_stream: string, _message: string) => {}),
    runtime: { sessionId, sessionParams: { sessionId, cwd }, sessionDisplayId: sessionId, taskKey: null },
    runtimeMcp: { getServers: () => [{ name: "not-enabled", url: "https://example.invalid" }] },
  };
}
function policyArgs(args: string[]) {
  return args.slice(args.indexOf("--setting-sources="));
}
describe("Claude safety policy execution and probe", () => {
  it.each(["workspace-build", "candidate-review"])("uses the same closed %s settings for execution and probe", async profile => {
    const result = await execute(context(profile) as never);
    expect(result.exitCode).toBe(0);
    const executionArgs = runProcess.mock.calls.find(call => call[3].includes("--print"))![3] as string[];
    const executionOptions = runProcess.mock.calls.find(call => call[3].includes("--print"))![4];
    expect(executionArgs).not.toContain("--resume");
    expect(executionArgs).not.toContain("--dangerously-skip-permissions");
    expect(executionOptions.stdin).toContain("No runtime MCP or finish tool is enabled");
    expect(executionArgs).toEqual(expect.arrayContaining(["--model", "custom-alias(max)", "--effort", "high"]));
    runProcess.mockClear();
    const tested = await testEnvironment({ companyId: "policy-company", adapterType: "claude_local", config: config(profile) });
    expect(tested.status).toBe("pass");
    const probeArgs = runProcess.mock.calls.find(call => call[3].includes("--print"))![3] as string[];
    // Bundle hashes differ with task instructions; safety settings protect the
    // stable cache parent in both. The actual selected profile must match.
    const executionSettings = JSON.parse(executionArgs[executionArgs.indexOf("--settings") + 1]!);
    const probeSettings = JSON.parse(probeArgs[probeArgs.indexOf("--settings") + 1]!);
    expect(probeSettings.sandbox.network).toEqual(executionSettings.sandbox.network);
    expect(probeArgs[probeArgs.indexOf("--tools") + 1]).toEqual(executionArgs[executionArgs.indexOf("--tools") + 1]);
    expect(policyArgs(probeArgs)).toContain("--strict-mcp-config");
    expect(prepareCommand.mock.calls.every(call => call[0].minimumVersion === "2.1.310")).toBe(true);
    expect(result.sessionParams).toHaveProperty("claudeSafetyPolicyIdentity");
  });
  it("fails before provider invocation for an invalid profile in both paths", async () => {
    const ctx = context(); ctx.config.dangerouslySkipPermissions = true;
    await expect(execute(ctx as never)).rejects.toThrow(/claudeSafetyPolicy/);
    const result = await testEnvironment({ companyId: "policy-company", adapterType: "claude_local", config: ctx.config });
    expect(result.status).toBe("fail"); expect(result.checks[0]?.code).toBe("claude_safety_policy_invalid");
    expect(runProcess).not.toHaveBeenCalled();
  });
  it("fails closed on an older CLI even for custom model aliases", async () => {
    prepareCommand.mockImplementation(async input => ({ command: input.command, version: "2.1.309", check: null }));
    expect((await execute(context() as never)).errorCode).toBe("claude_cli_version_incompatible");
    const probe = await testEnvironment({ companyId: "policy-company", adapterType: "claude_local", config: config() });
    expect(probe.status).toBe("fail");
    expect(probe.checks.some(check => check.code === "claude_cli_version_incompatible")).toBe(true);
    expect(runProcess).not.toHaveBeenCalled();
  });
  it("rejects a remote profile before any remote runtime preparation", async () => {
    const runner = vi.fn(async () => { throw new Error("remote preparation must not run"); });
    await expect(execute({ ...context(), executionTarget: { kind: "remote", transport: "sandbox", providerKey: "test", remoteCwd: "/should-not-prepare", runner: { execute: runner } } } as never)).rejects.toThrow(/local CLI targets only/);
    // Assert counts without dumping invocation environments on failure.
    expect(prepareRemoteCommand.mock.calls.length).toBe(0);
    expect(runner.mock.calls.length).toBe(0);
    expect(runProcess.mock.calls.length).toBe(0);
    expect(prepareCommand.mock.calls.length).toBe(0);
  });
  it("resumes only a matching admitted profile identity", async () => {
    const first = await execute(context() as never);
    runProcess.mockClear();
    await execute({ ...context(), runtime: { ...context().runtime, sessionParams: first.sessionParams } } as never);
    expect(runProcess.mock.calls.find(call => call[3].includes("--print"))![3]).toContain("--resume");
    runProcess.mockClear();
    await execute({ ...context("candidate-review"), runtime: { ...context().runtime, sessionParams: first.sessionParams } } as never);
    expect(runProcess.mock.calls.find(call => call[3].includes("--print"))![3]).not.toContain("--resume");
  });
  it("exposes only explicitly selected skill sources, including their real symlink targets", async () => {
    const selected = path.join(cwd, "selected-source"); const unselected = path.join(cwd, "unselected-source");
    await Promise.all([mkdir(selected), mkdir(unselected)]);
    await Promise.all([writeFile(path.join(selected, "SKILL.md"), "selected"), writeFile(path.join(selected, "reference.md"), "full source"), writeFile(path.join(unselected, "SKILL.md"), "not selected")]);
    const link = path.join(cwd, "skill-link"); await symlink(selected, link);
    const cfg = { ...config(), paperclipRuntimeSkills: [{ key: "selected", runtimeName: "selected", source: link }, { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: unselected }], paperclipSkillSync: { desiredSkills: ["selected"] } };
    await execute({ ...context(), config: cfg } as never);
    const execution = runProcess.mock.calls.find(call => call[3].includes("--print"))!;
    expect(execution[4].stdin).toContain(path.join(selected, "SKILL.md"));
    const settings = JSON.parse(execution[3][execution[3].indexOf("--settings") + 1]);
    expect(settings.sandbox.filesystem.allowRead).toEqual([selected]);
    runProcess.mockClear();
    expect((await testEnvironment({ companyId: "policy-company", adapterType: "claude_local", config: cfg })).status).toBe("pass");
    const probe = runProcess.mock.calls.find(call => call[3].includes("--print"))!;
    const probeSettings = JSON.parse(probe[3][probe[3].indexOf("--settings") + 1]);
    expect(probeSettings.sandbox.filesystem.allowRead).toEqual([selected]);
  });
  it("projects the same seven trusted workspace cache keys in execute and local probe", async () => {
    const snapshots: Record<string, string>[] = [];
    runProcess.mockImplementation(async (...args) => {
      const env = args[4].env; snapshots.push(env);
      expect(typeof env.pnpm_config_store_dir).toBe("string");
      expect(env.pnpm_config_store_dir.startsWith(`${cwd}/.paperclip-runtime/claude/task-cache/`)).toBe(true);
      expect(env.PNPM_CONFIG_STORE_DIR).toBe(env.pnpm_config_store_dir);
      for (const key of ["pnpm_config_store_dir", "UV_CACHE_DIR", "TMPDIR", "TMP", "TEMP", "XDG_RUNTIME_DIR"]) expect((await stat(env[key])).mode & 0o777).toBe(0o700);
      expect(env.TMPDIR).toBe(env.TMP); expect(env.TMP).toBe(env.TEMP);
      args[4].onProcessStopped?.();
      return { exitCode: 0, signal: null, timedOut: false, stdout: JSON.stringify({ type: "result", subtype: "success", result: "hello", session_id: sessionId }), stderr: "" };
    });
    const cfg = { ...config(), env: { HOME: "/managed-provider-home", PATH: "/configured/toolchain", pnpm_config_store_dir: "/shared/store", TMPDIR: "/caller/tmp", UV_CACHE_DIR: "/shared/uv", XDG_RUNTIME_DIR: "/caller/runtime" } };
    await execute({ ...context(), config: cfg } as never);
    expect(snapshots[0]!.HOME).toBe(cfg.env.HOME); expect(snapshots[0]!.PATH).toBe(cfg.env.PATH);
    expect((await testEnvironment({ companyId: "policy-company", adapterType: "claude_local", config: cfg })).status).toBe("pass");
    expect(snapshots.length).toBe(2);
    for (const env of snapshots) { await expect(stat(env.TMPDIR!)).rejects.toThrow(); await expect(stat(env.XDG_RUNTIME_DIR!)).rejects.toThrow(); }
    // The local probe's caller allowlist stays closed; only adapter-owned cache
    // values enter after it, with no caller HOME/PATH promotion.
    expect(snapshots[1]!.HOME).toBeUndefined(); expect(snapshots[1]!.PATH).toBeUndefined();
  });
  it("retains build caches without a provider stop receipt and reports the outcome", async () => {
    let temporary = "";
    runProcess.mockImplementation(async (...args) => {
      temporary = args[4].env.TMPDIR;
      expect(typeof temporary).toBe("string");
      return { exitCode: 0, signal: null, timedOut: false, stdout: JSON.stringify({ type: "result", subtype: "success", result: "hello", session_id: sessionId }), stderr: "" };
    });
    const ctx = context(); await execute(ctx as never);
    expect((await stat(temporary)).isDirectory()).toBe(true);
    expect(ctx.onLog.mock.calls.some(call => call[1].includes("retained"))).toBe(true);
  });
  it("retains caches when provider collection fails without hiding that error", async () => {
    let temporary = "";
    runProcess.mockImplementation(async (...args) => {
      temporary = args[4].env.TMPDIR; expect(typeof temporary).toBe("string"); args[4].onProcessStopped?.();
      return { exitCode: 0, signal: null, timedOut: false, stdout: JSON.stringify({ type: "result", subtype: "success", result: "hello", session_id: sessionId }), stderr: "" };
    });
    await expect(execute({ ...context(), onProviderStopped: async () => { throw new Error("collection failed"); } } as never)).rejects.toThrow("collection failed");
    expect((await stat(temporary)).isDirectory()).toBe(true);
  });

  it("does not allocate writable caches for candidate review or legacy execution", async () => {
    await execute(context("candidate-review") as never);
    await expect(stat(path.join(cwd, ".paperclip-runtime/claude/task-cache"))).rejects.toThrow();
    const { claudeSafetyPolicy: _policy, ...legacy } = config();
    await execute({ ...context(), config: legacy } as never);
    await expect(stat(path.join(cwd, ".paperclip-runtime/claude/task-cache"))).rejects.toThrow();
    for (const call of runProcess.mock.calls) { expect(call[4].env.pnpm_config_store_dir).toBeUndefined(); expect(call[4].env.XDG_RUNTIME_DIR).toBeUndefined(); }
  });

  it("keeps provider failure primary when collection and cache cleanup cannot settle", async () => {
    runProcess.mockImplementation(async (...args) => { args[4].onProcessStopped?.(); throw new Error("provider failure"); });
    const ctx = { ...context(), onProviderStopped: async () => { throw new Error("collection failure"); } };
    await expect(execute(ctx as never)).rejects.toThrow("provider failure");
    expect(ctx.onLog.mock.calls.some(call => call[1].includes("retained"))).toBe(true);
  });

  it("retains probe cache if collection rejects after a provider stop receipt", async () => {
    let temporary = "";
    runProcess.mockImplementation(async (...args) => { temporary = args[4].env.TMPDIR; args[4].onProcessStopped?.(); throw new Error("probe collection failure"); });
    await expect(testEnvironment({ companyId: "policy-company", adapterType: "claude_local", config: config() })).rejects.toThrow("probe collection failure");
    expect((await stat(temporary)).isDirectory()).toBe(true);
  });

});
