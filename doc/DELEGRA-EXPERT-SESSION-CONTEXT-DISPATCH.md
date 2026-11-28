# Delegra Stage B3 Design: Expert Agent Session Persistence, Context Construction, and Dispatch Worker

- **Tracking Issue**: `hrygo/Delegra#101`
- **Prerequisite Foundation**: `hrygo/Delegra#100` (Stage B2: `#96`, `#97`, `#98`, `#99`), `hrygo/heluo-forge#484` (DSH Stage C4)
- **Contract Reference**: `CORP-DSH-EXPERT-001` (§5–§8), `CORP-DSH-DESIGN-023` (§3.6, §5.1)
- **Status**: Revised Design (RFC v2 — Audit-Hardened)

---

## 1. Problem Statement & Scope

Stage B2 (`#100`) established the control-plane foundations for restricted employee expert tasks in Delegra:
- RFC 8693 employee token exchange (`POST /oauth/token-exchange`) and fail-closed credential verification (`server/src/services/employee-token-exchange.ts`).
- Single-transaction PostgreSQL persistence across four tables (`packages/db/src/schema/employee_expert_tasks.ts`, `server/src/services/employee-experts-store.ts`).
- Private ACL filtering on generic run listings, direct-by-ID lookups, and WebSocket broadcasts (`server/src/services/employee-expert-acl.ts`, `server/src/routes/agents.ts`, `server/src/realtime/live-events-ws.ts`).
- Per-task isolation descriptors (`buildIsolatedEmployeeTaskExecutionContext`), monotonic `runGeneration` fencing (`assertRunGenerationFence`), and fail-closed `reuseRefs` authorization (`resolveReadOnlyReuseRefs`) in `server/src/services/employee-expert-isolation.ts`.

Stage B3 closes the end-to-end runtime loop with three core components:
1. A durable **Dispatch Intent Worker** that claims and executes `employee_expert_dispatch_intents` (`initial`, `followup`, `cancel`) against Paperclip Runner with retry bounds, dead-letter convergence, and `cancel` short-circuiting.
2. A **Prefix-Cache-Friendly, Five-Layer Session Context Assembler** that bridges persisted task state, native runner sessions (`agent_task_sessions` / `native_runner_checkpoints`), and frozen authorized `reuseRefs` under dual token+character budgets.
3. Exact **hot-resume vs. deterministic cold-rebuild** semantics that preserve cross-session isolation (`shareAgentChatThread: false`) and satisfy PostgreSQL foreign-key invariants (`native_runner_checkpoints` via deterministic `native_issue_id` UUIDv5).

---

## 2. Three-Layer Session Persistence Architecture

Expert agent sessions separate **client correlation**, **control-plane task ledger**, and **runner execution state** into three persistence layers so sensitive payloads, tokens, and large transcripts never leak across trust boundaries.

| Layer | Owner & Storage | Persisted Fields | Authoritative Invariants |
| :--- | :--- | :--- | :--- |
| **Layer A: Client Correlation** | HeLuoForge / DSH (`forge_experts_requests.correlations` in `packages/forge-experts/src/dispatch.mjs`) | `requestId`, `instanceId`, `orgId`, `issuer`, `subject`, `originSessionRef`, `expertId`, `delegationScope`, `payloadDigest`, `taskId`, `status` | Never persists raw task text or bearer tokens. Written as `pending_delivery` *before* outbound RFC 8693 / HTTP delivery to enable `reconcileByRequest` after network timeouts or crashes. |
| **Layer B: Control-Plane Ledger** | Delegra PostgreSQL (`employee_expert_tasks`, `employee_expert_idempotency_receipts`, `employee_expert_dispatch_intents`, `employee_expert_auth_continuity`) | Private task metadata, `task_text`, `reuse_refs`, `run_id`, `run_generation`, `result_version`, structured `result`, `sources`, `artifacts`, idempotency receipts, durable dispatch intents (including frozen `reuseRefSnapshots` and `executionContext` on **both** `initial` and `followup`), and `auth_continuity_digest` | Written inside a single PostgreSQL transaction (`acceptTaskAtomically` / `createFollowupAtomically`). Always `visibility = 'private'` and `origin_client = 'dsh'`. |
| **Layer C: Execution Runtime** | Delegra Runner + Object Storage (`agent_task_sessions`, `native_runner_checkpoints`, `heartbeat_runs`, S3/local snapshots) | Harness session handle (`session_params_json`, keyed by `(company_id, agent_id, adapter_type, task_key)`), encrypted runner checkpoints `(run_id, part)` bound via deterministic `native_issue_id` UUIDv5, encrypted workspace snapshots, and immutable run log segments | Large transcripts, raw stdout, and workspace files stay outside PostgreSQL. `task_key` is strictly `emp_thread_<taskId>` — never shared with standing Agent Chat threads. |

