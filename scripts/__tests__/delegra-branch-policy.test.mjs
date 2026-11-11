import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const policy = resolve(import.meta.dirname, "../check-delegra-branch-policy.mjs");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "deleg-branch-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.name", "Policy test");
  git("config", "user.email", "policy-test@example.invalid");
  const commit = (path, content) => {
    writeFileSync(join(dir, path), content);
    git("add", path);
    git("commit", "-qm", path);
    return git("rev-parse", "HEAD");
  };
  const stable = commit("stable.txt", "stable\n");
  git("tag", "v2026.1106.0", stable);
  const canary = commit("upstream.txt", "later upstream change\n");
  git("tag", "canary/v2026.1104.0-canary.1", canary);
  git("update-ref", "refs/remotes/upstream/master", canary);
  const fork = commit("fork.txt", "registered fork change\n");
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, ".delegra"));
  copyFileSync(policy, join(dir, "scripts/check-delegra-branch-policy.mjs"));
  const registry = {
    base: { kind: "stable", ref: "v2026.1106.0", commit: stable },
    upstreamOverlays: [{
      kind: "canary",
      ref: "canary/v2026.1104.0-canary.1",
      commit: canary,
      transitionalWaiver: { reason: "Preserve existing functionality", expiresOn: "2099-12-31", replaceWith: "A stable release containing the overlay" },
    }],
    patches: [{ id: "fork", kind: "fork-only", status: "active", commits: [fork] }],
  };
  const check = () => {
    writeFileSync(join(dir, ".delegra/patches.json"), `${JSON.stringify(registry, null, 2)}\n`);
    return spawnSync(process.execPath, ["scripts/check-delegra-branch-policy.mjs", "--skip-mirror-check"], { cwd: dir, encoding: "utf8" });
  };
  return { git, commit, registry, check, stable, canary, fork };
}

test("accepts a verified upstream overlay and a separately registered fork patch", (t) => {
  const f = fixture(t);
  const result = f.check();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /upstream overlay: canary\/v2026\.1104\.0-canary\.1/);
});

test("does not exempt unregistered fork commits after the overlay", (t) => {
  const f = fixture(t);
  f.commit("unregistered.txt", "local change\n");
  const result = f.check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unregistered local commit.*unregistered\.txt/);
});

test("rejects an overlay whose tag and recorded commit differ", (t) => {
  const f = fixture(t);
  f.registry.upstreamOverlays[0].commit = f.stable;
  const result = f.check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /overlay.*does not match/i);
});

test("rejects a canary tag mislabeled as a stable overlay", (t) => {
  const f = fixture(t);
  f.registry.upstreamOverlays[0].kind = "stable";
  delete f.registry.upstreamOverlays[0].transitionalWaiver;
  const result = f.check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /overlay.*stable.*tag/i);
});

test("rejects a canary tag mislabeled as the stable base", (t) => {
  const f = fixture(t);
  f.registry.base = { kind: "stable", ref: "canary/v2026.1104.0-canary.1", commit: f.canary };
  f.registry.upstreamOverlays = [];
  const result = f.check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /base.*stable.*tag/i);
});

test("rejects a tagged fork commit masquerading as an upstream overlay", (t) => {
  const f = fixture(t);
  f.git("tag", "canary/not-upstream", f.fork);
  f.registry.upstreamOverlays[0].ref = "canary/not-upstream";
  f.registry.upstreamOverlays[0].commit = f.fork;
  const result = f.check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /overlay.*not contained in upstream\/master/i);
});

test("fails closed when the upstream mirror is unavailable", (t) => {
  const f = fixture(t);
  f.git("update-ref", "-d", "refs/remotes/upstream/master");
  const result = f.check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /overlay.*not contained in upstream\/master/i);
});

test("rejects an overlay absent from the candidate branch", (t) => {
  const f = fixture(t);
  f.git("checkout", "--detach", "-q", f.stable);
  const other = f.commit("upstream-next.txt", "another upstream change\n");
  f.git("tag", "canary/not-merged", other);
  f.git("update-ref", "refs/remotes/upstream/master", other);
  f.git("checkout", "--detach", "-q", f.fork);
  f.registry.upstreamOverlays[0].ref = "canary/not-merged";
  f.registry.upstreamOverlays[0].commit = other;
  const result = f.check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /overlay.*not contained in HEAD/i);
});

test("requires an unexpired waiver for a canary overlay", (t) => {
  const f = fixture(t);
  delete f.registry.upstreamOverlays[0].transitionalWaiver;
  let result = f.check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /overlay.*transitionalWaiver/i);
  f.registry.upstreamOverlays[0].transitionalWaiver = { reason: "test", expiresOn: "2000-01-01", replaceWith: "stable" };
  result = f.check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /overlay.*expired/i);
});
