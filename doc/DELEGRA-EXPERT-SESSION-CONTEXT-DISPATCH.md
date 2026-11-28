# Delegra Stage B3 Design: Expert Agent Session Persistence, Context Construction, and Dispatch Worker

- **Tracking Issue**: `hrygo/Delegra#101`
- **Prerequisite Foundation**: `hrygo/Delegra#100` (Stage B2: `#96`, `#97`, `#98`, `#99`), `hrygo/heluo-forge#484` (DSH Stage C4)
- **Contract Reference**: `CORP-DSH-EXPERT-001` (§5–§8), `CORP-DSH-DESIGN-023` (§3.6, §5.1)
- **Status**: Proposed Design (RFC)

---

## 1. Problem Statement & Scope

Stage B2 (`#100`) established the control-plane foundations for restricted employee expert tasks in Delegra:
- RFC 8693 employee token exchange (`POST /oauth/token-exchange`) and fail-closed credential verification (`server/src/services/employee-token-exchange.ts`).
- Single-transaction PostgreSQL persistence across four tables (`packages/db/src/schema/employee_expert_tasks.ts`, `server/src/services/employee-experts-store.ts`).
- Private ACL filtering on generic run listings, direct-by-ID lookups, and WebSocket broadcasts (`server/src/services/employee-expert-acl.ts`, `server/src/routes/agents.ts`, `server/src/realtime/live-events-ws.ts`).
- Per-task isolation descriptors (`buildIsolatedEmployeeTaskExecutionContext`), monotonic `runGeneration` fencing (`assertRunGenerationFence`), and fail-closed `reuseRefs` authorization (`resolveReadOnlyReuseRefs`) in `server/src/services/employee-expert-isolation.ts`.

What remains to close the end-to-end runtime loop (Stage B3) is:
1. A durable **Dispatch Intent Worker** that claims and executes `employee_expert_dispatch_intents` (`initial`, `followup`, `cancel`) against Paperclip Runner.
2. A deterministic **Session Context Assembler** that bridges persisted task state, native runner sessions (`agent_task_sessions` / `native_runner_checkpoints`), and authorized read-only `reuseRefs` into a bounded, injection-resistant prompt/context payload for the expert agent.
3. Clear **hot-resume vs. cold-rebuild** semantics so multi-turn follow-ups and crash recoveries remain reliable without violating cross-session isolation (`shareAgentChatThread: false`).

---

## 2. Three-Layer Session Persistence Architecture

Expert agent sessions intentionally separate **client correlation**, **control-plane task ledger**, and **runner execution state** into three persistence layers so sensitive payloads, tokens, and large transcripts never leak across trust boundaries.

| Layer | Owner & Storage | Persisted Fields | Authoritative Invariants |
| :--- | :--- | :--- | :--- |
| **Layer A: Client Correlation** | HeLuoForge / DSH (`forge_experts_requests.correlations` in `packages/forge-experts/src/dispatch.mjs`) | `requestId`, `instanceId`, `orgId`, `issuer`, `subject`, `originSessionRef`, `expertId`, `delegationScope`, `payloadDigest`, `taskId`, `status` | Never persists raw task text or bearer tokens. Written as `pending_delivery` *before* outbound HTTP delivery to enable `reconcileByRequest` after network timeouts or crashes. |
| **Layer B: Control-Plane Ledger** | Delegra PostgreSQL (`employee_expert_tasks`, `employee_expert_idempotency_receipts`, `employee_expert_dispatch_intents`, `employee_expert_auth_continuity`) | Private task metadata, `task_text`, `reuse_refs`, `run_id`, `run_generation`, `result_version`, structured `result`, `sources`, `artifacts`, idempotency receipts, durable dispatch intents, and `auth_continuity_digest` | Written inside a single PostgreSQL transaction (`acceptTaskAtomically` / `createFollowupAtomically`). Always `visibility = 'private'` and `origin_client = 'dsh'`. |
| **Layer C: Execution Runtime** | Delegra Runner + Object Storage (`agent_task_sessions`, `native_runner_checkpoints`, `heartbeat_runs`, S3/local snapshots) | Harness session handle (`session_params_json`, keyed by `(company_id, agent_id, adapter_type, task_key)`), encrypted runner checkpoints `(run_id, part)`, encrypted workspace snapshots, and immutable run log segments | Large transcripts, raw stdout, and workspace files stay outside PostgreSQL. `task_key` is strictly `emp_thread_<taskId>` — never shared with standing Agent Chat threads. |