### Key Binding & `native_runner_checkpoints` Compatibility

`native_runner_checkpoints.issue_id` is `NOT NULL` (`uuid`) and references `heartbeat_runs(company_id, native_issue_id, id)`. Meanwhile, `heartbeat_runs_scope_binding_check` allows `scope_kind = 'company' AND issue_id IS NULL`, and `live-events-ws.ts` relies on `issueId === null` to run `canActorReceivePrivateEmployeeExpertEvent` without adding queries to ordinary issue-scoped runs.

To satisfy **both** invariants without inserting synthetic rows into `issues`:
- Set `heartbeat_runs.scope_kind = 'company'` and `heartbeat_runs.issue_id = null`.
- Derive a deterministic **UUIDv5** from `("delegra:employee-expert-task", orgId, taskId)` and persist it in `heartbeat_runs.native_issue_id` (which has no foreign key to `issues`, only the composite unique constraint `(company_id, native_issue_id, id)`).
- Pass that same deterministic UUIDv5 as `native_runner_checkpoints.issue_id`.

```text
taskId                 = task_<16-hex>
nativeIssueId          = uuidv5("delegra:employee-expert-task", `${orgId}:${taskId}`)
runGeneration          = 1, 2, 3, ... (monotonic per followup)
agent_task_sessions:
  task_key             = emp_thread_<taskId>
execution workspace:
  workspaceId          = emp_ws_<taskId>
tool cache namespace:
  toolCacheNamespace   = emp_cache_<taskId>
Kubernetes SandboxClaim:
  sandboxClaimName     = emp-claim-<sanitizedTaskId>-g<runGeneration>
  neverReturnToPool    = true
  shareAgentChatThread = false
```

- **Across different tasks** (even same employee + same expert + concurrent DSH sessions): distinct `taskId` -> distinct `nativeIssueId`, `task_key`, `workspaceId`, `toolCacheNamespace`, and `sandboxClaimName`. Zero shared model context or filesystem state.
- **Across follow-ups on the same task**: same `taskId` -> same `nativeIssueId`, `task_key`, and `workspaceId`, while `runGeneration` increments and `sandboxClaimName` rotates to a fresh one-way claim (`-g2`, `-g3`, ...).

---

## 3. When & How Session Context Is Built (Trigger Matrix)

