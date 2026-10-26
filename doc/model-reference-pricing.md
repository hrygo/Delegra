# Public model reference prices

Company operators can open **Activity → Costs → Providers → Public price usage estimate** to save rates for an exact ledger `provider` and `model` pair. Rates use USD per million tokens. A gateway alias keeps its recorded identity; choose the public preset for the actual upstream model explicitly.

The report applies the **current saved rates** to normalized usage in the selected period, including subscription and gateway events. It is a scenario estimate, separate from recorded charges, monthly subscription fees, immutable receipts, invoice reconciliation and budget enforcement. Saving a rate never rewrites those records. An empty rate is unknown; `0` is an explicit zero rate. Partially priced groups contribute only their known subtotal.

Input excludes cached reads. The existing ledger has no independent cache-write count, so the report values writes within ordinary input and displays the optional cache-write price for reference only. Long-context premiums, processing tiers, time discounts, tools, taxes and hardware/electricity costs are not modeled. Do not interpret this report as an invoice.

## Public presets

Verified **2026-10-26**. Values below are input / cached read / output, USD per 1M tokens.

| Preset | Input | Cached read | Output | Source and assumptions |
| --- | ---: | ---: | ---: | --- |
| GPT-6.1 Sol | 2 | 0.1 | 10 | [OpenAI pricing](https://developers.openai.com/api/docs/pricing), Standard short context. Cache write reference: 30 minutes $2.5, 12 hours $5. |
| GPT-6 Luna | 0.1 | 0.01 | 0.5 | [OpenAI pricing](https://developers.openai.com/api/docs/pricing), Standard short context. Cache write reference: 30 minutes $0.125, 12 hours $0.25. |
| MiMo V2.6 Pro on OpenCode Go | 0.435 | 0.003625 | 0.87 | [OpenCode Go](https://opencode.ai/v2/docs/console/go/), public allowance valuation, not an additional subscription invoice. |
| DeepSeek V4.1 Flash, peak | 0.30 | 0.006 | 1.20 | [OpenCode Go](https://opencode.ai/v2/docs/console/go/), conservative scenario for mixed-time usage. |
| DeepSeek V4.1 Flash, off-peak | 0.15 | 0.003 | 0.60 | [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/), scenario only for off-peak usage. |

DeepSeek peak windows are weekdays 01:00–04:00 and 06:00–10:00 UTC; public-holiday rules can also affect the actual price. The report does not split usage across those windows. Operators must select and document their scenario. A local Sage model has no established hosted API list price here and remains unknown until a defensible source is supplied.

## API and safeguards

- `GET /api/companies/{companyId}/costs/model-reference-rates` accepts the existing `period=all` or `from` / `to` cost report bounds. It returns company rates, grouped estimates, known USD subtotal, incomplete group count and the caller's `canEdit` flag.
- `PUT` at the same path saves one exact provider/model pair with four nullable decimal rate strings, `sourceUrl`, `verifiedAt`, `notes` and `expectedRevision`. A new record requires `expectedRevision: null`; updates require the current revision. A stale save returns `409` without replacing another editor's changes. Clear rates to restore unknown pricing.
- Reads require board identity, company membership and company cost-read permission. Writes additionally require AI connection management permission and reject viewer memberships. Ordinary agent identities are denied.
- Priced records require an HTTPS source without URL credentials. Rates are nonnegative, at most $1,000,000/M, with up to nine decimal places. Decimal arithmetic avoids binary floating-point money calculations.
- The unique company/provider/model index prevents cross-company reuse. Configuration writes serialize under the company row lock and atomically append a `model_reference_rate.saved` activity with previous and current values. No provider request is made during saving or reporting.

The migration adds a separate table. To roll back application behavior, return to the prior immutable deployment tag; leave the additive table and its saved configuration in place. No historical usage migration is needed.