### Key Binding Between Layer B and Layer C

When the Dispatch Worker executes a task, it binds all three identifiers deterministically via `buildIsolatedEmployeeTaskExecutionContext`:

```text
taskId                = task_<16-hex>
runGeneration         = 1, 2, 3, ... (monotonic per followup)
agent_task_sessions:
  task_key            = emp_thread_<taskId>
execution workspace:
  workspaceId         = emp_ws_<taskId>
tool cache namespace:
  toolCacheNamespace  = emp_cache_<taskId>
Kubernetes SandboxClaim:
  sandboxClaimName    = emp-claim-<sanitizedTaskId>-g<runGeneration>
  neverReturnToPool   = true
  shareAgentChatThread = false
```

- **Across different tasks** (even same employee + same expert + concurrent DSH sessions): distinct `taskId` -> distinct `task_key`, `workspaceId`, `toolCacheNamespace`, and `sandboxClaimName`. Zero shared model context or filesystem state.
- **Across follow-ups on the same task**: same `taskId` -> same `task_key` and `workspaceId`, while `runGeneration` increments and `sandboxClaimName` rotates to a fresh one-way claim (`-g2`, `-g3`, ...).

---

## 3. When & How Session Context Is Built (Trigger Matrix)

| Scenario | Trigger | Isolation & Auth Pre-checks | Context Strategy |
| :--- | :--- | :--- | :--- |
| **1. Initial Dispatch** | `employee_expert_dispatch_intents.kind = 'initial'` (`runGeneration = 1`) | `isIsolationVerified() === true`; `reuseRefs` already frozen or re-validated via `resolveReadOnlyReuseRefs` | **Cold Start Build**: Assemble Layers 1, 2 (initial goal only), 3 (frozen `reuseRefs`), and 4 (initial instruction). Create fresh `agent_task_sessions` row on `task_key = emp_thread_<taskId>`. |
| **2. Same-Task Follow-up** | `kind = 'followup'` (`runGeneration = N > 1`) | Re-verify employee callable permission + `acceptingTasks === 'accepting'` + `delegationScope` + `reuseRefs` read ACL before enqueue (`createFollowup`); fence older runs via `runGeneration` | **Hot Resume Preferred**: If `agent_task_sessions` has a live `session_params_json` for `emp_thread_<taskId>` and the harness supports resume, resume natively and inject only Layer 3 (new `reuseRefs`) + Layer 4 (follow-up turn). Otherwise fall back to **Deterministic Cold Rebuild**. |
| **3. Explicit Cross-Task Reuse** | Caller passes `reuseRefs: string[]` on `createTask` or `createFollowup` | `resolveReadOnlyReuseRefs` validates every ref against the employee's current read ACL; any unauthorized ref fails closed with `403 EXPERT_CALL_FORBIDDEN` | Inject frozen `ReadOnlyReuseRefSnapshot[]` (`readOnly: true`, `sourceAttribution`) into Layer 3 as untrusted read-only reference data. Never implicitly inherit unreferenced chats. |
| **4. Crash Recovery / Cold Rebuild** | Runner crash, sandbox expiry, controller restart, model/harness switch, or missing `agent_task_sessions` | Verify `runGeneration` matches latest `employee_expert_tasks.run_generation` and `!cancelRequested` | First attempt native re-adoption via `native_runner_checkpoints` + workspace snapshot. If harness session is unrecoverable, execute **Deterministic Cold Rebuild** from `employee_expert_tasks` + completed intents + latest `result` summary. |
| **5. Cancellation** | `kind = 'cancel'` (`cancelRequested = true`) | Owner-only ACL verified on `/cancel` | Signal active `heartbeat_runs` cancellation + gateway proxy lease revocation; do not run another turn; transition task to `cancelled` via `publishTaskResultAsync` once run stops. |