| Scenario | Trigger | Isolation & Auth Pre-checks | Context Strategy |
| :--- | :--- | :--- | :--- |
| **1. Initial Dispatch** | `employee_expert_dispatch_intents.kind = 'initial'` (`runGeneration = 1`) | `isIsolationVerified() === true`; frozen `reuseRefSnapshots` + `executionContext` persisted in intent `payload` at `createTask` | **Cold Start Build**: Assemble L1 (static prefix) -> L2 (initial goal) -> L3 (frozen `reuseRefs`) -> L4 (initial turn). Create fresh `agent_task_sessions` row on `task_key = emp_thread_<taskId>`. |
| **2. Same-Task Follow-up** | `kind = 'followup'` (`runGeneration = N > 1`) | Re-verify employee callable permission + `acceptingTasks === 'accepting'` + `delegationScope` + `reuseRefs` read ACL in `createFollowup`; **persist frozen `reuseRefSnapshots` + rotated `executionContext` in `createFollowupAtomically`** while the employee bearer token is live | **Hot Resume Preferred**: If `agent_task_sessions` has a live `session_params_json` for `emp_thread_<taskId>` and the harness supports resume, resume natively and **skip L1/L2**, appending only new L3 (`reuseRefSnapshots`) + L4 (follow-up turn). Otherwise fall back to **Deterministic Cold Rebuild**. |
| **3. Explicit Cross-Task Reuse** | Caller passes `reuseRefs: string[]` on `createTask` or `createFollowup` | `resolveReadOnlyReuseRefs` validates every ref against the employee's current read ACL; any unauthorized ref fails closed with `403 EXPERT_CALL_FORBIDDEN` | Persist frozen `ReadOnlyReuseRefSnapshot[]` (`readOnly: true`, `sourceAttribution`) inside the intent `payload` and inject into Layer 3 as untrusted read-only reference data. Never implicitly inherit unreferenced chats. |
| **4. Crash Recovery / Cold Rebuild** | Runner crash, sandbox expiry, controller restart, model/harness switch, or missing/expired `agent_task_sessions` | Verify `runGeneration` matches latest `employee_expert_tasks.run_generation` and `!cancelRequested` | First attempt native re-adoption via `native_runner_checkpoints` (keyed by deterministic `native_issue_id`) + workspace snapshot. If harness session is unrecoverable, execute **Deterministic Cold Rebuild** (L1 -> Structured L2 Compaction -> L3 -> L4). |
| **5. Cancellation / Retry Exhausted** | `kind = 'cancel'` (`cancelRequested = true`) or `attemptCount >= maxAttempts` | Owner-only ACL verified on `/cancel`; terminal error classifier separates transient vs. permanent errors | **Short-Circuit**: Bypass session resume completely; stop active `heartbeat_runs`, revoke zero-trust gateway proxy lease, and converge `employee_expert_tasks` to terminal `cancelled` or `failed` via `publishTaskResultAsync`. |

---

## 4. Five-Layer Session Context Construction Pipeline

Context is assembled in strict trust and cache-stability order — keeping the immutable Prefix Cache at the top, structured state compaction in the middle, untrusted read-only data isolated in Layer 3, active turn instructions at the bottom, and reverse-projected results isolated from the DSH main assistant.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 1 · Static Prefix Cache (Immutable · Zero Dynamic Fields)      │
│   - Expert persona, capabilities, instruction files, tool schemas    │
│   - Stable delegationScope policy, shareAgentChatThread=false        │
│   - NO timestamps, NO runGeneration, NO per-run lease IDs            │
│   [Cold Start & Cold Rebuild only; SKIPPED on Hot Resume]            │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 2 · Structured Task State Compaction (Control-Plane Ground)    │
│   - taskId, runGeneration, initial objective                         │
│   - Structured Compaction Schema: confirmedFacts, openQuestions,     │
│     artifactManifest, failedAttempts (never raw stdout logs)         │
│   [Cold Start: objective only; Cold Rebuild: full schema;            │
│    SKIPPED on Hot Resume]                                            │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 3 · Authorized Read-Only Reference Block (Untrusted Data)      │
│   - Frozen ReadOnlyReuseRefSnapshot[] from intent.payload            │
│   - Dual token + char budget; explicit sourceAttribution +           │
│     non-instruction quoted-data framing                              │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 4 · Current Turn Incremental Input (Active Turn · Never Cut)   │
│   - Latest employee_expert_dispatch_intents.payload.taskText         │
│   - Turn-specific reuseRefs index & output schema contract           │
│   - Reserved outputReserveTokens + toolCallHeadroom                  │
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

