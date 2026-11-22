import { describe, it, expect } from "vitest";
import {
  deriveCompanySlug,
  deriveNamespaceName,
  extractRuntimeEvidence,
  newRunUlidDns,
  paperclipLabels,
  sanitizeLabelValue,
  stripRegistryScheme,
} from "../../src/utils.js";

const INDEX_DIGEST = `sha256:${"a".repeat(64)}`;
const PLATFORM_DIGEST = `sha256:${"b".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"c".repeat(64)}`;

describe("deriveCompanySlug", () => {
  it("lowercases and replaces non-alphanumerics", () => {
    expect(deriveCompanySlug("Acme Co!")).toBe("acme-co");
  });

  it("preserves long inputs within the namespace budget instead of blind truncation", () => {
    const input = "a".repeat(40) + "-suffix-that-pushes-past-the-budget";
    const slug = deriveCompanySlug(input);
    expect(slug.length).toBeLessThanOrEqual(53);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back to 'company' on empty/zero-letter input", () => {
    expect(deriveCompanySlug("!!!")).toBe("company");
    expect(deriveCompanySlug("")).toBe("company");
  });
  it("keeps full UUIDs untruncated so distinct companies never share a slug", () => {
    const a = deriveCompanySlug("0d9c52f6-2f30-4d3e-9a01-aaaaaaaa0001");
    const b = deriveCompanySlug("0d9c52f6-2f30-4d3e-9a01-aaaaaaaa0002");
    expect(a).toBe("0d9c52f6-2f30-4d3e-9a01-aaaaaaaa0001");
    expect(a).not.toBe(b);
  });

  it("appends a hash of the full input when the slug exceeds the namespace budget", () => {
    const long1 = "x".repeat(60) + "-tail-one";
    const long2 = "x".repeat(60) + "-tail-two";
    const s1 = deriveCompanySlug(long1);
    const s2 = deriveCompanySlug(long2);
    expect(s1.length).toBeLessThanOrEqual(53);
    expect(s2.length).toBeLessThanOrEqual(53);
    expect(s1).not.toBe(s2);
  });
});

describe("deriveNamespaceName", () => {
  it("concatenates prefix and slug", () => {
    expect(deriveNamespaceName("paperclip-", "acme-co")).toBe("paperclip-acme-co");
  });
});

describe("newRunUlidDns", () => {
  it("produces a DNS-safe 26-char lowercase id", () => {
    const id = newRunUlidDns();
    expect(id).toMatch(/^[a-z0-9]{26}$/);
  });
});

describe("sanitizeLabelValue & stripRegistryScheme", () => {
  it("sanitizes invalid characters and bounds length to 63", () => {
    expect(sanitizeLabelValue("  agent/foo@bar  ")).toBe("agent-foo-bar");
    expect(sanitizeLabelValue("!!!")).toBe("unknown");
    const long = sanitizeLabelValue("z".repeat(80));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[A-Za-z0-9].*[A-Za-z0-9]$/);
  });

  it("strips http/https schemes and trailing slashes from imageRegistry", () => {
    expect(stripRegistryScheme("https://registry.example:5000/org/")).toBe("registry.example:5000/org");
    expect(stripRegistryScheme("http://mirror.example/team")).toBe("mirror.example/team");
    expect(stripRegistryScheme("registry.example/team")).toBe("registry.example/team");
    expect(stripRegistryScheme(undefined)).toBeUndefined();
  });
});

describe("paperclipLabels", () => {
  it("returns canonical label map", () => {
    const labels = paperclipLabels({ runId: "r1", agentId: "a1", companyId: "c1", adapterType: "claude_local" });
    expect(labels["paperclip.io/run-id"]).toBe("r1");
    expect(labels["paperclip.io/agent-id"]).toBe("a1");
    expect(labels["paperclip.io/company-id"]).toBe("c1");
    expect(labels["paperclip.io/adapter"]).toBe("claude_local");
    expect(labels["paperclip.io/managed-by"]).toBe("paperclip-k8s-plugin");
    expect(labels["paperclip.io/profile"]).toBeUndefined();
    expect(labels["paperclip.io/arch"]).toBeUndefined();
  });

  it("attaches profile and arch labels when provided (and omits arch=any)", () => {
    const labels = paperclipLabels({
      runId: "r1",
      agentId: "a1",
      companyId: "c1",
      adapterType: "codex_local",
      resourceProfile: "browser",
      nodeArch: "arm64",
    });
    expect(labels["paperclip.io/profile"]).toBe("browser");
    expect(labels["paperclip.io/arch"]).toBe("arm64");

    const anyArch = paperclipLabels({
      runId: "r1",
      agentId: "a1",
      companyId: "c1",
      adapterType: "codex_local",
      nodeArch: "any",
    });
    expect(anyArch["paperclip.io/arch"]).toBeUndefined();
  });
});

describe("extractRuntimeEvidence", () => {
  it("detects exact_index_match", () => {
    const ev = extractRuntimeEvidence(
      {
        spec: { nodeName: "arm64-node-01" },
        status: {
          containerStatuses: [
            { name: "agent", imageID: `docker-pullable://ghcr.io/hrygo/delegra/codex-min@${INDEX_DIGEST}` },
          ],
        },
      },
      INDEX_DIGEST,
      PLATFORM_DIGEST,
    );
    expect(ev).toEqual({
      nodeName: "arm64-node-01",
      containerImageId: `docker-pullable://ghcr.io/hrygo/delegra/codex-min@${INDEX_DIGEST}`,
      digestVerification: "exact_index_match",
    });
  });

  it("detects exact_platform_match", () => {
    const ev = extractRuntimeEvidence(
      {
        spec: { nodeName: "arm64-node-02" },
        status: {
          containerStatuses: [
            { name: "agent", imageID: `ghcr.io/hrygo/delegra/codex-min@${PLATFORM_DIGEST}` },
          ],
        },
      },
      INDEX_DIGEST,
      PLATFORM_DIGEST,
    );
    expect(ev.digestVerification).toBe("exact_platform_match");
  });

  it("detects cri_config_id_only when runtime reports a bare config digest", () => {
    const ev = extractRuntimeEvidence(
      {
        spec: { nodeName: "arm64-node-03" },
        status: {
          containerStatuses: [{ name: "agent", imageID: `containerd://${OTHER_DIGEST}` }],
        },
      },
      INDEX_DIGEST,
      null,
    );
    expect(ev.digestVerification).toBe("cri_config_id_only");
  });

  it("detects mismatch when repo digest differs from both expected digests", () => {
    const ev = extractRuntimeEvidence(
      {
        spec: { nodeName: "arm64-node-04" },
        status: {
          containerStatuses: [{ name: "agent", imageID: `ghcr.io/hrygo/delegra/codex-min@${OTHER_DIGEST}` }],
        },
      },
      INDEX_DIGEST,
      PLATFORM_DIGEST,
    );
    expect(ev.digestVerification).toBe("mismatch");
  });

  it("returns null fields safely when pod is absent or unscheduled", () => {
    expect(extractRuntimeEvidence(null, INDEX_DIGEST, null)).toEqual({
      nodeName: null,
      containerImageId: null,
      digestVerification: null,
    });
  });
});
