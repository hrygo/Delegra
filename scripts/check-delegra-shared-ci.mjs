import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const caller = readFileSync('.github/workflows/pr.yml', 'utf8');
const baseline = readFileSync('.github/workflows/pr-trusted.yml', 'utf8');
const snapshot = readFileSync('.github/workflows/pr-delegra-trusted.yml', 'utf8');
const reference = caller.match(/^\s+uses: hrygo\/Delegra\/\.github\/workflows\/pr-delegra-trusted\.yml@([0-9a-f]{40})\s*$/m);
const routing = /hrygo\/Delegra\/\.github\/workflows\/ci-routing-delegra\.yml@([0-9a-f]{40})/g;

const routingReferences = [...snapshot.matchAll(routing)];
if (!reference || routingReferences.length !== 1) {
  throw new Error('Shared CI caller and routing must each use one full commit SHA');
}
const routingPin = routingReferences[0][1];
const routingSnapshot = readFileSync('.github/workflows/ci-routing-delegra.yml', 'utf8');
const routingBaseline = readFileSync('.github/workflows/ci-routing.yml', 'utf8');
const plannerLines = [...routingSnapshot.matchAll(/^          trusted="([0-9a-f]{40})"$/gm)];
if (plannerLines.length !== 1) throw new Error('Trusted planner input must use one full commit SHA');
const plannerPin = plannerLines[0][1];
const dynamicPlanner = '          trusted="$(gh api /repos/paperclipai/paperclip/git/ref/heads/master --jq .object.sha)" || fallback';
if (routingSnapshot.replace(plannerLines[0][0], dynamicPlanner) !== routingBaseline) {
  throw new Error('Fork routing snapshot differs from ci-routing.yml beyond the planner pin');
}
const registry = JSON.parse(readFileSync('.delegra/patches.json', 'utf8'));
const acceptedSources = [registry.base, ...(registry.upstreamOverlays ?? [])].map(entry => entry.commit);
if (!acceptedSources.includes(plannerPin)) throw new Error('Planner pin is not an accepted upstream base or overlay');

// The fork snapshot is resolved in hrygo/Delegra, while its planner inputs
// are fetched only from an accepted commit in paperclipai/paperclip.
const mirrorRefs = ['origin/master', 'master'].filter(ref => {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});
if (mirrorRefs.length === 0) {
  console.warn('Skipping the routing provenance check: no master mirror ref is available');
} else if (!mirrorRefs.some(ref => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', plannerPin, ref], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})) {
  throw new Error(`Planner pin ${plannerPin} is not an upstream commit: it is not an ancestor of the master mirror`);
}
const normalized = snapshot.replace(routing, 'paperclipai/paperclip/.github/workflows/ci-routing.yml@master');
if (normalized !== baseline) {
  throw new Error('Shared CI snapshot differs from pr-trusted.yml beyond the routing pin');
}
const committed = execFileSync('git', ['show', `${reference[1]}:.github/workflows/pr-delegra-trusted.yml`], { encoding: 'utf8' });
if (snapshot !== committed) {
  throw new Error('Caller SHA does not contain the current shared CI snapshot');
}
const committedRouting = execFileSync('git', ['show', `${routingPin}:.github/workflows/ci-routing-delegra.yml`], { encoding: 'utf8' });
if (routingSnapshot !== committedRouting) throw new Error('Routing SHA does not contain the current fork routing snapshot');
const pinnedRouting = execFileSync('git', ['show', `${plannerPin}:.github/workflows/ci-routing.yml`], { encoding: 'utf8' });
if (routingBaseline !== pinnedRouting) {
  throw new Error('The pinned routing workflow differs from ci-routing.yml');
}
const matrixPath = '.github/ci-task-matrix.json';
const pinnedMatrix = execFileSync('git', ['show', `${plannerPin}:${matrixPath}`], { encoding: 'utf8' });
if (readFileSync(matrixPath, 'utf8') !== pinnedMatrix) {
  throw new Error('The trusted CI task matrix differs from the candidate matrix');
}
console.log('Shared CI snapshot and pinned caller agree; routing and planner match the accepted upstream source');
