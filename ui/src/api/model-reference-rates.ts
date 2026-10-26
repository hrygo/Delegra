import type { ModelReferenceRate, ModelReferenceRateInput, ModelReferenceReport } from "@paperclipai/shared";
import { api } from "./client";
export const modelReferenceRatesApi = {
  report: (companyId: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (!from && !to) params.set("period", "all");
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return api.get<ModelReferenceReport>(`/companies/${companyId}/costs/model-reference-rates?${params}`);
  },
  save: (companyId: string, input: ModelReferenceRateInput) =>
    api.put<ModelReferenceRate>(`/companies/${companyId}/costs/model-reference-rates`, input),
};
