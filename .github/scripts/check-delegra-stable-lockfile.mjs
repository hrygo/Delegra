import { ghFetch } from './get-bot-token.mjs';
import { checkLockfile } from './check-pr-lockfile.mjs';
import { LOCKFILES, REPORT_LOCK_FILES } from './lockfile-trust.mjs';

const FORK = 'hrygo/Delegra';
const UPSTREAM = '/repos/paperclipai/paperclip';
const LOCK_CONTENT = new Set([...LOCKFILES, ...REPORT_LOCK_FILES]);
const FULL_SHA = /^[0-9a-f]{40}$/;
const STABLE_UPGRADE = /^upgrade\/(v\d{4}\.\d{3,4}\.\d+)$/;

export async function checkPullRequestLockfile({ files, author, branch, pr, repository, token, fetchFromGitHub = ghFetch }) {
  const normalResult = checkLockfile(files, author, branch);
  if (normalResult.passed) return normalResult;

  const tag = pr.head?.ref?.match(STABLE_UPGRADE)?.[1];
  const head = pr.head?.sha;
  if (repository !== FORK || pr.base?.repo?.full_name !== FORK || pr.head?.repo?.full_name !== FORK ||
      pr.base.ref !== 'deploy' || !tag || !FULL_SHA.test(head)) {
    return normalResult;
  }
  const changedLocks = files.filter((file) => LOCK_CONTENT.has(file.filename));
  if (!changedLocks.length || changedLocks.some(({ status, sha }) =>
    !['added', 'modified'].includes(status) || !FULL_SHA.test(sha))) return normalResult;

  const failure = {
    passed: false,
    failures: ['A Delegra stable upgrade must contain the published Paperclip tag and use its exact lockfiles and reporting lock proof.'],
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
    const [comparison, matches] = await Promise.all([
      fetchFromGitHub(`/repos/${FORK}/compare/${stable}...${head}?per_page=1`, token),
      Promise.all(changedLocks.map(async ({ filename, sha }) => {
        const [original, proposed] = await Promise.all([
          fetchFromGitHub(`${UPSTREAM}/contents/${filename}?ref=${stable}`),
          fetchFromGitHub(`/repos/${FORK}/contents/${filename}?ref=${head}`, token),
        ]);
        return original?.type === 'file' && proposed?.type === 'file' && original.sha === sha && proposed.sha === sha;
      })),
    ]);
    if (!['ahead', 'identical'].includes(comparison?.status) || comparison.merge_base_commit?.sha !== stable ||
        !matches.every(Boolean)) {
      return failure;
    }
  } catch {
    return {
      passed: false,
      failures: ['GitHub could not verify the official Paperclip tag and lockfile. Retry the review.'],
    };
  }

  return { passed: true, failures: [] };
}