### 4.1 Prompt Prefix Caching Invariant

- **Layer 1 MUST be byte-stable across turns and tasks for the same `(orgId, expertId, delegationScope)`**: never embed `taskId`, `runGeneration`, `acceptedAt`, or per-run gateway lease tokens in Layer 1 so provider-side Prompt Prefix Caching (Anthropic / OpenAI / DeepSeek) hits reliably.
- **Hot Resume (`hot_resume`) MUST NOT re-inject Layer 1 or Layer 2**: it appends only the new turn's Layer 3 (if new `reuseRefs` were supplied) and Layer 4 to the resumed harness thread.

### 4.2 Structured Compaction Schema (Layer 2)

To avoid lossy free-text drift across repeated cold rebuilds, Layer 2 renders a bounded structured state object:

```ts
export interface CompactedExpertTaskState {
  taskId: string;
  runGeneration: number;
  objective: string;
  confirmedFacts: string[];
  openQuestions: string[];
  artifactManifest: Array<{ id: string; label?: string; url?: string }>;
  failedAttempts: Array<{ generation: number; reason: string }>;
  recentTurnSummaries: Array<{ generation: number; summary: string }>;
}
```

### 4.3 Dual Token + Character Budget & Truncation Order

Because CJK text and JSON/code have higher token-per-character density than English prose, the assembler enforces **both** a conservative token estimator (`estimateTokens`) and hard character caps while always reserving `outputReserveTokens` (e.g. 4,096) and `toolCallHeadroom` (e.g. 4,096) inside the model's context window:

1. **Never truncate**: Layer 1 (Static Prefix) and Layer 4 (Current Turn Input, already capped at `MAX_TASK_TEXT_CHARS = 32_000` at ingress).
2. **Compact first (Layer 2)**:
   - Keep `objective` (capped at 4,000 chars), `artifactManifest`, and `openQuestions`.
   - Trim older `recentTurnSummaries` (keep latest 5) and `failedAttempts` (keep latest 3) if over budget.
   - Never inline raw tool stdout/stderr logs; expose workspace file paths instead.
3. **Bound second (Layer 3)**:
   - Enforce per-ref and total caps across `reuseRefSnapshots` (default `maxReuseRefTokensEach = 4_000` / `16 KiB`, `maxReuseRefsTotalTokens = 16_000` / `64 KiB`).
   - Truncate deterministically with an explicit `[truncated: N chars omitted]` marker while preserving `refId` and `sourceAttribution`.

### 4.4 Untrusted-Data Framing for `reuseRefs`

Every Layer 3 item is rendered inside a clearly delimited quoted-data block (`readOnly: true`, `sourceAttribution`) instructing the model to treat its contents strictly as reference data, never as system instructions or permission overrides.

---

## 5. Dispatch Intent Worker Design

### 5.1 Proposed Module Layout

- `server/src/services/employee-expert-context-assembler.ts`
  - Pure context assembly (`assembleExpertSessionContext`), prefix-cache-safe L1/L2 separation, structured compaction formatter, dual token+char budget enforcer, and `cold_start` / `hot_resume` / `cold_rebuild` mode selector.
- `server/src/services/employee-expert-dispatch-worker.ts`
  - Background worker loop integrated into `server/src/app.ts` host service lifecycle and `shutdown.ts` graceful drain.
- `server/src/services/employee-experts-store.ts` & `server/src/services/employee-experts.ts` (extensions)
  - Persist frozen `reuseRefSnapshots` + rotated `executionContext` in `createFollowupAtomically` (closing the follow-up snapshot gap).
  - Atomic intent leasing (`claimNextDispatchIntents`), bounded retry with exponential backoff (`maxAttempts = 3`), dead-letter terminal failure convergence, and `markTaskRunning`.

### 5.2 Intent Claiming, Retry Backoff & Short-Circuit State Machine