---

## 4. Five-Layer Session Context Construction Pipeline

Context is assembled in strict trust order — from immutable system/policy rules down to untrusted reference data and current user turn input — and projected back to the main assistant through a fail-closed synthesis envelope.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 1 · Expert Identity & Security Policy (Trusted / Immutable)    │
│   - Agent persona, capabilities, instruction files, toolScope        │
│   - delegationScope (org:<id> | project:<id>), private visibility    │
│   - Zero-trust gateway lease constraints, shareAgentChatThread=false │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 2 · Task Anchor & Compacted State (Control-Plane Ground Truth) │
│   - taskId, runGeneration, initial taskText                          │
│   - [Follow-up / Cold Rebuild only] Prior structured result summary  │
│     + compacted turn history + artifact manifest (no raw stdout)     │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 3 · Authorized Read-Only Reference Block (Untrusted Data)      │
│   - Frozen ReadOnlyReuseRefSnapshot[] from resolveReadOnlyReuseRefs  │
│   - Explicit sourceAttribution + data-only non-instruction framing   │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 4 · Current Turn Incremental Input (Active Turn)               │
│   - Latest employee_expert_dispatch_intents.payload.taskText         │
│   - Turn-specific reuseRefs index & expected output structure        │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  (Runner Execution + runGeneration Fence)
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 5 · Reverse Projection to DSH Main Assistant (Synthesis Guard) │
│   - projectExpertResultEnvelope (HeLuoForge tool.mjs)                │
│   - rawResultCollapsed: true, synthesizedByMainAssistant: false      │
│   - Fail-closed sources/artifacts filter (authorized === true only)  │
│   - Read-only waitingUserNotice on waiting_user                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.1 Token Budget & Truncation Policy

To keep long multi-turn expert tasks predictable and prevent context overflow during cold rebuilds:

1. **Never truncate**: Layer 1 (System/Policy) and Layer 4 (Current Turn Input, already bounded by `MAX_TASK_TEXT_CHARS = 32_000` at ingress).
2. **Compact first (Layer 2)**:
   - Retain initial `taskText` verbatim (or bounded to 4,000 chars if huge).
   - Keep only the latest `result` structured summary and an ordered manifest of `artifacts` (`id`, `label`, `url`) and prior completed turn summaries (capped at e.g. last 5 turns).
   - Never inline full raw tool stdout/stderr logs from earlier runs; store them in workspace/object storage and expose file paths if needed.
3. **Bound second (Layer 3)**:
   - Enforce a per-ref and total character budget across `reuseRefSnapshots` (e.g. 16 KiB per ref, 64 KiB total).
   - If a snapshot exceeds its slice, truncate deterministically with an explicit `[truncated: N chars omitted]` marker while preserving `refId` and `sourceAttribution`.

### 4.2 Untrusted-Data Framing for `reuseRefs`

Every Layer 3 item is rendered inside a clearly delimited block with explicit non-instruction framing:
- Identifies `refId`, `sourceAttribution`, and `readOnly: true`.
- Instructs the model to treat the block strictly as quoted reference material, never as policy overrides or tool authorization grants.

---

## 5. Dispatch Intent Worker Design

### 5.1 Proposed Module Layout

- `server/src/services/employee-expert-context-assembler.ts`
  - Pure + DB-backed context assembly (`assembleExpertSessionContext`), hot-resume eligibility check, deterministic cold-rebuild formatter, and token-budget enforcer.
