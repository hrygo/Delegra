# Codex Launch Policy Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task by task in the already assigned worktree. Implementation is owned by the assigned worker; commit, push, deployment, live data changes, and DEL-43 revival are outside this assignment.

**Goal:** Move generated Codex filesystem and non-secret shell policy out of argv while retaining every assigned skill, exact permission boundaries, and durable recovery behavior.

**Architecture:** One Codex-owned policy builder produces bounded process arguments and a versioned, typed `launchPolicy`, carrying filesystem paths only as entry-array values. Native Runner freezes the policy behind a new, old-runner-rejected driver discriminant; the direct TypeScript driver freezes it in its actual session snapshots. Native identity uses a separate `paperclip.codex.native-launch-identity.v1` digest schema, consistently projected by open, restore, and authenticated snapshot. Both project the policy only at the Codex boundary and perform bounded profile-name and inherited-environment-key conflict checks before thread admission.

**Tech Stack:** TypeScript/Vitest, Rust/Serde, Codex app-server CLI `0.160.0`; no new dependency.

**Spec:** This document records the delegated DEL-43 requirements, the existing `codex-security-config.ts` policy, and the measured fixed-CLI dependency contract below.

## Global Constraints

- Preserve all assigned immutable skill roots; do not replace them with a wider parent directory or truncate the inventory.
- Keep argv limits at 64 arguments, 4,096 UTF-8 bytes per argument, and no NUL; errors disclose index, safe key, size, and limit, never values.
- Preserve managed/preconfigured home, default/plan, external sandbox, controller network decision, Git metadata, broker/host authentication, instruction working copy, protected state, and environment allowlist semantics.
- Generated `launchPolicy` contains no credential values, provider/model overrides, hooks, MCP configuration, arbitrary feature flags, or arbitrary Codex configuration.
- Exact-run recovery reuses its frozen policy. Historical descriptors without `launchPolicy` retain their original argv path; no migration of frozen launch intent is inferred.
- Do not change existing checkpoint/command fingerprint algorithms. Persisted object keys remain fixed ASCII; dynamic paths are values, never keys.
- A new settled run may rebind the same run-scoped policy components that `runtimeLaunchArgs` already permits; executable/model/instructions/approval policy remain protected.
- No global/user config edits, new polling, automatic fallback to broader permissions, or automatic retry with a different launch identity.
- Only the parent owns `.delegra` registration, PR/release work, and the live agent fleet.

## Verified Baseline (2026-10-27)

- Worktree: `delegra-launch-policy/Delegra`; branch `codex/codex-launch-policy-transport`; starting HEAD `7ab14f8277f522fd692dcf084b5a902d566a9988`; clean before this plan.
- Parent's failure evidence: the historical 20-skill launch has 21 argv entries. Its two filesystem arguments are 4,809 and 4,811 UTF-8 bytes, exceeding Rust's 4,096-byte bound by 713 and 715 bytes. No NUL is involved.
- Current builder includes every skill bundle root separately. `CodexProviderConfig` persists argv and optional skill instructions; Rust currently sends only the latter in thread config.
- Fixed CLI `0.160.0` was verified from the immutable local release artifact. Probes used fresh temporary `HOME`/`CODEX_HOME`, no credentials, a dummy loopback provider, an outer network-deny sandbox, ephemeral threads, and no model turn. Probe-only `project_doc_max_bytes=0` must not become a product default.
- Dotted filesystem objects, a whole `permissions` object, and the original `-c` inline-table override **all recursively merge** a pre-existing same-name profile. A seeded extra write root survived all three. A null entry is rejected by `FilesystemPermissionToml` and cannot clear it.
- The experimental CLI schema and real `permissionProfile/list` RPC expose bounded profile summaries without provider/MCP configuration. A new namespace excluded the seeded old profile's extra write root; a seeded same-namespace profile with `extends` was discovered before `thread/start` and rejected by the probe's collision gate.
- A synthetic `thread/shellCommand` probe (only `printf`, no model request) verified that a stale configured `set` variable outside `include_only` was absent and an explicitly generated `set` value won (`expected|absent`). This does **not** cover an allowed, inheritance-only variable shadowed by a same-name configured `set`; that counterexample is a mandatory regression.
- Existing preparation storage compares the complete provider JSON, not only `configurationId`. Existing native recovery compares the recorded provider descriptor before restoring it. `runtimeLaunchArgs` has an explicit settled-run rebind path that must remain paired with its structured-policy successor.
- Old Rust `CodexProviderConfig.validate` accepts exactly `codex/codex_app_server` or `opencode/opencode_server`. Native executor selection routes by provider `kind`, separately from that driver. Old direct TS recovery compares the checkpoint's existing `providerIdentity` with the opened identity before admitting a turn; its parser recognizes only `kind: acpx`.
- Direct `CodexHarnessSession.snapshot()` currently omits launch policy; `HarnessDriverBackend` explicitly copies checkpoint fields in both directions. All three locations must change; adding a policy field only to the driver options cannot freeze recovery.
- Graph generation `2026-10-24T15:52:33Z` was used for lookup. Evidence paths were coverage-checked; `runnerd-codex-transport.ts` is newer than that graph, so its preparation/recovery branches were read directly. The graph is not exhaustive evidence for the current worktree.

