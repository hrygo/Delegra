/**
 * Pre-dispatch capacity admission, ResourceQuota watermark backpressure,
 * aging priority queue, and C3/C4 Kata-FC microVM isolation enforcement.
 *
 * Key invariants:
 * - Reads live `ResourceQuota.status` (`used`/`hard`), WarmPool ready count,
 *   and cluster Pending Pod watermark BEFORE creating a Sandbox CR so bursts
 *   remain in `queued` state instead of flooding the cluster with Pending Pods.
 * - Explicit state machine: `queued -> dispatching -> running` (never emits
 *   stale results or false success on admission denial).
 * - Two-tier PriorityClass (`paperclip-expert-interactive` = 100000 vs
 *   `paperclip-expert-batch` = 10000) with wait-time aging to prevent starvation.
 * - Fail-closed C3/C4 regulated data isolation: mandates `runtimeClassName: kata-fc`,
 *   equal `requests.memory === limits.memory`, >= 512Mi memory offset annotation,
 *   and bare-metal `paperclip.io/runtime=kata-fc:NoSchedule` toleration/selector.
 */

import type { KubeClients } from "./kube-client.js";
import type { ExpertResourceProfileName } from "./sandbox-cr-builder.js";

export const PRIORITY_CLASS_INTERACTIVE = "paperclip-expert-interactive";
export const PRIORITY_CLASS_BATCH = "paperclip-expert-batch";
export const PRIORITY_VALUE_INTERACTIVE = 100_000;
export const PRIORITY_VALUE_BATCH = 10_000;
export const KATA_FC_RUNTIME_CLASS = "kata-fc";
export const KATA_FC_MIN_MEMORY_OFFSET_MI = 512;

export type DataClassificationLevel = "C1" | "C2" | "C3" | "C4";
export type DispatchLifecycleState = "queued" | "dispatching" | "running";
export type TenantQuotaTier = "small" | "medium" | "large";

export interface TenantQuotaSpec {
  pods: number;
  requestsCpu: string;
  requestsMemory: string;
  limitsCpu: string;
  limitsMemory: string;
}

export const TENANT_QUOTA_TIERS: Record<TenantQuotaTier, TenantQuotaSpec> = {
  small: {
    pods: 8,
    requestsCpu: "4",
    requestsMemory: "8Gi",
    limitsCpu: "12",
    limitsMemory: "24Gi",
  },
  medium: {
    pods: 24,
    requestsCpu: "16",
    requestsMemory: "32Gi",
    limitsCpu: "48",
    limitsMemory: "96Gi",
  },
  large: {
    pods: 64,
    requestsCpu: "48",
    requestsMemory: "96Gi",
    limitsCpu: "128",
    limitsMemory: "256Gi",
  },
};

/**
 * Parses a Kubernetes CPU quantity (e.g. `"250m"`, `"1"`, `"2.5"`) into millicores.
 */
export function parseCpuMillicores(raw: string | undefined | null): number {
  if (!raw) return 0;
  const s = raw.trim();
  if (s.endsWith("m")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  }
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : 0;
}

const BINARY_UNITS: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

const DECIMAL_UNITS: Record<string, number> = {
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
};

/**
 * Parses a Kubernetes memory quantity (e.g. `"512Mi"`, `"2Gi"`, `"1G"`) into bytes.
 */
