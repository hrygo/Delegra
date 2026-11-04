# Shared PR CI snapshot

`pr-delegra-trusted.yml` is a snapshot of the deploy baseline's
`pr-trusted.yml`. Its nested `ci-routing.yml` call is pinned to the matching
upstream commit. `pr.yml` calls the snapshot by the fork commit that contains
it. This prevents a moving upstream workflow from requiring scripts that do
not exist in deploy. The consistency job checks both the snapshot against
`pr-trusted.yml`, the caller SHA against the snapshot, and the pinned routing
content against the candidate `ci-routing.yml` on every PR.

To update CI with a deploy upgrade or a deliberate workflow change:

1. Review the new upstream workflow, routing workflow and every referenced
   script and command against the candidate deploy tree. Preserve all gates.
2. Update `pr-trusted.yml` and the snapshot together; the only allowed
   difference is the full SHA used by the snapshot's `ci-routing.yml` call.
   The routing pin must identify a commit whose `ci-routing.yml` matches the
   candidate baseline. Commit the snapshot before updating its caller SHA.
3. Set the `pr.yml` snapshot reference to that commit, run
   `node scripts/check-delegra-shared-ci.mjs`, validate both workflow files,
   and register fork-only code commits in `.delegra/patches.json`.
4. Push the complete candidate branch and verify an actual PR run, including
   routing, policy, all applicable test and build gates, and consistency.
   A local snapshot commit cannot be resolved by GitHub before it is pushed.

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
