import { describe, it, expect } from "vitest";
import { parseKubernetesProviderConfig } from "../../src/types.js";

describe("kubernetesProviderConfigSchema", () => {
  it("accepts inCluster=true with no kubeconfig and sets safe defaults", () => {
    const parsed = parseKubernetesProviderConfig({ inCluster: true });
    expect(parsed.inCluster).toBe(true);
    expect(parsed.namespacePrefix).toBe("paperclip-");
    expect(parsed.imageAllowList).toEqual([]);
    expect(parsed.egressMode).toBe("standard");
    expect(parsed.jobTtlSecondsAfterFinished).toBe(900);
    expect(parsed.requireImmutableDigest).toBe(false);
    expect(parsed.nodeArch).toBe("any");
    expect(parsed.priorityClassName).toBeUndefined();
    expect(parsed.sandboxApiVersion).toBe("agents.x-k8s.io/v1alpha1");
  });

  it("accepts expert scheduling options", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: true,
      requireImmutableDigest: true,
      nodeArch: "arm64",
      priorityClassName: "paperclip-expert-interactive",
      sandboxApiVersion: "agents.x-k8s.io/v1beta1",
    });
    expect(parsed.requireImmutableDigest).toBe(true);
    expect(parsed.nodeArch).toBe("arm64");
    expect(parsed.priorityClassName).toBe("paperclip-expert-interactive");
    expect(parsed.sandboxApiVersion).toBe("agents.x-k8s.io/v1beta1");
  });

  it("accepts inline kubeconfig", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: false,
      kubeconfig: "apiVersion: v1\nkind: Config\n",
    });
    expect(parsed.kubeconfig).toContain("apiVersion");
  });

  it("rejects when neither inCluster nor any kubeconfig source is set", () => {
    expect(() => parseKubernetesProviderConfig({ inCluster: false })).toThrow(
      /requires one of `inCluster` or `kubeconfig`/,
    );
  });

  it("rejects invalid companySlug", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, companySlug: "INVALID UPPER" }),
    ).toThrow();
  });

  it("rejects egressAllowCidrs entries that are not valid CIDR", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, egressAllowCidrs: ["not-a-cidr"] }),
    ).toThrow(/CIDR/i);
  });
});
