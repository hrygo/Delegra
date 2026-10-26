import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const { runProcess, runShell, prepareRuntime, checkCommand } = vi.hoisted(() => ({ runProcess: vi.fn(), runShell: vi.fn(), prepareRuntime: vi.fn(), checkCommand: vi.fn() }));
vi.mock("@paperclipai/adapter-utils/execution-target", async () => ({
  ...await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target"),
  runAdapterExecutionTargetProcess: runProcess,
  runAdapterExecutionTargetShellCommand: runShell,
  prepareAdapterExecutionTargetRuntime: prepareRuntime,
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
  ensureAdapterExecutionTargetCommandResolvable: checkCommand,
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => {}),
  ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "/remote/toolchain/codex"),
  maybeRunSandboxInstallCommand: vi.fn(async () => null),
}));
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

let root: string;
let provider: string;
const remoteCwd = "/remote/task/checkout";
const proc = { exitCode: 0, signal: null, timedOut: false, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }), stderr: "", pid: 1, startedAt: "2026-10-27T00:00:00Z" };
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(path.join(os.tmpdir(), "codex-remote-env-test-")); provider = path.join(root, "provider");
  await mkdir(provider); await writeFile(path.join(provider, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "unit-test-key" })); await writeFile(path.join(provider, "config.toml"), "");
  vi.stubEnv("PAPERCLIP_HOME", root);
  runProcess.mockImplementation(async (...args) => { args[4].onProcessStopped?.(); return proc; }); runShell.mockResolvedValue(proc); checkCommand.mockResolvedValue(undefined);
  prepareRuntime.mockResolvedValue({ workspaceRemoteDir: remoteCwd, runtimeRootDir: `${remoteCwd}/.paperclip-runtime/codex`, assetDirs: { home: `${remoteCwd}/.paperclip-runtime/codex/home` }, restoreWorkspace: async () => {} });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
