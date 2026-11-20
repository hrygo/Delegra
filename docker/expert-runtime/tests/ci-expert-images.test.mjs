import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bakeOverrides, buildMatrix, collectRelease, promote, releaseVersion,
} from '../ci.mjs';

const capabilities = JSON.parse(readFileSync(new URL(
  '../capabilities.json', import.meta.url,
)));
const batchTargets = (publish) => buildMatrix(publish).include.flatMap(({ targets }) => targets);
const repository = 'hrygo/Delegra';
const ghcr = 'ghcr.io/hrygo/delegra';
const commit = 'a'.repeat(40);
const digest = 'sha256:' + 'b'.repeat(64);
const platformDigest = 'sha256:' + 'c'.repeat(64);
const version = 'v1.2.3';

test('only a dedicated stable tag in the canonical Delegra fork grants the release lane', () => {
  const tag = { event: 'push', ref: 'refs/tags/expert-images-v1.2.3', repository, fork: true };
  assert.equal(releaseVersion(tag), version);
  assert.equal(releaseVersion({ ...tag, event: 'workflow_dispatch' }), version);
  assert.equal(releaseVersion({ ...tag, event: 'pull_request' }), '');
  assert.equal(releaseVersion({ ...tag, deleted: true }), '');
  assert.equal(releaseVersion({ ...tag, repository: 'other/Delegra' }), '');
  assert.equal(releaseVersion({ ...tag, repository: 'paperclipai/paperclip', fork: false }), '');
  assert.equal(releaseVersion({ ...tag, repository: undefined }), '');
  assert.equal(releaseVersion({ ...tag, ref: 'refs/heads/deploy' }), '');
  assert.throws(() => releaseVersion({ ...tag, ref: 'refs/tags/expert-images-v01.2.3' }), /stable version/);
  assert.throws(() => releaseVersion({ ...tag, ref: 'refs/tags/expert-images-v1.2.3-rc.1' }), /stable version/);
  assert.throws(() => releaseVersion({ ...tag, ref: 'refs/tags/v1.2.3' }), /stable version/);
});

test('the planner skips CI-only diffs and verifies changes to image inputs', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'delegra-expert-plan-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=Delegra CI', '-c', 'user.email=ci@example.test',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.git/hooks', ...args,
  ], { cwd, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=deploy');
  const commitFiles = (...paths) => {
    for (const path of paths) {
      const file = join(cwd, path);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, 'fixture\n');
    }
    git('add', '--', ...paths);
    git('commit', '--quiet', '-m', 'Change fixtures');
    return git('rev-parse', 'HEAD');
  };
  const plan = (name, event = {}, ref = 'refs/heads/deploy') => {
    const eventFile = join(cwd, 'event.json');
    const outputFile = join(cwd, 'outputs');
    writeFileSync(eventFile, JSON.stringify(event));
    writeFileSync(outputFile, '');
    execFileSync(process.execPath, [fileURLToPath(new URL('../ci.mjs', import.meta.url)), 'plan'], {
      cwd,
      env: {
        ...process.env, GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: eventFile,
        GITHUB_OUTPUT: outputFile, GITHUB_REF: ref, GITHUB_REPOSITORY: repository,
      },
    });
    return readFileSync(outputFile, 'utf8');
  };
  const pullRequest = (sha) => ({ pull_request: { base: { sha } } });
  const base = commitFiles('docker/expert-runtime/Dockerfile');
  const ciOnly = commitFiles(
    '.nvmrc', '.github/workflows/delegra-expert-images.yml', 'docker/expert-runtime/ci.mjs',
    'docker/expert-runtime/README.md', 'docker/expert-runtime/tests/fixtures/smoke.sh',
  );
  assert.match(plan('pull_request', pullRequest(base)), /^verify_images=false$/m);
  assert.match(plan('push', { before: base }), /^verify_images=false$/m);
  assert.match(plan('workflow_dispatch'), /^verify_images=true$/m);
  assert.match(plan('push', { before: '0'.repeat(40) }), /^verify_images=true$/m);
  assert.match(plan('push', { before: 'f'.repeat(40) }), /^verify_images=true$/m);

  commitFiles('docker/expert-runtime/tooling/node/package-lock.json');
  const head = commitFiles('docker/expert-runtime/tests/fixtures/smoke.sh');
  assert.match(plan('push', { before: ciOnly }), /^verify_images=true$/m);
  assert.match(plan('pull_request', pullRequest(ciOnly)), /^verify_images=true$/m);

  git('update-ref', 'refs/remotes/origin/deploy', head);
  const release = plan('push', { before: head }, 'refs/tags/expert-images-v1.2.3');
  assert.match(release, /^version=v1\.2\.3$/m);
  assert.match(release, /^verify_images=false$/m);
});