export function parseMemoryBytes(raw: string | undefined | null): number {
  if (!raw) return 0;
  const s = raw.trim();
  for (const [suffix, mult] of Object.entries(BINARY_UNITS)) {
    if (s.endsWith(suffix)) {
      const n = Number(s.slice(0, -suffix.length));
      return Number.isFinite(n) && n >= 0 ? Math.round(n * mult) : 0;
    }
  }
  for (const [suffix, mult] of Object.entries(DECIMAL_UNITS)) {
    if (s.endsWith(suffix)) {
      const n = Number(s.slice(0, -suffix.length));
      return Number.isFinite(n) && n >= 0 ? Math.round(n * mult) : 0;
    }
  }
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/**
 * Builds the `paperclip-warm-pool-quota` sub-quota capped at `<= 25%` of the
 * tenant's quota tier so warm pods never starve active workloads.
 */
export function buildWarmPoolSubQuota(
  tier: TenantQuotaTier,
  ratio = 0.25,
): TenantQuotaSpec {
  const cappedRatio = Math.min(0.25, Math.max(0.05, ratio));
  const base = TENANT_QUOTA_TIERS[tier];
  const pods = Math.max(1, Math.floor(base.pods * cappedRatio));
  const reqCpuM = Math.max(250, Math.floor(parseCpuMillicores(base.requestsCpu) * cappedRatio));
  const limCpuM = Math.max(500, Math.floor(parseCpuMillicores(base.limitsCpu) * cappedRatio));
  const reqMemMi = Math.max(512, Math.floor((parseMemoryBytes(base.requestsMemory) / (1024 ** 2)) * cappedRatio));
  const limMemMi = Math.max(1024, Math.floor((parseMemoryBytes(base.limitsMemory) / (1024 ** 2)) * cappedRatio));
  return {
    pods,
    requestsCpu: `${reqCpuM}m`,
    requestsMemory: `${reqMemMi}Mi`,
    limitsCpu: `${limCpuM}m`,
    limitsMemory: `${limMemMi}Mi`,
  };
}

export interface QuotaWatermarkSnapshot {
  hard: Record<string, string>;
  used: Record<string, string>;
}

export interface AdmissionRequestResources {
  requestsCpu: string;
  requestsMemory: string;
  limitsCpu?: string;
  limitsMemory?: string;
}

export interface CapacityAdmissionInput {
  quota: QuotaWatermarkSnapshot | null;
  requested: AdmissionRequestResources;
  warmPoolReadyCount?: number;
  clusterPendingPods?: number;
  maxClusterPendingPods?: number;
}

export type CapacityAdmissionDecision =
  | {
      admitted: true;
      state: "dispatching";
      usedWarmPool: boolean;
      reason: "ok";
    }
  | {
      admitted: false;
      state: "queued";
      reason: "quota_exhausted" | "pending_backoff";
      detail: string;
      retryAfterMs: number;
    };

/**
 * Pure pre-dispatch admission check evaluating tenant `ResourceQuota.status`
 * headroom, warm-pool availability, and cluster-wide Pending Pod backoff.
 */
export function evaluateCapacityAdmission(
  input: CapacityAdmissionInput,
): CapacityAdmissionDecision {
  const maxPending = input.maxClusterPendingPods ?? 10;
  const pendingPods = input.clusterPendingPods ?? 0;

  // If a warm pod is already Running and ready, it does not add a new Pending pod.
  const hasWarmPod = (input.warmPoolReadyCount ?? 0) > 0;
  if (!hasWarmPod && pendingPods >= maxPending) {
    return {
      admitted: false,
      state: "queued",
      reason: "pending_backoff",
      detail: `Cluster Pending pod count (${pendingPods}) reached backoff threshold (${maxPending}).`,
      retryAfterMs: 5_000,
    };
  }

  if (input.quota) {
    const { hard, used } = input.quota;

    const hardPods = Number(hard.pods ?? NaN);
    const usedPods = Number(used.pods ?? 0);
    if (Number.isFinite(hardPods) && usedPods + 1 > hardPods) {
      return {
        admitted: false,
        state: "queued",
        reason: "quota_exhausted",
        detail: `Tenant pod quota exhausted (${usedPods}/${hardPods}).`,
        retryAfterMs: 3_000,
      };
    }

    const hardReqCpu = parseCpuMillicores(hard["requests.cpu"]);
    const usedReqCpu = parseCpuMillicores(used["requests.cpu"]);
    const needReqCpu = parseCpuMillicores(input.requested.requestsCpu);
    if (hardReqCpu > 0 && usedReqCpu + needReqCpu > hardReqCpu) {
      return {
        admitted: false,
        state: "queued",
        reason: "quota_exhausted",
        detail: `Tenant requests.cpu quota exhausted (${usedReqCpu}m + ${needReqCpu}m > ${hardReqCpu}m).`,
        retryAfterMs: 3_000,
      };
    }

    const hardReqMem = parseMemoryBytes(hard["requests.memory"]);
    const usedReqMem = parseMemoryBytes(used["requests.memory"]);
    const needReqMem = parseMemoryBytes(input.requested.requestsMemory);
    if (hardReqMem > 0 && usedReqMem + needReqMem > hardReqMem) {
      return {
        admitted: false,
        state: "queued",
        reason: "quota_exhausted",
        detail: `Tenant requests.memory quota exhausted (${usedReqMem} + ${needReqMem} > ${hardReqMem}).`,
        retryAfterMs: 3_000,
      };
    }

    const hardLimCpu = parseCpuMillicores(hard["limits.cpu"]);
    const usedLimCpu = parseCpuMillicores(used["limits.cpu"]);
    const needLimCpu = parseCpuMillicores(input.requested.limitsCpu);
    if (hardLimCpu > 0 && needLimCpu > 0 && usedLimCpu + needLimCpu > hardLimCpu) {
      return {
        admitted: false,
        state: "queued",
        reason: "quota_exhausted",
        detail: `Tenant limits.cpu quota exhausted (${usedLimCpu}m + ${needLimCpu}m > ${hardLimCpu}m).`,
        retryAfterMs: 3_000,
      };
    }

    const hardLimMem = parseMemoryBytes(hard["limits.memory"]);
    const usedLimMem = parseMemoryBytes(used["limits.memory"]);
    const needLimMem = parseMemoryBytes(input.requested.limitsMemory);
    if (hardLimMem > 0 && needLimMem > 0 && usedLimMem + needLimMem > hardLimMem) {
      return {
        admitted: false,
        state: "queued",
        reason: "quota_exhausted",
        detail: `Tenant limits.memory quota exhausted (${usedLimMem} + ${needLimMem} > ${hardLimMem}).`,
        retryAfterMs: 3_000,
      };
    }
  }

  return {
    admitted: true,
    state: "dispatching",
    usedWarmPool: hasWarmPod,
    reason: "ok",
  };
}

/**
 * Reads the live `ResourceQuota.status` (`hard` / `used`) for a tenant namespace.
 */
export async function readTenantQuotaWatermark(
  clients: KubeClients,
  namespace: string,
  quotaName = "paperclip-tenant-quota",
): Promise<QuotaWatermarkSnapshot | null> {
  try {
    const quota = (await clients.core.readNamespacedResourceQuota({
      namespace,
      name: quotaName,
    })) as {
      status?: {
        hard?: Record<string, string>;
        used?: Record<string, string>;
      };
    };
    if (!quota?.status?.hard) return null;
    return {
      hard: quota.status.hard ?? {},
      used: quota.status.used ?? {},
    };
  } catch (err) {
    const code =
      (err as { code?: number; statusCode?: number }).code ??
      (err as { code?: number; statusCode?: number }).statusCode;
    if (code === 404) return null;
    throw err;
  }
}

export class KataIsolationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KataIsolationRequiredError";
  }
}

