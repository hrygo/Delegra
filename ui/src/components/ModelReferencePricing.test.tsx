// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelReferencePricing } from "./ModelReferencePricing";
const mocks = vi.hoisted(() => ({ report: vi.fn(), save: vi.fn() }));
vi.mock("../api/model-reference-rates", () => ({ modelReferenceRatesApi: mocks }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const row = { provider: "openai", model: "gateway-alias", inputTokens: 1000000, cachedInputTokens: 100, outputTokens: 100, eventCount: 1, rate: null, knownUsd: "0.000000000", complete: false };
describe("reference pricing editor", () => {
  let container: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient;
  beforeEach(() => {
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    mocks.report.mockResolvedValue({ rows: [row], rates: [], knownUsd: "0.000000000", incompleteRowCount: 1, canEdit: true });
    mocks.save.mockResolvedValue({ revision: 0 });
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); client.clear(); vi.clearAllMocks(); });
  async function render() { await act(async () => root.render(<QueryClientProvider client={client}><ModelReferencePricing companyId="company" from="2026-10-01" to="2026-10-31" /></QueryClientProvider>)); }
  async function click(text: string) { await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === text)!.click()); }
  it("keeps unknown pricing visible and saves an explicitly selected preset without renaming the alias", async () => {
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("gateway-alias"));
    expect(container.textContent).toContain("Unpriced");
    expect(container.textContent).toContain("not an invoice");
    await click("Set rate");
    await act(async () => {
      const preset = document.querySelector<HTMLSelectElement>("#reference-preset")!;
      preset.value = "0"; preset.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledWith("company", expect.objectContaining({ provider: "openai", model: "gateway-alias", inputUsdPerMillion: "2", cachedInputUsdPerMillion: "0.1", outputUsdPerMillion: "10", expectedRevision: null })));
    expect(mocks.report).toHaveBeenCalledWith("company", "2026-10-01", "2026-10-31");
  });
  it("hides editing for readers", async () => {
    mocks.report.mockResolvedValueOnce({ rows: [row], rates: [], knownUsd: "0.000000000", incompleteRowCount: 1, canEdit: false });
    await render(); await vi.waitFor(() => expect(container.textContent).toContain("gateway-alias"));
    expect(container.textContent).not.toContain("Set rate");
    expect(container.textContent).not.toContain("Add rate");
  });
  it("shows fetch failures with a retry action", async () => {
    mocks.report.mockRejectedValueOnce(new Error("unavailable"));
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Could not load reference rates"));
    expect(container.textContent).toContain("Reload rates");
  });
  it("keeps the editor open with actionable feedback after a stale save", async () => {
    mocks.save.mockRejectedValue(new Error("stale"));
    await render(); await vi.waitFor(() => expect(container.textContent).toContain("gateway-alias"));
    await click("Set rate");
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Reload rates and close editor"));
    mocks.report.mockResolvedValue({ rows: [{ ...row, rate: { ...row, inputUsdPerMillion: "2", cachedInputUsdPerMillion: "0.1", outputUsdPerMillion: "10", cacheWriteUsdPerMillion: null, sourceUrl: "https://example.com/pricing", verifiedAt: "2026-10-26", notes: "", revision: 2 } }], rates: [], knownUsd: "2", incompleteRowCount: 0, canEdit: true });
    await click("Reload rates and close editor");
    await vi.waitFor(() => expect(container.textContent).toContain("Edit rate"));
    expect(container.textContent).toContain("$10");
    await click("Edit rate");
    mocks.save.mockResolvedValueOnce({ revision: 3 });
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(mocks.save).toHaveBeenLastCalledWith("company", expect.objectContaining({ expectedRevision: 2 })));
  });
});