## Design Decisions

1. Add `launchPolicy?: CodexLaunchPolicy` to the provider descriptor. Its v1 shape contains exactly: schema, normal/planning filesystem **entry arrays** (`{ path, access: none|read|write }`), network boolean, external-sandbox boolean, and shell environment policy (`inherit`, `ignoreDefaultExcludes`, `includeOnly`, `set`). Pseudo-roots are entry values too; only the Codex projection converts `:workspace_roots` to its required `{".": access}` map and other paths to object keys. Rust and TypeScript reject unknown fields and malformed keys/values. No filesystem path-keyed map is stored in `run.prepare`, `run.attach`, receipts, or checkpoints.
2. Bound serialized policy to 256 KiB, each profile to 1,024 filesystem entries, each path/value to 4,096 UTF-8 bytes, environment names to 256 entries of 256 bytes, and `set` to the existing non-secret command environment keys. Environment names must match ASCII `[A-Za-z_][A-Za-z0-9_]*`. Reject lone UTF-16 surrogates in all incoming JS strings and invalid Unicode at the Rust JSON boundary; do not normalize Unicode. Exceeding a budget fails with a value-free diagnostic and never drops roots. Existing PRP whole-command/frame limits remain unchanged.
3. Sort entry arrays by the lexicographic order of their original UTF-8 bytes (`Buffer.compare` / Rust byte-string order); deduplicate identical path/access pairs and reject conflicting duplicate paths. Canonical namespace JSON recursively sorts the remaining ASCII object keys, preserves array order, emits valid Unicode as UTF-8, does not escape `/`, and escapes quote/backslash, the standard short control escapes, and other U+0000–U+001F as lowercase `\u00xx`. Hash that complete semantic policy with SHA-256 and append fixed normal/plan/external suffixes. This new owner format does not alter generic TS/Rust checkpoint hashing. A shared fixture must include same-prefix U+E000 and U+1F600 paths; both namespace generation and a real warm `run.attach` receipt exercise it across TS/Rust. Profiles never specify `extends`, and names are owner-generated.
4. After initialize and before opening/resuming a thread, call `permissionProfile/list` with the authoritative cwd. Reject any existing generated profile name, including a disallowed/inherited entry. Follow pagination with at most 32 pages and 128 entries per page. Also call `config/read` with that cwd and `includeLayers: false` at a private, bounded configuration boundary: inspect **only key names** in the effective `shell_environment_policy.set`. Let `inheritedOnly = includeOnly - keys(generated set)`; if any effective set key intersects `inheritedOnly`, reject before thread admission. These are normally two local, request-bound RPCs, with no model inference, new timer, or network call. Unsupported RPC, malformed response/pagination, timeout, or budget exhaustion fails closed under existing startup cancellation/cleanup.
5. A `config/read` response may contain unrelated secrets: its raw response/error must bypass raw-frame trace/diagnostic recording **before** recording occurs, then be reduced immediately to key names and discarded. Neither values nor full response/error objects enter policy, checkpoints, events, logs, or exceptions. Errors use a fixed value-free conflict/unavailable code. Transport tests seed sentinel values in successful, erroneous, and malformed replies and assert absence from all trace/diagnostic sinks. A same-name synthetic inherited-key shadow is a required real-CLI negative test; never copy credential values into generated `set` as a workaround.
6. Project only `default_permissions`, the generated profiles, and `shell_environment_policy` into thread config, then merge the frozen instruction switches. Preserve external-sandbox thread/turn behavior and fixed process switches. The exact `include_only` array removes stale set keys outside the allowlist; generated non-secret set keys explicitly override matching keys, while Decision 4 rejects stale overrides of inheritance-only keys. The direct process path consumes this projection; factory/native transports retain logical modes and resolve policy on the actual execution host, without inferring remote grants from controller paths.
7. Keep caller-supplied `codexArgs` as an explicit legacy override unless the caller supplies the new typed policy through the owner contract. Never reverse-parse arbitrary argv into grants. All automatically generated production paths use the new pair. Legacy oversized argv still receives a precise bounded-contract error.
8. Native state serializes the complete policy. A settled new run transports a paired `runtimeLaunchArgs`/`runtimeLaunchPolicy` update through the existing authenticated rebind boundary; both are validated before state mutation and changes force reopening the same provider thread. Exact recovery and historical missing-field state do not gain a policy silently. Keep the complete policy associated with the preparation's `configurationId` and reject tampering under an unchanged identity/ID.
9. Use internal provider config `driver: codex_app_server_launch_policy_v1` **if and only if** a valid typed policy is present; legacy `codex_app_server` forbids that field. The old runner's existing exact driver check therefore rejects a new descriptor even though old Serde ignores unknown fields. `kind: codex` routing remains unchanged. Public harness `driverKind` and readiness/evidence `providerDescriptor.driver` remain the logical `codex_app_server`, normalized by the owner so existing server readiness consumers need no change. Update and test the preparation validator, native run/session results, evidence/probe paths, and driver/config pairing together.
10. Add a closed `CodexLaunchPolicyIdentity` variant to the **existing** `providerIdentity` contract. Native identity binds policy digest, mode/instruction switches, and actual provider IDs; direct identity binds the complete frozen-context digest. Identity equality alone is insufficient as a downgrade barrier because the old direct comparison occurs after `thread/resume`. **Parent-approved option B:** a new direct checkpoint's `driverSessionId` is exactly `paperclip-codex-launch-v1:<64 lowercase hex SHA-256 of canonical FrozenCodexLaunchContext>`. Its real provider thread ID remains only inside that context. A new owner validates schema, complete digest, identity, and token before unwrapping the ID; an old owner sends the token to its existing first `thread/read` lookup and must fail before `thread/resume`. No lookup-failure-to-new-thread fallback is permitted; these checkpoints use existing `providerRecoveryPolicy: same_session_only`. Test actual old controller/backend and runner artifacts, including active/goal-bearing history. Stop this sub-path and report if an old owner can resume or create replacement work.
11. At direct open, put `FrozenCodexLaunchContext` on `OpenedCodexThread`, containing schema, policy, selected default/plan mode, explicit managed/preconfigured home mode, authoritative working directory, skill/collaboration instruction switches, actual `threadId`, and actual nullable `providerSessionId`; derive generated profile IDs into the opened sandbox context. `CodexHarnessSession.snapshot()` persists context plus the versioned lookup token; runtime `ids().displayId` and Codex RPCs retain real IDs. `PersistedHarnessSession`, `PersistedNativeSession`, and both directions of `HarnessDriverBackend` preserve the opaque token/context without inspecting provider IDs. Verify event/metadata/display consumers do not send the token to Codex or treat it as a displayed native ID. Recovery requires the snapshot working directory and current home mode to match the frozen fields, validates the frozen context/digest/identity before spawning/lookup and uses it for process arguments, `thread/resume.config`, and `turn/start` selection without reconstructing grants from current options. Changed options either preserve the frozen policy or cause explicit admission failure. Secret values come only from current authorized environment bindings under the frozen allowlist/conflict check.
12. Direct historical snapshots with no frozen context cannot establish their old filesystem policy and return `recovered: false` with a fresh-session-required reason before spawning a provider; do not silently upgrade them. Factory/native historical snapshots continue to delegate to the existing authoritative frozen native descriptor and legacy argv. A structured-policy identity with missing context on a direct path is corrupt state, not a legacy fallback.