export interface SensitiveIsolationInput {
  dataClassification?: DataClassificationLevel;
  configuredRuntimeClassName?: string | null;
  kataFcAvailable?: boolean;
  requestsMemory: string;
  limitsMemory: string;
  memoryOffsetMi?: number;
}

export interface ResolvedIsolationPolicy {
  runtimeClassName?: string;
  requestsMemory: string;
  limitsMemory: string;
  nodeSelector?: Record<string, string>;
  tolerations?: Array<{
    key: string;
    operator: "Equal";
    value: string;
    effect: "NoSchedule";
  }>;
  podAnnotations?: Record<string, string>;
}

/**
 * Enforces fail-closed `kata-fc` microVM isolation for regulated C3/C4 workloads:
 * - Rejects startup (never degrades to `runc`) if `kata-fc` is unavailable or
 *   mismatched.
 * - Enforces `requests.memory === limits.memory` (guaranteed memory) and
 *   `memory_offset >= 512Mi` to prevent silent Guest OOM on Firecracker ARM64.
 * - Adds `paperclip.io/runtime: kata-fc` nodeSelector and `NoSchedule` toleration.
 */
export function resolveSensitiveIsolationPolicy(
  input: SensitiveIsolationInput,
): ResolvedIsolationPolicy {
  const isRegulated = input.dataClassification === "C3" || input.dataClassification === "C4";
  if (!isRegulated) {
    return {
      ...(input.configuredRuntimeClassName
        ? { runtimeClassName: input.configuredRuntimeClassName }
        : {}),
      requestsMemory: input.requestsMemory,
      limitsMemory: input.limitsMemory,
    };
  }

  if (input.kataFcAvailable === false) {
    throw new KataIsolationRequiredError(
      `Regulated workload (${input.dataClassification}) requires runtimeClassName="${KATA_FC_RUNTIME_CLASS}", ` +
        `but kata-fc is not available on the target cluster (fail-closed; refusing to downgrade).`,
    );
  }

  if (
    input.configuredRuntimeClassName &&
    input.configuredRuntimeClassName !== KATA_FC_RUNTIME_CLASS
  ) {
    throw new KataIsolationRequiredError(
      `Regulated workload (${input.dataClassification}) forbids runtimeClassName="${input.configuredRuntimeClassName}"; ` +
        `must use "${KATA_FC_RUNTIME_CLASS}".`,
    );
  }

  const reqBytes = parseMemoryBytes(input.requestsMemory);
  const limBytes = parseMemoryBytes(input.limitsMemory);
  if (reqBytes <= 0 || limBytes <= 0 || reqBytes !== limBytes) {
    throw new KataIsolationRequiredError(
      `Kata-FC requires requests.memory === limits.memory to prevent silent Guest OOM ` +
        `(got requests=${input.requestsMemory}, limits=${input.limitsMemory}).`,
    );
  }

  const memoryOffsetMi = Math.max(
    KATA_FC_MIN_MEMORY_OFFSET_MI,
    Math.floor(input.memoryOffsetMi ?? KATA_FC_MIN_MEMORY_OFFSET_MI),
  );

  return {
    runtimeClassName: KATA_FC_RUNTIME_CLASS,
    requestsMemory: input.requestsMemory,
    limitsMemory: input.limitsMemory,
    nodeSelector: {
      "kubernetes.io/arch": "arm64",
      "paperclip.io/runtime": KATA_FC_RUNTIME_CLASS,
    },
    tolerations: [
      {
        key: "paperclip.io/runtime",
        operator: "Equal",
        value: KATA_FC_RUNTIME_CLASS,
        effect: "NoSchedule",
      },
    ],
    podAnnotations: {
      "io.katacontainers.config.hypervisor.default_memory_offset_mb": String(memoryOffsetMi),
    },
  };
}

