import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MODEL_REFERENCE_PRESETS, MODEL_REFERENCE_PRESETS_VERIFIED_AT, modelReferenceRateInputSchema,
  type ModelReferenceEstimateRow, type ModelReferenceRateInput } from "@paperclipai/shared";
import { modelReferenceRatesApi } from "../api/model-reference-rates";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { formatTokens } from "../lib/utils";

const amount = (value: string) => `$${value.includes(".") ? value.replace(/\.?0+$/, "") : value}`;
const price = (value: string | null | undefined) => value == null ? "Unknown" : amount(value);
const fields = [
  ["inputUsdPerMillion", "Input"], ["cachedInputUsdPerMillion", "Cached read"],
  ["outputUsdPerMillion", "Output"], ["cacheWriteUsdPerMillion", "Cache write (reference only)"],
] as const;
function Editor({ companyId, row, close, reload }: { companyId: string; row: ModelReferenceEstimateRow | null; close: () => void; reload: () => Promise<unknown> }) {
  const [form, setForm] = useState<ModelReferenceRateInput>(() => ({ provider: row?.provider ?? "", model: row?.model ?? "",
    inputUsdPerMillion: row?.rate?.inputUsdPerMillion ?? null, cachedInputUsdPerMillion: row?.rate?.cachedInputUsdPerMillion ?? null,
    outputUsdPerMillion: row?.rate?.outputUsdPerMillion ?? null, cacheWriteUsdPerMillion: row?.rate?.cacheWriteUsdPerMillion ?? null,
    sourceUrl: row?.rate?.sourceUrl ?? null, verifiedAt: row?.rate?.verifiedAt ?? new Date().toISOString().slice(0, 10),
    notes: row?.rate?.notes ?? "", expectedRevision: row?.rate?.revision ?? null }));
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState("");
  const save = useMutation({ mutationFn: (input: ModelReferenceRateInput) => modelReferenceRatesApi.save(companyId, input),
    onSuccess: async () => { await reload(); close(); } });
  function change(field: keyof ModelReferenceRateInput, value: string | null) { setForm(current => ({ ...current, [field]: value })); setError(null); }
  return <form className="space-y-4" onSubmit={event => {
    event.preventDefault();
    const parsed = modelReferenceRateInputSchema.safeParse(form);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check the entered rates."); return; }
    save.mutate(parsed.data);
  }}>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2"><Label htmlFor="reference-provider">Provider (ledger key)</Label><Input id="reference-provider" value={form.provider} disabled={!!row} onChange={event => change("provider", event.target.value)} required /></div>
      <div className="space-y-2"><Label htmlFor="reference-model">Exact model ID or alias</Label><Input id="reference-model" value={form.model} disabled={!!row} onChange={event => change("model", event.target.value)} required /></div>
    </div>
    <div className="space-y-2"><Label htmlFor="reference-preset">Public price preset</Label><select id="reference-preset" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={preset} onChange={event => {
      setPreset(event.target.value);
      const chosen = MODEL_REFERENCE_PRESETS[Number(event.target.value)];
      if (event.target.value === "" || !chosen) return;
      setForm(current => ({ ...current, inputUsdPerMillion: chosen.input, cachedInputUsdPerMillion: chosen.cached,
        outputUsdPerMillion: chosen.output, cacheWriteUsdPerMillion: chosen.write, sourceUrl: chosen.sourceUrl,
        verifiedAt: MODEL_REFERENCE_PRESETS_VERIFIED_AT, notes: chosen.notes })); setError(null);
    }}><option value="">Enter custom rates / keep current rates</option>{MODEL_REFERENCE_PRESETS.map((item, index) => <option key={item.label} value={index}>{item.label}</option>)}</select></div>
    <p className="text-xs text-muted-foreground">USD per million tokens. Blank means unknown; 0 is an explicit zero rate. Choose the actual upstream model. A preset keeps the ledger provider and model alias unchanged.</p>
    <div className="grid gap-4 sm:grid-cols-2">{fields.map(([field, label]) => <div className="space-y-2" key={field}><Label htmlFor={`reference-${field}`}>{label}</Label><Input id={`reference-${field}`} inputMode="decimal" value={form[field] ?? ""} placeholder="Unknown" onChange={event => change(field, event.target.value.trim() || null)} /></div>)}</div>
    <div className="space-y-2"><Label htmlFor="reference-source">Public source URL</Label><Input id="reference-source" type="url" value={form.sourceUrl ?? ""} onChange={event => change("sourceUrl", event.target.value || null)} placeholder="https://" /></div>
    <div className="space-y-2"><Label htmlFor="reference-date">Price verified on</Label><Input id="reference-date" type="date" value={form.verifiedAt} onChange={event => change("verifiedAt", event.target.value)} required /></div>
    <div className="space-y-2"><Label htmlFor="reference-notes">Assumptions / tier / local cost boundary</Label><Textarea id="reference-notes" maxLength={1000} value={form.notes} onChange={event => change("notes", event.target.value)} /></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {save.error && <div role="alert" className="space-y-2 text-sm text-destructive"><p>Could not save this rate. Your draft is retained. Check your permission and values, or reload saved rates and reopen the editor. Reloading closes this draft.</p><Button type="button" variant="outline" onClick={async () => { await reload(); close(); }}>Reload rates and close editor</Button></div>}
    <div className="flex items-center justify-between"><Button type="button" variant="ghost" disabled={save.isPending} onClick={close}>Cancel</Button><Button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save rate"}</Button></div>
  </form>;
}

