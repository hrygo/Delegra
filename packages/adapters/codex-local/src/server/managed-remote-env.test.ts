import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { buildManagedRemoteEnvironment } from "./managed-remote-env.js";

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const input = {
  managed: true, remote: true, cwd: "/remote/run/workspace", runId: "run-123",
  env: { HOME: "/var/folders/host/paperclip-ai-123", XDG_DATA_HOME: "/var/folders/host/data", TMPDIR: "/var/folders/host/T", CODEX_HOME: "/remote/provider", PATH: "/remote/toolchain/bin:/usr/bin:/bin", OPENAI_API_KEY: "test-only-key", MODEL_RECEIPT: "unchanged" },
};

describe("managed remote Codex process environment", () => {
  it.each([{ managed: false }, { remote: false }])("leaves local or unmanaged environments unchanged", change => {
    const plan = buildManagedRemoteEnvironment({ ...input, ...change });
    expect(plan.env).toEqual(input.env); expect(plan.prepareCommand).toBeNull();
  });
  it("projects identity and tool caches under this exact remote run checkout", () => {
    const plan = buildManagedRemoteEnvironment(input);
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP", "UV_CACHE_DIR", "COREPACK_HOME", "PNPM_HOME"]) {
      expect(plan.env[key]).toMatch(/^\/remote\/run\/workspace\/\.paperclip-runtime\/codex\/run-environment\/run-123\//);
      expect(plan.env[key]).not.toContain("/var/folders/");
    }
    expect(plan.env.CODEX_HOME).toBe(input.env.CODEX_HOME);
    expect(plan.env.PATH).toBe(input.env.PATH);
    expect(plan.env.OPENAI_API_KEY).toBe(input.env.OPENAI_API_KEY);
    expect(plan.env.MODEL_RECEIPT).toBe(input.env.MODEL_RECEIPT);
    expect(input.env.HOME).toBe("/var/folders/host/paperclip-ai-123");
    expect(plan.prepareCommand).toContain("umask 077");
    expect(plan.prepareCommand).toContain("chmod 700");
    expect(plan.prepareCommand).not.toContain(input.env.OPENAI_API_KEY);
    expect(plan.prepareCommand).not.toContain(input.env.HOME);
  });
  it("separates concurrent runs", () => {
    expect(buildManagedRemoteEnvironment(input).env.HOME).not.toBe(buildManagedRemoteEnvironment({ ...input, runId: "run-456" }).env.HOME);
  });
  it.each([{ cwd: "relative" }, { cwd: "/" }, { runId: "../escape" }, { runId: "" }])("rejects ambiguous run roots", change => {
    expect(() => buildManagedRemoteEnvironment({ ...input, ...change })).toThrow(/managed remote environment/);
  });
  it("creates actual private writable directories with mode 0700", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remote-env-mode-")); fixtures.push(root);
    const plan = buildManagedRemoteEnvironment({ ...input, cwd: root });
    await promisify(execFile)("sh", ["-c", plan.prepareCommand!]);
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR", "UV_CACHE_DIR", "COREPACK_HOME"]) expect((await stat(plan.env[key]!)).mode & 0o777).toBe(0o700);
  });
  it("refuses a preexisting symlink instead of preparing state outside the checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remote-env-symlink-")); fixtures.push(root);
    const cwd = path.join(root, "checkout"); const outside = path.join(root, "outside");
    await Promise.all([mkdir(cwd), mkdir(outside)]);
    const plan = buildManagedRemoteEnvironment({ ...input, cwd });
    await mkdir(plan.env.HOME!, { recursive: true }); await symlink(outside, plan.env.XDG_CACHE_HOME!);
    await expect(promisify(execFile)("sh", ["-c", plan.prepareCommand!])).rejects.toThrow();
  });
  it("cleans only this exact run root and never follows descendant links", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "remote-env-cleanup-")); fixtures.push(cwd);
    const plan = buildManagedRemoteEnvironment({ ...input, cwd });
    await promisify(execFile)("sh", ["-c", plan.prepareCommand!]);
    const outside = path.join(cwd, "outside"); await mkdir(outside);
    await writeFile(path.join(outside, "keep"), "outside");
    await symlink(outside, path.join(plan.env.HOME!, "link"));
    const provider = path.join(cwd, ".paperclip-runtime/codex/home"); await mkdir(provider);
    await writeFile(path.join(provider, "session"), "keep");
    const sibling = buildManagedRemoteEnvironment({ ...input, cwd, runId: "other-run" });
    await promisify(execFile)("sh", ["-c", sibling.prepareCommand!]);
    await promisify(execFile)("sh", ["-c", plan.cleanupCommand!]);
    await expect(stat(plan.env.HOME!)).rejects.toThrow();
    expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("outside");
    expect(await readFile(path.join(provider, "session"), "utf8")).toBe("keep");
    expect((await stat(sibling.env.HOME!)).isDirectory()).toBe(true);
  });
  it.each(["root", "parent"])("refuses cleanup through a substituted %s symlink", async kind => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "remote-env-cleanup-link-")); fixtures.push(cwd);
    const plan = buildManagedRemoteEnvironment({ ...input, cwd });
    await promisify(execFile)("sh", ["-c", plan.prepareCommand!]);
    const outside = path.join(cwd, "outside"); await mkdir(outside);
    await writeFile(path.join(outside, "keep"), "keep");
    const replaced = kind === "root" ? path.dirname(plan.env.HOME!) : path.join(cwd, ".paperclip-runtime/codex/run-environment");
    await rm(replaced, { recursive: true }); await symlink(outside, replaced);
    await expect(promisify(execFile)("sh", ["-c", plan.cleanupCommand!])).rejects.toThrow();
    expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("keep");
  });

});
