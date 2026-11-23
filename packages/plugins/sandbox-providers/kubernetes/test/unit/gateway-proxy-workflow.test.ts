import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../../..");
const WORKFLOW_PATH = resolve(REPO_ROOT, ".github/workflows/delegra-gateway-proxy-image.yml");

describe("delegra-gateway-proxy-image workflow contract", () => {
  it("pins all GitHub Actions to full 40-char commit SHAs and enforces SBOM, provenance, and attestation", () => {
    const content = readFileSync(WORKFLOW_PATH, "utf8");
    const usesMatches = [...content.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]!);
    expect(usesMatches.length).toBeGreaterThanOrEqual(5);
    for (const ref of usesMatches) {
      expect(ref).toMatch(/@[0-9a-f]{40}$/);
    }

    expect(content).toContain("--sbom=true");
    expect(content).toContain("--provenance=mode=min,version=v1");
    expect(content).toContain("actions/attest@");
    expect(content).toContain("--read-only");
    expect(content).toContain('test "$uid" = "1001"');
    expect(content).toContain("immutableRef");
  });
});