## Review Focus

- Preconfigured home contains same-name profiles, `extends`, or extra allow roots: collision gate rejects before any provider work.
- Historical frozen provider descriptor omits the new field: restore retains original argv and permission semantics.
- New run rotates instruction/broker paths while reusing a settled thread: paired policy rebind is persisted and reopen is required.
- Long Unicode/quoted skill paths and a 20-skill inventory, including U+E000/U+1F600 same-prefix order: exact roots, namespaces, and real warm command receipts agree across TS/Rust.
- Same-name stale `set` shadows an allowed inherited key: reject before thread admission, with all configuration values absent from trace, diagnostics, and state. Old-runner/controller and direct snapshot-policy downgrade cases are mandatory negative acceptance.

## File Ownership and Tasks

### Task 1: Shared generated policy and regression

**Files:** Add `packages/paperclip-runner/src/drivers/codex/codex-launch-policy.ts` and its owner test. Modify `codex-security-config.ts`, `codex-security-config.test.ts`, and the driver export surface only as needed.

**Interfaces:** `CodexLaunchPolicy`; `createIsolatedCodexAppServerLaunch(...) -> { args, launchPolicy }`; typed policy validation/canonical namespace/config projection; existing policy input parameters retain their meaning.

- [x] Add a failing 20-skill regression with filesystem policy over 4,096 bytes, quotes/Unicode, and three representative local/SSH/container path layouts. Assert exact grants and bounded argv rather than skill count reduction; reject lone surrogates without Unicode normalization.
- [x] Add shared `test/fixtures/codex-launch-policy-unicode.json` with U+E000/U+1F600 same-prefix paths and expected canonical bytes/namespace, consumed by both TS and Rust tests. Dynamic paths must be values throughout the fixture's persisted command shape.
- [x] Implement one policy builder and its strict serializer/projection. Update owner tests from TOML-string checks to equivalent exact structured-policy assertions.
- [x] Cover all existing default/plan, managed/preconfigured, network, Git/broker, protected-root, and secret-exclusion rows; add total-budget and unknown-field failures.
- [x] Run focused Vitest files and retain the red/green evidence.

