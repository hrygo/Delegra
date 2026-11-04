import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const workflow = readFileSync(join(root, '.github/workflows/pr.yml'), 'utf8');

function detectScript() {
  const block = workflow.split('\n');
  const start = block.findIndex((line) => line.trim() === '- id: detect');
  assert.notEqual(start, -1, 'pr.yml must keep the scope detection step');
  const runAt = block.findIndex((line, index) => index > start && line.trim() === 'run: |');
  assert.notEqual(runAt, -1, 'the scope step must run a script');
  const indent = block[runAt].search(/\S/);
  const body = [];
  for (const line of block.slice(runAt + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    body.push(line);
  }
  return body.join('\n');
}

function decide(t, { labels, changed }) {
  const dir = mkdtempSync(join(tmpdir(), 'deleg-pr-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'fixture');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/app.ts'), 'export const value = 1;\n');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  const script = detectScript()
    .replace(/\$\{\{ join\(github\.event\.pull_request\.labels\.\*\.name, ' '\) \}\}/g, labels)
    .replace(/\$\{\{ github\.event\.pull_request\.base\.sha \}\}/g, base);
  const output = join(dir, 'github-output');
  writeFileSync(output, '');
  for (const file of changed) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), `${file}\n`);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
    cwd: dir,
    env: { ...process.env, GITHUB_OUTPUT: output },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const written = readFileSync(output, 'utf8');
  return {
    run: /run_matrix=true/.test(written),
    reason: (result.stdout.match(/reason=(\S+)/) ?? [, ''])[1],
  };
}

test('skips the full matrix for an application-only change', (t) => {
  const decision = decide(t, { labels: '', changed: ['src/feature.ts'] });
  assert.deepEqual(decision, { run: false, reason: 'no-ci-scope' });
});

test('runs the full matrix when the change touches workflows', (t) => {
  const decision = decide(t, { labels: '', changed: ['.github/workflows/pr.yml'] });
  assert.deepEqual(decision, { run: true, reason: 'ci-paths' });
});

test('runs the full matrix when the change touches a composite action', (t) => {
  const decision = decide(t, { labels: '', changed: ['.github/actions/run-ci-task/action.yml'] });
  assert.deepEqual(decision, { run: true, reason: 'ci-paths' });
});

test('runs the full matrix when the change touches a CI script', (t) => {
  const decision = decide(t, { labels: '', changed: ['scripts/run-vitest-stable.mjs'] });
  assert.deepEqual(decision, { run: true, reason: 'ci-paths' });
});

test('runs the full matrix when a maintainer adds the full-ci label', (t) => {
  const decision = decide(t, { labels: 'bug full-ci', changed: ['src/feature.ts'] });
  assert.deepEqual(decision, { run: true, reason: 'label' });
});

test('runs the full matrix when a maintainer adds the profile-ci label', (t) => {
  const decision = decide(t, { labels: 'profile-ci', changed: ['src/feature.ts'] });
  assert.deepEqual(decision, { run: true, reason: 'label' });
});

test('ignores an unrelated label', (t) => {
  const decision = decide(t, { labels: 'documentation', changed: ['src/feature.ts'] });
  assert.deepEqual(decision, { run: false, reason: 'no-ci-scope' });
});
