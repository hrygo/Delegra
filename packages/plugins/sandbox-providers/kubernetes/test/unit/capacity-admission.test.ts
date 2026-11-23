import { describe, it, expect } from "vitest";
import {
  buildWarmPoolSubQuota,
  evaluateCapacityAdmission,
  KATA_FC_RUNTIME_CLASS,
  KataIsolationRequiredError,
  parseCpuMillicores,
  parseMemoryBytes,
  PRIORITY_CLASS_BATCH,
  PRIORITY_CLASS_INTERACTIVE,
  PriorityBackpressureQueue,
  resolveSensitiveIsolationPolicy,
  TENANT_QUOTA_TIERS,
} from "../../src/capacity-admission.js";

describe("K8s quantity parsing & tenant quota sub-allocation", () => {
  it("parses CPU millicores and memory bytes accurately", () => {
    expect(parseCpuMillicores("250m")).toBe(250);
    expect(parseCpuMillicores("2")).toBe(2000);
    expect(parseCpuMillicores("1.5")).toBe(1500);
    expect(parseMemoryBytes("512Mi")).toBe(512 * 1024 * 1024);
    expect(parseMemoryBytes("2Gi")).toBe(2 * 1024 ** 3);
  });

  it("caps paperclip-warm-pool-quota at <= 25% of tenant tier", () => {
    const sub = buildWarmPoolSubQuota("medium", 0.5); // over-request clamped to 0.25
    expect(sub.pods).toBeLessThanOrEqual(TENANT_QUOTA_TIERS.medium.pods * 0.25);
    expect(parseCpuMillicores(sub.requestsCpu)).toBeLessThanOrEqual(
      parseCpuMillicores(TENANT_QUOTA_TIERS.medium.requestsCpu) * 0.25,
    );
  });
});

describe("evaluateCapacityAdmission", () => {
  it("defers to queued state when tenant pod or CPU quota is exhausted (zero Pending Pods)", () => {
    const podFull = evaluateCapacityAdmission({
      quota: {
        hard: { pods: "8", "requests.cpu": "16", "requests.memory": "32Gi" },
        used: { pods: "8", "requests.cpu": "4", "requests.memory": "8Gi" },
      },
      requested: { requestsCpu: "250m", requestsMemory: "512Mi" },
    });
    expect(podFull.admitted).toBe(false);
    if (!podFull.admitted) {
      expect(podFull.state).toBe("queued");
      expect(podFull.reason).toBe("quota_exhausted");
    }

    const cpuFull = evaluateCapacityAdmission({
      quota: {
        hard: { pods: "8", "requests.cpu": "4", "requests.memory": "16Gi" },
        used: { pods: "2", "requests.cpu": "3500m", "requests.memory": "4Gi" },
      },
      requested: { requestsCpu: "1", requestsMemory: "2Gi" },
    });
    expect(cpuFull.admitted).toBe(false);
    if (!cpuFull.admitted) {
      expect(cpuFull.reason).toBe("quota_exhausted");
    }
  });

  it("triggers pending_backoff on cold starts when cluster Pending Pods hit threshold, but admits warm hits", () => {
    const coldBlocked = evaluateCapacityAdmission({
      quota: null,
      requested: { requestsCpu: "250m", requestsMemory: "512Mi" },
      warmPoolReadyCount: 0,
      clusterPendingPods: 12,
      maxClusterPendingPods: 10,
    });
    expect(coldBlocked.admitted).toBe(false);
    if (!coldBlocked.admitted) {
      expect(coldBlocked.reason).toBe("pending_backoff");
    }

    const warmAllowed = evaluateCapacityAdmission({
      quota: null,
      requested: { requestsCpu: "250m", requestsMemory: "512Mi" },
      warmPoolReadyCount: 3,
      clusterPendingPods: 12,
      maxClusterPendingPods: 10,
    });
    expect(warmAllowed.admitted).toBe(true);
    if (warmAllowed.admitted) {
      expect(warmAllowed.usedWarmPool).toBe(true);
    }
  });
});

describe("resolveSensitiveIsolationPolicy (Kata-FC fail-closed)", () => {
  it("mandates kata-fc with guaranteed memory, 512Mi offset, and NoSchedule toleration for C3/C4", () => {
    const policy = resolveSensitiveIsolationPolicy({
      dataClassification: "C4",
      kataFcAvailable: true,
      requestsMemory: "4Gi",
      limitsMemory: "4Gi",
    });
    expect(policy.runtimeClassName).toBe(KATA_FC_RUNTIME_CLASS);
    expect(policy.nodeSelector).toEqual({
      "kubernetes.io/arch": "arm64",
      "paperclip.io/runtime": "kata-fc",
    });
    expect(policy.tolerations?.[0]).toMatchObject({
      key: "paperclip.io/runtime",
      value: "kata-fc",
      effect: "NoSchedule",
    });
    expect(
      policy.podAnnotations?.["io.katacontainers.config.hypervisor.default_memory_offset_mb"],
    ).toBe("512");
  });

  it("fails closed when kata-fc is unavailable or requests.memory !== limits.memory", () => {
    expect(() =>
      resolveSensitiveIsolationPolicy({
        dataClassification: "C3",
        kataFcAvailable: false,
        requestsMemory: "4Gi",
        limitsMemory: "4Gi",
      }),
    ).toThrow(KataIsolationRequiredError);

    expect(() =>
      resolveSensitiveIsolationPolicy({
        dataClassification: "C3",
        kataFcAvailable: true,
        requestsMemory: "2Gi",
        limitsMemory: "4Gi",
      }),
    ).toThrow(/requests\.memory === limits\.memory/);
  });
});

describe("PriorityBackpressureQueue", () => {
  it("prioritizes interactive over batch, supports aging, and tracks backpressure metrics", () => {
    const queue = new PriorityBackpressureQueue(500);
    queue.enqueue({
      runId: "batch-1",
      profile: "build",
      priorityClassName: PRIORITY_CLASS_BATCH,
      nowMs: 1_000,
    });
    queue.enqueue({
      runId: "interactive-1",
      profile: "light",
      priorityClassName: PRIORITY_CLASS_INTERACTIVE,
      nowMs: 2_000,
    });
    queue.recordAdmissionReject();
    queue.observePendingPods(7);

    const first = queue.dequeueNext(3_000);
    expect(first?.runId).toBe("interactive-1");
    expect(first?.state).toBe("dispatching");
    queue.markRunning("interactive-1", 3_000);

    const second = queue.dequeueNext(4_000);
    expect(second?.runId).toBe("batch-1");
    queue.requeueOnPreemption("batch-1");
    expect(queue.snapshot().queueDepth).toBe(1);

    const snap = queue.snapshot();
    expect(snap.admissionRejects).toBe(1);
    expect(snap.pendingPeak).toBe(7);
    expect(snap.waitMsByProfile.light).toEqual({ count: 1, p50Ms: 1000, p95Ms: 1000 });
  });
});
