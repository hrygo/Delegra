# Delegra fork branch and release workflow

Status: internal fork policy  
Applies to: `hrygo/Delegra`  
Owner: Delegra platform

## 1. Invariants

1. `master` is a read-only mirror of `upstream/master`. It has no local commits.
2. `deploy` is the only branch used for a Delegra installation. It contains
   every active fork-only change and every upstream stable release we have
   accepted.
3. `upstream/master` is a canary line. It is never a deployment input and is
   never merged directly into `deploy`.
4. A deployment runs an immutable `deploy/*` tag, not a moving branch tip.
5. Every code commit on `deploy` that is not from an upstream stable tag is
   registered in [`.delegra/patches.json`](../.delegra/patches.json).
6. Every registered patch has an owner, a review date, and a condition for
   retirement. A patch with no exit condition is technical debt, not a policy.

These rules separate three concerns that are easy to confuse:

| Concern | Branch or ref |
| --- | --- |
| Upstream identity | `master` |
| Internal integration | `deploy` |
| Upstream contribution | `fix/*` or `codex/*` |
| Release identity | `deploy/*` tag |

## 2. Branch model

| Branch | Created from | Merges into | Purpose |
| --- | --- | --- | --- |
| `master` | `upstream/master` | nowhere | Exact upstream mirror; never deploy |
| `deploy` | an accepted deployment baseline | release tags | Long-lived internal integration and deployment branch |
| `fix/<topic>` or `codex/<topic>` | `master` | upstream `master` through a PR | Upstream contribution |
| `backport/<topic>-<stable>` | `deploy` | `deploy` | Bring an upstream fix into the installation before it reaches stable |
| `local/<topic>` | `deploy` | `deploy` | Fork-only code or configuration that will not be sent upstream |
| `upgrade/<stable-tag>` | `deploy` | `deploy` | Candidate merge of a new upstream stable tag |
| `hotfix/<topic>` | the deployed tag | `deploy` and a new release tag | Urgent correction with a minimal diff |

`deploy` is merge-based and must not be rebased or force-pushed. Merge commits
preserve the reviewed integration point and keep deployed tags reproducible.
Feature branches may be rebased before review; `deploy` itself may not.

## 3. Why these boundaries

### `master` is not a working branch

The fork keeps `master` byte-for-byte identical to `upstream/master` so that:

- upstream comparisons show only real contribution branches;
- "Sync fork" remains safe and meaningful;
- there is one unambiguous reference for the current upstream canary;
- internal files never leak into an upstream PR.

Keep `master` as the GitHub default branch. If `deploy` were the default,
GitHub's "Sync fork" action would target the deployment branch and could merge
the upstream canary into production. Contributors must explicitly switch to
`deploy` when doing installation work.

### `deploy` accepts only stable upstream releases

The upstream canary line contains unreviewed, rapidly changing work. A stable
tag is the reviewable unit that Delegra accepts. Do not use
`canary/*`, `nightly/*`, `candidate/release-*`, or `upstream/master` as an
upgrade base.

The current `deploy` baseline is a documented exception because the existing
managed Codex fix was built on a canary commit newer than the latest stable
tag. The exception expires on the date in `.delegra/patches.json` and must be
replaced by the first suitable stable tag.

## 4. Normal workflows

### 4.1 Refresh the upstream mirror

Run this on a schedule and before creating a contribution branch:

```sh
git fetch upstream --prune --tags
git switch master
git merge --ff-only upstream/master
git push origin master
```

`master` must never receive a merge commit, a local edit, or a force push
unless upstream itself rewrote history. Record the resulting SHA in the
mirror-update log or release ticket when the mirror is part of a release.

### 4.2 Contribute a fix upstream

Start from the canary mirror, not from `deploy`:

```sh
git switch master
git merge --ff-only upstream/master
git switch -c fix/<topic>
# implement, test, commit
git push -u origin fix/<topic>
```

Open the pull request against `paperclipai/paperclip:master`. Keep the branch
free of `.delegra/`, `doc/DELEGRA-*`, deployment configuration, company names,
and credentials.

After the PR merges:

1. Delete the contribution branch.
2. If the change is already in the chosen stable base, do nothing.
3. If the installation needs it before the next stable, use the backport flow
   in section 4.3.

### 4.3 Backport an upstream fix before stable

```sh
git switch deploy
git pull --ff-only origin deploy
git switch -c backport/<topic>-<stable>
git cherry-pick -x <upstream-commit>...
```

Add or update the patch entry in `.delegra/patches.json` with:

- `kind: "upstream-pr"` or `"upstream-backport"`;
- the upstream PR number;
- the cherry-picked commit SHAs;
- `retireWhen` naming the first stable tag expected to contain it.

Run the policy check and the narrow tests for the changed area, then open a PR
to `deploy`. Merge it as a merge commit; do not squash, because the registry
tracks the original commit identities.

### 4.4 Add a fork-only change

```sh
git switch deploy
git pull --ff-only origin deploy
git switch -c local/<topic>
# implement, test, commit
```

Register the commit with `kind: "fork-only"` in `.delegra/patches.json`,
including the reason it is intentionally not upstreamable. Open a PR to
`deploy`, pass the policy check and relevant tests, and merge with a merge
commit.

Fork-only changes should stay small and isolated. If a change starts to affect
shared upstream behavior, split it into an upstreamable part and a thin
Delegra-specific adapter.

