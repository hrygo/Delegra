import { ghFetch } from './get-bot-token.mjs';
import { checkLockfile } from './check-pr-lockfile.mjs';

const FORK = 'hrygo/Delegra';
const UPSTREAM = '/repos/paperclipai/paperclip';
const LOCKFILE = 'pnpm-lock.yaml';
const FULL_SHA = /^[0-9a-f]{40}$/;
const STABLE_UPGRADE = /^upgrade\/(v\d{4}\.\d{3,4}\.\d+)$/;

export async function checkPullRequestLockfile({ files, author, branch, pr, repository, token, fetchFromGitHub = ghFetch }) {
  const normalResult = checkLockfile(files, author, branch);
  if (normalResult.passed) return normalResult;

  const tag = pr.head?.ref?.match(STABLE_UPGRADE)?.[1];
  const head = pr.head?.sha;
  const lock = files.find((file) => file.filename === LOCKFILE);
  if (repository !== FORK || pr.base?.repo?.full_name !== FORK || pr.head?.repo?.full_name !== FORK ||
      pr.base.ref !== 'deploy' || !tag || !FULL_SHA.test(head) || lock?.status !== 'modified' ||
      !FULL_SHA.test(lock.sha)) {
    return normalResult;
  }

  const failure = {
    passed: false,
    failures: ['A Delegra stable upgrade must contain the published Paperclip tag and use its exact root lockfile.'],
  };
  try {
    // These public reads do not need the fork's workflow token. The trusted
    // base runs this check and treats every pull request ref as data.
    const release = await fetchFromGitHub(`${UPSTREAM}/releases/tags/${tag}`);
    if (release?.tag_name !== tag || release.draft !== false || release.prerelease !== false || !release.published_at) {
      return failure;
    }

    const commit = await fetchFromGitHub(`${UPSTREAM}/commits/${tag}`);
    if (!FULL_SHA.test(commit?.sha)) return failure;
    const stable = commit.sha;
    const [comparison, original, proposed] = await Promise.all([
      fetchFromGitHub(`/repos/${FORK}/compare/${stable}...${head}?per_page=1`, token),
      fetchFromGitHub(`${UPSTREAM}/contents/${LOCKFILE}?ref=${stable}`),
      fetchFromGitHub(`/repos/${FORK}/contents/${LOCKFILE}?ref=${head}`, token),
    ]);
    if (!['ahead', 'identical'].includes(comparison?.status) || comparison.merge_base_commit?.sha !== stable ||
        original?.type !== 'file' || proposed?.type !== 'file' || original.sha !== lock.sha || proposed.sha !== lock.sha) {
      return failure;
    }
  } catch {
    return {
      passed: false,
      failures: ['GitHub could not verify the official Paperclip tag and lockfile. Retry the review.'],
    };
  }

  // Apply the normal policy to any other lock content in the PR.
  return checkLockfile(files.filter((file) => file.filename !== LOCKFILE), author, branch);
}
