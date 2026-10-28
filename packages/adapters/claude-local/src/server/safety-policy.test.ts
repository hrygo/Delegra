import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildClaudeSafetyPolicy, parseClaudeSafetyPolicy } from "./safety-policy.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const config = (profile = "workspace-build") => ({ engine: "cli", dangerouslySkipPermissions: false, claudeSafetyPolicy: { version: 1, profile } });
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-policy-"))); roots.push(root);
  const cwd = path.join(root, "checkout"); const bundle = path.join(root, "claude-prompt-cache", "hash");
  const common = path.join(root, "main", ".git"); const gitdir = path.join(common, "worktrees", "test");
  await Promise.all([mkdir(cwd), mkdir(bundle, { recursive: true }), mkdir(gitdir, { recursive: true })]);
  await writeFile(path.join(cwd, ".git"), `gitdir: ${gitdir}\n`); await writeFile(path.join(gitdir, "commondir"), "../..\n");
  return { root, cwd, bundle, common };
}

describe("closed Claude safety policy v1", () => {
  it("leaves legacy configurations untouched", () => { expect(parseClaudeSafetyPolicy({ dangerouslySkipPermissions: true })).toBeNull(); });
  it.each([{ version: 2, profile: "workspace-build" }, { version: 1, profile: "other" }, { version: 1, profile: "workspace-build", allowedDomains: ["*"] }])("rejects unknown versions, profiles and keys", value => {
    expect(() => parseClaudeSafetyPolicy({ ...config(), claudeSafetyPolicy: value })).toThrow(/claudeSafetyPolicy/);
  });
  it.each([{ dangerouslySkipPermissions: true }, { dangerouslySkipPermissions: undefined }, { extraArgs: ["--settings", "{}"] }, { args: ["--plugin-dir", "/tmp/plugin"] }, { engine: "acp" }])("rejects bypass and argument conflicts", change => {
    expect(() => parseClaudeSafetyPolicy({ ...config(), ...change })).toThrow(/claudeSafetyPolicy/);
  });
  it("constructs fail-closed sandboxed Bash with only the registry allowlist", async () => {
    const f = await fixture(); const result = await buildClaudeSafetyPolicy({ config: config(), cwd: f.cwd, promptBundleDir: f.bundle, selectedSkills: [] });
    expect(result?.args).toContain("--setting-sources="); expect(result?.args).not.toContain("--dangerously-skip-permissions");
    const args = result!.args; const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, excludedCommands: [], network: { strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false } });
    expect(settings.sandbox.network.allowedDomains).toEqual(["registry.npmjs.org", "registry.npmmirror.com"]);
    expect(result!.protectedWriteRoots).toEqual(settings.sandbox.filesystem.denyWrite);
    expect(settings.sandbox.filesystem.allowWrite).toEqual([]);
    expect(settings.sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining([path.dirname(f.bundle), f.common, path.join(f.cwd, ".git")]));
    expect(args[args.indexOf("--tools") + 1]).toContain("Bash");
    expect(args).toContain("--strict-mcp-config"); expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
  });
  it("gives candidate review only read tools, no egress and final text", async () => {
    const f = await fixture(); const result = await buildClaudeSafetyPolicy({ config: config("candidate-review"), cwd: f.cwd, promptBundleDir: f.bundle, selectedSkills: [] });
    expect(result!.args[result!.args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(result!.args[result!.args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    const args = result!.args; const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(settings.sandbox.network.allowedDomains).toEqual([]);
  });
  it("keeps only selected full skill sources readable and write-denied", async () => {
    const f = await fixture(); const source = path.join(f.root, "skill"); await mkdir(source); await writeFile(path.join(source, "SKILL.md"), "selected skill"); await writeFile(path.join(source, "reference.md"), "full reference");
    const mounted = path.join(f.bundle, ".claude", "skills", "selected"); await mkdir(path.dirname(mounted), { recursive: true }); await symlink(source, mounted);
    const result = await buildClaudeSafetyPolicy({ config: config(), cwd: f.cwd, promptBundleDir: f.bundle, selectedSkills: [{ runtimeName: "selected", source }] });
    expect(result!.skillReadDirective).toContain(path.join(source, "SKILL.md")); expect(result!.skillReadDirective).not.toContain("not-selected");
    expect(await readFile(path.join(mounted, "reference.md"), "utf8")).toBe("full reference");
    const args = result!.args; const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(settings.sandbox.filesystem.denyWrite).toContain(source); expect(settings.sandbox.filesystem.allowRead).toContain(source);
  });
  it("rejects remote targets rather than applying host paths to another machine", async () => {
    const f = await fixture(); await expect(buildClaudeSafetyPolicy({ config: config(), cwd: f.cwd, promptBundleDir: f.bundle, selectedSkills: [], remote: true })).rejects.toThrow(/local/);
  });
  it("rejects path syntax that would be interpreted as a permission glob", async () => {
    const f = await fixture(); const source = path.join(f.root, "skill[unsafe]"); await mkdir(source); await writeFile(path.join(source, "SKILL.md"), "skill");
    await expect(buildClaudeSafetyPolicy({ config: config(), cwd: f.cwd, promptBundleDir: f.bundle, selectedSkills: [{ runtimeName: "skill", source }] })).rejects.toThrow(/literal paths/);
  });
  it("never treats a checkout as a prompt bundle and denies its whole parent", async () => {
    const f = await fixture();
    await expect(buildClaudeSafetyPolicy({ config: config(), cwd: f.cwd, promptBundleDir: f.cwd, selectedSkills: [] })).rejects.toThrow(/prompt cache/);
  });
});
