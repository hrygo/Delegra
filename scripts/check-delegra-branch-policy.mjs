#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = resolve(repoRoot, ".delegra/patches.json");
const args = new Set(process.argv.slice(2));
const errors = [];
const warnings = [];

function git(gitArgs, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", gitArgs, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`git ${gitArgs.join(" ")} failed: ${detail}`);
  }
}

function resolveCommit(ref) {
  return git(["rev-parse", "--verify", `${ref}^{commit}`], { allowFailure: true });
}

function short(commit) {
  return commit.slice(0, 12);
}

function isAncestor(ancestor, descendant) {
  try {
    git(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function changedPaths(commit) {
  const output = git(["diff-tree", "--no-commit-id", "--name-only", "-r", commit]);
  return output ? output.split("\n").filter(Boolean) : [];
}

function matchesInternalPath(file, prefixes) {
  return prefixes.some((prefix) =>
    prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix || file.startsWith(prefix),
  );
}

let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, "utf8"));
} catch (error) {
  console.error(`Cannot read ${registryPath}: ${error.message}`);
  process.exit(1);
}

const head = resolveCommit("HEAD");
if (!head) {
  console.error("HEAD does not resolve to a commit.");
  process.exit(1);
}

const mirrorBranch = registry.branches?.mirror ?? "master";
const deployBranch = registry.branches?.deploy ?? "deploy";
const localMirror =
  resolveCommit(`refs/heads/${mirrorBranch}`) ??
  resolveCommit(`refs/remotes/origin/${mirrorBranch}`);
const upstreamMirror =
  resolveCommit("refs/remotes/upstream/master") ??
  resolveCommit("refs/remotes/origin/master");

if (!args.has("--skip-mirror-check")) {
  if (!upstreamMirror) {
    warnings.push("No upstream/master or origin/master ref is available; mirror identity was not checked.");
  } else if (!localMirror) {
    warnings.push(`Neither local nor origin ${mirrorBranch} is available; mirror identity was not checked.`);
  } else if (localMirror !== upstreamMirror) {
    errors.push(
      `${mirrorBranch} must exactly match upstream/master: local ${short(localMirror)}, upstream ${short(upstreamMirror)}.`,
    );
  } else {
    console.log(`mirror: ${mirrorBranch} == upstream/master (${short(localMirror)})`);
  }
}

const base = registry.base;
if (!base?.ref || !base?.commit || !base?.kind) {
  errors.push("Registry base must define kind, ref, and commit.");
} else {
  const resolvedBase = resolveCommit(base.ref);
  if (!resolvedBase) {
    errors.push(`Registry base ref does not resolve: ${base.ref}.`);
  } else if (resolvedBase !== resolveCommit(base.commit)) {
    errors.push(
      `Registry base commit does not match ${base.ref}: expected ${short(base.commit)}, resolved ${short(resolvedBase)}.`,
    );
  } else if (!isAncestor(resolvedBase, head)) {
    errors.push(`Registry base ${short(resolvedBase)} is not an ancestor of HEAD ${short(head)}.`);
  } else {
    console.log(`base: ${base.ref} (${short(resolvedBase)})`);
  }

  if (base.kind !== "stable") {
    const waiver = base.transitionalWaiver;
    if (!waiver?.reason || !waiver?.expiresOn || !waiver?.replaceWith) {
      errors.push(
        `base.kind is "${base.kind}", not "stable"; a transitionalWaiver with reason, expiresOn, and replaceWith is required.`,
      );
    } else {
      const expiry = new Date(`${waiver.expiresOn}T23:59:59Z`);
      if (Number.isNaN(expiry.getTime())) {
        errors.push(`transitionalWaiver.expiresOn is not a valid date: ${waiver.expiresOn}.`);
      } else if (Date.now() > expiry.getTime()) {
        errors.push(
          `The non-stable base waiver expired on ${waiver.expiresOn}; move deploy to a stable tag.`,
        );
      } else {
        warnings.push(
          `Transitional non-stable base accepted until ${waiver.expiresOn}; replace it with ${waiver.replaceWith}.`,
        );
      }
    }
  }
}

const patches = Array.isArray(registry.patches) ? registry.patches : [];
const patchIds = new Set();
const registeredCommits = new Set();
for (const patch of patches) {
  if (!patch.id) {
    errors.push("Every patch must have an id.");
    continue;
  }
  if (patchIds.has(patch.id)) errors.push(`Duplicate patch id: ${patch.id}.`);
  patchIds.add(patch.id);

  if (!["active", "merged-upstream", "absorbed", "retired"].includes(patch.status)) {
    errors.push(`${patch.id}: unsupported status "${patch.status}".`);
  }
  if (!Array.isArray(patch.commits) || patch.commits.length === 0) {
    errors.push(`${patch.id}: commits must be a non-empty array.`);
    continue;
  }
  if (patch.kind === "upstream-pr" && !patch.upstreamPr) {
    errors.push(`${patch.id}: upstream-pr patches must name upstreamPr.`);
  }

  const resolvedCommits = [];
  for (const commit of patch.commits) {
    const resolved = resolveCommit(commit);
    if (!resolved) {
      errors.push(`${patch.id}: commit does not resolve: ${commit}.`);
      continue;
    }
    registeredCommits.add(resolved);
    resolvedCommits.push(resolved);
    if (!isAncestor(resolved, head)) {
      errors.push(`${patch.id}: ${short(resolved)} is not contained in HEAD ${short(head)}.`);
    }
  }

  if (patch.status === "active" && base?.commit && resolvedCommits.length > 0) {
    const baseCommit = resolveCommit(base.commit);
    if (baseCommit && resolvedCommits.every((commit) => isAncestor(commit, baseCommit))) {
      errors.push(
        `${patch.id}: all commits are already contained in the base; mark the patch absorbed or retired.`,
      );
    }
  }

  if (patch.status === "active") {
    console.log(`patch: ${patch.id} (${patch.kind}, ${patch.commits.length} commit(s))`);
  }
}

if (base?.commit) {
  const baseCommit = resolveCommit(base.commit);
  if (baseCommit) {
    const localCommits = git(["rev-list", "--no-merges", `${baseCommit}..HEAD`])
      .split("\n")
      .filter(Boolean);
    const internalPaths = Array.isArray(registry.internalPaths) ? registry.internalPaths : [];
    for (const commit of localCommits) {
      if (registeredCommits.has(commit)) continue;
      const files = changedPaths(commit);
      if (files.length > 0 && files.every((file) => matchesInternalPath(file, internalPaths))) {
        continue;
      }
      const subject = git(["show", "-s", "--format=%s", commit]);
      errors.push(
        `Unregistered local commit ${short(commit)} "${subject}". Register it as a patch or keep it within internalPaths.`,
      );
    }
  }
}

const deployRef = resolveCommit(`refs/heads/${deployBranch}`);
if (deployRef && deployRef !== head && args.has("--require-deploy-head")) {
  errors.push(`HEAD ${short(head)} is not the tip of ${deployBranch} (${short(deployRef)}).`);
}

for (const warning of warnings) console.warn(`warning: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`ok: ${patches.filter((patch) => patch.status === "active").length} active patch(es)`);
}
