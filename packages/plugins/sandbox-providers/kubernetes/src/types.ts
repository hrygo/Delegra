import { z } from "zod";
import { adapterRegistrySchema } from "./adapter-registry.js";
import { KNOWN_ADAPTER_TYPES } from "./adapter-defaults.js";
import type { ExpertResourceProfileName } from "./sandbox-cr-builder.js";

const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

export const kubernetesProviderConfigSchema = z
  .object({
    inCluster: z.boolean().default(false),
    kubeconfig: z.string().optional(),

    namespacePrefix: z.string().regex(/^[a-z0-9-]{1,32}$/).default("paperclip-"),
    companySlug: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),

    imageRegistry: z.string().url().optional(),
    imageAllowList: z.array(z.string()).default([]),
    imagePullSecrets: z.array(z.string()).default([]),
    requireImmutableDigest: z.boolean().default(false),

    egressAllowFqdns: z.array(z.string()).default([]),
    egressAllowCidrs: z.array(z.string().regex(cidrRegex, "Invalid CIDR")).default([]),
    egressMode: z.enum(["cilium", "standard"]).default("standard"),

    defaultResources: z
      .object({
        requests: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
        limits: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
      })
      .optional(),

    nodeArch: z.enum(["arm64", "amd64", "any"]).default("any"),
    priorityClassName: z.string().min(1).optional(),
    runtimeClassName: z.string().optional(),
    sandboxApiVersion: z
      .enum(["agents.x-k8s.io/v1alpha1", "agents.x-k8s.io/v1beta1"])
      .default("agents.x-k8s.io/v1alpha1"),
    warmPool: z
      .object({
        enabled: z.boolean().default(false),
        templateName: z.string().min(1).optional(),
        claimTimeoutMs: z.number().int().positive().default(15_000),
        defaultTtlSeconds: z.number().int().positive().default(3600),
        sameSessionIdleTtlSeconds: z.number().int().min(60).max(600).default(240),
      })
      .optional(),
    gatewayProxyUrl: z.string().url().optional(),
    serviceAccountAnnotations: z.record(z.string(), z.string()).default({}),

    jobTtlSecondsAfterFinished: z.number().int().nonnegative().default(900),
    podActivityDeadlineSec: z.number().int().positive().default(3600),

    adapterType: z
      .string()
      .default("claude_local")
      .refine((v) => KNOWN_ADAPTER_TYPES.has(v), {
        message: "adapterType must be one of the known adapter types",
      }),

    adapters: adapterRegistrySchema.optional(),

    backend: z.enum(["sandbox-cr", "job"]).default("sandbox-cr"),
  })
  .refine(
    (cfg) => cfg.inCluster || cfg.kubeconfig,
    {
      message:
        "kubernetes provider requires one of `inCluster` or `kubeconfig`",
    },
  );

export type KubernetesProviderConfig = z.infer<typeof kubernetesProviderConfigSchema>;

export function parseKubernetesProviderConfig(input: unknown): KubernetesProviderConfig {
  return kubernetesProviderConfigSchema.parse(input);
}

export type DigestVerificationStatus =
  | "exact_index_match"
  | "exact_platform_match"
  | "cri_config_id_only"
  | "mismatch";

export interface KubernetesRuntimeEvidence {
  nodeName: string | null;
  containerImageId: string | null;
  digestVerification: DigestVerificationStatus | null;
}

export interface KubernetesLeaseMetadata {
  namespace: string;
  jobName: string;
  podName: string | null;
  secretName: string;
  phase: "Pending" | "Running" | "Succeeded" | "Failed";
  backend: "sandbox-cr" | "job";
  scopedNetworkPolicyName: string | null;
  scopedNetworkEgress: {
    allowFqdns: string[];
    allowCidrs: string[];
  };
  resolvedImage?: string;
  resolvedImageDigest?: string | null;
  expectedPlatformDigest?: string | null;
  resourceProfile?: ExpertResourceProfileName;
  nodeArch?: "arm64" | "amd64" | "any";
  priorityClassName?: string | null;
  sandboxClaimName?: string | null;
  poolHit?: boolean;
  sandboxApiVersion?: "agents.x-k8s.io/v1alpha1" | "agents.x-k8s.io/v1beta1";
  zeroTrustGateway?: boolean;
  runtimeEvidence?: KubernetesRuntimeEvidence;
  nativeFileSyncUnsupported?: boolean;
}
