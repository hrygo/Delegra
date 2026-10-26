import {
  PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_BLOCK_TOOL_DESCRIPTION,
  PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_COMPLETION_TOOL_DESCRIPTION,
} from "../../contracts/completion-result.js";
import {
  CODEX_BLOCK_RESULT_OUTPUT_SCHEMA,
  CODEX_INVALID_REQUEST,
  CODEX_METHOD_NOT_FOUND,
  CODEX_RESULT_OUTPUT_SCHEMA,
  CodexAppServerDriver,
  CodexRpcError,
  FakeCodexTransport,
  HarnessCapabilityUnavailableError,
  HarnessOperationAlreadyTerminalError,
  HarnessReconciliationError,
  HarnessStaleTurnError,
  WORKSPACE,
  applyPrpEvent,
  collectUntilTerminal,
  createCodexTaskEnvelope,
  createIsolatedCodexAppServerArgs,
  createSessionSnapshotFromMetadata,
  describe,
  envelope,
  expect,
  isSkilllessCodexContext,
  it,
  liveConsoleFixturePath,
  loadLiveConsoleConformanceFixture,
  makeDriver,
  replayPersistedCodexEvents,
  result,
  reverseObjectKeys,
  runCodexCodexTracer,
  traceCompletedProposal,
  validateCodexResultProposal,
  validatePrpEvent,
  vi,
  type CodexAppServerTransport,
  type CodexRpcNotification,
  type CodexRpcServerRequest,
  type CodexServerRequestHandler,
  type CodexTraceInterpretation,
  type HarnessRuntimeRequestResolution,
  type PrpCapabilities,
  type PrpEvent,
  type PrpStructuredRunResult,
} from "./codex-app-server-driver.test-support.js";
import { HarnessDriverBackend } from "../../backends/harness-driver-backend.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