- `server/src/services/employee-expert-dispatch-worker.ts`
  - Background worker loop (integrated into `server/src/app.ts` host service lifecycle and `shutdown.ts` graceful drain).
- `server/src/services/employee-experts-store.ts` (extensions)
  - Atomic intent leasing (`claimNextDispatchIntents`), lease heartbeat/reclaim, intent completion/failure transitions, and `markTaskRunning`.

### 5.2 Intent Claiming & Crash-Safe State Machine

```text
employee_expert_dispatch_intents.status:
  pending ──(claim: FOR UPDATE SKIP LOCKED)──▶ claimed
  claimed ──(heartbeat_run created)──────────▶ dispatched
  dispatched ──(publishTaskResultAsync ok)───▶ completed
  claimed/dispatched ──(lease expired)───────▶ pending (reclaimed, idempotent)
  claimed/dispatched ──(terminal error)──────▶ failed
```

1. **Atomic Claim**:
   - Query `employee_expert_dispatch_intents` where `status = 'pending'` (or `status = 'claimed'` and `claimed_at < now() - leaseTimeout`) ordered by `created_at ASC` using `FOR UPDATE SKIP LOCKED` with a bounded batch size (e.g. `limit = 10`).
   - Atomically update `status = 'claimed'`, `claimed_at = now()`, `updated_at = now()`.
2. **Pre-Execution Fence & Isolation Check**:
   - Load the parent `employee_expert_tasks` row.
   - If `intent.runGeneration < task.runGeneration` (for `initial` or `followup`), immediately mark the stale intent `failed` (superseded) without starting a run.
   - If `task.cancelRequested === true` and `intent.kind !== 'cancel'`, skip execution and mark intent `completed` / `failed` cleanly.
   - Re-check `isIsolationVerified()`; if `false`, release claim or fail with `EXPERT_ISOLATION_UNVERIFIED` without starting an unisolated run.
3. **Private `heartbeat_runs` Creation Contract**:
   - Create a `heartbeat_runs` row with:
     - `companyId = task.orgId`
     - `agentId = task.expertId`
     - `scopeKind = 'company'`, `issueId = null` (ensuring `live-events-ws.ts` enforces `canActorReceivePrivateEmployeeExpertEvent` without affecting issue-scoped query budgets)
     - `contextSnapshot` containing:
       - `originClient: 'dsh'`
       - `visibility: 'private'`
       - `responsibleUserId: task.responsibleUserId`
       - `employeeExpertTaskId: task.taskId`
       - `runGeneration: intent.runGeneration`
       - `executionContext` (`threadId`, `workspaceId`, `toolCacheNamespace`, `sandboxClaimName`, `neverReturnToPool: true`, `shareAgentChatThread: false`)
   - Update `employee_expert_tasks.run_id = run.id`, `status = 'running'` (only where `run_generation = intent.runGeneration`) and mark intent `dispatched`.
4. **Result Publication & Generation Fencing**:
   - On run completion, waiting-for-user pause, or failure, invoke `publishTaskResultAsync({ taskId, runId, runGeneration, status, result, sources, artifacts })`.
   - `publishTaskResultAsync` enforces `WHERE task_id = $1 AND run_generation <= $2` inside a transaction; stale generations throw `409 EXPERT_TASK_STATE_CONFLICT` and are discarded safely.
   - Only `sources` and `artifacts` authorized for the initiating employee are persisted/projected; DSH's `projectExpertResultEnvelope` enforces `authorized === true` fail-closed on readback.
5. **Cancellation Handling (`kind = 'cancel'`)**:
   - If `task.runId` is active, request native run stop and trigger zero-trust gateway proxy revocation for that run.
   - Once the run terminates (or if no run has started yet), publish terminal status `cancelled` via `publishTaskResultAsync` (preserving `externalActionsNotReverted: true` semantics at the tool layer).

