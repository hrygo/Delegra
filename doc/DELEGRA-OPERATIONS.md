# Delegra pilot operations

Delegra maintains a small Paperclip patch set for internal deployment. Keep
upstream package names and data formats so upgrades remain reviewable.

## Source and upgrades

- `origin`: `https://github.com/hrygo/Delegra.git`
- `upstream`: `https://github.com/paperclipai/paperclip.git`
- `master` is a read-only mirror of `upstream/master`. Never edit it and never
  deploy it. Upstream `master` is the canary line.
- `deploy` is the only installation branch. It accepts upstream stable tags
  and registered Delegra-only patches.
- Put each upstream contribution on a dedicated `fix/*` or `codex/*` branch
  based on `master` and open a PR against `paperclipai/paperclip`.
- Put a fork-only fix on a dedicated `local/*` branch based on `deploy` and
  open a PR against `deploy`.
- Deploy an exact reviewed `deploy/*` tag. Do not deploy a moving branch tip.
- Record every deploy-only code commit in
  [`.delegra/patches.json`](../.delegra/patches.json). Before an upgrade, check
  whether upstream has fixed the same defect. Drop an obsolete patch instead
  of maintaining two implementations.
- Review schema changes and take a database backup before changing the deployed
  revision. Follow [database guidance](DATABASE.md) and the existing deployment
  procedures. The managed Codex project-authentication patch has no migration.

See [the branch and release workflow](DELEGRA-BRANCH-WORKFLOW.md) for the
commands, branch protection, stable-upgrade process, and patch lifecycle.

## Codex account and workspace configuration

Use [AI Connections](connections/AI-CONNECTIONS.md) to select a personal or
company-shared account. The selected connection owns provider routing. Keep
gateway credentials in the existing encrypted secret store.

The native runner uses Codex app-server with an isolated authentication home.
A developer's host provider settings do not become the worker's provider
settings. Configure the intended gateway on the AI connection.

For a local HTTP gateway, use a loopback endpoint supported by the existing
routing policy. A loopback forwarder is a host-specific deployment component;
it does not add encryption to its onward connection. Use a suitable HTTPS
endpoint for a shared network deployment.

Managed Codex checks project authentication within the physical task project.
It stops at the nearest `.git` marker, including Git worktree marker files.
Without Git, it checks the working directory only. It rejects authentication
overrides inside that scope. Before workspace resolution it checks explicit
configuration arguments, then checks files after the task workspace is known.

## Managed agent configuration checks

An ordinary environment-variable edit keeps the selected AI connection and
does not start a provider probe. Binding comparison normalizes both saved and
requested values, including values read back from PostgreSQL JSONB.
Changes to the model, harness, provider, engine, connection, or execution
environment still require the applicable validation. A failed check leaves
the saved configuration unchanged.

Adoption checks and independent environment tests resolve the same prospective
configuration. The selected environment supplies the base variables. Agent
variables take precedence, followed by managed authentication. Both paths
validate the execution target before reading its secrets. When a target is
unavailable, metadata-only checks still report missing environment bindings
without resolving secret values. Missing bindings and unauthorized secrets
still fail; secret values stay out of responses.

## Deployment and rollback