### Task 2: Native descriptor, startup, and restoration

**Files:** Modify `src/live/runner-provider-launch.ts`, `runnerd-codex-transport.ts`, and their owner/preparation/store/recovery tests. Add `runner/crates/runner-core/src/codex_launch_policy.rs`; modify `lib.rs`, `codex_provider.rs`, `provider_backend.rs`, `tests/codex_provider.rs`, and the owned fake app-server as necessary. Extend owner transport trace/privacy tests and the shared Unicode fixture.

**Interfaces:** Optional Serde `launch_policy` with camelCase JSON `launchPolicy`, paired with the new existing-field driver discriminant; closed typed policy projection; bounded collision/environment-key preflight; paired optional `runtimeLaunchPolicy` for settled-run update; closed policy identity carried by existing session identity events.

- [x] Add failing native tests for large-policy `run.prepare`, start/resume config equality, JSON persistence, both preflight cleanup paths, legacy missing-field state, exact-identity tampering, and settled rotation. Use the shared Unicode fixture in a real runner warm-attachment receipt so generic command fingerprint parity is exercised, not mocked.
- [x] Prove the baseline runner refuses the new driver descriptor before spawn, and the baseline controller refuses a new tagged checkpoint before any turn; prove the new runner still restores unchanged legacy descriptors. Retain logical public driver/readiness evidence.
- [x] Generate/persist the policy at the execution-host launch owner. Validate host-supplied policy structurally without comparing its resolved paths with controller placeholders.
- [x] Add Rust typed validation, collision preflight, thread/turn permission selection, and merged instruction config. Preserve legacy start/resume behavior when the optional field is absent.
- [x] Reduce `config/read` responses to set-key names without recording raw successful/error/malformed frames; reject inherited-key conflicts using value-free diagnostics and sentinel privacy assertions.
- [x] Extend the existing authenticated runtime rebind boundary for the paired policy; do not alter protected durable provider fields or replay uncertain work.
- [x] Replace generic argv-bound errors with index/key/UTF-8-size/limit diagnostics and verify no argument value is disclosed.
- [x] Run focused native/provider-backend and preparation/recovery suites.

