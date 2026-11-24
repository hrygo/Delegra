// The manifest builders return Record<string, unknown> because the manifests go
// straight to the Kubernetes API. These views name only the fields the tests read.

export interface PodTemplateView {
  metadata: { labels: Record<string, string> };
  spec: {
    automountServiceAccountToken: boolean;
    restartPolicy: string;
    dnsConfig?: { options?: { name: string; value?: string }[] };
    nodeSelector?: Record<string, string>;
    priorityClassName?: string;
    runtimeClassName?: string;
    imagePullSecrets?: { name: string }[];
    securityContext: {
      runAsNonRoot: boolean;
      runAsUser: number;
      fsGroupChangePolicy: string;
      seccompProfile: { type: string };
    };
    containers: {
      name?: string;
      image?: string;
      command: string[];
      envFrom: { secretRef: { name: string } }[];
      resources?: {
        requests?: { cpu?: string; memory?: string };
        limits?: { cpu?: string; memory?: string };
      };
      securityContext: {
        runAsNonRoot: boolean;
        readOnlyRootFilesystem: boolean;
        allowPrivilegeEscalation: boolean;
        capabilities: { drop: string[] };
      };
      volumeMounts: { name?: string; mountPath: string }[];
    }[];
    volumes: { name?: string; emptyDir?: { medium?: string; sizeLimit?: string } }[];
  };
}

export interface JobManifestView {
  apiVersion: string;
  kind: string;
  metadata: { labels: Record<string, string> };
  spec: {
    backoffLimit: number;
    ttlSecondsAfterFinished: number;
    activeDeadlineSeconds: number;
    template: PodTemplateView;
  };
}

export interface SandboxCrManifestView {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    ownerReferences?: unknown[];
  };
  spec: { podTemplate: PodTemplateView };
}

export interface NetworkPolicyEgressRuleView {
  to: {
    namespaceSelector?: { matchLabels?: Record<string, string> };
    podSelector?: { matchLabels?: Record<string, string> };
    ipBlock?: { cidr: string; except?: string[] };
  }[];
  ports?: { protocol: string; port: number }[];
}

export interface DenyAllPolicyView {
  metadata: { name: string };
  spec: {
    podSelector: Record<string, never>;
    policyTypes: string[];
    ingress?: unknown[];
    egress?: unknown[];
  };
}

export interface EgressAllowPolicyView {
  metadata: { name: string; ownerReferences?: unknown[] };
  spec: {
    podSelector: { matchLabels: Record<string, string> };
    egress: NetworkPolicyEgressRuleView[];
  };
}

export interface CiliumEgressRuleView {
  toEndpoints?: { matchLabels: Record<string, string> }[];
  toPorts?: {
    ports: { port: string }[];
    rules?: { dns?: Array<{ matchName?: string; matchPattern?: string }> };
  }[];
  toFQDNs?: { matchName: string }[];
  toCIDRSet?: { cidr: string }[];
}

export interface CiliumNetworkPolicyView {
  apiVersion: string;
  kind: string;
  metadata: { name: string; ownerReferences?: unknown[] };
  spec: {
    endpointSelector: { matchLabels: Record<string, string> };
    egress: CiliumEgressRuleView[];
    egressDeny?: CiliumEgressRuleView[];
  };
}
