import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FakeCodexTransport, WORKSPACE, createCodexTaskEnvelope } from "./codex-app-server-driver.test-support.js";
import { createIsolatedCodexAppServerLaunch } from "./codex-security-config.js";
import { codexLaunchDigest, frozenCodexLookupToken } from "./codex-launch-policy.js";

// Qualification uses an immutable installed old release, not a reimplementation
// of its compatibility behavior. No provider process or model call is involved.
it.skipIf(!process.env.PAPERCLIP_LEGACY_RUNNER_PACKAGE)("the actual old runtime rejects a versioned lookup before resume and never opens a replacement", async () => {
  const root = process.env.PAPERCLIP_LEGACY_RUNNER_PACKAGE!;
  const load = (path: string) => import(/* @vite-ignore */ pathToFileURL(join(root, "dist", path)).href);
  const [{ CodexAppServerDriver }, { HarnessDriverBackend }, { executeNativeSession }] = await Promise.all([
    load("drivers/codex/codex-app-server-driver-impl.js"), load("backends/harness-driver-backend.js"), load("native-session-runtime.js"),
  ]);
  const identity = { runId: "compat-run", sessionId: "compat-session", companyId: "compat-company", issueId: "compat-issue", agentId: "compat-agent" };
  const policy = createIsolatedCodexAppServerLaunch({ PATH: "/usr/bin" }).launchPolicy;
  const context = { schema: "paperclip.codex.frozen-launch.v1" as const, policy, collaborationMode: "plan" as const, homeMode: "managed" as const, workingDirectory: WORKSPACE,
    includeSkillInstructions: true, includeCollaborationModeInstructions: true, threadId: "real-native-thread",
    providerSessionId: null, providerRecoveryPolicy: "same_session_only" as const };
  const token = frozenCodexLookupToken(context);
  const transport = new FakeCodexTransport();
  const driver = new CodexAppServerDriver({ transportFactory: () => transport,
    taskEnvelope: createCodexTaskEnvelope({ objective: "Compatibility qualification" }) });
  const backend = new HarnessDriverBackend(driver);
  const open = vi.spyOn(backend, "openSession");
  const replacement = vi.fn(() => { throw new Error("replacement must never be attempted"); });
  backend.openReplacementSession = replacement;
  const checkpoint = { backendKind: "runner", driverKind: "codex_app_server", sessionId: token,
    identity, workingDirectory: WORKSPACE, providerSessionId: null,
    providerIdentity: { kind: "codex_launch_policy_v1", digest: codexLaunchDigest(context) },
    codexLaunchContext: context, providerRecoveryPolicy: "same_session_only", cursor: "0",
    activeTurnId: "active-historical-work", pendingRuntimeRequests: [], lineage: [] };
  const openRun = vi.fn();
  const input = { schema: "paperclip.native-execution-input.v1", binding: { companyId: identity.companyId, runId: identity.runId, issueId: identity.issueId, agentId: identity.agentId, executionWorkspaceId: "workspace" },
    task: { identifier: "COMPAT-1", title: "Qualification", description: null, prompt: "Synthetic", workMode: "standard" },
    workspace: { cwd: WORKSPACE, repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1 },
    provider: { kind: "codex", model: null }, completionContract: { id: "contract", sha256: "synthetic", schemaVersion: "1",
      contract: { revision: "1", objective: "Synthetic", criteria: [{ id: "objective", requirement: "Synthetic" }] } },
    interactionResponses: [], credentialBindings: [] };
  await expect(executeNativeSession({ input, backend, runnerInstanceId: "compat-runner", controlPlaneInstanceId: "compat-control",
    persistedSession: checkpoint, controlPlane: { openRun, async appendEvent() {}, async completeRun() {},
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; } } })).rejects.toThrow("native_session_recovery_failed");
  expect(transport.calls.find(call => call.method === "thread/read")?.params.threadId).toBe(token);
  expect(transport.calls.some(call => ["thread/resume", "thread/start", "turn/start"].includes(call.method))).toBe(false);
  expect(open).not.toHaveBeenCalled(); expect(replacement).not.toHaveBeenCalled(); expect(openRun).not.toHaveBeenCalled();
});