### Task 3: Direct TypeScript driver

**Files:** Modify `src/drivers/codex/codex-app-server-driver-impl.ts`, `codex-harness-session.ts`, `codex-driver-types.ts`, `codex-driver-values.ts`, `app-server-transport.ts`, `src/contracts/codex.ts`, `src/contracts/harness-driver.ts`, `src/contracts/native-session-backend.ts`, and `src/backends/harness-driver-backend.ts`; use their existing lifecycle/context-control/recovery/backend/transport suites and support. Contract changes are only the Codex-specific frozen-context and identity variant; other providers retain their current behavior.

**Interfaces:** The direct process path consumes Task 1's `{ args, launchPolicy }`; `FrozenCodexLaunchContext` is stored by the real snapshot path and forwarded by the actual backend. Actual startup/resume runs both preflights. Opened sandbox context carries generated profile IDs used by `turn/start`; factory/native transports retain logical mode inputs.

- [x] Add failing tests covering actual process-path start/resume config, snapshot→backend→restore roundtrip, changed current environment/network/skill paths, conflicting inherited set keys, cancellation, missing legacy context, corrupt identity/context, and unchanged factory/native mode selection.
- [x] Exercise default and plan through real `session.startTurn` → `turn/start`, asserting the generated profile ID and preserved external-sandbox behavior. Cover reopened session turns as well as initial thread requests.
- [x] Wire the common projection into startup/resume, frozen snapshot storage/restoration, required-profile validation, and existing identity equality. Preserve skills/instruction switches from the frozen context.
- [x] Run the affected split driver suites; do not recreate the retired monolithic driver test.

### Task 4: Fixed-CLI boundary and handoff

**Files:** Add an opt-in fixed-CLI owner qualification test/helper under `packages/paperclip-runner`; update this plan and the nearest existing Runner behavior documentation.

- [x] Exercise the real `0.160.0` boundary with synthetic 20-skill roots: separate namespaces, static/dynamic name collisions, inherited profiles, network false/true, default/plan/external selection, secret-free shell projection, and thread resume. Use no paid/model turn or live product data.
- [x] Verify both the previously measured outside-allowlist filtering and the allowed inheritance-only key shadow counterexample through controlled synthetic dependencies; conflict checks must reject the latter before thread admission. Assert config/read values never appear in output/trace/state.
- [x] Run pinned old/new runner/controller compatibility cases with disposable checkpoints, including exact recovery and warm rotation; malformed or unsupported structured policy never falls back to legacy configuration.
- [ ] Parent final gate: refresh complete repository TypeScript/tests/build after the frozen final source. Package build/typechecks passed before the last scoped permission/warm fixes; current-source tsc, native policy tests, artifact qualifications, and targeted owners pass. Preserve the earlier failures and their disposition.
- [x] Review final diff and document check results, limitations, and the parent's separate three-host live acceptance obligation. Do not claim live fleet recovery from fixture path variants or fake servers.

## Verification Commands

Run focused red/green commands first from the package directory using its installed dependencies:

```sh
pnpm exec vitest run src/drivers/codex/codex-launch-policy.test.ts src/drivers/codex/codex-security-config.test.ts src/live/runner-provider-launch.test.ts src/live/runner-launch-preparation.test.ts src/live/runner-launch-preparation-store.test.ts
cargo test --manifest-path runner/Cargo.toml --locked -p paperclip-runner-core --test codex_provider
cargo test --manifest-path runner/Cargo.toml --locked -p paperclip-runner-core codex_launch_policy
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run docs:validate
```

