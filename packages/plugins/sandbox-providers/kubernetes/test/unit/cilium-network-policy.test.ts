import { describe, it, expect } from "vitest";
import {
  buildCiliumNetworkPolicyManifest as buildRawCiliumNetworkPolicyManifest,
  buildScopedCiliumDnsRules,
  CLOUD_IMDS_DENIED_CIDRS,
  type BuildCiliumNetworkPolicyInput,
} from "../../src/cilium-network-policy.js";
import type { CiliumNetworkPolicyView } from "./manifest-views.js";

const buildCiliumNetworkPolicyManifest = (input: BuildCiliumNetworkPolicyInput) =>
  buildRawCiliumNetworkPolicyManifest(input) as unknown as CiliumNetworkPolicyView;

describe("buildCiliumNetworkPolicyManifest", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    paperclipServerNamespace: "paperclip",
    egressAllowFqdns: ["api.anthropic.com"],
    egressAllowCidrs: [] as string[],
  };

  it("returns a CiliumNetworkPolicy with the correct apiVersion and kind", () => {
    const cnp = buildCiliumNetworkPolicyManifest(baseInput);
    expect(cnp.apiVersion).toBe("cilium.io/v2");
    expect(cnp.kind).toBe("CiliumNetworkPolicy");
  });

  it("targets agent pods by role label", () => {
    const cnp = buildCiliumNetworkPolicyManifest(baseInput);
    expect(cnp.spec.endpointSelector.matchLabels["paperclip.io/role"]).toBe("agent");
  });

  it("includes an FQDN allow rule for each adapter FQDN", () => {
    const cnp = buildCiliumNetworkPolicyManifest({
      ...baseInput,
      egressAllowFqdns: ["api.anthropic.com", "api.openai.com"],
    });
    const fqdnRule = cnp.spec.egress.find((e: { toFQDNs?: { matchName: string }[] }) => e.toFQDNs);
    expect(fqdnRule).toBeDefined();
    expect(fqdnRule!.toFQDNs!.map((f: { matchName: string }) => f.matchName).sort()).toEqual([
      "api.anthropic.com",
      "api.openai.com",
    ]);
  });

  it("permits scoped DNS to kube-dns without wildcard matchPattern '*' (anti-DNS-tunneling)", () => {
    const cnp = buildCiliumNetworkPolicyManifest({
      ...baseInput,
      egressAllowFqdns: ["api.anthropic.com", "*", "*.openai.com"],
    });
    const dnsRule = cnp.spec.egress.find((e) =>
      e.toPorts?.some((tp) => tp.ports.some((p) => p.port === "53")),
    );
    expect(dnsRule).toBeDefined();
    const dnsEntries = dnsRule?.toPorts?.[0]?.rules?.dns ?? [];
    expect(dnsEntries.some((d) => d.matchPattern === "*")).toBe(false);
    expect(dnsEntries).toContainEqual({ matchPattern: "*.svc.cluster.local" });
    expect(dnsEntries).toContainEqual({ matchPattern: "*.cluster.local" });
    expect(dnsEntries).toContainEqual({ matchName: "api.anthropic.com" });
    expect(dnsEntries).toContainEqual({ matchPattern: "*.openai.com" });
  });

  it("adds egressDeny blocking cloud IMDS and lateral agent-to-agent traffic", () => {
    const cnp = buildCiliumNetworkPolicyManifest({
      ...baseInput,
      extraDeniedCidrs: ["100.100.100.200/32"],
    });
    expect(cnp.spec.egressDeny).toBeDefined();
    const cidrDeny = cnp.spec.egressDeny!.find((r) => r.toCIDRSet);
    expect(cidrDeny?.toCIDRSet?.map((c) => c.cidr)).toEqual([
      ...CLOUD_IMDS_DENIED_CIDRS,
      "100.100.100.200/32",
    ]);
    const agentDeny = cnp.spec.egressDeny!.find((r) =>
      r.toEndpoints?.some((ep) => ep.matchLabels["paperclip.io/role"] === "agent"),
    );
    expect(agentDeny).toBeDefined();
  });

  it("deduplicates and strips bare '*' in buildScopedCiliumDnsRules", () => {
    const rules = buildScopedCiliumDnsRules(["API.Anthropic.com", "api.anthropic.com", "*"]);
    expect(rules.filter((r) => r.matchName === "api.anthropic.com")).toHaveLength(1);
    expect(rules.some((r) => r.matchPattern === "*")).toBe(false);
  });

  it("includes a rule for paperclip-server callback", () => {
    const cnp = buildCiliumNetworkPolicyManifest(baseInput);
    const cb = cnp.spec.egress.find((e: { toEndpoints?: { matchLabels: Record<string, string> }[] }) =>
      e.toEndpoints?.some((ep) => ep.matchLabels.app === "paperclip-server"),
    );
    expect(cb).toBeDefined();
  });

  it("includes user-supplied CIDRs in toCIDRSet rule", () => {
    const cnp = buildCiliumNetworkPolicyManifest({
      ...baseInput,
      egressAllowCidrs: ["10.0.0.0/8"],
    });
    const cidrRule = cnp.spec.egress.find((e: { toCIDRSet?: { cidr: string }[] }) => e.toCIDRSet);
    expect(cidrRule?.toCIDRSet?.[0]?.cidr).toBe("10.0.0.0/8");
  });

  it("adds a cluster-level gateway proxy egress rule when gatewayProxy is configured", () => {
    const cnp = buildCiliumNetworkPolicyManifest({
      ...baseInput,
      gatewayProxy: { namespace: "paperclip" },
    });
    const proxyRule = cnp.spec.egress.find((e) =>
      e.toEndpoints?.some(
        (ep) =>
          ep.matchLabels.app === "delegra-gateway-proxy" &&
          ep.matchLabels["k8s:io.kubernetes.pod.namespace"] === "paperclip",
      ),
    );
    expect(proxyRule).toBeDefined();
    expect(proxyRule?.toPorts?.[0]?.ports?.[0]?.port).toBe("8443");
  });

  it("targets only the granted run when building a scoped policy", () => {
    const cnp = buildCiliumNetworkPolicyManifest({
      ...baseInput,
      name: "pc-run-egress",
      endpointSelector: { "paperclip.io/run-id": "run-123" },
      includeBaseRules: false,
      ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: "pc-run", uid: "uid-1" }],
      egressAllowFqdns: ["github.com", "pypi.org"],
    });

    expect(cnp.metadata.name).toBe("pc-run-egress");
    expect(cnp.metadata.ownerReferences).toHaveLength(1);
    expect(cnp.spec.endpointSelector.matchLabels).toEqual({ "paperclip.io/run-id": "run-123" });
    expect(cnp.spec.egress).toHaveLength(1);
    expect(cnp.spec.egressDeny).toBeUndefined();
  });
});
