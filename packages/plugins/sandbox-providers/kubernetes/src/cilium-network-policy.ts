export interface CiliumGatewayProxyTarget {
  namespace: string;
  appLabel?: string;
  port?: number;
}

export interface BuildCiliumNetworkPolicyInput {
  namespace: string;
  paperclipServerNamespace: string;
  egressAllowFqdns: string[];
  egressAllowCidrs: string[];
  gatewayProxy?: CiliumGatewayProxyTarget;
  /** Additional CIDRs explicitly denied in `spec.egressDeny` alongside cloud IMDS. */
  extraDeniedCidrs?: string[];
  name?: string;
  endpointSelector?: Record<string, string>;
  includeBaseRules?: boolean;
  ownerReferences?: Record<string, unknown>[];
}

export const CLOUD_IMDS_DENIED_CIDRS = [
  "169.254.169.254/32",
  "fd00:ec2::254/128",
] as const;

export const CLUSTER_INTERNAL_DNS_PATTERNS = [
  "*.svc.cluster.local",
  "*.cluster.local",
] as const;

/**
 * Builds an explicit, non-wildcard Cilium DNS match list (`rules.dns`) so
 * agent pods cannot exfiltrate data via arbitrary DNS tunneling (`matchPattern: "*"`).
 */
export function buildScopedCiliumDnsRules(
  egressAllowFqdns: readonly string[],
): Array<{ matchName?: string; matchPattern?: string }> {
  const rules: Array<{ matchName?: string; matchPattern?: string }> = [];
  const seen = new Set<string>();

  for (const pattern of CLUSTER_INTERNAL_DNS_PATTERNS) {
    if (!seen.has(`pattern:${pattern}`)) {
      seen.add(`pattern:${pattern}`);
      rules.push({ matchPattern: pattern });
    }
  }

  for (const raw of egressAllowFqdns) {
    const fqdn = raw.trim().toLowerCase();
    if (!fqdn || fqdn === "*") continue;
    if (fqdn.includes("*")) {
      const key = `pattern:${fqdn}`;
      if (!seen.has(key)) {
        seen.add(key);
        rules.push({ matchPattern: fqdn });
      }
    } else {
      const key = `name:${fqdn}`;
      if (!seen.has(key)) {
        seen.add(key);
        rules.push({ matchName: fqdn });
      }
    }
  }

  return rules;
}

// Design note: no ingress rules are defined here. Paperclip-server does NOT
// push to agent pods — agents make outbound (egress) callbacks to
// paperclip-server on port 3100. If server→agent push is ever needed, add a
// targeted ingress rule scoped to the paperclip-server endpoint selector.
export function buildCiliumNetworkPolicyManifest(input: BuildCiliumNetworkPolicyInput): Record<string, unknown> {
  const egress: Record<string, unknown>[] = [];
  const egressDeny: Record<string, unknown>[] = [];

  if (input.includeBaseRules !== false) {
    egress.push({
      toEndpoints: [
        { matchLabels: { "k8s:io.kubernetes.pod.namespace": "kube-system", "k8s-app": "kube-dns" } },
      ],
      toPorts: [
        {
          ports: [
            { port: "53", protocol: "UDP" },
            { port: "53", protocol: "TCP" },
          ],
          rules: { dns: buildScopedCiliumDnsRules(input.egressAllowFqdns) },
        },
      ],
    });
  }

  if (input.egressAllowFqdns.length > 0) {
    egress.push({
      toFQDNs: input.egressAllowFqdns.map((fqdn) => ({ matchName: fqdn })),
      toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }],
    });
  }

  if (input.includeBaseRules !== false) {
    egress.push({
      toEndpoints: [
        {
          matchLabels: {
            "k8s:io.kubernetes.pod.namespace": input.paperclipServerNamespace,
            app: "paperclip-server",
          },
        },
      ],
      toPorts: [{ ports: [{ port: "3100", protocol: "TCP" }] }],
    });
  }

  if (input.includeBaseRules !== false && input.gatewayProxy) {
    egress.push({
      toEndpoints: [
        {
          matchLabels: {
            "k8s:io.kubernetes.pod.namespace": input.gatewayProxy.namespace,
            app: input.gatewayProxy.appLabel ?? "delegra-gateway-proxy",
          },
        },
      ],
      toPorts: [{ ports: [{ port: String(input.gatewayProxy.port ?? 8443), protocol: "TCP" }] }],
    });
  }

  if (input.egressAllowCidrs.length > 0) {
    egress.push({
      toCIDRSet: input.egressAllowCidrs.map((cidr) => ({ cidr })),
    });
  }

  if (input.includeBaseRules !== false) {
    const deniedCidrs = [
      ...CLOUD_IMDS_DENIED_CIDRS,
      ...(input.extraDeniedCidrs ?? []).map((c) => c.trim()).filter(Boolean),
    ];
    egressDeny.push({
      toCIDRSet: deniedCidrs.map((cidr) => ({ cidr })),
    });
    egressDeny.push({
      toEndpoints: [
        {
          matchLabels: {
            "paperclip.io/role": "agent",
          },
        },
      ],
    });
  }

  return {
    apiVersion: "cilium.io/v2",
    kind: "CiliumNetworkPolicy",
    metadata: {
      name: input.name ?? "paperclip-egress-fqdn",
      namespace: input.namespace,
      labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" },
      ...(input.ownerReferences ? { ownerReferences: input.ownerReferences } : {}),
    },
    spec: {
      endpointSelector: { matchLabels: input.endpointSelector ?? { "paperclip.io/role": "agent" } },
      egress,
      ...(egressDeny.length > 0 ? { egressDeny } : {}),
    },
  };
}