it.each(["default", "plan"] as const)("freezes direct %s process context and unwraps checkpoint tokens only after validation", async collaborationMode => {
  const root = mkdtempSync(join(tmpdir(), "codex-direct-policy-"));
  const bin = join(root, "bin"); mkdirSync(bin);
  const fake = resolve(import.meta.dirname, "../../../runner/target/debug/fake-codex-app-server");
  const log = join(root, "requests.jsonl");
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${JSON.stringify(fake)} --returned-cwd ${JSON.stringify(WORKSPACE)} --state-file ${JSON.stringify(join(root, "fake-state.json"))} --request-log ${JSON.stringify(log)} "$@"\n`, { mode: 0o700 });
  const options = { taskEnvelope: createCodexTaskEnvelope({ objective: "Synthetic launch test" }),
    environment: { HOME: root, CODEX_HOME: join(root, "home"), PATH: `${bin}:/usr/bin:/bin` },
    includeSkillInstructions: true, includeCollaborationModeInstructions: false, requestedCollaborationMode: collaborationMode };
  try {
    const session = await new CodexAppServerDriver(options).openSession({ runId: "policy-run", normalizedSessionId: "policy-session", workingDirectory: WORKSPACE });
    await session.startTurn({ message: { role: "user", text: "Synthetic turn" } });
    await collectUntilTerminal(session.events());
    const snapshot = await session.snapshot();
    expect(snapshot.driverSessionId).toMatch(/^paperclip-codex-launch-v1:[a-f0-9]{64}$/);
    expect(snapshot.codexLaunchContext).toHaveProperty("threadId");
    expect(snapshot.providerRecoveryPolicy).toBe("same_session_only");
    expect(session.ids().displayId).not.toBe(snapshot.driverSessionId);
    await session.close({ reason: "verify cold recovery" });
    expect((await new CodexAppServerDriver(options).recoverSession({ ...snapshot, workingDirectory: undefined })).recovered).toBe(false);
    expect((await new CodexAppServerDriver(options).recoverSession({ ...snapshot, workingDirectory: root })).recovered).toBe(false);
    const oldSnapshot = { ...snapshot }; delete oldSnapshot.codexLaunchContext;
    expect((await new CodexAppServerDriver(options).recoverSession(oldSnapshot)).recovered).toBe(false);
    expect((await new CodexAppServerDriver(options).recoverSession({ ...snapshot, codexLaunchContext: { ...snapshot.codexLaunchContext!, includeSkillInstructions: false } })).recovered).toBe(false);
    expect((await new CodexAppServerDriver({ ...options, environment: { ...options.environment, PAPERCLIP_RUNNER_HOME_MODE: "preconfigured" } }).recoverSession(snapshot)).recovered).toBe(false);
    expect((await new CodexAppServerDriver({ ...options, instructionWorkingCopyRoot: root }).recoverSession(snapshot)).recovered).toBe(false);
    const changed = await new CodexAppServerDriver({ ...options, environment: { ...options.environment, PAPERCLIP_RUNNER_NETWORK_ACCESS: "enabled" } }).recoverSession(snapshot);
    expect(changed.recovered).toBe(false);
    const recovered = await new CodexAppServerDriver({ ...options, includeSkillInstructions: false, includeCollaborationModeInstructions: true, requestedCollaborationMode: collaborationMode === "plan" ? "default" : "plan" }).recoverSession(snapshot);
    expect(recovered.reason).toBeUndefined();
    expect(recovered).toMatchObject({ recovered: true });
    await recovered.session!.close({ reason: "test complete" });
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const start = calls.find(call => call.method === "thread/start");
    const resume = calls.find(call => call.method === "thread/resume");
    expect(resume.params.config).toEqual(start.params.config);
    expect(calls.find(call => call.method === "turn/start").params.permissions).toBe(start.params.permissions);
    expect(start.params.permissions).toContain(collaborationMode === "plan" ? "workspace-read-only" : "workspace-only");
    expect(resume.params.threadId).toBe(snapshot.codexLaunchContext!.threadId);
    expect(JSON.stringify(calls)).not.toContain(snapshot.driverSessionId);
    const nativeIdentity = { runId: "native-policy-run", sessionId: "native-policy-session", companyId: "company", issueId: "issue", agentId: "agent" };
    const nativeBackend = new HarnessDriverBackend(new CodexAppServerDriver(options));
    const nativeSession = await nativeBackend.openSession({ identity: nativeIdentity, workingDirectory: WORKSPACE });
    const nativeSnapshot = await nativeSession.snapshot();
    expect(nativeSnapshot.sessionId).toMatch(/^paperclip-codex-launch-v1:/);
    expect(nativeSnapshot.codexLaunchContext?.workingDirectory).toBe(WORKSPACE);
    expect(nativeSnapshot.providerRecoveryPolicy).toBe("same_session_only");
    await nativeSession.close({ reason: "backend checkpoint roundtrip" });
    const nativeRecovered = await new HarnessDriverBackend(new CodexAppServerDriver(options)).recoverSession(nativeSnapshot, { signal: new AbortController().signal });
    if (!nativeRecovered.recovered) throw new Error(nativeRecovered.reason);
    expect((await nativeRecovered.session.snapshot()).codexLaunchContext).toEqual(nativeSnapshot.codexLaunchContext);
    expect((await nativeRecovered.session.snapshot()).sessionId).toBe(nativeSnapshot.sessionId);
    await nativeRecovered.session.close({ reason: "backend roundtrip verified" });
    const shim = readFileSync(join(bin, "codex"), "utf8");
    writeFileSync(join(bin, "codex"), shim.replace(JSON.stringify(WORKSPACE), JSON.stringify(root)), { mode: 0o700 });
    expect((await new CodexAppServerDriver(options).recoverSession(snapshot)).recovered).toBe(false);
    const afterMismatch = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(afterMismatch.filter(call => call.method === "thread/resume")).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["permissionProfile/list", "config/read"])("reaps the direct provider when %s preflight is cancelled", async method => {
  const root = mkdtempSync(join(tmpdir(), "codex-policy-abort-")); const bin = join(root, "bin"); mkdirSync(bin);
  const fake = resolve(import.meta.dirname, "../../../runner/target/debug/fake-codex-app-server"); const log = join(root, "requests.jsonl");
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${JSON.stringify(fake)} --block-policy-preflight ${JSON.stringify(method)} --state-file ${JSON.stringify(join(root, "state.json"))} --request-log ${JSON.stringify(log)} "$@"\n`, { mode: 0o700 });
  let pid: number | undefined;
  const controller = new AbortController(); const cancellation = new Error("cancel private preflight");
  const driver = new CodexAppServerDriver({ taskEnvelope: createCodexTaskEnvelope({ objective: "Synthetic cancellation" }),
    environment: { HOME: root, CODEX_HOME: join(root, "home"), PATH: `${bin}:/usr/bin:/bin` }, onSpawn: async info => { pid = info.pid; } });
  const opened = driver.openSession({ runId: "abort-run", normalizedSessionId: "abort-session", workingDirectory: WORKSPACE, signal: controller.signal });
  const outcome = opened.catch(error => error);
  try {
    await vi.waitFor(() => { expect(readFileSync(log, "utf8")).toContain(JSON.stringify(method)); });
    controller.abort(cancellation);
    expect(await outcome).toBe(cancellation);
    expect(readFileSync(log, "utf8")).not.toContain('"method":"thread/start"');
    expect(pid).toBeTypeOf("number"); expect(() => process.kill(pid!, 0)).toThrow();
  } finally { controller.abort(cancellation); await outcome; rmSync(root, { recursive: true, force: true }); }
});