Add focused driver/native recovery files to the targeted command as their changes land. Repo-wide server/UI gates and real three-host deployment acceptance remain the parent's handoff scope; report any uncovered integration risk explicitly.

## Rollback and Acceptance Boundary

This is not a live-state migration. The changed existing driver discriminant makes old runners reject new descriptors; direct versioned lookup tokens make old owners fail at their first provider lookup, before resume, while tagged identity supplies an additional check. Acceptance requires actual old-artifact negative tests and no replacement-thread fallback. Rollback leaves new-policy checkpoints visibly unavailable. Stop/drain structured-policy runs and retain their checkpoints; resume only with compatible artifacts, or explicitly start a fresh authorized run after stop proof. Historical native descriptors keep legacy argv; historical direct snapshots without frozen policy require a fresh session. No code rewrites saved commands, restarts DEL-43, changes the live fleet, or modifies user credentials/configuration.


## Implementation evidence (2026-10-27)

- The new policy is a closed TS/Rust type with UTF-8 sorted entry arrays, budgets, exact JSON scalar validation, unknown-field rejection, and a shared Unicode canonical-byte/digest fixture. Historical generic checkpoint/command hashes are unchanged.
- Native `run.prepare`, thread start/resume/turn, settled paired rebind, protected-profile tampering rejection, and public logical driver projection are covered by owner tests. The policy used in the native wire matrix contains all 20 synthetic long skill roots and exceeds the old single-argument limit.
- The actual installed baseline runner rejects the new driver before Codex spawn. The actual old controller/runtime/backend rejects the versioned lookup during `thread/read`, with active historical work, and calls neither resume/start/turn nor replacement/openRun. Qualification also tests rejection of that token against real CLI 0.160.0.
- The direct process tests freeze home mode/cwd/flags, preserve default/plan mode through actual turns and recovery, reject absent/corrupt context and changed environment/path/cwd before admission, and reject a provider-reported cwd mismatch before resume. Separate tests abort each new preflight and prove child reaping/no thread admission.
- Native private-config tests inject successful/error/malformed config responses and synthetic secret stderr under a real trace sidecar; diagnostics and trace must exclude the sentinel. TS transport tests also cover delayed stderr.
- A real runnerd warm attach consumes the shared Unicode fixture through the existing command receipt. Cold recovery after rotation asserts the new run's replay contains no identity event. An adopted live runner test compacts identity events and requires confirmation through authenticated `session.snapshot`.
- Real CLI qualification uses isolated temporary homes, a synthetic loopback provider, outer network denial, 20 long skill roots, profile collision+extends, allowed inherited-key shadow rejection, both direct/native request shapes, generated process flags, default/plan/external modes, network decisions, and a real rollout/resume. Only synthetic `printf` creates the rollout; no model request occurs. Probe-only `project_doc_max_bytes=0` is not a product default.
- Initial broad owner regression found obsolete argv assertions and an external-authority propagation mismatch in read-only probes; these are corrected in implementation/tests. One existing adoption test timed out in the broad concurrent run and passed the isolated targeted rerun. Final command counts and remaining limits are reported in the handoff, not inferred from this checklist.

Three-host path fixtures prove transport independence, not deployed local/SSH/container execution. The parent owns compatible artifact rollout and actual three-host acceptance; the live fleet remains paused and DEL-43 is not restarted by this change.

- Final permission-window correction: real CLI qualification showed legacy `sandbox: danger-full-access` can replace a generated external profile's network=false semantics before a turn. New structured native threads now always send named `permissions`; the active profile ID must be present and exact in both owners. New external turns use policy.networkAccess; legacy external requests and their enabled network value are unchanged. The real CLI matrix covers the actual new native process flags and named-profile shapes.

