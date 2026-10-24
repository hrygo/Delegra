import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as executionTarget from "@paperclipai/adapter-utils/execution-target";
import { assertManagedAiProjectAuth } from "../services/ai-connection-runtime.js";

describe.each(["local", "remote"] as const)("managed Claude project auth (%s)", (mode) => {
  let home: string;
  let hostHome: string;
  let cwd: string;
  let independentProject: string | undefined;

  async function settings(directory: string, file = "settings.json") {
    await mkdir(path.join(directory, ".claude"), { recursive: true });
    await writeFile(path.join(directory, ".claude", file), JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: "fixture-user-token" },
    }));
  }

  function check(directory = cwd) {
    return assertManagedAiProjectAuth({ cwd: directory }, "anthropic", mode === "remote"
      ? { kind: "remote", transport: "ssh", remoteCwd: directory } as Parameters<typeof assertManagedAiProjectAuth>[2]
      : undefined);
  }

  async function useProjectWithoutHostHome() {
    independentProject = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-auth-project-")));
    cwd = independentProject;
    hostHome = path.join(home, "missing-home");
  }

  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-auth-home-")));
    hostHome = home;
    independentProject = undefined;
    cwd = path.join(home, "projects", "task");
    await mkdir(cwd, { recursive: true });
    await settings(home);
    vi.spyOn(os, "homedir").mockImplementation(() => hostHome);
    // Exercise the generated remote shell against real files, with no SSH or provider calls.
    vi.spyOn(executionTarget, "runAdapterExecutionTargetProcess").mockImplementation(async (_id, _target, command, args) => {
      const result = spawnSync(command, args, { cwd, env: { PATH: process.env.PATH, HOME: hostHome }, encoding: "utf8" });
      if (result.error) throw result.error;
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, signal: result.signal, timedOut: false };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
    if (independentProject) await rm(independentProject, { recursive: true, force: true });
  });

  it("does not treat the isolated host user's settings as project authentication", async () => {
    await expect(check()).resolves.toBeUndefined();
  });

  it("allows a valid project when the host home does not exist", async () => {
    await useProjectWithoutHostHome();
    await expect(check()).resolves.toBeUndefined();
  });

  it("still rejects project credentials when the host home does not exist", async () => {
    await useProjectWithoutHostHome();
    await settings(cwd);
    await expect(check()).rejects.toMatchObject({ status: 422, details: { code: "ai_connection_incompatible" } });
  });

  it.each(["settings.json", "settings.local.json"])("still rejects project %s credentials", async (file) => {
    await settings(cwd, file);
    await expect(check()).rejects.toMatchObject({ status: 422, details: { code: "ai_connection_incompatible" } });
  });

  it("still rejects project ancestors below the user's home", async () => {
    await settings(path.dirname(cwd));
    await expect(check()).rejects.toMatchObject({ status: 422 });
  });

  it("checks the home itself when explicitly used as the working directory", async () => {
    await expect(check(home)).rejects.toMatchObject({ status: 422 });
  });

  it("recognizes the home boundary through a workspace symlink", async () => {
    const alias = path.join(home, "workspace-alias");
    await symlink(cwd, alias);
    await expect(check(alias)).resolves.toBeUndefined();
  });

  it("still checks physical project ancestors when the workspace is a symlink", async () => {
    await settings(path.dirname(cwd));
    const alias = path.join(home, "workspace-alias");
    await symlink(cwd, alias);
    await expect(check(alias)).rejects.toMatchObject({ status: 422 });
  });
});
