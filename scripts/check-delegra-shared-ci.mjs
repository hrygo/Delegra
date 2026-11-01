import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const caller = readFileSync('.github/workflows/pr.yml', 'utf8');
const baseline = readFileSync('.github/workflows/pr-trusted.yml', 'utf8');
const snapshot = readFileSync('.github/workflows/pr-delegra-trusted.yml', 'utf8');
const reference = caller.match(/^\s+uses: hrygo\/Delegra\/\.github\/workflows\/pr-delegra-trusted\.yml@([0-9a-f]{40})\s*$/m);
const routing = /paperclipai\/paperclip\/\.github\/workflows\/ci-routing\.yml@([0-9a-f]{40})/g;

const routingReferences = [...snapshot.matchAll(routing)];
if (!reference || routingReferences.length !== 1) {
  throw new Error('Shared CI caller and routing must each use one full commit SHA');
}
const normalized = snapshot.replace(routing, 'paperclipai/paperclip/.github/workflows/ci-routing.yml@master');
if (normalized !== baseline) {
  throw new Error('Shared CI snapshot differs from pr-trusted.yml beyond the routing pin');
}
const committed = execFileSync('git', ['show', `${reference[1]}:.github/workflows/pr-delegra-trusted.yml`], { encoding: 'utf8' });
if (snapshot !== committed) {
  throw new Error('Caller SHA does not contain the current shared CI snapshot');
}
const routingBaseline = readFileSync('.github/workflows/ci-routing.yml');
const pinnedRouting = execFileSync('git', ['show', `${routingReferences[0][1]}:.github/workflows/ci-routing.yml`]);
if (!routingBaseline.equals(pinnedRouting)) {
  throw new Error('The pinned routing workflow differs from ci-routing.yml');
}
console.log('Shared CI snapshot and pinned caller agree; routing matches the baseline');
