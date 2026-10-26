import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareClaudeTaskBuildCache } from "./task-build-cache.js";

let cwd: string;
beforeEach(async () => { cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claude-task-cache-test-"))); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(cwd, { recursive: true, force: true }); });
const prepare = () => prepareClaudeTaskBuildCache({ cwd, protectedWriteRoots: [] });

describe("Claude workspace build cache ownership", () => {
  it("creates only seven private workspace overrides and cleans its exact root", async () => {
    const first = await prepare(); const sibling = await prepare();
    expect(first.root).not.toBe(sibling.root);
    expect(first.root.startsWith(path.join(cwd, ".paperclip-runtime/claude/task-cache/"))).toBe(true);
    expect(Object.keys(first.envOverrides).sort()).toEqual(["pnpm_config_store_dir", "PNPM_CONFIG_STORE_DIR", "UV_CACHE_DIR", "TMPDIR", "TMP", "TEMP", "XDG_RUNTIME_DIR"].sort());
    expect(first.envOverrides.pnpm_config_store_dir).toBe(first.envOverrides.PNPM_CONFIG_STORE_DIR);
    for (const directory of [first.root, ...Object.values(first.envOverrides)]) {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      await fs.writeFile(path.join(directory, "canary"), "private");
    }
    const outside = path.join(cwd, "old-store"); await fs.mkdir(outside); await fs.writeFile(path.join(outside, "keep"), "old");
    await fs.symlink(outside, path.join(first.root, "untracked-link"));
    const stop = first.beginInvocation(); stop();
    expect(await first.cleanup({ collectionSucceeded: true })).toBe("removed");
    await expect(fs.stat(first.root)).rejects.toThrow();
    expect((await fs.stat(sibling.root)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe("old");
  });
  it("fences old attempt stop callbacks and retains an unstopped current attempt", async () => {
    const cache = await prepare(); const oldStop = cache.beginInvocation(); oldStop();
    const currentStop = cache.beginInvocation(); oldStop();
    expect(await cache.cleanup({ collectionSucceeded: true })).toBe("retained");
    expect((await fs.stat(cache.root)).isDirectory()).toBe(true);
    currentStop(); expect(await cache.cleanup({ collectionSucceeded: true })).toBe("removed");
  });
  it("retains stopped state until provider collection succeeds", async () => {
    const cache = await prepare(); cache.beginInvocation()();
    expect(await cache.cleanup({ collectionSucceeded: false })).toBe("retained");
    expect((await fs.stat(cache.root)).isDirectory()).toBe(true);
    expect(await cache.cleanup({ collectionSucceeded: true })).toBe("removed");
  });
  it.each(["root", "ancestor"])("does not remove a replaced %s identity", async kind => {
    const cache = await prepare(); cache.beginInvocation()();
    const replaced = kind === "root" ? cache.root : path.join(cwd, ".paperclip-runtime/claude");
    await fs.rename(replaced, `${replaced}-original`); await fs.mkdir(replaced);
    await fs.writeFile(path.join(replaced, "unknown"), "preserve");
    expect(await cache.cleanup({ collectionSucceeded: true })).toBe("retained");
    expect(await fs.readFile(path.join(replaced, "unknown"), "utf8")).toBe("preserve");
  });
  it.each(["symlink", "file"])("rejects a %s ancestor before making a task root", async kind => {
    const parent = path.join(cwd, ".paperclip-runtime");
    if (kind === "symlink") { const outside = path.join(cwd, "outside"); await fs.mkdir(outside); await fs.symlink(outside, parent); }
    else await fs.writeFile(parent, "file");
    await expect(prepare()).rejects.toThrow(/ancestor/);
  });
  it.each(["checkout", "parent", "descendant"])("rejects overlap with a protected %s root", async kind => {
    const parent = path.join(cwd, ".paperclip-runtime/claude/task-cache");
    const protectedRoot = kind === "checkout" ? cwd : kind === "parent" ? parent : path.join(parent, "skill");
    await expect(prepareClaudeTaskBuildCache({ cwd, protectedWriteRoots: [protectedRoot] })).rejects.toThrow(/protected/);
    await expect(fs.stat(parent)).rejects.toThrow();
  });
  it("keeps cleanup and log failures from changing the provider outcome", async () => {
    const cache = await prepare(); cache.beginInvocation()();
    const log = vi.fn(async (_stream: string, _message: string) => { throw new Error("closed log"); });
    const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("sensitive filesystem detail"));
    expect(await cache.cleanup({ collectionSucceeded: true, onLog: log })).toBe("failed");
    expect(log.mock.calls[0]![1]).toContain("cleanup failed");
    expect(log.mock.calls[0]![1]).not.toContain("sensitive filesystem detail");
    remove.mockRestore();
    expect((await fs.stat(cache.root)).isDirectory()).toBe(true);
  });
});
