import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' }).trim();
const paths = [
  '.delegra/patches.json',
  '.github/ci-task-matrix.json',
  '.github/workflows/pr.yml',
  '.github/workflows/pr-trusted.yml',
  '.github/workflows/pr-delegra-trusted.yml',
  '.github/workflows/ci-routing.yml',
  '.github/workflows/ci-routing-delegra.yml',
  'scripts/check-delegra-shared-ci.mjs',
];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'deleg-shared-ci-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of paths) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    copyFileSync(join(root, path), join(dir, path));
  }
  return dir;
}

function check(dir) {
  return spawnSync(process.execPath, ['scripts/check-delegra-shared-ci.mjs'], {
    cwd: dir,
    env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: dir },
    encoding: 'utf8',
  });
}

test('the fork routing snapshot pins trusted planner inputs to the accepted overlay', () => {
  const caller = readFileSync(join(root, '.github/workflows/pr-delegra-trusted.yml'), 'utf8');
  assert.match(caller, /hrygo\/Delegra\/\.github\/workflows\/ci-routing-delegra\.yml@[0-9a-f]{40}/);
  const routing = readFileSync(join(root, '.github/workflows/ci-routing-delegra.yml'), 'utf8');
  const config = JSON.parse(readFileSync(join(root, '.delegra/patches.json'), 'utf8'));
  assert.match(routing, new RegExp(`trusted="${config.upstreamOverlays[0].commit}"`));
  assert.doesNotMatch(routing, /^\s*trusted="\$\(/m);
});

test('accepts a matching snapshot and pinned caller', (t) => {
  const result = check(fixture(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /snapshot and pinned caller agree/);
});

test('rejects a baseline change missing from the snapshot', (t) => {
  const dir = fixture(t);
  const file = join(dir, '.github/workflows/pr-trusted.yml');
  writeFileSync(file, readFileSync(file, 'utf8') + '# new policy step\n');
  const result = check(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /differs from pr-trusted.yml beyond the routing pin/);
});

test('rejects a caller SHA that does not contain the current snapshot', (t) => {
  const dir = fixture(t);
  const file = join(dir, '.github/workflows/pr.yml');
  const caller = readFileSync(file, 'utf8');
  // The recorded base predates the snapshot and is guaranteed to exist in this history.
  writeFileSync(file, caller.replace(/(pr-delegra-trusted\.yml@)[0-9a-f]{40}/, (_, prefix) => `${prefix}32e0d1fb3b4150fb4d63545eda753d44547bc032`));
  const result = check(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not exist in|exists on disk, but not in/);
});

test('rejects a moving nested routing reference', (t) => {
  const dir = fixture(t);
  const file = join(dir, '.github/workflows/pr-delegra-trusted.yml');
  const snapshot = readFileSync(file, 'utf8');
  writeFileSync(file, snapshot.replace(/(ci-routing-delegra\.yml@)[0-9a-f]{40}/, '$1master'));
  const result = check(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /caller and routing must each use one full commit SHA/);
});

test('rejects routing baseline drift from the pinned workflow', (t) => {
  const dir = fixture(t);
  const file = join(dir, '.github/workflows/ci-routing.yml');
  writeFileSync(file, readFileSync(file, 'utf8') + '# new routing rule\n');
  const result = check(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Fork routing snapshot differs from ci-routing.yml/);
});

test('rejects a planner pin outside the accepted upstream sources', (t) => {
  const dir = fixture(t);
  const file = join(dir, '.github/workflows/ci-routing-delegra.yml');
  const snapshot = readFileSync(file, 'utf8');
  writeFileSync(file, snapshot.replace(/trusted="[0-9a-f]{40}"/, 'trusted="123ee31552e16507d520ca7344db5bbadfdf3a73"'));
  const result = check(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not an accepted upstream base or overlay/);
});

test('rejects a planner pin that is not reachable from the master mirror', (t) => {
  const mirror = ['origin/master', 'master'].find((ref) => {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
  if (!mirror) {
    t.skip('no master mirror ref in this checkout');
    return;
  }
  const dir = fixture(t);
  const file = join(dir, '.github/workflows/ci-routing-delegra.yml');
  const snapshot = readFileSync(file, 'utf8');
  const forkCommit = 'aa25ac9be5785243836e2f4aec0ad09a8cf348d3';
  writeFileSync(file, snapshot.replace(/trusted="[0-9a-f]{40}"/, `trusted="${forkCommit}"`));
  const registryPath = join(dir, '.delegra/patches.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  registry.upstreamOverlays[0].commit = forkCommit;
  writeFileSync(registryPath, JSON.stringify(registry));
  const result = check(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not an upstream commit/);
});

test('rejects a moving planner input', (t) => {
  const dir = fixture(t);
  const file = join(dir, '.github/workflows/ci-routing-delegra.yml');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/trusted="[0-9a-f]{40}"/, 'trusted="master"'));
  const result = check(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Trusted planner input must use one full commit SHA/);
});

test('rejects a candidate task matrix that differs from the trusted source', (t) => {
  const dir = fixture(t);
  const file = join(dir, '.github/ci-task-matrix.json');
  writeFileSync(file, readFileSync(file, 'utf8') + '\n');
  const result = check(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /trusted CI task matrix differs from the candidate matrix/);
});