export interface QueuedDispatchItem {
  runId: string;
  profile: ExpertResourceProfileName;
  priorityClassName: typeof PRIORITY_CLASS_INTERACTIVE | typeof PRIORITY_CLASS_BATCH;
  enqueuedAtMs: number;
  state: DispatchLifecycleState;
}

export interface BackpressureMetricsSnapshot {
  queueDepth: number;
  admissionRejects: number;
  pendingPeak: number;
  waitMsByProfile: Record<string, { count: number; p50Ms: number; p95Ms: number }>;
}

/**
 * Priority queue with wait-time aging (`effectiveScore = basePriority + waitSec * agingWeight`)
 * and control-plane backpressure metrics.
 */
export class PriorityBackpressureQueue {
  private readonly items = new Map<string, QueuedDispatchItem>();
  private readonly agingWeightPerSec: number;
  private admissionRejects = 0;
  private pendingPeak = 0;
  private readonly waitSamplesByProfile = new Map<string, number[]>();

  constructor(agingWeightPerSec = 500) {
    this.agingWeightPerSec = agingWeightPerSec;
  }

  enqueue(input: {
    runId: string;
    profile: ExpertResourceProfileName;
    priorityClassName: typeof PRIORITY_CLASS_INTERACTIVE | typeof PRIORITY_CLASS_BATCH;
    nowMs?: number;
  }): QueuedDispatchItem {
    const existing = this.items.get(input.runId);
    if (existing) {
      existing.state = "queued";
      return existing;
    }
    const item: QueuedDispatchItem = {
      runId: input.runId,
      profile: input.profile,
      priorityClassName: input.priorityClassName,
      enqueuedAtMs: input.nowMs ?? Date.now(),
      state: "queued",
    };
    this.items.set(input.runId, item);
    return item;
  }

