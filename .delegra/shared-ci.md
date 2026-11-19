# Shared PR CI snapshot

`pr-delegra-trusted.yml` snapshots the candidate's `pr-trusted.yml` and calls
the `ci-routing-delegra.yml` snapshot by its fork commit. `pr.yml` also pins
its snapshot to a fork commit. The routing snapshot reads planner inputs from
the accepted upstream source. A stable tag's upstream ancestor can supply
those inputs when every planner input and the routing workflow match the tag.
The consistency job checks the snapshots, their pins, and the candidate task
matrix on each pull request.

To update CI with a deploy upgrade or a deliberate workflow change:

1. Review the new upstream workflow, routing workflow and every referenced
   script and command against the candidate deploy tree. Preserve all gates.
2. Stage and commit the fork routing snapshot with its upstream planner pin.
   Regenerate `pr-delegra-trusted.yml` from `pr-trusted.yml` using that fork
   commit for its nested routing call, then commit the trusted snapshot.
3. Set the `pr.yml` snapshot reference to the trusted snapshot's commit, run
   `node scripts/check-delegra-shared-ci.mjs`, validate both workflow files,
   and register fork-only code commits in `.delegra/patches.json`.
4. Push the complete candidate branch and verify an actual PR run, including
   routing, policy, all applicable test and build gates, and consistency.
   A local snapshot commit cannot be resolved by GitHub before it is pushed.

The `upgrade/v2026.1117.0` pull request can carry lock content from the
published `v2026.1117.0` source. The policy checks tag ancestry and requires
identical lockfiles and reporting lock proof at both the PR head and tested
merge. Once `deploy` contains the tag, its normal lockfile policy applies.
For this adoption, migration ordering uses the verified stable source. The
gate requires the upstream SQL stream and the published Delegra SQL at `0452`
on both the PR head and tested merge. Lock content and migration changes
trigger the fork policy and matrix even when no application code changes.

The fork uses GitHub-hosted runners: the routing workflow selects the upstream
AWS fleet only for `paperclipai/paperclip` and its repository ID. The upstream
runner group only permits its specified trusted workflow ref, so the fork
snapshot must not assume access to that fleet. Keep the routing pin under
review: the consistency check does not prove future routing semantics.

For an existing PR, merge this fix into its base through the normal protected
PR flow, update the PR branch from the new base, and trigger a new
`pull_request` run. Re-running an older run retains its original event SHA;
it does not adopt the new caller workflow. Confirm the new run's displayed
called workflow SHA and all applicable check results before relying on it.