it.each(["--omit-active-profile", "--returned-active-profile wrong-profile"])("requires positive direct profile attestation (%s)", async flags => {
  const root = mkdtempSync(join(tmpdir(), "codex-policy-attestation-")); const bin = join(root, "bin"); mkdirSync(bin);
  const fake = resolve(import.meta.dirname, "../../../runner/target/debug/fake-codex-app-server"); const log = join(root, "requests.jsonl");
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${JSON.stringify(fake)} ${flags} --state-file ${JSON.stringify(join(root, "state.json"))} --request-log ${JSON.stringify(log)} "$@"\n`, { mode: 0o700 });
  try {
    const driver = new CodexAppServerDriver({ taskEnvelope: createCodexTaskEnvelope({ objective: "Synthetic attestation" }),
      environment: { HOME: root, CODEX_HOME: join(root, "home"), PATH: `${bin}:/usr/bin:/bin` } });
    await expect(driver.openSession({ runId: "attest-run", normalizedSessionId: "attest-session", workingDirectory: WORKSPACE }))
      .rejects.toThrow("required filesystem permission profile");
    expect(readFileSync(log, "utf8")).not.toContain('"method":"turn/start"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

class BlockingBootstrapTransport extends FakeCodexTransport {
  readonly blocked: Promise<void>;
  readonly closeStarted: Promise<void>;
  closeCalls = 0;
  #resolveBlocked!: () => void;
  #resolveCloseStarted!: () => void;
  #resolveClose!: () => void;
  #rejectBlocked: ((reason: Error) => void) | null = null;
  readonly #closeReleased: Promise<void>;

  constructor(readonly blockedMethod: "thread/start" | "thread/read") {
    super();
    this.blocked = new Promise<void>((resolve) => {
      this.#resolveBlocked = resolve;
    });
    this.closeStarted = new Promise<void>((resolve) => {
      this.#resolveCloseStarted = resolve;
    });
    this.#closeReleased = new Promise<void>((resolve) => {
      this.#resolveClose = resolve;
    });
  }

  override request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method !== this.blockedMethod) return super.request(method, params);
    this.calls.push({ method, params: structuredClone(params) });
    this.#resolveBlocked();
    return new Promise<Record<string, unknown>>((_resolve, reject) => {
      this.#rejectBlocked = reject;
    });
  }

  releaseClose(): void {
    this.#resolveClose();
  }

  override async close(): Promise<void> {
    this.closeCalls += 1;
    this.#rejectBlocked?.(new Error("blocked bootstrap transport closed"));
    this.#rejectBlocked = null;
    this.#resolveCloseStarted();
    await this.#closeReleased;
    await super.close();
  }
}

class WarmAttachTransport extends FakeCodexTransport {
  readonly attachments: Array<{
    runId: string;
    turnId: string;
    itemId: string;
  }> = [];

  async attachRun(input: {
    runId: string;
    turnId: string;
    itemId: string;
  }): Promise<void> {
    this.attachments.push(structuredClone(input));
  }
}

describe("Codex app-server Codex driver", () => {
  it("accepts runner-proven warm attachment when the host active-turn reducer is stale", async () => {
    const transport = new WarmAttachTransport();
    const driver = makeDriver([transport]);
    const session = await driver.openSession({
      runId: "run-warm-first",
      normalizedSessionId: "normalized-warm",
      workingDirectory: WORKSPACE,
    });

    await session.startTurn({
      message: { role: "user", text: "first turn" },
    });
    await expect(
      session.attachRun?.({ runId: "run-warm-second", currentRunGrant: { runtimeContext: null, instructions: "Current registered instructions." } }),
    ).resolves.toBeUndefined();
    expect(transport.attachments).toHaveLength(1);
    expect(transport.attachments[0]).toMatchObject({ currentRunGrant: { runtimeContext: null, instructions: "Current registered instructions." } });
    expect((await session.snapshot()).activeTurnId).toBeNull();

    await expect(
      session.startTurn({
        message: { role: "user", text: "second turn" },
      }),
    ).resolves.toMatchObject({ turnId: "turn-1" });
    await session.close({ reason: "test complete" });
  });

  it("does not create a transport for a pre-aborted session open", async () => {
    const transportFactory = vi.fn(() => new FakeCodexTransport());
    const driver = makeDriver([], { transportFactory });
    const controller = new AbortController();
    const cancelled = new Error("session open cancelled before admission");
    controller.abort(cancelled);

    await expect(
      driver.openSession({
        runId: "run-pre-aborted",
        normalizedSessionId: "normalized-pre-aborted",
        workingDirectory: WORKSPACE,
        signal: controller.signal,
      }),
    ).rejects.toBe(cancelled);
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it("does not create a transport for pre-aborted session recovery", async () => {
    const initialDriver = makeDriver([new FakeCodexTransport()]);
    const original = await initialDriver.openSession({
      runId: "run-pre-aborted-recovery",
      normalizedSessionId: "normalized-pre-aborted-recovery",
      workingDirectory: WORKSPACE,
    });
    const snapshot = await original.snapshot();
    await original.close({ reason: "prepare recovery checkpoint" });
    const transportFactory = vi.fn(() => new FakeCodexTransport());
    const recoveryDriver = makeDriver([], { transportFactory });
    const controller = new AbortController();
    const cancelled = new Error("session recovery cancelled before admission");
    controller.abort(cancelled);

    await expect(
      recoveryDriver.recoverSession(snapshot, {
        signal: controller.signal,
      }),
    ).rejects.toBe(cancelled);
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it("closes and awaits a blocked session-open transport on abort", async () => {
    const transport = new BlockingBootstrapTransport("thread/start");
    const driver = makeDriver([transport]);
    const controller = new AbortController();
    const cancelled = new Error("session open cancelled while blocked");
    let settled = false;

    const opening = driver
      .openSession({
        runId: "run-blocked-open",
        normalizedSessionId: "normalized-blocked-open",
        workingDirectory: WORKSPACE,
        signal: controller.signal,
      })
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    await transport.blocked;
    controller.abort(cancelled);
    await transport.closeStarted;
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(transport.closeCalls).toBe(1);
    transport.releaseClose();
    await expect(opening).resolves.toEqual({ error: cancelled });
    expect(transport.calls.map((call) => call.method)).toEqual([
      "initialize",
      "thread/start",
    ]);
  });

  it("closes and awaits a blocked recovery transport on abort", async () => {
    const initial = new FakeCodexTransport();
    const recoveryTransport = new BlockingBootstrapTransport("thread/read");
    const driver = makeDriver([initial, recoveryTransport]);
    const original = await driver.openSession({
      runId: "run-blocked-recovery",
      normalizedSessionId: "normalized-blocked-recovery",
      workingDirectory: WORKSPACE,
    });
    const snapshot = await original.snapshot();
    await original.close({ reason: "simulate transport loss" });
    const controller = new AbortController();
    const cancelled = new Error("session recovery cancelled while blocked");
    let settled = false;

    const recovering = driver
      .recoverSession(snapshot, {
        signal: controller.signal,
      })
      .then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      )
      .finally(() => {
        settled = true;
      });
    await recoveryTransport.blocked;
    controller.abort(cancelled);
    await recoveryTransport.closeStarted;
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(recoveryTransport.closeCalls).toBe(1);
    recoveryTransport.releaseClose();
    await expect(recovering).resolves.toEqual({
      value: null,
      error: cancelled,
    });
    expect(recoveryTransport.calls.map((call) => call.method)).toEqual([
      "initialize",
      "thread/read",
    ]);
  });

  it("persists process ownership before sending provider requests", async () => {
    const transport = new FakeCodexTransport();
    Object.assign(transport, {
      processInfo: () => ({
        pid: 71_001,
        processGroupId: 71_001,
        startedAt: "2026-08-18T18:00:00.000Z",
        exited: false,
        exitCode: null,
        signal: null,
      }),
    });
    let releaseOwnership!: () => void;
    const ownershipPersisted = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });
    const onSpawn = vi.fn(() => ownershipPersisted);
    const driver = makeDriver([transport], { onSpawn });

    const opening = driver.openSession({
      runId: "run-owned",
      normalizedSessionId: "normalized-owned",
      workingDirectory: WORKSPACE,
    });
    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalledOnce());
    expect(transport.calls).toEqual([]);

    releaseOwnership();
    await opening;
    expect(onSpawn).toHaveBeenCalledWith({
      pid: 71_001,
      processGroupId: 71_001,
      startedAt: "2026-08-18T18:00:00.000Z",
    });
    expect(transport.calls[0]?.method).toBe("initialize");
  });

  it("persists process ownership after a lazy transport launches during session open", async () => {
    const transport = new FakeCodexTransport();
    Object.assign(transport, {
      processInfo: () => ({
        pid: transport.calls.some((call) => call.method === "thread/start")
          ? 71_002
          : null,
        processGroupId: 71_002,
        startedAt: "2026-08-18T18:01:00.000Z",
        exited: false,
        exitCode: null,
        signal: null,
      }),
    });
    const onSpawn = vi.fn(async () => undefined);
    const driver = makeDriver([transport], { onSpawn });

    await driver.openSession({
      runId: "run-lazy-owned",
      normalizedSessionId: "normalized-lazy-owned",
      workingDirectory: WORKSPACE,
    });

    expect(onSpawn).toHaveBeenCalledOnce();
    expect(onSpawn).toHaveBeenCalledWith({
      pid: 71_002,
      processGroupId: 71_002,
      startedAt: "2026-08-18T18:01:00.000Z",
    });
    expect(transport.calls.map((call) => call.method)).toContain(
      "thread/start",
    );
  });

  it("persists process ownership after a lazy transport launches during recovery", async () => {
    const originalTransport = new FakeCodexTransport();
    const originalDriver = makeDriver([originalTransport]);
    const original = await originalDriver.openSession({
      runId: "run-lazy-recovery-owned",
      normalizedSessionId: "normalized-lazy-recovery-owned",
      workingDirectory: WORKSPACE,
    });
    const snapshot = await original.snapshot();
    snapshot.activeTurnId = "turn-recovery-race";
    await original.close({ reason: "prepare lazy ownership recovery" });

    const recoveryTransport = new FakeCodexTransport();
    recoveryTransport.readResponse = {
      thread: {
        id: snapshot.driverSessionId,
        sessionId: snapshot.providerSessionId,
        cwd: WORKSPACE,
        turns: [{ id: "turn-recovery-race", status: "inProgress", items: [] }],
      },
    };
    Object.assign(recoveryTransport, {
      processInfo: () => ({
        pid: recoveryTransport.calls.some(
          (call) => call.method === "thread/read",
        )
          ? 71_003
          : null,
        processGroupId: 71_003,
        startedAt: "2026-08-18T18:02:00.000Z",
        exited: false,
        exitCode: null,
        signal: null,
      }),
    });
    const onSpawn = vi.fn(async () => undefined);
    const transportFactory = vi.fn(() => recoveryTransport);
    const recoveryDriver = makeDriver([], { onSpawn, transportFactory });

    const recovered = await recoveryDriver.recoverSession(snapshot);

    expect(recovered.recovered).toBe(true);
    expect(transportFactory).toHaveBeenCalledWith({
      workingDirectory: snapshot.workingDirectory,
      providerRecoveryPolicy: snapshot.providerRecoveryPolicy,
      persistedSession: {
        driverSessionId: snapshot.driverSessionId,
        providerSessionId: snapshot.providerSessionId,
        providerIdentity: snapshot.providerIdentity,
        activeTurnId: snapshot.activeTurnId,
      },
    });
    expect(onSpawn).toHaveBeenCalledOnce();
    expect(onSpawn).toHaveBeenCalledWith({
      pid: 71_003,
      processGroupId: 71_003,
      startedAt: "2026-08-18T18:02:00.000Z",
    });
    expect(recoveryTransport.calls.map((call) => call.method)).toContain(
      "thread/read",
    );
  });

  it("detaches restart authority without closing the provider transport", async () => {
    const transport = new FakeCodexTransport();
    const detachControllerForRestart = vi.fn(async () => undefined);
    Object.assign(transport, { detachControllerForRestart });
    const driver = makeDriver([transport]);
    const session = await driver.openSession({
      runId: "run-hot-detach",
      normalizedSessionId: "normalized-hot-detach",
      workingDirectory: WORKSPACE,
    });
    const close = vi.spyOn(transport, "close");

    await session.detachControllerForRestart?.();

    expect(detachControllerForRestart).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it("sends direct chat as plain text and permits a follow-up turn", async () => {
    const transport = new FakeCodexTransport();
    const driver = makeDriver([transport], { conversationMode: "direct" });
    const session = await driver.openSession({
      runId: "run-chat",
      normalizedSessionId: "normalized-chat",
      workingDirectory: WORKSPACE,
    });

    const threadStart = transport.calls.find(
      (call) => call.method === "thread/start",
    );
    expect(threadStart?.params).not.toHaveProperty("baseInstructions");
    expect(threadStart?.params.dynamicTools).toEqual([]);

    const first = await session.startTurn({
      message: { role: "user", text: "Hello Codex" },
    });
    const firstStart = transport.calls.find(
      (call) => call.method === "turn/start",
    );
    expect(firstStart?.params).not.toHaveProperty("outputSchema");
    expect(firstStart?.params.input).toEqual([
      { type: "text", text: "Hello Codex", text_elements: [] },
    ]);
    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: first.turnId, status: "inProgress" },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: first.turnId, status: "completed", items: [] },
    });
    await collectUntilTerminal(session.events());

    transport.turnStartResponse = Promise.resolve({
      turn: { id: "turn-2", status: "inProgress", items: [] },
    });
    await expect(
      session.startTurn({ message: { role: "user", text: "And a follow-up" } }),
    ).resolves.toEqual({
      turnId: "turn-2",
      effectiveCollaborationMode: "default",
    });
  });

  it("forwards the persisted native model to the runner transport", async () => {
    const transport = new FakeCodexTransport();
    const driver = makeDriver([transport], {
      model: "qualified-provider-model",
    });

    await driver.openSession({
      runId: "run-qualified-model",
      normalizedSessionId: "normalized-qualified-model",
      workingDirectory: WORKSPACE,
    });

    expect(
      transport.calls.find((call) => call.method === "thread/start")?.params,
    ).toMatchObject({
      model: "qualified-provider-model",
      completionContract: {
        revision: "codex-demo-v1",
        criterionIds: ["file"],
      },
    });
  });

  it("adds Paperclip developer instructions without replacing the Codex base and enables selected skills", async () => {
    const transport = new FakeCodexTransport();
    const baseInstructions = [
      "You are running as a Paperclip agent.",
      "Follow the attached AGENTS.md instructions.",
      "Read-only instruction sibling root: /paperclip/context/instructions",
    ].join("\n\n");
    const driver = makeDriver([transport], {
      baseInstructions,
      includeSkillInstructions: true,
    });

    await driver.openSession({
      runId: "run-runtime-context",
      normalizedSessionId: "normalized-runtime-context",
      workingDirectory: WORKSPACE,
    });

    const threadStart = transport.calls.find(
      (call) => call.method === "thread/start",
    );
    expect(threadStart?.params).toMatchObject({
      developerInstructions: baseInstructions,
      config: {
        "skills.include_instructions": true,
        include_apps_instructions: false,
      },
    });
    expect(threadStart?.params).not.toHaveProperty("baseInstructions");
    expect(JSON.stringify(threadStart?.params.input ?? null)).not.toContain(
      baseInstructions,
    );
  });

  it.each(["task", "prepared", "direct"] as const)("preserves stock Codex instructions on %s recovery", async (conversationMode) => {
    const originalTransport = new FakeCodexTransport();
    const recoveryTransport = new FakeCodexTransport();
    const baseInstructions = "Paperclip coordination and assigned instruction paths.";
    const driver = makeDriver([originalTransport, recoveryTransport], {
      conversationMode,
      baseInstructions,
      includeSkillInstructions: true,
    });
    const original = await driver.openSession({
      runId: "run-additive-recovery",
      normalizedSessionId: "normalized-additive-recovery",
      workingDirectory: WORKSPACE,
    });
    const snapshot = await original.snapshot();
    recoveryTransport.readResponse = {
      thread: { id: snapshot.driverSessionId, sessionId: snapshot.providerSessionId, cwd: WORKSPACE, turns: [] },
    };
    await original.close({ reason: "verify additive recovery" });

    const recovered = await driver.recoverSession(snapshot);
    expect(recovered.recovered).toBe(true);
    const started = originalTransport.calls.find((call) => call.method === "thread/start")!.params;
    const resumed = recoveryTransport.calls.find((call) => call.method === "thread/resume")!.params;
    expect(started).not.toHaveProperty("baseInstructions");
    expect(resumed).not.toHaveProperty("baseInstructions");
    expect(started.developerInstructions).toBe(conversationMode === "direct" ? undefined : baseInstructions);
    expect(resumed.developerInstructions).toBe(conversationMode === "direct" ? "" : baseInstructions);
    expect(resumed.dynamicTools).toEqual(started.dynamicTools);
    expect(started.dynamicTools).toEqual(conversationMode === "direct" ? [] : [
      { name: "paperclip_finish", description: PRP_COMPLETION_TOOL_DESCRIPTION, inputSchema: PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA },
      { name: "paperclip_block", description: PRP_BLOCK_TOOL_DESCRIPTION, inputSchema: PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA },
    ]);
    expect(resumed.config).toEqual(started.config);
    await recovered.session?.close({ reason: "verified additive recovery" });
  });

  it("retains the instruction field for non-Codex provider facades", async () => {
    const transport = new FakeCodexTransport();
    const driver = makeDriver([transport], {
      baseInstructions: "Provider-specific runtime context.",
      driverIdentity: { kind: "opencode_server", displayName: "OpenCode", version: "1" },
    });
    const session = await driver.openSession({
      runId: "run-facade-instructions",
      normalizedSessionId: "normalized-facade-instructions",
      workingDirectory: WORKSPACE,
    });
    const started = transport.calls.find((call) => call.method === "thread/start")!.params;
    expect(started.baseInstructions).toBe("Provider-specific runtime context.");
    expect(started).not.toHaveProperty("developerInstructions");
    await session.close({ reason: "verified facade instructions" });
  });

  it("passes the common typed-event contract and reports one provider turn terminal", async () => {
    const transport = new FakeCodexTransport();
    const driver = makeDriver([transport]);
    const descriptor = await driver.descriptor();
    const session = await driver.openSession({
      runId: "run-1",
      normalizedSessionId: "normalized-1",
      workingDirectory: WORKSPACE,
    });
    const turn = await session.startTurn({
      message: { role: "user", text: "Do the safe task." },
    });

    transport.push("turn/started", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "inProgress" },
    });
    transport.push("turn/plan/updated", {
      threadId: "thread-1",
      turnId: turn.turnId,
      revision: 1,
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "inProgress" },
      ],
    });
    transport.push("turn/diff/updated", {
      threadId: "thread-1",
      turnId: turn.turnId,
      revision: 1,
      diff: [
        "diff --git a/hello.txt b/hello.txt",
        "--- a/hello.txt",
        "+++ b/hello.txt",
        "@@ -1 +1,2 @@",
        "-hello",
        "+hello world",
        "+again",
      ].join("\n"),
    });
    transport.push("turn/plan/updated", {
      threadId: "thread-1",
      turnId: turn.turnId,
      revision: 2,
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "completed" },
      ],
    });
    transport.push("item/started", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: { id: "cmd-1", type: "commandExecution", command: "printf hello" },
    });
    transport.push("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: turn.turnId,
      itemId: "cmd-1",
      delta: "hello",
    });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "file-1",
        type: "fileChange",
        changes: [{ path: "hello.txt" }],
      },
    });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "reference-1",
        type: "agentMessage",
        text: "Open [hello.txt](hello.txt).",
      },
    });
    const requestResolution = transport.invoke({
      id: "request-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: turn.turnId,
        itemId: "question-1",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.pendingRuntimeRequests?.()).toHaveLength(1);
    await session.resolveRuntimeRequest?.({
      requestId: "request-1",
      turnId: turn.turnId,
      resolution: { action: "cancel" },
    });
    expect(await requestResolution).toEqual({ answers: {} });
    transport.push("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: turn.turnId,
      tokenUsage: {
        total: { inputTokens: 10, outputTokens: 4 },
        modelContextWindow: 128000,
      },
    });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: turn.turnId,
      item: {
        id: "answer-1",
        type: "agentMessage",
        text: JSON.stringify(result),
      },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: turn.turnId, status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(events.every((event) => validatePrpEvent(event).ok)).toBe(true);
    expect(
      events.filter((event) => event.eventType === "run.result.proposed"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === "turn.completed"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === "run.terminal"),
    ).toHaveLength(0);
    const workspaceEvents = events.filter(
      (event) => event.eventType === "workspace.change.updated",
    );
    expect(workspaceEvents[0]?.payload).toMatchObject({
      schema: "paperclip.workspace.diff.v1",
      changeSetId: `${turn.turnId}:workspace`,
      complete: false,
      totals: { files: 1, additions: 2, deletions: 1 },
    });
    expect(workspaceEvents.at(-1)?.payload).toMatchObject({
      schema: "paperclip.workspace.diff.v1",
      complete: true,
      totals: { files: 1 },
    });
    const planEvents = events.filter(
      (event) => event.eventType === "plan.updated",
    );
    expect(planEvents).toHaveLength(2);
    expect(new Set(planEvents.map((event) => event.itemId))).toEqual(
      new Set([turn.turnId]),
    );
    expect(planEvents.at(-1)?.payload).toMatchObject({
      planId: turn.turnId,
      revision: 2,
      complete: true,
      syncStatus: "not_applicable",
    });
    expect(
      events.find((event) => event.eventType === "workspace.diff.recorded")
        ?.payload,
    ).toMatchObject({ schema: "paperclip.workspace.diff.v1", complete: true });
    expect(
      events.find((event) => event.eventType === "workspace.file.referenced")
        ?.payload,
    ).toMatchObject({
      schema: "paperclip.workspace.file_reference.v1",
      path: "hello.txt",
    });
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "session.started",
        "turn.started",
        "item.started",
        "item.delta",
        "item.completed",
        "run.result.proposed",
        "turn.completed",
        "runtime_request.created",
        "runtime_request.resolved",
        "workspace.change.updated",
        "workspace.diff.recorded",
      ]),
    );

    const capabilities: PrpCapabilities = {
      schema: "paperclip.prp.capabilities.v1",
      sessionReusePolicy: "reuse_per_issue",
      driver: { kind: descriptor.kind, version: descriptor.version },
      steer: true,
      interrupt: true,
      resume: true,
      runtimeRequests: true,
      structuredResult: true,
      typedEvents: true,
    };
    const metadata = {
      fixtureName: "codex-conformance",
      identity: {
        schema: "paperclip.prp.identity.v1" as const,
        companyId: "company-1",
        issueId: "issue-1",
        runId: "run-1",
        environmentLeaseId: "lease-1",
        runnerInstanceId: "runner-codex",
        normalizedSessionId: "normalized-1",
      },
      capabilities,
    };
    const live = events.reduce(
      applyPrpEvent,
      createSessionSnapshotFromMetadata(metadata),
    );
    const replay = events.reduce(
      applyPrpEvent,
      createSessionSnapshotFromMetadata(metadata),
    );
    expect(live).toEqual(replay);
    expect(live.integrity).toBe("complete");
    expect(await session.usage?.()).toMatchObject({
      modelContextWindow: 128000,
    });
  });
});


it("sends explicit skill input on every requested turn", async () => {
  const transport = new FakeCodexTransport();
  const skillInputs = [{ type: "skill" as const, name: "first-task", path: "/runtime/assigned/first-task/SKILL.md" }];
  const driver = makeDriver([transport], { conversationMode: "direct", skillInputs });
  const session = await driver.openSession({ runId: "run-skills", normalizedSessionId: "session-skills", workingDirectory: WORKSPACE });
  for (const text of ["Start onboarding", "Yes, I approve"]) {
    const turn = await session.startTurn({ message: { role: "user", text } });
    const call = transport.calls.filter((call) => call.method === "turn/start").at(-1);
    expect(call?.params.input).toEqual([{ type: "text", text: `$first-task\n\n${text}`, text_elements: [] }, ...skillInputs]);
    transport.push("turn/completed", { threadId: "thread-1", turn: { id: turn.turnId, status: "completed", items: [] } });
    await collectUntilTerminal(session.events());
    transport.turnStartResponse = Promise.resolve({ turn: { id: "turn-2", status: "inProgress", items: [] } });
  }
  await session.close();
});


it("reapplies explicit skills after recovery without persisting them into ordinary tasks", async () => {
  const skillInputs = [{ type: "skill" as const, name: "first-task", path: "/runtime/onboarding/SKILL.md" }];
  const first = new FakeCodexTransport();
  const original = await makeDriver([first], { skillInputs }).openSession({
    runId: "initial", normalizedSessionId: "skill-recovery", workingDirectory: WORKSPACE,
  });
  const snapshot = await original.snapshot();
  await original.close();
  for (const selected of [skillInputs, []]) {
    const transport = new FakeCodexTransport();
    const recovery = await makeDriver([transport], { skillInputs: selected }).recoverSession(snapshot);
    expect(recovery.recovered).toBe(true);
    const session = recovery.session!;
    try {
      await session.startTurn({ message: { role: "user", text: "Continue" } });
      const items = transport.calls.find((call) => call.method === "turn/start")?.params.input as Array<{type:string}>;
      expect(items.filter((item) => item.type === "skill")).toEqual(selected);
    } finally { await session.close(); }
  }
});
