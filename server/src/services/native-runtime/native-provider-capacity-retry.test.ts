import { describe, it, expect } from "vitest";
import {
  classifyCapacityBackpressureError,
  computeCapacityBackoffMs,
  isRetryableCapacityError,
  materializeNativeProviderCapacityRetry,
} from "./native-provider-capacity-retry.js";

describe("native-provider-capacity-retry", () => {
  it("exports materializeNativeProviderCapacityRetry alongside backpressure helpers", () => {
    expect(materializeNativeProviderCapacityRetry).toBeTypeOf("function");
  });

  it("classifies quota_exhausted, pending_backoff, pool_exhausted, and 429/503 as queued retries", () => {
    const q = classifyCapacityBackpressureError(
      { reason: "quota_exhausted", retryAfterMs: 3000 },
      1,
      0,
    );
    expect(q).toEqual({
      retryable: true,
      nextState: "queued",
      reason: "quota_exhausted",
      retryAfterMs: 3000,
    });

    const p = classifyCapacityBackpressureError(
      new Error("Cluster Pending pod count reached backoff threshold"),
      2,
      0,
    );
    expect(p?.reason).toBe("pending_backoff");
    expect(p?.nextState).toBe("queued");
    expect(p?.retryAfterMs).toBe(4000);

    expect(isRetryableCapacityError({ statusCode: 429 })).toBe(true);
    expect(isRetryableCapacityError(new Error("Invalid image digest"))).toBe(false);
  });

  it("caps exponential backoff at maxDelayMs", () => {
    expect(computeCapacityBackoffMs({ attempt: 1, baseDelayMs: 1000, maxDelayMs: 10_000, jitterFactor: 0 })).toBe(1000);
    expect(computeCapacityBackoffMs({ attempt: 6, baseDelayMs: 1000, maxDelayMs: 10_000, jitterFactor: 1 })).toBe(10_000);
  });
});