### 4.5 Upgrade to a new upstream stable release

This is the normal production path.

```sh
git fetch upstream --prune --tags
STABLE=v2026.1024.0
git switch deploy
git pull --ff-only origin deploy
git switch -c "upgrade/${STABLE}"
git merge --no-ff "${STABLE}" -m "chore(deploy): absorb upstream ${STABLE}"
```

Resolve conflicts by preserving upstream behavior and then reapplying the
smallest necessary Delegra patch. Do not merge `upstream/master` to resolve a
conflict. Do not copy a canary commit unless it is itself registered as a
backport with an upstream PR.

Before opening the upgrade PR:

1. Update `base.kind`, `base.ref`, `base.commit`, and remove an obsolete
   waiver in `.delegra/patches.json`.
2. For each active patch, check whether the stable base already contains it.
   Mark absorbed patches `absorbed` and remove them from the deploy history at
   the next safe rebuild; do not keep duplicate implementations.
3. Run `node scripts/check-delegra-branch-policy.mjs`.
4. Run the repository checks required by `AGENTS.md`:
   `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`.
5. Run the pilot acceptance procedure in
   [`DELEGRA-OPERATIONS.md`](DELEGRA-OPERATIONS.md) against a staging instance
   before changing the production service.

Open a PR from `upgrade/<stable-tag>` to `deploy`. After it passes, merge it
with a merge commit. The merge commit is the auditable "we accepted this
stable release" boundary.

### 4.6 Hotfix a deployed release

Create the hotfix from the exact deployed tag, not from an arbitrary local
branch:

```sh
git switch -c hotfix/<topic> deploy/<stable-tag>-rN
# minimal fix and focused regression test
```

Open a PR to `deploy`, then create a new release tag from the merged result.
If `deploy` has already advanced, forward-port the fix through the normal
backport or local-patch flow; never move an existing release tag.

## 5. Patch registry lifecycle

`.delegra/patches.json` is the source of truth for deploy-only code. The
policy checker verifies that:

- `master` matches `upstream/master` when both refs are available;
- the recorded base exists, matches its SHA, and is an ancestor of `deploy`;
- every registered patch commit exists and is contained in `deploy`;
- active patches that are already fully contained in the stable base are
  reported as stale;
- non-internal local commits are registered.

Patch status values:

| Status | Meaning | Action |
| --- | --- | --- |
| `active` | Needed by the current deployment | Keep and review |
| `merged-upstream` | Upstream PR merged, stable not yet accepted | Wait for the next stable or keep the backport |
| `absorbed` | Present in the accepted stable base | Remove at the next rebuild |
| `retired` | Intentionally no longer used | Keep the historical record |

Every active patch needs an owner and a `reviewBy` date. Review the inventory
at least monthly and before every stable upgrade.

## 6. Release and deployment

A release tag has this form:

```text
deploy/<upstream-stable-tag>-r<N>
```

Examples: `deploy/v2026.1023.0-r1`, `deploy/v2026.1024.0-r2`.

Create the tag only after the `deploy` PR has passed:

```sh
git switch deploy
git pull --ff-only origin deploy
node scripts/check-delegra-branch-policy.mjs
git tag -a "deploy/${STABLE}-r${N}" -m "Delegra release ${STABLE} r${N}"
git push origin "deploy/${STABLE}-r${N}"
```

Deploy the exact tag commit into an isolated release directory. Record:

- the tag and commit;
- the upstream stable base;
- the active patch IDs;
- database backup and migration status;
- the `/api/health` commit and acceptance evidence;
- the rollback tag.

Do not deploy a branch tip. Do not reuse or move a release tag. A source
rollback is not a database rollback; follow the database guidance before any
upgrade that changes schema.

## 7. Branch protection and repository settings

Keep `master` as the GitHub default branch.

| Setting | `master` | `deploy` |
| --- | --- | --- |
| Force pushes | Disabled | Disabled |
| Deletions | Disabled | Disabled |
| Direct changes | Mirror update only | PR only |
| Merge method | Fast-forward mirror update | Merge commit only |
| Required check | None or mirror provenance | `Delegra branch policy` |
| Reviews | Not applicable | At least one once the team has two maintainers |

If the instance has only one maintainer, require the policy check and
conversation resolution, and use the PR as the audit record. Do not disable
the policy check to make an upgrade pass.

## 8. Cadence and ownership

- **Daily or on demand:** refresh `master` from `upstream/master`.
- **On every upstream stable release:** open an `upgrade/<stable-tag>` PR.
- **On every urgent production defect:** use the hotfix flow and create a new
  release tag.
- **Monthly:** review active patches, owners, review dates, and retirement
  conditions.
- **Before company-wide rollout:** verify branch protection, CI availability,
  rollback, backup restore, and the acceptance journey on a staging instance.

## 9. Current transition

The existing deployed commit `a4976cdd7` is based on
`canary/v2026.1024.0-canary.7` and contains five upstream-facing commits plus
the operational document. The latest stable tag, `v2026.1023.0`, predates the
code path used by those commits; a direct port would be a rewrite rather than
a backport.

Therefore the initial `deploy` branch keeps this commit as a time-bounded
transitional baseline. It must move to the first suitable stable tag before
the waiver expires. The migration is complete when `.delegra/patches.json`
declares `base.kind: "stable"` and the policy check passes without a warning.
