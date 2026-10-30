import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' }).trim();
const paths = [
  '.github/workflows/pr.yml',
  '.github/workflows/pr-trusted.yml',
  '.github/workflows/pr-delegra-trusted.yml',
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
  writeFileSync(file, snapshot.replace(/(ci-routing\.yml@)[0-9a-f]{40}/, '$1master'));
  const result = check(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /caller and routing must each use one full commit SHA/);
});