```text
employee_expert_dispatch_intents.status:
  pending ──(claim: FOR UPDATE SKIP LOCKED)──▶ claimed (attemptCount += 1)
  claimed ──(cancel intent)──────────────────▶ short-circuit stop + revoke lease ─▶ completed
  claimed ──(heartbeat_run created)──────────▶ dispatched
  dispatched ──(publishTaskResultAsync ok)───▶ completed
  claimed/dispatched ──(transient err & attempt < 3)──▶ pending (backoff nextAttemptAt)
  claimed/dispatched ──(permanent err OR attempt >= 3)─▶ failed + task.status = 'failed'
```

1. **Atomic Claim with Backoff & Poison-Pill Guard**:
   - Query `employee_expert_dispatch_intents` where:
     - `status = 'pending'` AND `(payload->'_dispatchMeta'->>'nextAttemptAt' IS NULL OR (payload->'_dispatchMeta'->>'nextAttemptAt')::timestamptz <= now())`, OR
     - `status = 'claimed'` AND `claimed_at < now() - leaseTimeout`
   - Order by `created_at ASC` with `FOR UPDATE SKIP LOCKED` and bounded batch size (`limit = 10`).
   - Atomically increment `_dispatchMeta.attemptCount`, set `status = 'claimed'`, `claimed_at = now()`, `updated_at = now()`.
   - If `attemptCount > maxAttempts` (default `3`), immediately transition the intent to `failed` and call `publishTaskResultAsync(..., status: 'failed')` so the client is never stuck polling forever.
2. **Pre-Execution Short-Circuit (`cancel`, stale generation, isolation)**:
   - Load parent `employee_expert_tasks` row.
   - **`kind === 'cancel'`**: short-circuit before any session/context check — stop active `heartbeat_runs`, revoke zero-trust gateway proxy lease for `task.runId`, and publish terminal `cancelled` via `publishTaskResultAsync`.
   - **Stale generation** (`intent.runGeneration < task.runGeneration` or `task.cancelRequested === true`): mark intent `failed` (superseded) without starting a run.
   - **Isolation probe** (`!isIsolationVerified()`): fail closed (`EXPERT_ISOLATION_UNVERIFIED`) without launching an unisolated run.
3. **Private `heartbeat_runs` Creation Contract**:
   - Create `heartbeat_runs` row with:
     - `companyId = task.orgId`
     - `agentId = task.expertId`
     - `scopeKind = 'company'`, `issueId = null`
     - `nativeIssueId = deriveExpertNativeIssueUuidV5(task.orgId, task.taskId)` (satisfies `native_runner_checkpoints` FK without touching `issues`)
     - `contextSnapshot` containing `originClient: 'dsh'`, `visibility: 'private'`, `responsibleUserId: task.responsibleUserId`, `employeeExpertTaskId: task.taskId`, `runGeneration: intent.runGeneration`, `executionContext`, and assembled context metadata
   - Update `employee_expert_tasks.run_id = run.id`, `status = 'running'` (guarded by `WHERE run_generation = intent.runGeneration`) and mark intent `dispatched`.
4. **Result Publication & Generation Fencing**:
   - On run completion, `waiting_user`, or failure, invoke `publishTaskResultAsync({ taskId, runId, runGeneration, status, result, sources, artifacts })`.
   - Stale generations (`runGeneration < current`) throw `409 EXPERT_TASK_STATE_CONFLICT` and are discarded safely.

### 5.3 TypeScript Interface Sketch