The 2026-10-27 environment repair runs
`deploy/v2026.1024.0-canary.7-r8` (`ec00bcd4c001502dde7f24ee7f72825efff495b8`),
merged in [PR #20](https://github.com/hrygo/Delegra/pull/20).
The reviewed source passed independent review, local typecheck and build,
and 50 CI checks; one paired check was skipped. The local full suite completed
on 2026-10-27 at 01:10 Asia/Shanghai with exit code 0; existing skipped cases
remain skipped. The merge tree matches the reviewed source, and the isolated
release installation built successfully.

The authenticated controller health reports the expected clean commit and
startup recovery ready. Both affected agents saved their final environment
fields, and an exact read-only database check verified all three values.
At activation, models, managed connections, secret references, all seven manual
pauses, and the existing budget policy were unchanged; this repair did not run
a business task. The full agent checkout/tool/report/finalize lifecycle was not
part of deployment qualification. Subsequent task rollout and role changes are
owned by the current project coordination workflow.

The two historical zero-incremental-fee events were corrected through the
existing r6 audited adjustment API before this release. They did not require
new billing code. The budget is healthy and the original usage and receipts
match after r8. PR #21's automatic billing declaration feature remains a draft
and was not deployed.

A fresh pre-release database backup passed gzip integrity and SHA256 checks;
no restore drill was performed. This repair adds no migration. The deploy
base retains the unused reference-rate table migration from the withdrawn
feature. Keep current data for a source rollback to r6; do not overwrite the
new audit adjustments with an older database snapshot.

The source fix is proposed upstream in
[PR #17760](https://github.com/paperclipai/paperclip/pull/17760), with
[issue #17759](https://github.com/paperclipai/paperclip/issues/17759) and the
existing [issue #14518](https://github.com/paperclipai/paperclip/issues/14518).
Upstream acceptance remains separate from this local release.

Keep service configuration, instance data, and source revisions separate.
Preserve the instance data directory when switching source revisions. Run one
service against that data directory; do not start a second controller on it.

Use the existing source-checkout TypeScript launcher when running from this
monorepo. A source build alone does not qualify a standalone published-package
installation. Record the source revision reported by `/api/health` and confirm
that the service starts the expected checkout.

For a local runner on the controller host, use an explicit loopback
`PAPERCLIP_API_URL` for the runner's control-plane connection. Remote runners
need their own reachable, authorized controller endpoint.

Keep the previous service configuration and reviewed source revision available
for rollback. Restore that configuration and restart the service if acceptance
fails. A later upgrade with schema changes may require a compatible database
restore; source rollback alone is not a general migration rollback.

The 2026-10-26 pricing rollback restored
`deploy/v2026.1024.0-canary.7-r6` (`c59e0854c`). The controller reported that
revision through `/api/health` at the time. The operator authorized discarding post-r7
changes, so the database was restored from the verified pre-r7 snapshot. The former r7
database and a separate dump remain available as recovery points outside Git.
PR #17's reference-rate API and Providers editor are withdrawn. Keep its SQL
migration, journal, snapshots, and schema in source to preserve executable
migration history; they have no active pricing API or UI. Future deployment
from this branch may create the unused table again. Complete billing design
files remain on a local-only branch pending upstream scope agreement.

## Remote native Codex over SSH

Remote Codex agents use the same `paperclip_runner` Codex app-server harness as
local native Codex. The SSH environment owns the host and workspace selection.
The Runner uses a separate authenticated WSS connection back to the controller;
SSH reachability alone does not prove that this callback is reachable.

For a private loopback installation, terminate TLS on a loopback-only bridge and
forward only `/api/runner/v1/connect/:runnerId` WebSocket upgrades to the API.
Keep ordinary API routes unavailable through this bridge. Use a dedicated CA and
leaf certificate with the loopback IP in its SAN. Store private keys outside the
checkout with mode `0600`. Set `PAPERCLIP_RUNNER_PUBLIC_URL` to the WSS endpoint
and `PAPERCLIP_RUNNER_CA_BUNDLE_PATH` to that CA certificate in the controller's
service environment. Each host reaches it through a loopback-bound SSH reverse
tunnel. Keep host-key validation, authentication, and reconnect supervision on.

Package the Runner binary for every target OS and architecture in
`bin/<platform>-<arch>/paperclip-runnerd` under the Runner distribution and the
server's vendored copy. Build Linux ARM64 on the intended Linux ARM64 host from
the same Runner sources and lockfile, compare artifact hashes after transfer,
and check `--build-metadata`. Do not set a global remote-binary override when
macOS ARM64 and Linux ARM64 environments coexist.

Verify a real native setup probe on each host, then a small task that checks the
host and workspace with tools. Inspect its persisted result and terminal run
state. A working legacy Codex CLI task does not qualify native app-server.
Keep the preceding immutable release, service configuration, and database backup
for rollback. Do not delete prior tasks or runs to hide failed acceptance.

## Acceptance before wider rollout

1. Run `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`.
2. Run `node scripts/check-maps.mjs` after map changes.
3. Test the selected managed connection in the intended execution environment.
4. Assign one small task that asks for a fixed single-line reply and no tools.
5. Verify the native turn completes, its output persists in the task, the task
   reaches its intended final state, and its execution lock is released.
6. Reload the task and inspect the stored result. A successful account probe
   does not establish task completion.
7. Keep evidence of earlier failures. A successful retry does not explain an
   earlier timeout without a controlled comparison.

Start the pilot with one worker and one concurrent task. Keep existing account
audiences, agent grants, approvals, budgets, and audit controls in effect.
Increase scope only after the same checks pass for the intended environment.

The inherited upstream CI workflow uses upstream-owned runner routing. Confirm
Delegra has usable CI and review gates before treating a pilot build as an
organization-wide release. Local checks do not establish fork CI readiness.
Remote shell policy tests do not qualify a real SSH host or a task-only plugin
environment. Follow [deployment modes](DEPLOYMENT-MODES.md) for network access
and [execution semantics](execution-semantics.md) for task lifecycle behavior.
