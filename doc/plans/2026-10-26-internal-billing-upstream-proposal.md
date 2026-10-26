# Proposal: separate estimated usage value from ledger spend across cost reports

### Subsystem affected

Cross-cutting (server, UI, shared contracts, adapters, and database accounting)

### Problem or motivation

Subscription accounts, compatible API gateways, and self-hosted models can report token usage without a separately billed amount for each request. Operators still need to compare usage value across agents, projects, tasks, models, and service channels.

A reference-price estimate answers a different question from recorded ledger spend, an invoice, or a subscription fee. Replacing ledger amounts with reference prices can change existing budgets. Adding subscription fees to token estimates can count the same service twice.

Related requests already describe this need: #339 and #6843. This issue proposes a shared contract and a small contribution scope, rather than a separate accounting engine.

### Proposed solution

Build on the durable accounting and attribution work in #14997. First check the current implementation and identify the remaining gaps. Keep existing reported/estimated/unpriced provenance and original receipts.

1. **Separate reporting measures.** Offer an explicit reference-price usage value alongside recorded ledger amounts. Show subscription fees separately. Do not replace existing ledger values, silently change the default report measure, or add these measures into one total.

2. **Use one reporting basis across dimensions.** Company, agent, project, task, model, and provider views should use the same canonical usage and valuation rules. A provider-only estimate should not produce different totals from the other views. Preserve company isolation and count each usage event once.

3. **Separate service identity from protocol.** Record the selected service channel, upstream when known, requested/reported model, and protocol as distinct facts. An OpenAI-compatible endpoint does not by itself identify OpenAI as the biller. Use immutable connection/run evidence. Leave historical attribution unresolved when there is no evidence; do not infer it from today's agent configuration.

4. **Support explicit, versioned reference rates.** Allow company-scoped overrides and optional public-price presets with a source and effective time. Use the rate applicable when usage occurred. Price changes must not silently rewrite history. If historical revaluation is supported later, require a preview and an audit record. A self-hosted model may use an administrator-selected benchmark without implying an actual payment or a product default.

5. **Expose incomplete estimates.** Missing prices, cache breakdowns, or other required metering remain unknown or partial. Show coverage and any declared assumptions. Do not turn unknown into zero or label a partial result complete. Cache-read and cache-write semantics need attention; see #12538.

Existing budget enforcement must keep its current basis. Any future estimate-based budget should be a separate, explicit option, with warning-only behavior by default and an opt-in hard stop. It should reuse the existing admission and pause ownership paths. It does not need to be in the first PR.

A possible sequence is: identify missing metering/identity fields, add a consistent read-only estimate view, then add rate configuration. Historical revaluation and new budget controls can follow only if maintainers want them. USD estimates and UTC budget boundaries could be an initial scope limit, without converting foreign-currency invoices.

### Alternatives considered

- Use only adapter-reported dollar values. These remain useful evidence, but a reported amount does not always establish an invoice amount or provide a comparable benchmark.
- Write reference prices into existing ledger fields. This risks changing budget behavior and losing provenance.
- Use an external report or plugin. This may be the right boundary if maintainers prefer to keep reference-price configuration outside core. I would welcome guidance on that split.

### Roadmap alignment

This relates to [Better Budgeting in ROADMAP.md](https://github.com/paperclipai/paperclip/blob/master/ROADMAP.md). I have read the contribution guidance and am seeking scope agreement before implementation. This issue does not claim prior agreement in Discord `#dev`; I can continue the design discussion there as requested.

### Additional context

Related work: #339, #6843, #4571, #12538, merged accounting PR #14997, and the open price-catalog PR #11896. The implementation should extend the accepted accounting model and avoid parallel work.

**I am willing to implement this in focused pull requests after maintainers confirm the scope and data model. I can also help an existing PR rather than create parallel work.**

The main decisions I would like to confirm are the smallest useful first slice, which canonical usage/valuation fields already cover it, and whether rate configuration belongs in core or a plugin. If an existing issue is the preferred place, I am happy to consolidate there.


Published: https://github.com/paperclipai/paperclip/issues/17710

Local design branch: `codex/internal-billing-plan-local` (not pushed).
