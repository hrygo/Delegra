/**
 * Provider-agnostic capacity backpressure retry classifier and bounded backoff
 * helper for native runtime dispatch.
 *
 * When a sandbox provider (e.g. Kubernetes ResourceQuota watermark or Pending
 * Pod backoff) defers admission, the run stays explicitly in `queued` state
 * for DSH rather than failing or returning stale output.
 */

export type CapacityBackpressureReason =
  | "quota_exhausted"
  | "pending_backoff"
  | "pool_exhausted"
  | "provider_rate_limited";

export interface CapacityBackpressureClassification {
  retryable: true;
  nextState: "queued";
  reason: CapacityBackpressureReason;
  retryAfterMs: number;
}

export interface ComputeBackoffOptions {
  attempt: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Deterministic jitter factor in [0, 1] for tests; defaults to Math.random(). */
  jitterFactor?: number;
}

/**
 * Computes bounded exponential backoff with up to 25% positive jitter.
 */
export function computeCapacityBackoffMs(opts: ComputeBackoffOptions): number {
  const attempt = Math.max(1, Math.floor(opts.attempt));
  const base = Math.max(100, opts.baseDelayMs ?? 2_000);
  const cap = Math.max(base, opts.maxDelayMs ?? 60_000);
  const exp = Math.min(cap, base * Math.pow(2, attempt - 1));
  const jitter = Math.min(1, Math.max(0, opts.jitterFactor ?? Math.random()));
  return Math.min(cap, Math.round(exp * (1 + 0.25 * jitter)));
}

/**
 * Classifies an error or admission response from a sandbox provider into a
 * retryable `queued` backpressure decision, or `null` if the error is fatal.
 */
export function classifyCapacityBackpressureError(
  err: unknown,
  attempt = 1,
  jitterFactor?: number,
): CapacityBackpressureClassification | null {
  if (!err || typeof err !== "object") return null;

  const record = err as {
    reason?: unknown;
    code?: unknown;
    statusCode?: unknown;
    status?: unknown;
    retryAfterMs?: unknown;
    message?: unknown;
  };

  const explicitReason = typeof record.reason === "string" ? record.reason : "";
  const message = typeof record.message === "string" ? record.message : "";
  const status =
    typeof record.statusCode === "number"
      ? record.statusCode
      : typeof record.status === "number"
        ? record.status
        : typeof record.code === "number"
          ? record.code
          : 0;

  let reason: CapacityBackpressureReason | null = null;
  if (explicitReason === "quota_exhausted" || /exceeded quota|quota exhausted/i.test(message)) {
    reason = "quota_exhausted";
  } else if (explicitReason === "pending_backoff" || /pending pod.*backoff/i.test(message)) {
    reason = "pending_backoff";
  } else if (explicitReason === "pool_exhausted" || /warm ?pool.*exhausted/i.test(message)) {
    reason = "pool_exhausted";
  } else if (status === 429 || status === 503) {
    reason = "provider_rate_limited";
  }

  if (!reason) return null;

  const hinted =
    typeof record.retryAfterMs === "number" && record.retryAfterMs > 0
      ? record.retryAfterMs
      : computeCapacityBackoffMs({ attempt, jitterFactor });

  return {
    retryable: true,
    nextState: "queued",
    reason,
    retryAfterMs: hinted,
  };
}

export function isRetryableCapacityError(err: unknown): boolean {
  return classifyCapacityBackpressureError(err) !== null;
}