function config() {
  return { engine: "cli", cwd: root, model: "custom-model", modelReasoningEffort: "high", managedAiConnection: { identity: "unit-test" }, env: { CODEX_HOME: provider, HOME: "/var/folders/host/paperclip-ai-test", XDG_DATA_HOME: "/var/folders/host/data", PATH: "/remote/toolchain/bin:/usr/bin:/bin", pnpm_config_store_dir: "/shared/legacy-store", PNPM_CONFIG_STORE_DIR: "/shared/upper-store", OPENAI_API_KEY: "unit-test-key" } };
}
const target = { kind: "remote", transport: "sandbox", remoteCwd, providerKey: "test", runner: { execute: vi.fn() } };
function context() {
  return { runId: "unit-run", agent: { id: "unit-agent", companyId: "unit-company", name: "unit", adapterType: "codex_local", adapterConfig: {} }, config: config(), context: {}, runtime: { sessionId: null, sessionParams: null }, onLog: vi.fn(async (_stream: string, _message: string) => {}), executionTarget: target };
}
describe("managed remote environment wiring", () => {
  it("uses the same projection for execution preflight and launch", async () => {
    expect((await execute(context() as never)).exitCode).toBe(0);
    const launched = runProcess.mock.calls.find(call => call[3].includes("exec"))![4].env;
    expect(launched.HOME).toBe(`${remoteCwd}/.paperclip-runtime/codex/run-environment/unit-run/home`);
    for (const key of ["HOME", "XDG_DATA_HOME", "TMPDIR", "UV_CACHE_DIR", "COREPACK_HOME", "pnpm_config_store_dir", "PNPM_CONFIG_STORE_DIR"]) expect(checkCommand.mock.calls.at(-1)![3][key]).toBe(launched[key]);
    expect(launched.CODEX_HOME).toBe(`${remoteCwd}/.paperclip-runtime/codex/home`);
    expect(launched.pnpm_config_store_dir).toBe(`${launched.XDG_CACHE_HOME}/pnpm-store`);
    expect(launched.PNPM_CONFIG_STORE_DIR).toBe(launched.pnpm_config_store_dir);
    expect(launched.PATH).toBe(config().env.PATH); expect(launched.OPENAI_API_KEY).toBe("unit-test-key");
    const preparation = runShell.mock.calls.find(call => call[2].includes("run-environment"));
    expect(preparation?.[2]).toContain("chmod 700"); expect(preparation?.[3].env).toEqual({});
    expect(runProcess.mock.calls.find(call => call[3].includes("exec"))![3]).toEqual(expect.arrayContaining(["--model", "custom-model", "model_reasoning_effort=\"high\""]));
    const args = runProcess.mock.calls.find(call => call[3].includes("exec"))![3] as string[];
    const policy = args.find(arg => arg.startsWith("shell_environment_policy.include_only="))!;
    const shellKeys = JSON.parse(policy.slice(policy.indexOf("=") + 1)) as string[];
    expect(shellKeys).toEqual(expect.arrayContaining(["pnpm_config_store_dir", "PNPM_CONFIG_STORE_DIR"]));
    expect(args).toEqual(expect.arrayContaining(['shell_environment_policy.inherit="all"', "shell_environment_policy.ignore_default_excludes=true"]));
    expect(args.join(" ")).not.toContain("/shared/legacy-store");
  });
  it("prepares probe directories before preflight and keeps its managed provider home", async () => {
    const result = await testEnvironment({ companyId: "unit-company", adapterType: "codex_local", config: config(), executionTarget: target } as never);
    expect(result.status).toBe("pass");
    const launched = runProcess.mock.calls.find(call => call[3].includes("exec"))![4].env;
    expect(launched.HOME.startsWith(`${remoteCwd}/.paperclip-runtime/codex/run-environment/codex-envtest-`)).toBe(true);
    expect(checkCommand.mock.calls.at(-1)![3].HOME).toBe(launched.HOME);
    expect(checkCommand.mock.calls.at(-1)![3].pnpm_config_store_dir).toBe(launched.pnpm_config_store_dir);
    expect(launched.CODEX_HOME).toBe(`${remoteCwd}/.paperclip-runtime/codex/home`);
    expect(launched.pnpm_config_store_dir).toBe(`${launched.XDG_CACHE_HOME}/pnpm-store`);
    expect(launched.PNPM_CONFIG_STORE_DIR).toBe(launched.pnpm_config_store_dir);
    expect(runShell.mock.calls.some(call => call[2].includes("chmod 700"))).toBe(true);
  });
  it("does not launch a provider after private directory preparation fails", async () => {
    runShell.mockResolvedValue({ ...proc, exitCode: 1 });
    await expect(execute(context() as never)).rejects.toThrow(/managed remote environment/);
    expect(runProcess.mock.calls.filter(call => call[3].includes("exec")).length).toBe(0);
    const result = await testEnvironment({ companyId: "unit-company", adapterType: "codex_local", config: config(), executionTarget: target } as never);
    expect(result.status).toBe("fail");
    expect(result.checks.some(check => check.code === "codex_managed_remote_env_failed")).toBe(true);
    expect(runProcess.mock.calls.filter(call => call[3].includes("exec")).length).toBe(0);
  });
  it("cleans execution state only after provider stop and successful restore", async () => {
    const order: string[] = [];
    prepareRuntime.mockResolvedValue({ workspaceRemoteDir: remoteCwd, assetDirs: { home: `${remoteCwd}/.paperclip-runtime/codex/home` }, restoreWorkspace: async () => { order.push("restore"); } });
    runProcess.mockImplementation(async (...args) => { args[4].onProcessStopped?.(); if (args[3].includes("exec")) order.push("stop"); return proc; });
    runShell.mockImplementation(async (...args) => { if (args[2].includes("rm -rf")) order.push("cleanup"); return proc; });
    expect((await execute(context() as never)).exitCode).toBe(0);
    expect(order).toEqual(["stop", "restore", "cleanup"]);
  });
  it("cleans a prepared root after preflight fails without masking that error", async () => {
    checkCommand.mockRejectedValue(new Error("preflight failure"));
    await expect(execute(context() as never)).rejects.toThrow("preflight failure");
    expect(runShell.mock.calls.filter(call => call[2].includes("rm -rf")).length).toBe(1);
    const result = await testEnvironment({ companyId: "unit-company", adapterType: "codex_local", config: config(), executionTarget: target } as never);
    expect(result.status).toBe("fail");
    expect(runShell.mock.calls.filter(call => call[2].includes("rm -rf")).length).toBe(2);
  });
  it("retains execution state when restore fails", async () => {
    prepareRuntime.mockResolvedValue({ workspaceRemoteDir: remoteCwd, assetDirs: { home: `${remoteCwd}/.paperclip-runtime/codex/home` }, restoreWorkspace: async () => { throw new Error("restore failure"); } });
    const ctx = context();
    await expect(execute(ctx as never)).rejects.toThrow("restore failure");
    expect(runShell.mock.calls.filter(call => call[2].includes("rm -rf")).length).toBe(0);
    expect(ctx.onLog.mock.calls.some(call => call[1].includes("retained"))).toBe(true);
  });
  it("retains execution state without an explicit provider stop receipt", async () => {
    runProcess.mockResolvedValue(proc);
    const ctx = context(); await execute(ctx as never);
    expect(runShell.mock.calls.filter(call => call[2].includes("rm -rf")).length).toBe(0);
    expect(ctx.onLog.mock.calls.some(call => call[1].includes("retained"))).toBe(true);
  });
  it("reports cleanup failure without changing the provider or probe result", async () => {
    runShell.mockImplementation(async (...args) => args[2].includes("rm -rf") ? { ...proc, exitCode: 1 } : proc);
    const ctx = context(); expect((await execute(ctx as never)).exitCode).toBe(0);
    expect(ctx.onLog.mock.calls.some(call => call[1].includes("cleanup failed"))).toBe(true);
    const result = await testEnvironment({ companyId: "unit-company", adapterType: "codex_local", config: config(), executionTarget: target } as never);
    expect(result.status).toBe("pass");
    expect(result.checks.some(check => check.code === "codex_managed_remote_env_cleanup_failed")).toBe(true);
  });
  it("cleans successful probe state after restore and retains it on restore failure", async () => {
    const order: string[] = [];
    prepareRuntime.mockResolvedValue({ workspaceRemoteDir: remoteCwd, assetDirs: { home: `${remoteCwd}/.paperclip-runtime/codex/home` }, restoreWorkspace: async () => { order.push("restore"); } });
    runShell.mockImplementation(async (...args) => { if (args[2].includes("rm -rf")) order.push("cleanup"); return proc; });
    await testEnvironment({ companyId: "unit-company", adapterType: "codex_local", config: config(), executionTarget: target } as never);
    expect(order).toEqual(["restore", "cleanup"]);
    order.length = 0;
    prepareRuntime.mockResolvedValue({ workspaceRemoteDir: remoteCwd, assetDirs: { home: `${remoteCwd}/.paperclip-runtime/codex/home` }, restoreWorkspace: async () => { throw new Error("restore failure"); } });
    const result = await testEnvironment({ companyId: "unit-company", adapterType: "codex_local", config: config(), executionTarget: target } as never);
    expect(order).toEqual([]);
    expect(result.checks.some(check => check.code === "codex_managed_remote_env_retained")).toBe(true);
  });

  it("keeps preflight failure primary even when cleanup transport also throws", async () => {
    checkCommand.mockRejectedValue(new Error("original preflight failure"));
    runShell.mockImplementation(async (...args) => { if (args[2].includes("rm -rf")) throw new Error("private transport detail"); return proc; });
    const ctx = context();
    await expect(execute(ctx as never)).rejects.toThrow("original preflight failure");
    expect(ctx.onLog.mock.calls.some(call => call[1].includes("cleanup failed"))).toBe(true);
    expect(ctx.onLog.mock.calls.some(call => call[1].includes("private transport detail"))).toBe(false);
  });
  it("retains probe state without an explicit provider stop receipt", async () => {
    runProcess.mockResolvedValue(proc);
    const result = await testEnvironment({ companyId: "unit-company", adapterType: "codex_local", config: config(), executionTarget: target } as never);
    expect(runShell.mock.calls.filter(call => call[2].includes("rm -rf")).length).toBe(0);
    expect(result.checks.some(check => check.code === "codex_managed_remote_env_retained")).toBe(true);
  });

});
