/**
 * SandboxOrchestrator implementation backed by the kubernetes-sigs/agent-sandbox
 * Sandbox CRD (`agents.x-k8s.io/v1alpha1` or `agents.x-k8s.io/v1beta1`).
 */

import type { KubeClients } from "./kube-client.js";
import type { SandboxOrchestrator, SandboxStatus } from "./sandbox-orchestrator.js";

const SANDBOX_GROUP = "agents.x-k8s.io";
const DEFAULT_SANDBOX_VERSION = "v1alpha1";
const SANDBOX_PLURAL = "sandboxes";

export type SandboxCrApiVersion =
  | "agents.x-k8s.io/v1alpha1"
  | "agents.x-k8s.io/v1beta1";

export function extractSandboxVersion(
  apiVersion?: SandboxCrApiVersion | string,
): "v1alpha1" | "v1beta1" {
  if (apiVersion === "agents.x-k8s.io/v1beta1" || apiVersion === "v1beta1") {
    return "v1beta1";
  }
  return DEFAULT_SANDBOX_VERSION;
}

export class SandboxCrTimeoutError extends Error {
  constructor(namespace: string, name: string, timeoutMs: number) {
    super(
      `Sandbox ${namespace}/${name} did not reach Ready phase within ${timeoutMs}ms`,
    );
    this.name = "SandboxCrTimeoutError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapSandboxPhase(cr: Record<string, unknown>): SandboxStatus {
  const status = (cr.status as Record<string, unknown>) ?? {};
  const phase = (status.phase as string) ?? "Pending";

  switch (phase) {
    case "Ready":
      return { phase: "Running", complete: false, active: 1, succeeded: 0, failed: 0 };
    case "Terminating":
      return { phase: "Running", complete: false, active: 0, succeeded: 0, failed: 0, reason: "Terminating" };
    case "Failed": {
      const conditions = (status.conditions as { type?: string; reason?: string; message?: string }[]) ?? [];
      const failedCond = conditions.find((c) => c.type === "Failed");
      return {
        phase: "Failed",
        complete: false,
        active: 0,
        succeeded: 0,
        failed: 1,
        reason: failedCond?.reason,
        message: failedCond?.message,
      };
    }
    default:
      return { phase: "Pending", complete: false, active: 0, succeeded: 0, failed: 0 };
  }
}

export async function createSandboxCr(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
  apiVersion?: SandboxCrApiVersion,
): Promise<{ uid: string }> {
  const version = extractSandboxVersion(
    apiVersion ?? (typeof manifest.apiVersion === "string" ? manifest.apiVersion : undefined),
  );
  const result = await clients.custom.createNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version,
    namespace,
    plural: SANDBOX_PLURAL,
    body: manifest,
  });
  const uid = (result as { metadata?: { uid?: string } }).metadata?.uid;
  if (!uid) throw new Error("Sandbox CR created without a UID");
  return { uid };
}

export async function getSandboxCrStatus(
  clients: KubeClients,
  namespace: string,
  name: string,
  apiVersion?: SandboxCrApiVersion,
): Promise<SandboxStatus> {
  const version = extractSandboxVersion(apiVersion);
  const result = await clients.custom.getNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version,
    namespace,
    plural: SANDBOX_PLURAL,
    name,
  });
  return mapSandboxPhase(result as Record<string, unknown>);
}

export async function findPodForSandbox(
  clients: KubeClients,
  namespace: string,
  name: string,
  apiVersion?: SandboxCrApiVersion,
): Promise<string | null> {
  const version = extractSandboxVersion(apiVersion);
  const cr = await clients.custom.getNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version,
    namespace,
    plural: SANDBOX_PLURAL,
    name,
  }) as Record<string, unknown>;

  const status = (cr.status as Record<string, unknown>) ?? {};
  const podName = status.podName as string | undefined;
  if (podName && podName.trim().length > 0) {
    return podName;
  }

  try {
    const pod = (await clients.core.readNamespacedPod({ namespace, name })) as {
      metadata?: { name?: string };
    };
    if (pod?.metadata?.name) {
      return pod.metadata.name;
    }
  } catch (err) {
    const code =
      (err as { code?: number; statusCode?: number }).code ??
      (err as { code?: number; statusCode?: number }).statusCode;
    if (code !== 404) throw err;
  }

  const result = await clients.core.listNamespacedPod({
    namespace,
    labelSelector: `agents.x-k8s.io/sandbox-name=${name}`,
  });
  const items =
    (
      (
        result as {
          items?: {
            metadata?: { name?: string; labels?: Record<string, string> };
            status?: { phase?: string };
          }[];
        }
      ).items
    ) ?? [];

  const matching = items.filter(
    (p) => (p.metadata?.labels ?? {})["agents.x-k8s.io/sandbox-name"] === name,
  );

  const running = matching.find((p) => p.status?.phase === "Running");
  return (running ?? matching[0])?.metadata?.name ?? null;
}