### 5.3 TypeScript Interface Sketch

```ts
export type ContextResolutionMode = "cold_start" | "hot_resume" | "cold_rebuild";

export interface AssembledExpertSessionContext {
  mode: ContextResolutionMode;
  taskId: string;
  runGeneration: number;
  taskKey: string; // emp_thread_<taskId>
  executionContext: IsolatedEmployeeTaskExecutionContext;
  resumeSessionParams: Record<string, unknown> | null;
  systemPolicyBlock: string;
  taskAnchorBlock: string;
  reuseRefsBlock: string | null;
  currentTurnPrompt: string;
  truncatedRefs: string[];
}

export interface ExpertSessionContextAssembler {
  assemble(input: {
    task: EmployeeExpertTaskRecord;
    intent: DispatchIntentRecord;
    priorIntents: readonly DispatchIntentRecord[];
    existingTaskSession: {
      sessionParamsJson: Record<string, unknown> | null;
      lastRunId: string | null;
    } | null;
    reuseRefSnapshots: readonly ReadOnlyReuseRefSnapshot[];
    budget?: {
      maxTaskAnchorChars?: number;
      maxReuseRefCharsEach?: number;
      maxReuseRefsTotalChars?: number;
    };
  }): AssembledExpertSessionContext;
}
```

---

## 6. Security & Isolation Invariants

1. **Zero Cross-Session Leakage**: `task_key` is strictly `emp_thread_<taskId>`. Standing Agent Chat sessions (`agent_conversations`) are never read or appended to by employee expert runs.
2. **Zero-Stub Private ACL**: Because expert runs use `scopeKind: 'company'`, `issueId: null`, and `employee_expert_tasks.run_id = run.id`, all generic endpoints (`/heartbeat-runs`, `/live-runs`, direct-by-ID `404`, and `live-events-ws.ts`) strip them completely for unauthorized same-org colleagues and cross-org users.
3. **One-Way Sandboxes**: Each `runGeneration` binds a fresh `sandboxClaimName` (`neverReturnToPool: true`), aligned with Delegra's Kubernetes v1beta1 `SandboxClaim` one-way lifecycle.
4. **Fail-Closed `reuseRefs`**: Every explicit reference is authorized against the employee's *current* read permissions before injection; revocation between turns blocks reuse on subsequent follow-ups.
5. **Zero-Credential Agent Environment**: Expert runs inherit Delegra's zero-trust gateway proxy lease model — no upstream API keys or employee IAM subject tokens are injected into the sandbox environment.

---

## 7. Phased Rollout & Verification Plan

| Phase | Deliverables | Verification |
| :--- | :--- | :--- |
| **Stage B3-1: Store Leasing & Dispatch Worker** | Add `claimNextDispatchIntents` (`FOR UPDATE SKIP LOCKED`), lease reclaim, `initial`/`followup`/`cancel` dispatch loop, and `app.ts` lifecycle wiring | Unit + PG integration tests: concurrent worker claims (no double dispatch), crash-reclaim idempotency, stale `runGeneration` rejection, and `cancel` propagation |
| **Stage B3-2: Context Assembler & Hot/Cold Resume** | Implement `employee-expert-context-assembler.ts` (5-layer builder, token-budget truncation, `reuseRefs` framing, hot-resume vs. cold-rebuild switch) | Unit tests covering all 3 modes (`cold_start`, `hot_resume`, `cold_rebuild`), budget truncation markers, and prompt-injection isolation framing |
| **Stage B3-3: End-to-End Runner & DSH Integration** | Wire `heartbeat_runs` -> Paperclip Runner execution -> `publishTaskResultAsync` callback -> DSH `forge_experts.get_result` verification | Cross-package E2E test: initial task -> `waiting_user` -> follow-up hot resume -> simulated session loss cold rebuild -> final attributed result envelope + 4-role ACL negative check |