test('CI batches cover all release targets once and exclude comparisons at release', () => {
  const scenes = Object.keys(capabilities.scenes);
  assert.deepEqual(batchTargets(true).sort(), scenes.toSorted());
  assert.deepEqual(batchTargets(false).sort(), [...scenes, 'codex-min-native', 'codex-java-21-native'].sort());
  assert.equal(scenes.length, 17);
  assert(!batchTargets(false).includes('codex-python'));
  assert(capabilities.common.includes('uv'));
  assert(capabilities.common.includes('uvx'));
  assert(buildMatrix(false).include.every(({ targets }) => targets.length <= 3));
});

test('deploy saves intermediate layers for the shared base and release candidates have no tag', () => {
  const targets = ['codex-min', 'codex-java-21'];
  const verify = bakeOverrides(targets, { saveCache: true });
  assert(!verify.some((argument) => /\.output=|\.tags=|push=true/.test(argument)));
  for (const target of targets) {
    assert(verify.includes(target + '.cache-from=type=gha,scope=expert-' + target));
  }
  assert(verify.includes('codex-min.cache-to=type=gha,scope=expert-codex-min,mode=max,ignore-error=true'));
  assert(verify.includes('codex-java-21.cache-to=type=gha,scope=expert-codex-java-21,mode=min,ignore-error=true'));
  const source = 'https://github.com/hrygo/Delegra';
  const candidate = bakeOverrides(targets, { ghcr, source, commit, version });
  assert(!candidate.some((argument) => argument.includes('.cache-to=')));
  for (const target of targets) {
    assert(candidate.includes(target + '.tags=' + ghcr + '/' + target));
    assert(candidate.includes(target + '.labels.org.opencontainers.image.revision=' + commit));
    assert(candidate.includes(target + '.output=type=image,push=true,push-by-digest=true,oci-mediatypes=true'));
  }
  assert.throws(() => bakeOverrides(['codex-min-native'], { ghcr, source, commit, version }), /Invalid target/);
  assert.throws(() => bakeOverrides(['codex-python'], { ghcr, source, commit, version }), /Invalid target codex-python/);
});

test('scene batches read the linked base cache and leave it to the base batch to export it', () => {
  const targets = ['codex-test-api', 'codex-test-load'];
  const settings = bakeOverrides(targets, { saveCache: true });
  assert(settings.includes('codex-min.cache-from=type=gha,scope=expert-codex-min'));
  assert(!settings.some((argument) => argument.startsWith('codex-min.cache-to=')));
  assert(settings.includes('codex-test-api.cache-from=type=gha,scope=expert-codex-test-api'));
  assert(settings.includes('codex-test-api.cache-to=type=gha,scope=expert-codex-test-api,mode=min,ignore-error=true'));
});

const release = { version, commit, ghcr };
function receipt() {
  return {
    version, commit,
    images: batchTargets(true).map((target) => ({ target, digest, platformDigest, compressedBytes: 1024 })),
  };
}