export async function streamSandboxLogs(
  clients: KubeClients,
  namespace: string,
  podName: string,
  onChunk: (stream: "stdout" | "stderr", text: string) => Promise<void>,
): Promise<void> {
  const result = await clients.core.readNamespacedPodLog({
    namespace,
    name: podName,
  });
  const text = (result as string) ?? "";
  if (text.length > 0) await onChunk("stdout", text);
}

export async function deleteSandboxCr(
  clients: KubeClients,
  namespace: string,
  name: string,
  apiVersion?: SandboxCrApiVersion,
): Promise<void> {
  const version = extractSandboxVersion(apiVersion);
  await clients.custom.deleteNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version,
    namespace,
    plural: SANDBOX_PLURAL,
    name,
    propagationPolicy: "Foreground",
  });
}

export async function waitForSandboxReady(
  clients: KubeClients,
  namespace: string,
  name: string,
  opts: { timeoutMs: number; pollMs?: number; apiVersion?: SandboxCrApiVersion } = {
    timeoutMs: 120_000,
    pollMs: 2000,
  },
): Promise<SandboxStatus> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 2000;
  const version = extractSandboxVersion(opts.apiVersion);

  while (Date.now() < deadline) {
    const cr = await clients.custom.getNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version,
      namespace,
      plural: SANDBOX_PLURAL,
      name,
    }) as Record<string, unknown>;

    const metadata = (cr.metadata as Record<string, unknown>) ?? {};
    const status = (cr.status as Record<string, unknown>) ?? {};
    const generation = typeof metadata.generation === "number" ? metadata.generation : undefined;

    if (
      generation !== undefined &&
      typeof status.observedGeneration === "number" &&
      status.observedGeneration < generation
    ) {
      await sleep(pollMs);
      continue;
    }

    const conditions = Array.isArray(status.conditions) ? status.conditions as Array<Record<string, unknown>> : [];
    const readyCondition = conditions.find((c) => c.type === "Ready");
    const readyObsGen =
      typeof readyCondition?.observedGeneration === "number"
        ? readyCondition.observedGeneration
        : undefined;
    if (generation !== undefined && readyObsGen !== undefined && readyObsGen < generation) {
      await sleep(pollMs);
      continue;
    }

    const failedCondition = conditions.find((c) => c.type === "Failed" || (c.type === "Ready" && c.status === "False" && typeof c.reason === "string" && /failed/i.test(c.reason)));
    const phase = (status.phase as string) ?? "";

    if (readyCondition?.status === "True" || phase === "Ready") {
      return mapSandboxPhase(cr);
    }
    if (failedCondition?.status === "True" || phase === "Failed") {
      const mapped = mapSandboxPhase(cr);
      throw new Error(
        `Sandbox ${namespace}/${name} failed: ${mapped.reason ?? (failedCondition?.reason as string) ?? "unknown reason"} — ${mapped.message ?? (failedCondition?.message as string) ?? ""}`,
      );
    }
    if (phase === "Terminating") {
      throw new Error(
        `Sandbox ${namespace}/${name} is Terminating — cannot wait for Ready`,
      );
    }
    await sleep(pollMs);
  }

  throw new SandboxCrTimeoutError(namespace, name, opts.timeoutMs);
}

export function createSandboxCrOrchestrator(
  apiVersion: SandboxCrApiVersion = "agents.x-k8s.io/v1alpha1",
): SandboxOrchestrator {
  return {
    claim: (clients, namespace, manifest) =>
      createSandboxCr(clients, namespace, manifest, apiVersion),
    getStatus: (clients, namespace, name) =>
      getSandboxCrStatus(clients, namespace, name, apiVersion),
    findPod: (clients, namespace, name) =>
      findPodForSandbox(clients, namespace, name, apiVersion),
    streamLogs: streamSandboxLogs,
    release: (clients, namespace, name) =>
      deleteSandboxCr(clients, namespace, name, apiVersion),
    waitForCompletion: (clients, namespace, name, opts) =>
      waitForSandboxReady(clients, namespace, name, { ...opts, apiVersion }),
  };
}

export const sandboxCrOrchestrator: SandboxOrchestrator = createSandboxCrOrchestrator("agents.x-k8s.io/v1alpha1");
