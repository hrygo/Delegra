import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createIsolatedCodexAppServerLaunch } from "./codex-security-config.js";
import { codexLaunchPolicyConfig, codexLaunchPolicyProfiles, checkCodexLaunchConfiguration,
  frozenCodexLookupToken, restoreFrozenCodexLaunchContext, canonicalCodexLaunchJson, codexLaunchDigest, validateCodexLaunchPolicy } from "./codex-launch-policy.js";

describe("bounded Codex launch policy", () => {
  it("shares canonical UTF-8 bytes and namespace with the native owner fixture", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../test/fixtures/codex-launch-policy-unicode.json", import.meta.url), "utf8"));
    const policy = validateCodexLaunchPolicy(fixture.policy);
    expect(canonicalCodexLaunchJson(policy)).toBe(fixture.canonical);
    expect(codexLaunchDigest(policy)).toBe(fixture.digest);
  });
  it.each(["/local", "/ssh/agent", "/container/runtime"])("retains every long skill root at %s outside argv", prefix => {
    const roots = Array.from({ length: 20 }, (_, i) => `${prefix}/skills/${i}-${"x".repeat(180)}-\"-😀`);
    const launch = createIsolatedCodexAppServerLaunch({ HOME: `${prefix}/home`, PATH: "/usr/bin" }, roots);
    expect(launch.args.length).toBeLessThanOrEqual(64);
    expect(launch.args.every(arg => Buffer.byteLength(arg) <= 4096 && !arg.includes("\0"))).toBe(true);
    expect(JSON.stringify(launch.args)).not.toContain("skills/");
    for (const path of roots) expect(launch.launchPolicy.defaultFilesystem).toContainEqual({ path, access: "read" });
    expect(Buffer.byteLength(JSON.stringify(launch.launchPolicy))).toBeGreaterThan(4096);
    expect(JSON.parse(JSON.stringify(launch.launchPolicy))).toEqual(launch.launchPolicy);
  });

  it("rejects unknown configuration, wrong JSON scalar types and policy budgets", () => {
    const base = createIsolatedCodexAppServerLaunch({ PATH: "/usr/bin" }).launchPolicy;
    for (const mutate of [
      (value: any) => { value.model_provider = "forbidden"; },
      (value: any) => { value.defaultFilesystem[0].access = ["read"]; },
      (value: any) => { value.shellEnvironmentPolicy.inherit = ["all"]; },
      (value: any) => { value.shellEnvironmentPolicy.set.GH_TOKEN = "synthetic-private"; },
      (value: any) => { value.shellEnvironmentPolicy.includeOnly = ["x".repeat(257)]; },
      (value: any) => { value.defaultFilesystem = Array.from({ length: 1025 }, () => base.defaultFilesystem[0]); },
      (value: any) => { value.defaultFilesystem[0].path = "/" + "x".repeat(4096); },
    ]) {
      const value = structuredClone(base); mutate(value);
      expect(() => validateCodexLaunchPolicy(value)).toThrow(/^codex_launch_policy_invalid$/);
    }
    expect(() => createIsolatedCodexAppServerLaunch({}, Array.from({ length: 80 }, (_, i) => `/skills/${i}-${"x".repeat(3900)}`)))
      .toThrow(/^codex_launch_policy_invalid$/);
  });

  it("uses UTF-8 ordering for paths and rejects lone surrogates without normalizing Unicode", () => {
    const { launchPolicy } = createIsolatedCodexAppServerLaunch({}, ["/skills/😀", "/skills/\uE000", "/skills/e\u0301", "/skills/é"]);
    const paths = launchPolicy.defaultFilesystem.map(entry => entry.path);
    expect(paths.indexOf("/skills/\uE000")).toBeLessThan(paths.indexOf("/skills/😀"));
    expect(paths).toContain("/skills/e\u0301"); expect(paths).toContain("/skills/é");
    expect(() => createIsolatedCodexAppServerLaunch({}, ["/skills/\uD800"])).toThrow("codex_launch_policy_invalid");
    const profiles = codexLaunchPolicyProfiles(launchPolicy);
    expect(codexLaunchPolicyConfig(launchPolicy)).toHaveProperty(`permissions.${profiles.default}.filesystem`);
  });

  it("rejects profile collisions and inherited environment keys shadowed by configured set", async () => {
    const { launchPolicy } = createIsolatedCodexAppServerLaunch({ GH_TOKEN: "never-persist", PATH: "/usr/bin" });
    const profiles = codexLaunchPolicyProfiles(launchPolicy);
    await expect(checkCodexLaunchConfiguration(async () => ({ data: [{ id: profiles.default }], nextCursor: null }), launchPolicy, "/workspace"))
      .rejects.toThrow("codex_launch_policy_profile_conflict");
    const calls: string[] = [];
    await expect(checkCodexLaunchConfiguration(async method => {
      calls.push(method);
      return method === "permissionProfile/list" ? { data: [], nextCursor: null }
        : { config: { shell_environment_policy: { set: { GH_TOKEN: "stale-secret-must-not-leak" } } } };
    }, launchPolicy, "/workspace")).rejects.toThrow(/^codex_launch_policy_environment_conflict$/);
    expect(calls).toEqual(["permissionProfile/list", "config/read"]);
    expect(JSON.stringify(launchPolicy)).not.toContain("never-persist");
  });

  it("fails closed on unsupported preflight and bounded pagination", async () => {
    const policy = createIsolatedCodexAppServerLaunch({}).launchPolicy;
    await expect(checkCodexLaunchConfiguration(async () => { throw new Error("unsupported-method"); }, policy, "/workspace"))
      .rejects.toThrow(/^codex_launch_policy_preflight_unavailable$/);
    await expect(checkCodexLaunchConfiguration(async () => ({ data: [], nextCursor: "repeated" }), policy, "/workspace"))
      .rejects.toThrow(/^codex_launch_policy_invalid$/);
    let pages = 0;
    await expect(checkCodexLaunchConfiguration(async () => ({ data: [], nextCursor: `page-${++pages}` }), policy, "/workspace"))
      .rejects.toThrow(/^codex_launch_policy_invalid$/);
    expect(pages).toBe(32);
  });

  it("binds the lookup token to the entire frozen context before exposing the real ID", () => {
    const { launchPolicy } = createIsolatedCodexAppServerLaunch({ PATH: "/usr/bin" });
    const frozen = { schema: "paperclip.codex.frozen-launch.v1" as const, policy: launchPolicy,
      collaborationMode: "plan" as const, homeMode: "managed" as const, workingDirectory: "/workspace", includeSkillInstructions: true,
      includeCollaborationModeInstructions: true, threadId: "native-thread", providerSessionId: "native-account",
      providerRecoveryPolicy: "same_session_only" as const };
    const token = frozenCodexLookupToken(frozen);
    expect(token).toMatch(/^paperclip-codex-launch-v1:[a-f0-9]{64}$/);
    expect(restoreFrozenCodexLaunchContext(token, frozen)).toEqual(frozen);
    for (const update of [{ collaborationMode: "default" }, { homeMode: "preconfigured" }, { includeSkillInstructions: false },
      { threadId: "other" }, { providerRecoveryPolicy: "allow_replacement_after_resume_failure" }]) {
      expect(() => restoreFrozenCodexLaunchContext(token, { ...frozen, ...update })).toThrow("codex_frozen_launch_invalid");
    }
  });
});