  recordAdmissionReject(): void {
    this.admissionRejects += 1;
  }

  observePendingPods(count: number): void {
    if (count > this.pendingPeak) {
      this.pendingPeak = count;
    }
  }

  /**
   * Computes aging-adjusted score so interactive tasks win during peaks while
   * long-waiting batch tasks smoothly gain priority instead of starving.
   */
  scoreOf(item: QueuedDispatchItem, nowMs = Date.now()): number {
    const base =
      item.priorityClassName === PRIORITY_CLASS_INTERACTIVE
        ? PRIORITY_VALUE_INTERACTIVE
        : PRIORITY_VALUE_BATCH;
    const waitSec = Math.max(0, (nowMs - item.enqueuedAtMs) / 1000);
    return base + waitSec * this.agingWeightPerSec;
  }

  /**
   * Transitions the highest-scoring `queued` item to `dispatching`.
   */
  dequeueNext(nowMs = Date.now()): QueuedDispatchItem | null {
    let best: QueuedDispatchItem | null = null;
    let bestScore = -Infinity;
    for (const item of this.items.values()) {
      if (item.state !== "queued") continue;
      const score = this.scoreOf(item, nowMs);
      if (score > bestScore || (score === bestScore && best && item.enqueuedAtMs < best.enqueuedAtMs)) {
        best = item;
        bestScore = score;
      }
    }
    if (!best) return null;
    best.state = "dispatching";
    return best;
  }

  markRunning(runId: string, nowMs = Date.now()): void {
    const item = this.items.get(runId);
    if (!item) return;
    item.state = "running";
    const waitMs = Math.max(0, nowMs - item.enqueuedAtMs);
    let samples = this.waitSamplesByProfile.get(item.profile);
    if (!samples) {
      samples = [];
      this.waitSamplesByProfile.set(item.profile, samples);
    }
    samples.push(waitMs);
    this.items.delete(runId);
  }

  requeueOnPreemption(runId: string): void {
    const item = this.items.get(runId);
    if (item) {
      item.state = "queued";
    }
  }

  snapshot(): BackpressureMetricsSnapshot {
    let queueDepth = 0;
    for (const item of this.items.values()) {
      if (item.state === "queued") queueDepth += 1;
    }
    const waitMsByProfile: BackpressureMetricsSnapshot["waitMsByProfile"] = {};
    for (const [profile, samples] of this.waitSamplesByProfile.entries()) {
      const sorted = [...samples].sort((a, b) => a - b);
      const pct = (p: number) =>
        sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
      waitMsByProfile[profile] = {
        count: sorted.length,
        p50Ms: pct(50),
        p95Ms: pct(95),
      };
    }
    return {
      queueDepth,
      admissionRejects: this.admissionRejects,
      pendingPeak: this.pendingPeak,
      waitMsByProfile,
    };
  }
}