export function ModelReferencePricing({ companyId, from, to }: { companyId: string; from?: string; to?: string }) {
  const client = useQueryClient();
  const key = ["model-reference-rates", companyId, from, to];
  const query = useQuery({ queryKey: key, queryFn: () => modelReferenceRatesApi.report(companyId, from, to) });
  const [editor, setEditor] = useState<{ row: ModelReferenceEstimateRow | null } | null>(null);
  const reload = () => client.invalidateQueries({ queryKey: ["model-reference-rates", companyId] });
  const report = query.data;
  return <Card>
    <CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>Public price usage estimate</CardTitle>{report?.canEdit && <Button variant="outline" size="sm" onClick={() => setEditor({ row: null })}>Add rate</Button>}</div>
      <CardDescription>Current reference rates applied to recorded usage in the selected period, including subscriptions. This is not an invoice and does not change charges, monthly fees or budget enforcement.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {query.isPending && <p className="text-sm text-muted-foreground">Loading reference rates…</p>}
      {query.error && <p role="alert" className="text-sm text-destructive">Could not load reference rates. <Button variant="link" onClick={() => query.refetch()}>Reload rates</Button>{report ? " Showing last loaded values." : ""}</p>}
      {report && <>
        <p className="font-mono text-lg">{report.incompleteRowCount ? "Known subtotal: " : "Estimated reference value: "}{amount(report.knownUsd)}{report.incompleteRowCount > 0 && <span className="text-sm text-muted-foreground"> · {report.incompleteRowCount} model groups partially priced or unpriced</span>}</p>
        <p className="text-xs text-muted-foreground">Input excludes cached reads. Cache-write counts are not separately available in this ledger; their reference rates are shown but writes are valued at the input rate. Long context, processing tiers, time discounts, tools and taxes require their own scenario. Historical periods use the current saved rates.</p>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Provider and model reference prices, USD per million tokens</caption>
          <thead><tr>{["Provider / model", "Input", "Cache read", "Output", "Cache write", "Usage estimate", "Source / verified", ""].map((label, index) => <th className="p-2 font-medium" key={index}>{label}</th>)}</tr></thead>
          <tbody>{report.rows.map(row => <tr key={JSON.stringify([row.provider, row.model])}>
            <td className="min-w-64 p-2"><div>{row.provider}</div><div className="break-all font-mono text-xs">{row.model}</div><div className="text-xs text-muted-foreground">{formatTokens(row.inputTokens + row.cachedInputTokens)} in · {formatTokens(row.outputTokens)} out</div>{row.rate?.notes && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Assumptions</summary><p className="max-w-64">{row.rate.notes}</p></details>}</td>
            <td className="p-2 font-mono">{price(row.rate?.inputUsdPerMillion)}</td><td className="p-2 font-mono">{price(row.rate?.cachedInputUsdPerMillion)}</td><td className="p-2 font-mono">{price(row.rate?.outputUsdPerMillion)}</td><td className="p-2 font-mono">{price(row.rate?.cacheWriteUsdPerMillion)}</td>
            <td className="whitespace-nowrap p-2 font-mono">{!row.eventCount ? "No recorded usage" : row.complete ? amount(row.knownUsd) : row.knownUsd === "0.000000000" ? "Unpriced" : `Partial: ${amount(row.knownUsd)}`}</td>
            <td className="whitespace-nowrap p-2 text-xs">{row.rate?.sourceUrl && <a className="underline" href={row.rate.sourceUrl} target="_blank" rel="noreferrer">Public source</a>}<div>{row.rate?.verifiedAt}</div></td>
            <td className="p-2">{report.canEdit && <Button variant="outline" size="sm" onClick={() => setEditor({ row })}>{row.rate ? "Edit rate" : "Set rate"}</Button>}</td>
          </tr>)}</tbody>
        </table></div>
        {report.rows.length === 0 && <p className="text-sm text-muted-foreground">No recorded usage or saved rates yet.</p>}
      </>}
    </CardContent>
    <Dialog open={!!editor} onOpenChange={open => { if (!open) setEditor(null); }}><DialogContent className="max-h-(--sz-80vh) overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>Model reference rate</DialogTitle><DialogDescription>Save a public-price scenario for this company and exact provider/model key.</DialogDescription></DialogHeader>{editor && <Editor companyId={companyId} row={editor.row} close={() => setEditor(null)} reload={reload} />}</DialogContent></Dialog>
  </Card>;
}
