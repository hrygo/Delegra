import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ProcessCodexAppServerTransport } from "./app-server-transport.js";
import { createIsolatedCodexAppServerLaunch } from "./codex-security-config.js";
import { checkCodexLaunchConfiguration, codexLaunchPermission, codexLaunchPolicyConfig, codexLaunchPolicyProfiles } from "./codex-launch-policy.js";

// Explicit immutable CLI and Node paths are supplied by the qualification job.
// The temporary home has no credentials; the outer sandbox denies all network.
// Linux requires permitted user/network namespaces; unsupported hosts fail closed.
it.skipIf(!process.env.PAPERCLIP_QUALIFY_CODEX_CLI)("qualifies structured permissions and fail-closed preflight against fixed Codex 0.160.0", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-policy-qualification-"));
  const home = join(root, "home"); const codexHome = join(root, "codex");
  await Promise.all([mkdir(home), mkdir(codexHome)]);
  const base = 'model="probe"\nmodel_provider="probe"\n[model_providers.probe]\nname="probe"\nbase_url="http://127.0.0.1:9"\nwire_api="responses"\nrequires_openai_auth=false\n';
  const environment = { HOME: home, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin", GH_TOKEN: "synthetic-current" };
  const roots = Array.from({ length: 20 }, (_, i) => join(root, "skills", `${i}-${"x".repeat(180)}-😀`));
  const diagnostics: string[] = [];
  const open = async (args = createIsolatedCodexAppServerLaunch(environment, roots).args) => {
    if (!["darwin", "linux"].includes(process.platform)) throw new Error("Codex policy qualification requires macOS sandbox-exec or Linux unshare");
    const sandbox = process.platform === "darwin" ? { command: "/usr/bin/sandbox-exec", args: ["-p", "(version 1)(allow default)(deny network*)"] }
      : { command: "/usr/bin/unshare", args: ["--user", "--map-root-user", "--net", "--"] };
    const transport = new ProcessCodexAppServerTransport({ command: sandbox.command,
      args: [...sandbox.args, process.env.PAPERCLIP_QUALIFY_NODE ?? process.execPath,
        process.env.PAPERCLIP_QUALIFY_CODEX_CLI!, "-c", "project_doc_max_bytes=0", ...args],
      environment, workingDirectory: root, onDiagnostic: value => diagnostics.push(value) });
    await transport.request("initialize", { clientInfo: { name: "paperclip-policy-qualification", version: "1" }, capabilities: { experimentalApi: true } });
    transport.notify("initialized");
    return transport;
  };
  try {
    expect(execFileSync(process.env.PAPERCLIP_QUALIFY_NODE ?? process.execPath, [process.env.PAPERCLIP_QUALIFY_CODEX_CLI!, "--version"],
      { env: environment, encoding: "utf8", timeout: 10_000, maxBuffer: 4096 }).trim()).toBe("codex-cli 0.160.0");
    await writeFile(join(codexHome, "config.toml"), base + '\n[shell_environment_policy.set]\nGH_TOKEN="synthetic-stale-private"\n');
    let transport = await open();
    const policy = createIsolatedCodexAppServerLaunch(environment, roots).launchPolicy;
    try {
      await expect(checkCodexLaunchConfiguration((method, params) => transport.request(method, params), policy, root))
        .rejects.toThrow("codex_launch_policy_environment_conflict");
    } finally { await transport.close(); }
    transport = await open();
    try {
      await expect(transport.request("thread/read", { threadId: `paperclip-codex-launch-v1:${"a".repeat(64)}`, includeTurns: false }))
        .rejects.toThrow();
    } finally { await transport.close(); }
    const profile = codexLaunchPolicyProfiles(policy).default;
    await writeFile(join(codexHome, "config.toml"), base + `\n[permissions.${profile}]\nextends="legacy"\n[permissions.${profile}.filesystem]\n"/extra-unrequested"="write"\n[permissions.legacy.filesystem]\n":root"="write"\n`);
    transport = await open();
    try {
      await expect(checkCodexLaunchConfiguration((method, params) => transport.request(method, params), policy, root))
        .rejects.toThrow("codex_launch_policy_profile_conflict");
    } finally { await transport.close(); }
    await writeFile(join(codexHome, "config.toml"), base.replace('model="probe"', 'default_permissions="legacy"\nmodel="probe"') + '\n[permissions.legacy.filesystem]\n":root"="write"\n"/extra-unrequested"="write"\n');
    for (const shape of ["direct", "native"]) {
    for (const networkAccess of [false, true]) {
    for (const externallySandboxed of [false, true]) {
      for (const mode of ["default", "plan"] as const) {
        const launch = createIsolatedCodexAppServerLaunch({ ...environment, PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: externallySandboxed ? "1" : "0", PAPERCLIP_RUNNER_NETWORK_ACCESS: networkAccess ? "enabled" : "disabled" }, roots);
        const processArgs = shape === "native" && mode === "plan" ? launch.args.filter(arg => arg !== "--dangerously-bypass-approvals-and-sandbox") : launch.args;
        transport = await open(processArgs);
        try {
          await checkCodexLaunchConfiguration((method, params) => transport.request(method, params), launch.launchPolicy, root);
          const permissions = codexLaunchPermission(launch.launchPolicy, mode);
          const config = { ...codexLaunchPolicyConfig(launch.launchPolicy), "skills.include_instructions": false };
          const selection = { permissions };
          const started = await transport.request("thread/start", { cwd: root, model: "probe", ...selection, config, approvalPolicy: "never", ephemeral: false });
          expect(started.activePermissionProfile).toMatchObject({ id: permissions });
          expect(started.sandbox).toMatchObject(mode === "plan" ? { type: "readOnly" } : externallySandboxed ? { type: networkAccess ? "dangerFullAccess" : "externalSandbox" } : { type: "workspaceWrite", networkAccess });
          expect(JSON.stringify(started.sandbox)).not.toContain("extra-unrequested");
          const threadId = (started.thread as { id: string }).id;
          // A synthetic local shell turn creates a rollout without a model RPC.
          await transport.request("thread/shellCommand", { threadId, command: "printf synthetic", timeoutMs: 1000 });
          await new Promise(resolve => setTimeout(resolve, 100));
          await transport.close();
          transport = await open(processArgs);
          const resumed = await transport.request("thread/resume", { threadId, cwd: root, ...selection, config, approvalPolicy: "never" });
          expect(resumed.activePermissionProfile).toMatchObject({ id: permissions });
          expect(resumed.sandbox).toEqual(started.sandbox);
        } finally { await transport.close(); }
      }
    }
    }
    }
    expect(diagnostics.join("\n")).not.toContain("synthetic-stale-private");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