- Warm-policy recovery regression: a real runner emitted new-policy `session.resumed` before its `run.attach` completion was consumed. The retained RED was `changed warm: native_adopted_provider_identity_mismatch`. The transition now accepts exactly old/candidate digests only under an already-confirmed old checkpoint, complete startup, one active attachment, no pending recovery-completion gate, and unchanged real thread/account IDs. The candidate hashes the same native context schema as Rust. Receipt completion retires the old expectation; a fresh authenticated snapshot must match the candidate before Harness freezes/publishes the next checkpoint. Failed dispatched changes close the transport. The actual fresh→warm→cold→changed network/root warm→snapshot→cold chain passes.

Opt-in artifact qualification from the Runner package directory (use immutable artifact paths selected on each host):

```sh
PAPERCLIP_QUALIFY_CODEX_CLI=/path/to/codex-0.160.0/bin/codex.js PAPERCLIP_QUALIFY_NODE=/path/to/node pnpm exec vitest run src/drivers/codex/codex-launch-policy.qualification.test.ts
PAPERCLIP_LEGACY_RUNNER_PACKAGE=/path/to/old/paperclip-runner PAPERCLIP_LEGACY_RUNNER_BINARY=/path/to/old/paperclip-runnerd pnpm exec vitest run src/drivers/codex/codex-launch-policy.compatibility.test.ts src/live/runner-prepared-launch-workspace.test.ts
```

The helper checks CLI `--version`, denies network through macOS `sandbox-exec` or Linux `unshare --user --map-root-user --net`, and fails on hosts lacking that isolation capability. It does not silently run without the outer network boundary. Qualification uses synthetic skill roots; deployed assigned-skill materialization and execution remain the parent's real host acceptance.


## Final owner handoff

Independent implementation review passed on 2026-10-27 with no remaining blocking finding. Final directly affected owner run: 7 files / 76 tests passed, including both opt-in artifact qualifications. Transport targeted rerun: 14 passed (273 deliberately excluded by the name filter). The broad owner run before the last scoped fixes had 695 passed / 3 failed: the three failures were the old realCLI sandbox expectation and two incorrectly updated legacy argv assertions, all corrected and re-run successfully. An earlier broad run had 677 passed / 11 failed; obsolete argv expectations and explicit external-authority propagation were corrected, and the one adoption timeout passed its isolated rerun.

Native owner run: Unicode policy fixture 1 passed; Codex provider 99 passed / 3 ignored subprocess helpers (the parent tests execute those helpers explicitly). Final scoped native permission/attestation/rebind tests: 3 passed after named-profile admission and frozen external network correction. OpenCode external-flag routing owner unit: 1 passed. The native code built and checked successfully; four pre-existing unused/dead-code warnings remain. Package build, TypeScript/Rust typechecks, and documentation links passed; the parent's final complete repository gate refreshes the last scoped fixes. Current-source `tsc --noEmit` and `git diff --check` pass.

Private local raw evidence stays under `.superpowers/sdd/2026-10-27-codex-launch-policy-transport/` and is not a published product artifact. Key logs: `focused-final.log`, `transport-final-targeted.log`, `changed-policy-final.log`, `fixed-cli-final.log`, `native-owner-final.log`, `native-policy-final.log`, `native-opencode-final.log`, `build-final.log`, and `typecheck-rust.log`. Logs contain synthetic fixtures only. Generated `.vitest` caches are excluded from the patch.

The parent requested a frozen-source broad owner rerun after the final fixes:
30 files / 699 tests passed, with zero failed, skipped or todo, exit code 0.
It uses the 24 Codex driver files and six adjacent owner suites. The historical
30-file command text was not retained, so the restored file list and exact new
argv are recorded separately; the current collection contains one additional
test. Pinned real-CLI and actual r8 artifact qualifications were enabled. Owner
inputs and existing debug/fake/distribution binary hashes were unchanged during
the run; only private temporary fixture compilation was permitted.

No commit, push, deployment, live configuration mutation, or DEL-43 restart was performed by this owner. Linux/macOS real host release qualification and deployment remain parent-owned. The fixed-CLI helper's Linux network-namespace prerequisite is an explicit qualification limitation, not proof of three-host execution.
