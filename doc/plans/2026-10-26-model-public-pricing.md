# Provider/model reference pricing implementation plan

**Goal:** Let company operators configure public token rates and see the reference value of recorded usage, including subscription/gateway usage, without presenting it as an invoice.

**Architecture:** A company-scoped `model_reference_rates` table stores an exact provider/model key, decimal USD per million input/cached/output tokens, optional cache-write reference price, source URL/date, notes and an optimistic revision. A separate read-only report applies current rates to the existing normalized cost ledger. Existing charges, immutable receipts, subscription fees and budget enforcement remain authoritative and unchanged.

**Tech stack:** Existing TypeScript, Zod, Drizzle/PostgreSQL, Express, React Query and shared UI components; no new dependency.

**Spec:** User request and accepted choice: “按 token 公价估算用量成本，并补齐配置能力”.

## Constraints and decisions

- Exact provider/model matching only. Protocol providers identify the stored ledger key, not necessarily the upstream vendor. Never infer upstream identity from an executor name.
- Rates are USD per 1M tokens, use decimal strings and integer arithmetic. Input in the ledger excludes cached reads. Cache writes are not independently available in this ledger; show that limitation and the optional write price as reference only.
- Estimate all recorded agent usage in the selected date range using the currently saved reference price; clearly label this scenario calculation, including historical ranges. Never rewrite past charges.
- Null means unknown; explicit zero is accepted only as an operator-supplied rate. Missing cached price with cached usage leaves that row incomplete, with a known subtotal.
- Board company cost-read permission controls reads. Writes additionally require connection-management permission and reject viewers/agents. Check company membership, validate values, audit changes atomically, reject stale revisions.
- UI lives in Audit → Costs → Providers, reuses tokens and components, preserves dates and displays source/date, unknown coverage, and save errors.
- Official presets: OpenAI GPT‑6.1 Sol 2 / .1 / 10; GPT‑6 Luna .1 / .01 / .5; OpenCode MiMo V2.6 Pro .435 / .003625 / .87; DeepSeek V4.1 Flash peak .30 / .006 / 1.20, off-peak .15 / .003 / .60. Fields here are input/cache-read/output. DeepSeek time-dependent rates must be selected and documented explicitly.
- Current local Sage has no established public hosted API rate: retain unknown pricing rather than fabricate electricity or hardware costs.
- Production changes must follow the existing PR/immutable-tag deployment workflow. Verify a disposable instance first; no paid model calls are necessary.

## Review focus

1. Cache read tokens must not be counted twice; mixed historical ledger formats use the existing normalization.
2. Unknown cached rates, huge decimals, negative/NaN/exponent values, explicit zero and stale writes.
3. Company isolation and denied cost readers, viewers, agents and non-managers.
4. Historical date windows and subscription records remain estimates without mutation of the ledger.
5. Unknown aliases stay visible/unpriced; public preset selection does not silently rename models.

## Tasks

- [x] Add shared schema, rate types and a pure reference-estimation function. First run behavioral tests covering exact values, fractional precision, cached splits, unknowns and invalid input.
- [x] Add the indexed company-scoped table and generate the additive migration with `pnpm db:generate`.
- [x] Add transaction-safe rate persistence and reporting service; exercise real PostgreSQL round trips, stale writes, company isolation and retained ledger values.
- [x] Add cost routes with existing read/configuration permission gates and route tests.
- [x] Add the provider-page editor/report, API client, public presets and component tests, then verify in a browser against the disposable instance.
- [ ] Add public source documentation and affected feature/access map entries, run token/map gates, targeted tests, typecheck, full tests and build. Review the complete diff and retain exact verification evidence.
- [ ] Prepare a reviewable change with current connection/model rate mappings; apply to the live instance only through its required deployment workflow.

## Verification evidence, 2026-10-26

- Focused backend/shared checks: 3 files, 7 tests pass. Real PostgreSQL fixtures cover concurrent revisions and immutable ledger values.
- UI editor and existing Costs host: 2 files, 35 tests pass. Includes conflict → explicit reload → retry with the new revision.
- Mutation experiment: changing unknown prices to complete causes the shared behavioral test to fail; restored source passes.
- Full recursive typecheck and build pass with the repository-pinned Rust 1.97.1 installed in an isolated temporary toolchain directory. No system default toolchain changed.
- Token gates, module boundaries, migration checks and paired maps pass. Generated snapshot retention contains 0374–0378 only.
- Disposable preview: loopback port 3310, separate embedded database and synthetic events. Browser saved Sol and DeepSeek presets and reloaded them successfully; known subtotal $3.4412, Sage unpriced, recorded charges $0. No paid provider calls.
- Full `pnpm test:run` is still running at this checkpoint. Production remains unchanged.
