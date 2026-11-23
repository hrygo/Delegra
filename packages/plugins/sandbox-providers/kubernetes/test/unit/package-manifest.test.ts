import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN_ROOT = resolve(import.meta.dirname, "../..");

function parseSemverFloor(range: string): [number, number, number] {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!match) {
    throw new Error(`Unable to parse semver floor from "${range}"`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(actual: [number, number, number], minimum: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (actual[i]! > minimum[i]!) return true;
    if (actual[i]! < minimum[i]!) return false;
  }
  return true;
}

describe("kubernetes plugin package & container contract", () => {
  it("pins @kubernetes/client-node to >= 1.1.1 to avoid 1.0.0 Server-Side Apply HTTP 400 bugs", () => {
    const pkg = JSON.parse(readFileSync(resolve(PLUGIN_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      files?: string[];
    };

    const clientNodeRange = pkg.dependencies?.["@kubernetes/client-node"];
    expect(clientNodeRange).toBeDefined();
    expect(isAtLeast(parseSemverFloor(clientNodeRange!), [1, 1, 1])).toBe(true);
    expect(pkg.scripts?.["start:gateway-proxy"]).toBe(
      "node --zero-fill-buffers dist/gateway-proxy-main.js",
    );
    expect(pkg.files).toContain("Dockerfile.gateway-proxy");
  });

  it("ships a non-root PSS-restricted Dockerfile.gateway-proxy using standalone plugin install", () => {
    const dockerfile = readFileSync(resolve(PLUGIN_ROOT, "Dockerfile.gateway-proxy"), "utf8");
    expect(dockerfile).toContain("USER 1001:1001");
    expect(dockerfile).toContain("--zero-fill-buffers");
    expect(dockerfile).toContain("dist/gateway-proxy-main.js");
    expect(dockerfile).toContain("--ignore-workspace");
  });
});
