import { createHash, randomInt } from "node:crypto";
import type { DigestVerificationStatus, KubernetesRuntimeEvidence } from "./types.js";

const ULID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

// Namespace names are capped at 63 chars (RFC 1123). The default "paperclip-"
// prefix leaves 53 for the slug, which fits a full 36-char UUID untruncated.
const MAX_SLUG_LENGTH = 53;

export function deriveCompanySlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+$/, "");
  if (slug.length === 0) return "company";
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  // Never drop entropy by plain truncation: two long inputs sharing a prefix
  // (e.g. UUIDs differing only in their tail) must not map to the same slug,
  // or the tenants would share a namespace and each other's per-run Secrets.
  // Keep a readable head and append a hash of the FULL input so every byte
  // contributes to the final name.
  const digest = createHash("sha256").update(input).digest("hex").slice(0, 8);
  return `${slug.slice(0, MAX_SLUG_LENGTH - 9).replace(/-+$/, "")}-${digest}`;
}

export function deriveNamespaceName(prefix: string, slug: string): string {
  return `${prefix}${slug}`;
}

export function newRunUlidDns(now: () => number = Date.now): string {
  const timestamp = now();
  let out = "";
  let t = timestamp;
  for (let i = 0; i < 10; i++) {
    out = ULID_ALPHABET[t & 0x1f] + out;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) {
    // crypto-strength randomness: these become Job/Sandbox CR names and the
    // providerLeaseId, so they must not be enumerable.
    out += ULID_ALPHABET[randomInt(32)];
  }
  return out;
}

/**
 * Sanitizes a string into a valid Kubernetes label value:
 * `[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?`, max 63 chars.
 */
export function sanitizeLabelValue(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (cleaned.length === 0) return "unknown";
  if (cleaned.length <= 63) return cleaned;
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${cleaned.slice(0, 54).replace(/[^A-Za-z0-9]+$/, "")}-${hash}`;
}

/**
 * Strips leading `http://` or `https://` scheme and trailing slashes from an
 * operator-configured `imageRegistry` URL before rewriting OCI image refs.
 */
export function stripRegistryScheme(registry?: string): string | undefined {
  if (!registry) return undefined;
  const trimmed = registry.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface LabelsInput {
  runId: string;
  agentId: string;
  companyId: string;
  adapterType: string;
  resourceProfile?: string;
  nodeArch?: string;
}

export function paperclipLabels(input: LabelsInput): Record<string, string> {
  return {
    "paperclip.io/run-id": sanitizeLabelValue(input.runId),
    "paperclip.io/agent-id": sanitizeLabelValue(input.agentId),
    "paperclip.io/company-id": sanitizeLabelValue(input.companyId),
    "paperclip.io/adapter": sanitizeLabelValue(input.adapterType),
    "paperclip.io/managed-by": "paperclip-k8s-plugin",
    ...(input.resourceProfile
      ? { "paperclip.io/profile": sanitizeLabelValue(input.resourceProfile) }
      : {}),
    ...(input.nodeArch && input.nodeArch !== "any"
      ? { "paperclip.io/arch": sanitizeLabelValue(input.nodeArch) }
      : {}),
  };
}

const REPO_DIGEST_RE = /@(sha256:[a-f0-9]{64})/i;
const BARE_CONFIG_ID_RE = /^(?:[a-z0-9+.-]+:\/\/)?sha256:[a-f0-9]{64}$/i;

/**
 * Extracts node placement and container imageID runtime evidence from a Pod
 * object and compares it against the expected OCI index / platform digests.
 */
export function extractRuntimeEvidence(
  pod: Record<string, unknown> | null | undefined,
  expectedIndexDigest: string | null,
  expectedPlatformDigest: string | null,
): KubernetesRuntimeEvidence {
  const spec = (pod?.spec as Record<string, unknown> | undefined) ?? {};
  const status = (pod?.status as Record<string, unknown> | undefined) ?? {};
  const nodeName =
    typeof spec.nodeName === "string" && spec.nodeName.trim().length > 0
      ? spec.nodeName.trim()
      : null;

  const containerStatuses = Array.isArray(status.containerStatuses)
    ? (status.containerStatuses as Array<Record<string, unknown>>)
    : [];
  const agentStatus =
    containerStatuses.find((c) => c.name === "agent") ?? containerStatuses[0];
  const containerImageId =
    typeof agentStatus?.imageID === "string" && agentStatus.imageID.trim().length > 0
      ? agentStatus.imageID.trim()
      : null;

  let digestVerification: DigestVerificationStatus | null = null;
  if (containerImageId && (expectedIndexDigest || expectedPlatformDigest)) {
    const repoMatch = REPO_DIGEST_RE.exec(containerImageId);
    if (repoMatch) {
      const actualDigest = repoMatch[1].toLowerCase();
      if (expectedIndexDigest && actualDigest === expectedIndexDigest.toLowerCase()) {
        digestVerification = "exact_index_match";
      } else if (
        expectedPlatformDigest &&
        actualDigest === expectedPlatformDigest.toLowerCase()
      ) {
        digestVerification = "exact_platform_match";
      } else {
        digestVerification = "mismatch";
      }
    } else if (BARE_CONFIG_ID_RE.test(containerImageId)) {
      digestVerification = "cri_config_id_only";
    } else {
      digestVerification = "mismatch";
    }
  }

  return {
    nodeName,
    containerImageId,
    digestVerification,
  };
}