```ts
export type ContextResolutionMode = "cold_start" | "hot_resume" | "cold_rebuild";

export interface ContextBudgetPolicy {
  modelContextWindowTokens: number;
  outputReserveTokens: number;
  toolCallHeadroomTokens: number;
  maxTaskAnchorTokens: number;
  maxReuseRefTokensEach: number;
  maxReuseRefsTotalTokens: number;
  maxReuseRefCharsEach: number;
  maxReuseRefsTotalChars: number;
}

export interface AssembledExpertSessionContext {
  mode: ContextResolutionMode;
  taskId: string;
  nativeIssueId: string; // deterministic UUIDv5 for native_runner_checkpoints
  runGeneration: number;
  taskKey: string; // emp_thread_<taskId>
  executionContext: IsolatedEmployeeTaskExecutionContext;
  resumeSessionParams: Record<string, unknown> | null;
  staticPrefixBlock: string | null; // null on hot_resume (Prefix Cache preserved)
  compactedState: CompactedExpertTaskState | null; // null on hot_resume
  reuseRefsBlock: string | null;
  currentTurnPrompt: string;
  estimatedInputTokens: number;
  truncatedRefs: string[];
}
```

---

## 6. Security & Isolation Invariants

1. **Zero Cross-Session Leakage**: `task_key` is strictly `emp_thread_<taskId>`. Standing Agent Chat sessions (`agent_conversations`) are never read or appended to by employee expert runs.
2. **Zero-Stub Private ACL**: Expert runs use `scopeKind = 'company'`, `issueId = null`, and `employee_expert_tasks.run_id = run.id`, so `/heartbeat-runs`, `/live-runs`, direct-by-ID `404`, and `live-events-ws.ts` strip them completely for unauthorized same-org colleagues and cross-org users while keeping `live-events-run-read` issue query counts unchanged.
3. **One-Way Sandboxes**: Each `runGeneration` binds a fresh `sandboxClaimName` (`neverReturnToPool: true`), aligned with Delegra's Kubernetes v1beta1 `SandboxClaim` one-way lifecycle.
4. **Fail-Closed `reuseRefs` Snapshot Freezing**: Every explicit reference is authorized against the employee's *current* read permissions during `createTask` / `createFollowup` and frozen into the intent `payload` before the short-lived RFC 8693 token expires.
5. **Zero-Credential Agent Environment**: Expert runs inherit Delegra's zero-trust gateway proxy lease model — no upstream API keys or employee IAM subject tokens are injected into the sandbox environment.

---

## 7. Phased Rollout & Verification Plan

| Phase | Deliverables | Verification |
| :--- | :--- | :--- |
| **Stage B3-1: Store Leasing, Follow-up Snapshot Freeze & Dispatch Worker** | Persist frozen `reuseRefSnapshots` + `executionContext` in `createFollowupAtomically`; add `claimNextDispatchIntents` (`FOR UPDATE SKIP LOCKED`, `maxAttempts = 3`, backoff, DLQ), deterministic `native_issue_id` UUIDv5, `cancel` short-circuit, and `employee-expert-dispatch-worker.ts` lifecycle wiring in `app.ts` | Unit + PG integration tests: concurrent worker claims (no double dispatch), poison-pill retry cap -> terminal `failed`, `followup` snapshot persistence, stale `runGeneration` rejection, and `cancel` lease revocation |
| **Stage B3-2: Prefix-Cache-Safe Context Assembler & Hot/Cold Resume** | Implement `employee-expert-context-assembler.ts` (static L1 prefix, structured L2 compaction, dual token+char budget, `reuseRefs` framing, `cold_start` / `hot_resume` / `cold_rebuild`) | Unit tests covering L1 byte stability (prefix cache), `hot_resume` skipping L1/L2, CJK/JSON token budget truncation markers, and prompt-injection isolation |
| **Stage B3-3: End-to-End Runner & DSH Integration** | Wire private `heartbeat_runs` (with `native_issue_id` UUIDv5) -> Paperclip Runner + `native_runner_checkpoints` -> `publishTaskResultAsync` -> DSH `forge_experts.get_result` | Cross-package E2E test: initial task -> `waiting_user` -> follow-up hot resume -> simulated session loss cold rebuild -> final attributed result envelope + 4-role ACL negative check |