test('release records require the complete matrix and the source commit', () => {
  const complete = receipt();
  const record = collectRelease([complete], release);
  assert.equal(record.platform, 'linux/arm64');
  assert.equal(record.python, capabilities.python);
  assert.equal(record.uv, capabilities.uv);
  assert.equal(record.images.length, 17);
  assert(record.images.every((image) => image.name === ghcr + '/' + image.target));
  const { images } = complete;
  assert.throws(() => collectRelease([{ ...complete, images: images.slice(1) }], release), /Incomplete/);
  assert.throws(() => collectRelease([{ ...complete, images: [...images, images[0]] }], release), /Duplicate/);
  assert.throws(() => collectRelease([{ ...complete, images: [
    ...images, { ...images[0], target: 'codex-python' },
  ] }], release), /Invalid release target codex-python/);
  assert.throws(() => collectRelease([{ ...complete, commit: '0'.repeat(40) }], release), /source/);
  assert.throws(() => collectRelease([{ ...complete, images: [
    ...images.slice(1), { ...images[0], digest: 'sha256:payload' },
  ] }], release), /digest/i);
});

test('a conflicting or unavailable release tag prevents every promotion', () => {
  const { images } = collectRelease([receipt()], release);
  const last = images.at(-1).name + ':' + version;
  let writes = 0;
  for (const invalid of ['sha256:' + 'd'.repeat(64), new Error('registry refused access')]) {
    assert.throws(() => promote(images, version, {
      digestFor(ref) {
        if (ref.endsWith('@' + digest)) return digest;
        if (ref === last && invalid instanceof Error) throw invalid;
        return ref === last ? invalid : null;
      },
      tag() { writes++; },
    }), /already points|refused access/);
    assert.equal(writes, 0);
  }
});

test('promotion reuses an identical tag and resolves the published digest', () => {
  const { images } = collectRelease([receipt()], release);
  const alreadyTagged = images[0].name + ':' + version;
  const tags = new Map([[alreadyTagged, digest]]);
  const writes = [];
  promote(images, version, {
    digestFor: (ref) => ref.endsWith('@' + digest) ? digest : tags.get(ref) ?? null,
    tag(from, to) {
      assert.match(from, /@sha256:[0-9a-f]{64}$/);
      writes.push(to);
      tags.set(to, from.split('@')[1]);
    },
  });
  assert.equal(tags.size, 17);
  assert.equal(writes.length, 16);
  assert(!writes.includes(alreadyTagged));
});

test('an unavailable candidate prevents every promotion', () => {
  const { images } = collectRelease([receipt()], release);
  const missing = images.at(-1).name + '@' + digest;
  assert.throws(() => promote(images, version, {
    digestFor: (ref) => ref.endsWith('@' + digest) && ref !== missing ? digest : null,
    tag() { assert.fail('Registry writes must wait for all candidate checks'); },
  }), /Missing tested candidate/);
});

test('only the tag jobs can write packages and publication requires the entire candidate job', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/delegra-expert-images.yml', import.meta.url), 'utf8');
  const verifyAt = workflow.indexOf('\n  verify:');
  const candidatesAt = workflow.indexOf('\n  candidates:');
  const publishAt = workflow.indexOf('\n  publish:');
  assert(verifyAt > 0 && candidatesAt > verifyAt && publishAt > candidatesAt);
  const verify = workflow.slice(verifyAt, candidatesAt);
  const candidates = workflow.slice(candidatesAt, publishAt);
  const publish = workflow.slice(publishAt);
  assert.doesNotMatch(workflow.slice(0, candidatesAt), /packages: write/);
  assert.match(workflow.slice(0, verifyAt), /verify_images: \$\{\{ steps\.plan\.outputs\.verify_images \}\}/);
  assert.match(verify, /github\.ref_type != 'tag'/);
  assert.match(verify, /needs\.plan\.outputs\.verify_images == 'true'/);
  for (const job of [candidates, publish]) {
    assert.match(job, /github\.ref_type == 'tag' && needs\.plan\.outputs\.version != ''/);
    assert.match(job, /packages: write/);
  }
  assert.match(candidates, /ci\.mjs receipt/);
  assert.match(publish, /needs: \[plan, candidates\]/);
  assert.match(publish, /actions\/attest@[a-f0-9]{40}/);
});
