import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { CodexFilesystemEntry, CodexLaunchPolicy, FrozenCodexLaunchContext } from "../../contracts/codex-launch-policy.js";
export type { CodexLaunchPolicy, FrozenCodexLaunchContext } from "../../contracts/codex-launch-policy.js";

export const CODEX_POLICY_DRIVER = "codex_app_server_launch_policy_v1";
export const CODEX_LOOKUP_PREFIX = "paperclip-codex-launch-v1:";
const MAX_POLICY_BYTES = 256 * 1024;
const safeSetKeys = new Set(["PATH", "PATHEXT", "SystemRoot", "WINDIR", "LANG", "LC_ALL", "HOME", "ZDOTDIR", "BASH_ENV", "AGENT_HOME"]);
const pseudoRoots = new Set([":root", ":minimal", ":tmpdir", ":workspace_roots"]);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function invalid(): never { throw new Error("codex_launch_policy_invalid"); }
function wellFormed(value: string): boolean {
  for (const character of value) {
    if (character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff) return false;
  }
  return true;
}
const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
};
function validString(value: unknown, max = 4096): value is string {
  return typeof value === "string" && wellFormed(value) && !value.includes("\0") && Buffer.byteLength(value) <= max;
}
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
/** Only fixed ASCII keys (and ASCII environment names) cross a durable boundary. */
export function canonicalCodexLaunchJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "string" && !wellFormed(item)) invalid();
    if (!record(item)) return item;
    if (Object.keys(item).some(key => !/^[\x20-\x7e]+$/.test(key))) invalid();
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b)));
  });
}
export function codexLaunchDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalCodexLaunchJson(value)).digest("hex")}`;
}

export function normalizeCodexLaunchPolicy(policy: CodexLaunchPolicy): CodexLaunchPolicy {
  const normalize = (entries: CodexFilesystemEntry[]) => {
    const paths = new Map<string, CodexFilesystemEntry>();
    for (const entry of entries) {
      if (paths.has(entry.path) && paths.get(entry.path)!.access !== entry.access) invalid();
      paths.set(entry.path, entry);
    }
    return [...paths.values()].sort((a, b) => compare(a.path, b.path));
  };
  const normalized = { ...policy, defaultFilesystem: normalize(policy.defaultFilesystem),
    planningFilesystem: normalize(policy.planningFilesystem), shellEnvironmentPolicy: {
      ...policy.shellEnvironmentPolicy, includeOnly: [...new Set(policy.shellEnvironmentPolicy.includeOnly)].sort(compare),
    } };
  return validateCodexLaunchPolicy(normalized);
}

export function validateCodexLaunchPolicy(value: unknown): CodexLaunchPolicy {
  const policy = exact(value, ["schema", "defaultFilesystem", "planningFilesystem", "networkAccess", "externallySandboxed", "shellEnvironmentPolicy"]);
  if (policy.schema !== "paperclip.codex.launch-policy.v1" || typeof policy.networkAccess !== "boolean" || typeof policy.externallySandboxed !== "boolean") invalid();
  for (const [key, workspaceAccess] of [["defaultFilesystem", "write"], ["planningFilesystem", "read"]] as const) {
    const entries = policy[key];
    if (!Array.isArray(entries) || entries.length > 1024) invalid();
    let previous: string | undefined;
    for (const raw of entries as unknown[]) {
      const entry = exact(raw, ["path", "access"]);
      if (!validString(entry.path) || (!pseudoRoots.has(entry.path) && !isAbsolute(entry.path))
        || typeof entry.access !== "string" || !["none", "read", "write"].includes(entry.access)
        || (previous !== undefined && compare(previous, entry.path) >= 0)) invalid();
      previous = entry.path;
    }
    for (const [path, access] of [[":root", "none"], [":minimal", "read"], [":tmpdir", "none"], [":workspace_roots", workspaceAccess]]) {
      if (!(entries as CodexFilesystemEntry[]).some(entry => entry.path === path && entry.access === access)) invalid();
    }
  }
  const environment = exact(policy.shellEnvironmentPolicy, ["inherit", "ignoreDefaultExcludes", "includeOnly", "set"]);
  if (typeof environment.inherit !== "string" || !["all", "none"].includes(environment.inherit) || typeof environment.ignoreDefaultExcludes !== "boolean"
    || !Array.isArray(environment.includeOnly) || environment.includeOnly.length > 256 || !record(environment.set)) invalid();
  const keys = environment.includeOnly as unknown[];
  if (keys.some((key, index) => !validString(key, 256) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    || (index > 0 && compare(keys[index - 1] as string, key) >= 0))) invalid();
  for (const [key, item] of Object.entries(environment.set as Record<string, unknown>)) {
    if (!safeSetKeys.has(key) || !keys.includes(key) || !validString(item)) invalid();
  }
  if (Buffer.byteLength(canonicalCodexLaunchJson(value)) > MAX_POLICY_BYTES) invalid();
  return structuredClone(value) as CodexLaunchPolicy;
}

export function codexLaunchPolicyProfiles(policy: CodexLaunchPolicy) {
  const prefix = `paperclip-runner-policy-v1-${codexLaunchDigest(policy).slice(7)}`;
  return { default: `${prefix}-workspace-only`, plan: `${prefix}-workspace-read-only`, external: `${prefix}-external-sandbox` };
}
export function codexLaunchPermission(policy: CodexLaunchPolicy, mode: "default" | "plan"): string {
  const profiles = codexLaunchPolicyProfiles(policy);
  return mode === "plan" ? profiles.plan : policy.externallySandboxed ? profiles.external : profiles.default;
}
export function codexLaunchPolicyArgs(policy: CodexLaunchPolicy): string[] {
  return ["--disable", "image_generation", ...(policy.externallySandboxed ? ["--dangerously-bypass-approvals-and-sandbox"] : []), "app-server"];
}
export function codexLaunchPolicyConfig(policy: CodexLaunchPolicy): Record<string, unknown> {
  const profiles = codexLaunchPolicyProfiles(policy);
  const filesystem = (entries: CodexFilesystemEntry[]) => Object.fromEntries(entries.map(entry => [entry.path,
    entry.path === ":workspace_roots" ? { ".": entry.access } : entry.access]));
  return { default_permissions: policy.externallySandboxed ? profiles.external : profiles.default,
    permissions: {
      [profiles.default]: { filesystem: filesystem(policy.defaultFilesystem), network: { enabled: policy.networkAccess } },
      [profiles.plan]: { filesystem: filesystem(policy.planningFilesystem), network: { enabled: policy.networkAccess } },
      [profiles.external]: { filesystem: { ":root": "write" }, network: { enabled: policy.networkAccess } },
    }, shell_environment_policy: { inherit: policy.shellEnvironmentPolicy.inherit,
      ignore_default_excludes: policy.shellEnvironmentPolicy.ignoreDefaultExcludes,
      include_only: policy.shellEnvironmentPolicy.includeOnly, set: policy.shellEnvironmentPolicy.set } };
}

/** The transport must suppress raw config/read responses before tracing or diagnostics. */
export async function checkCodexLaunchConfiguration(
  request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  policy: CodexLaunchPolicy, cwd: string,
): Promise<void> {
  const names = new Set(Object.values(codexLaunchPolicyProfiles(policy)));
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 32; page += 1) {
    const result = await request("permissionProfile/list", { cwd, limit: 128, ...(cursor ? { cursor } : {}) })
      .catch(() => { throw new Error("codex_launch_policy_preflight_unavailable"); });
    if (!Array.isArray(result.data) || result.data.length > 128 || result.data.some(item => !record(item) || typeof item.id !== "string")) invalid();
    if (result.data.some(item => names.has((item as Record<string, string>).id))) throw new Error("codex_launch_policy_profile_conflict");
    if (result.nextCursor == null) break;
    if (typeof result.nextCursor !== "string" || !result.nextCursor || Buffer.byteLength(result.nextCursor) > 4096 || seen.has(result.nextCursor) || page === 31) invalid();
    cursor = result.nextCursor; seen.add(cursor);
  }
  const result = await request("config/read", { cwd, includeLayers: false })
    .catch(() => { throw new Error("codex_launch_policy_preflight_unavailable"); });
  if (!record(result.config)) invalid();
  const shell = result.config.shell_environment_policy;
  if (shell != null && !record(shell)) invalid();
  const set = record(shell) ? shell.set : undefined;
  if (set != null && !record(set)) invalid();
  const inherited = new Set(policy.shellEnvironmentPolicy.includeOnly.filter(key => !Object.hasOwn(policy.shellEnvironmentPolicy.set, key)));
  if (record(set) && Object.keys(set).some(key => inherited.has(key))) throw new Error("codex_launch_policy_environment_conflict");
}

export function frozenCodexLookupToken(context: FrozenCodexLaunchContext): string {
  return `${CODEX_LOOKUP_PREFIX}${codexLaunchDigest(context).slice(7)}`;
}
export function restoreFrozenCodexLaunchContext(token: string, value: unknown): FrozenCodexLaunchContext {
  try {
    const context = exact(value, ["schema", "policy", "collaborationMode", "homeMode", "workingDirectory", "includeSkillInstructions", "includeCollaborationModeInstructions", "threadId", "providerSessionId", "providerRecoveryPolicy"]);
    validateCodexLaunchPolicy(context.policy);
    if (context.schema !== "paperclip.codex.frozen-launch.v1" || typeof context.collaborationMode !== "string" || !["default", "plan"].includes(context.collaborationMode)
      || typeof context.homeMode !== "string" || !["managed", "preconfigured"].includes(context.homeMode)
      || !validString(context.workingDirectory) || !isAbsolute(context.workingDirectory)
      || typeof context.includeSkillInstructions !== "boolean" || typeof context.includeCollaborationModeInstructions !== "boolean"
      || !validString(context.threadId, 240) || !context.threadId
      || (context.providerSessionId !== null && (!validString(context.providerSessionId, 240) || !context.providerSessionId))
      || context.providerRecoveryPolicy !== "same_session_only"
      || token !== frozenCodexLookupToken(value as FrozenCodexLaunchContext)) invalid();
    return structuredClone(value) as FrozenCodexLaunchContext;
  } catch { throw new Error("codex_frozen_launch_invalid"); }
}
