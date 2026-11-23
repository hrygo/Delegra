/**
 * Builds a kubernetes-sigs/agent-sandbox Sandbox CR manifest.
 *
 * The Sandbox CR creates a long-lived pod (sleep infinity entrypoint) into
 * which paperclip-server can exec arbitrary commands. This solves the
 * architectural mismatch with the batch/v1 Job backend, which only supports
 * a single one-shot entrypoint — not the multi-command adapter-install pattern
 * used by paperclip-server.
 *
 * Security baseline is identical to buildJobManifest (pod-spec-builder.ts):
 * non-root, drop ALL caps, read-only rootFS, Tini PID 1, seccomp
 * RuntimeDefault, fsGroupChangePolicy OnRootMismatch, automountSAToken=false.
 *
 * NOTE: paperclip-server runs OUTSIDE the cluster, so we cannot set ownerReferences
 * on the Sandbox CR (the owner would need to be an in-cluster resource). The
 * release path is explicit delete via sandboxCrOrchestrator.release().
 */

export type ExpertResourceProfileName = "light" | "build" | "browser" | "office" | "load";

export interface ResolvedPodSizing {
  profile: ExpertResourceProfileName;
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
  workspaceSizeLimit: string;
  tmpSizeLimit: string;
  shmSizeLimit?: string;
}

export const EXPERT_PROFILE_PRESETS: Record<ExpertResourceProfileName, Omit<ResolvedPodSizing, "profile">> = {
  light: {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "1", memory: "2Gi" },
    workspaceSizeLimit: "8Gi",
    tmpSizeLimit: "2Gi",
  },
  build: {
    requests: { cpu: "1", memory: "2Gi" },
    limits: { cpu: "4", memory: "6Gi" },
    workspaceSizeLimit: "16Gi",
    tmpSizeLimit: "4Gi",
  },
  browser: {
    requests: { cpu: "1", memory: "2Gi" },
    limits: { cpu: "4", memory: "8Gi" },
    workspaceSizeLimit: "8Gi",
    tmpSizeLimit: "2Gi",
    shmSizeLimit: "1Gi",
  },
  office: {
    requests: { cpu: "500m", memory: "1Gi" },
    limits: { cpu: "2", memory: "4Gi" },
    workspaceSizeLimit: "8Gi",
    tmpSizeLimit: "4Gi",
  },
  load: {
    requests: { cpu: "500m", memory: "1Gi" },
    limits: { cpu: "2", memory: "4Gi" },
    workspaceSizeLimit: "8Gi",
    tmpSizeLimit: "2Gi",
  },
};

/**
 * Infers the resource sizing profile from the canonical image name (ignoring
 * registry prefix, tag, and @sha256 digest). Defaults to `"light"`.
 */
export function inferResourceProfileFromImage(image: string): ExpertResourceProfileName {
  const withoutDigest = image.split("@")[0] ?? image;
  const lastSlash = withoutDigest.lastIndexOf("/");
  const nameWithTag = lastSlash >= 0 ? withoutDigest.slice(lastSlash + 1) : withoutDigest;
  const name = nameWithTag.split(":")[0]?.toLowerCase() ?? "";

  if (name === "codex-test-web") return "browser";
  if (name === "codex-office-zh") return "office";
  if (name === "codex-test-load") return "load";
  if (
    name.startsWith("codex-java-") ||
    name === "codex-node" ||
    name === "codex-go" ||
    name.startsWith("codex-dotnet-")
  ) {
    return "build";
  }
  return "light";
}

export function resolvePodSizing(
  explicitProfile: ExpertResourceProfileName | null | undefined,
  image: string,
): ResolvedPodSizing {
  const profile = explicitProfile ?? inferResourceProfileFromImage(image);
  const preset = EXPERT_PROFILE_PRESETS[profile];
  return {
    profile,
    requests: { ...preset.requests },
    limits: { ...preset.limits },
    workspaceSizeLimit: preset.workspaceSizeLimit,
    tmpSizeLimit: preset.tmpSizeLimit,
    ...(preset.shmSizeLimit ? { shmSizeLimit: preset.shmSizeLimit } : {}),
  };
}

