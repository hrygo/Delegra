import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPullRequestLockfile } from '../check-delegra-stable-lockfile.mjs';

const repository = 'hrygo/Delegra';
const upstream = '/repos/paperclipai/paperclip';
const fork = `/repos/${repository}`;
const tag = 'v2026.1117.0';
const stable = 'a'.repeat(40);
const head = 'b'.repeat(40);
const blob = 'c'.repeat(40);
const releasePath = `${upstream}/releases/tags/${tag}`;
const comparePath = `${fork}/compare/${stable}...${head}?per_page=1`;
const headLockPath = `${fork}/contents/pnpm-lock.yaml?ref=${head}`;

function fixture() {
  const responses = new Map([
    [releasePath, { tag_name: tag, draft: false, prerelease: false, published_at: '2026-11-18T22:20:29Z' }],
    [`${upstream}/commits/${tag}`, { sha: stable }],
    [comparePath, { status: 'ahead', merge_base_commit: { sha: stable } }],
    [headLockPath, { type: 'file', sha: blob }],
    [`${upstream}/contents/pnpm-lock.yaml?ref=${stable}`, { type: 'file', sha: blob }],
  ]);
  const requests = [];
  const input = {
    repository,
    token: 'test-token',
    author: 'hrygo',
    branch: `upgrade/${tag}`,
    pr: {
      base: { ref: 'deploy', repo: { full_name: repository } },
      head: { ref: `upgrade/${tag}`, sha: head, repo: { full_name: repository } },
    },
    files: [{ filename: 'pnpm-lock.yaml', status: 'modified', sha: blob }],
    fetchFromGitHub: async (path, token) => {
      requests.push({ path, token });
      if (!responses.has(path)) throw new Error('Unexpected GitHub request');
      return responses.get(path);
    },
  };
  return { input, responses, requests };
}

test('accepts the exact official lockfile on a same-repository stable upgrade', async () => {
  const { input, requests } = fixture();
  assert.deepEqual(await checkPullRequestLockfile(input), { passed: true, failures: [] });
  assert.equal(requests.length, 5);
  for (const { path, token } of requests) {
    assert.equal(token, path.startsWith(upstream) ? undefined : input.token);
  }
});

for (const [name, change] of [
  ['ordinary branches', (input) => { input.pr.head.ref = input.branch = 'fix/dependencies'; }],
  ['cross-repository pull requests', (input) => { input.pr.head.repo.full_name = 'contributor/Delegra'; }],
  ['other destinations', (input) => { input.pr.base.ref = 'master'; }],
  ['other repositories', (input) => { input.repository = 'paperclipai/paperclip'; }],
  ['unresolved heads', (input) => { input.pr.head.sha = 'abc123'; }],
  ['removed lockfiles', (input) => { input.files[0].status = 'removed'; }],
]) {
  test(`keeps the normal lockfile rejection for ${name}`, async () => {
    const { input, requests } = fixture();
    change(input);
    assert.equal((await checkPullRequestLockfile(input)).passed, false);
    assert.deepEqual(requests, []);
  });
}

for (const [name, path, response] of [
  ['a draft', releasePath, { tag_name: tag, draft: true, prerelease: false, published_at: '2026-11-18' }],
  ['a prerelease', releasePath, { tag_name: tag, draft: false, prerelease: true, published_at: '2026-11-18' }],
  ['missing stable history', comparePath, { status: 'diverged', merge_base_commit: { sha: 'e'.repeat(40) } }],
  ['hand-edited lock content', headLockPath, { type: 'file', sha: 'd'.repeat(40) }],
  ['an unavailable upstream release', releasePath, undefined],
]) {
  test(`rejects a stable upgrade with ${name}`, async () => {
    const { input, responses } = fixture();
    if (response) responses.set(path, response);
    else responses.delete(path);
    assert.equal((await checkPullRequestLockfile(input)).passed, false);
  });
}

test('rejects a changed file listing that disagrees with the pinned head', async () => {
  const { input } = fixture();
  input.files[0].sha = 'd'.repeat(40);
  assert.equal((await checkPullRequestLockfile(input)).passed, false);
});

test('keeps the refresh bot allowance without looking up a release', async () => {
  const { input, requests } = fixture();
  input.author = 'github-actions[bot]';
  input.pr.head.ref = input.branch = 'chore/refresh-lockfile';
  assert.deepEqual(await checkPullRequestLockfile(input), { passed: true, failures: [] });
  assert.deepEqual(requests, []);
});
