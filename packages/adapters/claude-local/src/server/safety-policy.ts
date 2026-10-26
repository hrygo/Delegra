import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const CLAUDE_SAFETY_MINIMUM_VERSION = "2.1.310";
export interface ClaudeSafetyPolicy {
  version: 1;
  profile: "workspace-build" | "candidate-review";
}

function invalid(reason: string): never {
  throw new Error(`claudeSafetyPolicy: ${reason}`);
}

/** Opt-in only. Never reinterpret or weaken a legacy permission configuration. */
export function parseClaudeSafetyPolicy(config: Record<string, unknown>): ClaudeSafetyPolicy | null {
  const value = config.claudeSafetyPolicy;
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("expected a versioned object");
  const policy = value as Record<string, unknown>;
  if (Object.keys(policy).some(key => key !== "version" && key !== "profile")) invalid("unknown key");
  if (policy.version !== 1) invalid("unsupported version");
  if (policy.profile !== "workspace-build" && policy.profile !== "candidate-review") invalid("unsupported profile");
  if (config.engine !== "cli") invalid('requires explicit engine="cli"');
  if (config.dangerouslySkipPermissions !== false) invalid("requires dangerouslySkipPermissions=false");
  for (const key of ["args", "extraArgs"]) {
    const args = config[key];
    if (args !== undefined && (!Array.isArray(args) || args.length !== 0)) invalid(`${key} must be empty`);
  }
  if (config.chrome) invalid("chrome is unavailable in offline profiles");
  return { version: 1, profile: policy.profile };
}

async function gitWritePaths(cwd: string): Promise<string[]> {
  // Resolve linked worktrees from their actual metadata, not a guessed checkout
  // parent. Protect the pointer as well as the shared repository metadata.
  let directory = cwd;
  while (true) {
    const marker = path.join(directory, ".git");
    const stat = await fs.lstat(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat) {
      let gitDir: string;
      if (stat.isDirectory()) gitDir = await fs.realpath(marker);
      else if (stat.isFile()) {
        const match = /^gitdir:\s*(.+)\s*$/m.exec(await fs.readFile(marker, "utf8"));
        if (!match) invalid("unrecognized .git pointer");
        gitDir = await fs.realpath(path.resolve(directory, match[1]!.trim()));
      } else invalid("unsupported .git marker");
      const common = await fs.readFile(path.join(gitDir, "commondir"), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      return [marker, gitDir, ...(common ? [await fs.realpath(path.resolve(gitDir, common.trim()))] : [])];
    }
    const parent = path.dirname(directory);
    if (parent === directory) return [];
    directory = parent;
  }
}

export async function buildClaudeSafetyPolicy(input: {
  config: Record<string, unknown>;
  cwd: string;
  promptBundleDir: string;
  selectedSkills: ReadonlyArray<{ runtimeName: string; source: string }>;
  remote?: boolean;
}): Promise<{ args: string[]; skillReadDirective: string; identity: string; protectedWriteRoots: readonly string[] } | null> {
  const policy = parseClaudeSafetyPolicy(input.config);
  if (!policy) return null;
  if (input.remote) invalid("v1 supports local CLI targets only");
  const cwd = await fs.realpath(input.cwd);
  const bundle = await fs.realpath(input.promptBundleDir);
  const promptCache = path.dirname(bundle);
  const relativeCwd = path.relative(promptCache, cwd);
  if (path.basename(promptCache) !== "claude-prompt-cache" || relativeCwd === "" || (!relativeCwd.startsWith(`..${path.sep}`) && relativeCwd !== ".." && !path.isAbsolute(relativeCwd))) {
    invalid("expected a managed prompt cache outside the checkout");
  }
  const skillSources = await Promise.all(input.selectedSkills.map(async skill => {
    if (!/^[a-zA-Z0-9._-]+$/.test(skill.runtimeName) || skill.runtimeName === "." || skill.runtimeName === "..") {
      invalid("invalid selected skill name");
    }
    const source = await fs.realpath(skill.source);
    if (!(await fs.stat(path.join(source, "SKILL.md"))).isFile()) invalid("selected skill has no SKILL.md");
    return { name: skill.runtimeName, source };
  }));
  const denyWrite = [...new Set([
    promptCache, bundle, ...await gitWritePaths(cwd), ...skillSources.map(skill => skill.source),
  ])];
  // These generated paths are literal, never operator-supplied glob patterns.
  // Refuse ambiguous syntax rather than silently protecting the wrong files.
  if ([cwd, ...denyWrite].some(directory => /[\x00\r\n*?\[\]{}()\\]/.test(directory))) {
    invalid("v1 requires literal paths without permission-pattern metacharacters");
  }
  // CLI file tools and sandboxed Bash have separate permission checks. Protect
  // both; --add-dir must not accidentally grant edit access to prompt/skill data.
  const deny = denyWrite.flatMap(directory => ["Edit", "Write", "NotebookEdit"].flatMap(tool => [
    `${tool}(/${directory})`, `${tool}(/${directory}/**)`,
  ]));
  const settings = {
    permissions: { deny },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      excludedCommands: [],
      allowAppleEvents: false,
      network: {
        strictAllowlist: true, allowedDomains: [], allowAllUnixSockets: false,
        allowUnixSockets: [], allowLocalBinding: false,
      },
      filesystem: { disabled: false, allowWrite: [], denyWrite, allowRead: skillSources.map(skill => skill.source) },
    },
  };
  const tools = policy.profile === "workspace-build" ? "Bash,Read,Glob,Grep,Edit,Write" : "Read,Glob,Grep";
  const args = [
    "--setting-sources=", "--settings", JSON.stringify(settings),
    // --restricted excludes other tools and constrains file reads to cwd and
    // explicit add-dirs. Explicit --tools restores Bash only for build tasks.
    "--restricted", "--tools", tools,
    "--permission-mode", policy.profile === "workspace-build" ? "acceptEdits" : "dontAsk",
    "--permission-prompts", "none",
    "--allowedTools", policy.profile === "workspace-build" ? "Read,Glob,Grep,Edit,Write" : tools,
    "--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config",
    ...skillSources.flatMap(skill => ["--add-dir", skill.source]),
  ];
  const skillReadDirective = [
    "This is an offline safety profile. Report the final result as text; the host saves it. No runtime MCP or finish tool is enabled.",
    "Only the selected skills below are available. Use Read on their exact SKILL.md paths when needed; sibling references remain available read-only. Automatic project/user skill discovery is disabled.",
    ...skillSources.map(skill => `- ${skill.name}: ${JSON.stringify(path.join(skill.source, "SKILL.md"))}`),
  ].join("\n");
  return {
    args,
    skillReadDirective,
    protectedWriteRoots: denyWrite,
    identity: createHash("sha256").update(JSON.stringify({ policy, cwd, args })).digest("hex"),
  };
}