export interface BuildSandboxCrManifestInput {
  apiVersion?: "agents.x-k8s.io/v1alpha1" | "agents.x-k8s.io/v1beta1";
  namespace: string;
  sandboxName: string;
  adapterType: string;
  image: string;
  envSecretName: string;
  serviceAccountName: string;
  labels: Record<string, string>;
  resources: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  runtimeClassName?: string;
  imagePullSecrets?: string[];
  nodeSelector?: Record<string, string>;
  tolerations?: Array<{
    key: string;
    operator: "Equal" | "Exists";
    value?: string;
    effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
  }>;
  podAnnotations?: Record<string, string>;
  priorityClassName?: string;
  workspaceSizeLimit?: string;
  tmpSizeLimit?: string;
  shmSizeLimit?: string;
}

export function buildSandboxCrManifest(
  input: BuildSandboxCrManifestInput,
): Record<string, unknown> {
  const podLabels: Record<string, string> = {
    ...input.labels,
    "paperclip.io/role": "agent",
  };
  const volumeMounts: Array<{ name: string; mountPath: string }> = [
    { name: "workspace", mountPath: "/workspace" },
    { name: "home", mountPath: "/home/paperclip" },
    { name: "cache", mountPath: "/home/paperclip/.cache" },
    { name: "tmp", mountPath: "/tmp" },
  ];
  const volumes: Array<Record<string, unknown>> = [
    { name: "workspace", emptyDir: { sizeLimit: input.workspaceSizeLimit ?? "8Gi" } },
    { name: "home", emptyDir: { sizeLimit: "1Gi" } },
    { name: "cache", emptyDir: { sizeLimit: "1Gi" } },
    { name: "tmp", emptyDir: { sizeLimit: input.tmpSizeLimit ?? "2Gi" } },
  ];
  if (input.shmSizeLimit) {
    volumeMounts.push({ name: "dshm", mountPath: "/dev/shm" });
    volumes.push({ name: "dshm", emptyDir: { medium: "Memory", sizeLimit: input.shmSizeLimit } });
  }

  return {
    apiVersion: input.apiVersion ?? "agents.x-k8s.io/v1alpha1",
    kind: "Sandbox",
    metadata: {
      name: input.sandboxName,
      namespace: input.namespace,
      labels: { ...input.labels },
      // No ownerReferences: paperclip-server is out-of-cluster. Release is
      // explicit delete.
    },
    spec: {
      podTemplate: {
        metadata: {
          labels: podLabels,
          ...(input.podAnnotations && Object.keys(input.podAnnotations).length > 0
            ? { annotations: { ...input.podAnnotations } }
            : {}),
        },
        spec: {
          serviceAccountName: input.serviceAccountName,
          // Agent containers call back to paperclip-server via HTTPS egress;
          // they never call the Kubernetes API, so mounting an SA token is
          // unnecessary attack surface.
          automountServiceAccountToken: false,
          // Sandbox controller requires restartPolicy: Always so the pod
          // stays running between exec calls.
          restartPolicy: "Always",
          ...(input.nodeSelector && Object.keys(input.nodeSelector).length > 0
            ? { nodeSelector: { ...input.nodeSelector } }
            : {}),
          ...(input.tolerations && input.tolerations.length > 0
            ? { tolerations: input.tolerations.map((t) => ({ ...t })) }
            : {}),
          ...(input.priorityClassName
            ? { priorityClassName: input.priorityClassName }
            : {}),
          ...(input.runtimeClassName
            ? { runtimeClassName: input.runtimeClassName }
            : {}),
          ...(input.imagePullSecrets && input.imagePullSecrets.length > 0
            ? {
                imagePullSecrets: input.imagePullSecrets.map((name) => ({
                  name,
                })),
              }
            : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "agent",
              image: input.image,
              imagePullPolicy: "IfNotPresent",
              // sleep infinity keeps the pod running; paperclip-server execs
              // commands into it via Kubernetes exec API. Tini as PID 1 for
              // proper signal forwarding and zombie reaping.
              command: [
                "/usr/bin/tini",
                "--",
                "/bin/sh",
                "-c",
                "sleep infinity",
              ],
              // HOME must point at a writable mount; the image's default
              // HOME=/home/node is inside the readOnly root filesystem.
              // Claude (and most agent runtimes) silently exit with code 0
              // and no output when HOME is unwritable, so set this explicitly.
              env: [{ name: "HOME", value: "/home/paperclip" }],
              envFrom: [{ secretRef: { name: input.envSecretName } }],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: input.resources.requests ?? {
                  cpu: "250m",
                  memory: "512Mi",
                },
                limits: input.resources.limits ?? {
                  cpu: "2",
                  memory: "4Gi",
                },
              },
              volumeMounts,
            },
          ],
          volumes,
        },
      },
    },
  };
}
