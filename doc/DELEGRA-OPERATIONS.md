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

## Managed task safety

Generated Codex filesystem policy travels through the typed launch-policy
contract, not a command-line argument. Assigned skill roots and the 4,096-byte
per-argument limit are preserved. Both controller and Runner artifacts must
support the contract; older artifacts reject a new-policy session before
admission. Drain those sessions before a source rollback and retain checkpoints
for recovery with compatible artifacts. Do not retry with broader permissions.

Managed Legacy Codex runs over SSH use private per-run HOME, XDG, temporary and
tool-cache directories with mode `0700`. The target PATH and Codex authentication
home remain explicit. Collection removes only that run's environment after
provider stop and successful workspace/auth restoration. Unknown stop or restore
failure retains it for investigation; a cleanup error does not replace the
primary result. A confirmed missing optional auth file preserves host auth;
permission, transport and local SSH setup failures remain fatal.

Managed Claude CLI tasks can opt into adapter-owned `claudeSafetyPolicy`
profiles: `workspace-build` or `candidate-review`. They require CLI 2.1.310 or
newer, disabled permission bypass, and no conflicting raw settings/arguments.
The build profile enables workspace file/build tools, protects prompt/skill/Git
metadata and keeps Bash offline inside the required sandbox. The review profile
exposes only read tools and final text; the host persists the report. Both keep
the complete selected skills and reject unsandboxed fallback. A CLI hello does
not prove tool boundaries or a successful platform task lifecycle.

Heartbeat skill preparation keeps the explicit company skill selection for both
closed profiles. It does not add Legacy operational or feedback defaults. Invalid
opt-ins fail before adapter dispatch. Stored selection snapshots retain their
original skill set, versions and bytes during recovery.

The build profile puts both pnpm store aliases, the UV cache and pnpm runtime
locks in a private directory inside the task workspace. Cleanup requires the
current provider stop receipt and successful collection; unknown state retains
the directory. No additional write grant is added. Requested temporary paths
and the CLI's effective Bash temporary directory are separate observations.
Candidate review creates no writable tool cache. Synthetic offline installation
qualifies this boundary only; product dependency installation remains separate.

The internal three-host pilot selects Codex, Claude CLI and OpenCode. Shared
launch-source changes advance the generated Copilot profile to immutable v59,
with live qualification explicitly pending and historical identities retained.
Offline profile and packaging checks do not qualify Copilot service execution.
The pilot does not claim a general four-platform provider release.

Verify a fixed toolchain entry with both a shell invocation and direct process
spawn. A shell can execute a pnpm placeholder without a shebang while a direct
spawn fails or falls through to another PATH entry. Use a versioned executable
entry for the installed native package, preserving the per-run cache projection;
do not repair this by installing a different global pnpm or rewriting a previous
toolchain revision.

An operator can explicitly select `unpricedUsagePolicy=allow` to value unknown
costs as zero for budget admission. See [Costs and Budgets](../docs/guides/board-operator/costs-and-budgets.md)
for the remaining accounting, reservation and recovery boundaries. This policy
does not complete a missing provider receipt or establish that a provider stopped.

## Deployment and rollback

The current deployment is `deploy/v2026.1024.0-canary.7-r13`
(`de2d1690f783bd6340eb6f1d7e37f25072c28851`). It replaced r12 on 2026-10-28 at
09:48 Asia/Shanghai through `delegra service restart --instance delegra --wait`,
which drained active work before the cutover and then adopted the native runs
that restarted with the new process. The controller health reported `ok` and
commit `de2d1690f78`. The release contains 20 active patch IDs, recorded in
`currentDeployment` in [`.delegra/patches.json`](../.delegra/patches.json).

r13 adds four patches on top of r12, all covered by merge commits that passed
the `Delegra branch policy` gate:

- `codex-remote-trust-bypass` ([PR #31](https://github.com/hrygo/Delegra/pull/31))
  passes `--skip-git-repo-check` for every remote execution target, not only the
  sandbox transport, so an SSH workspace staged without a git checkout no longer
  fails with `Not inside a trusted directory`.
- `remote-anchor-workspace-enoent` (same PR) also reports `ENOENT` from
  `resolveAnchorWorkspaceForRun` as a workspace validation failure and names the
  bound SSH environment's `remoteWorkspacePath`, instead of surfacing a bare
  `mkdir` error.
- `native-failure-finalize-without-result`
  ([PR #33](https://github.com/hrygo/Delegra/pull/33)) stops calling
  `finalizeNativeRun` on a `terminal_failure` coordinator that has no persisted
  result, which used to throw `native_result_missing` on every failed native run
  and log a retry that could never progress.
- `opencode-go-routing-session`
  ([PR #32](https://github.com/hrygo/Delegra/pull/32)) forwards the harness
  routing session to an OpenCode Go gateway as `x-opencode-session`, with the
  run's normalized session id as the fallback, so a projected custom provider no
  longer answers `Request is missing x-opencode-session`.

r13 has no schema, migration, or database change relative to r12, and the switch
performed no schema migration. The shim backup taken during the switch is
`~/.local/bin/delegra.bak-r12-20261028-094716`, and r12 is the source rollback
release.

The previous deployment was `deploy/v2026.1024.0-canary.7-r11`
(`4c833df7b063e45359339a80e61c28ed3493b07e`, tree
`80e1f63041bc8a0dcdd805948ff0c7906386b951`). It replaced r10 on
2026-10-27 at 11:52 Asia/Shanghai. The controller health reported `ok` and the
expected commit. [PR #26](https://github.com/hrygo/Delegra/pull/26) passed all
50 CI checks. The isolated release build preserved the source and lockfiles and
packaged macOS ARM64 and Linux ARM64 Runner artifacts. The 14 active patch IDs
are recorded in `currentDeployment` in
[`.delegra/patches.json`](../.delegra/patches.json).

A fresh database backup passed gzip integrity before the switch. No restore
drill was run. The switch performed no schema migration or database restore.
r10 is the source rollback release. Preserve the current database and the
existing service configuration. Drain structured-policy sessions before a
rollback to the older controller and Runner pair, and retain their checkpoints
for recovery with compatible artifacts.

At activation, an admission evaluation for the QA role on the SpeechNexus
project returned no block while a cancelled legacy run still had pending
accounting. The operator kept `unpricedUsagePolicy=allow` on both project
policies. Known spend, held reservations, native recovery gates, and manual
pauses still apply. The evaluation was read-only against the running release.

The operator changed the A, B, and integration-assistant roles from OpenAI
`gpt-6.1-sol` to CLIProxyAPI `opencode-go-ds-flash` through the board API. The
remaining roles already used non-OpenAI models: C and QA use
`opencode-go-ds-flash`, the evidence role uses `paperclip/omlx-sage-a1.5`, and
the reviewer and retired Gemini roles use Claude models. Saved configuration
readback matched. No agent was resumed, and no run was active before or after
this configuration update.

The previous deployment was `deploy/v2026.1024.0-canary.7-r10`
(`216f99e05907d150fa3057c1e2732188408f6baa`, tree
`8e98f28c2f232b6d12d735351f0931f138bb5cc3`). It replaced r8 on
2026-10-27 at 07:48 Asia/Shanghai. The controller health reported `ok` and the
expected commit. [PR #24](https://github.com/hrygo/Delegra/pull/24) passed
independent source review and all 50 CI checks. The isolated release build
preserved the source and lockfiles and packaged macOS ARM64 and Linux ARM64
Runner artifacts. The 13 active patch IDs were recorded in `currentDeployment`
in [`.delegra/patches.json`](../.delegra/patches.json).

A fresh database backup passed gzip integrity and SHA256 checks before the
switch. No restore drill was run. The switch performed no schema migration or
database restore. r9 remains an undeployed candidate; r8 is the source rollback
release. Preserve the current database and the existing service configuration.
Drain structured-policy sessions before a rollback to the older controller and
Runner pair, and retain their checkpoints for recovery with compatible artifacts.

The platform, workbench and reviewer roles saved the reviewed safety and explicit
skill selections through the normal board API. Full configuration readback
confirmed 75 explicit skill references. Models, effort, connections, execution
environments, environment variables and unrelated adapter fields were unchanged.
No agent was resumed, and no run was active before or after this configuration
update. At that configuration checkpoint, live model, tool and finalization
qualification, and the real product slice remained pending. Later qualification
uses the current operator cost policy and observed execution recovery state.
Deployment health and configuration readback do not establish pilot acceptance.
Copilot v59 live qualification remains pending.

The earlier 2026-10-27 environment repair installed
`deploy/v2026.1024.0-canary.7-r8` (`ec00bcd4c001502dde7f24ee7f72825efff495b8`),
merged in [PR #20](https://github.com/hrygo/Delegra/pull/20).
The reviewed source passed independent review, local typecheck and build,
and 50 CI checks; one paired check was skipped. The local full suite completed
on 2026-10-27 at 01:10 Asia/Shanghai with exit code 0; existing skipped cases
remain skipped. The merge tree matches the reviewed source, and the isolated
release installation built successfully.

At r8 activation, authenticated controller health reported the expected clean
commit and startup recovery ready. Both affected agents saved their final
environment fields, and an exact read-only database check verified all three values.
At activation, models, managed connections, secret references, all seven manual
pauses, and the existing budget policy were unchanged; this repair did not run
a business task. The full agent checkout/tool/report/finalize lifecycle was not
part of deployment qualification. Subsequent task rollout and role changes are
owned by the current project coordination workflow.

The two historical zero-incremental-fee events were corrected through the
existing r6 audited adjustment API before this release. They did not require
new billing code. The budget was healthy and the original usage and receipts
matched after r8. PR #21's automatic billing declaration feature remains a draft
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

## Fleet status panel

`scripts/fleet-status.sh` answers one question: who is working, who is idle, and
what is waiting on a human. It renders a text table by default and the same
facts as one JSON document with `--json`.

```sh
scripts/fleet-status.sh                      # one render
scripts/fleet-status.sh --json               # same facts, machine-readable
scripts/fleet-status.sh --watch 60           # re-render every minute
scripts/fleet-status.sh --company Delegra    # one company, by name or id
pnpm test:fleet-status                       # decision-rule tests
```

### Exit codes

| Code | Meaning |
| ---- | ------- |
| `0`  | Nothing needs a human |
| `1`  | At least one item needs a human |
| `2`  | Panel unavailable: bad usage, `psql` missing, unreachable database, query or schema failure, unparsable row, or a scope that matches no agent |

Text and JSON modes share one decision function, so they cannot disagree.
`--watch` deliberately does not propagate these codes: it reports each failure
on stderr and keeps the interval running. It clears the screen only when stdout
is a terminal, so redirecting a `--watch` run to a file yields plain frames
instead of one escape sequence per frame.

An idle agent with no unfinished work exits `0`. Free capacity is the healthy
case, not an item to action; the panel still lists it so work can be handed out.
A scope that matches no company, that matches only archived companies, or whose
query returns no agent, exits `2` instead of reporting an empty fleet as
all-clear. The one exception is a scope whose agents are all `terminated`: that
is a real answer, so the panel prints an empty table with the excluded count and
exits `0`.

### What counts as attention

The rule is that a state is only called out when the database shows no waiting
path for it. A live run, a fresh queued wakeup and an active recovery action
cover the whole agent; a scheduled monitor (`monitor_next_check_at`) covers only
the card it is attached to.

- A live run older than `--running-slow`, or one silent for longer than
  `--run-silent`. Reported for inspection only: the panel does not claim the run
  is wedged, does not recommend interrupting it, and does not suggest rewriting
  or clearing any field. Those calls need the run log, process state and
  artifacts, which this tool does not read.
- In-progress cards that no live run, fresh wakeup or recovery action covers and
  that carry no monitor of their own. A monitor on one card does not excuse the
  others, and the note counts only the uncovered cards.
- `in_review` work that is not the card of the live run. A review card the
  assigned agent is currently running is not counted again, and the reported
  wait skips that card.
- A paused agent that still holds unfinished work.
- Agent status `error` or `pending_approval`.
- Failed wakeup requests inside the `--wake-window` window.
- Queued or deferred wakeups older than `--wake-stale` when the agent has no run
  that could drain them. Behind a live run the same queue is reported without
  raising attention, because one run serialises its agent's wakeups.

A stale queue is not a waiting path either. An agent whose only queued wakeups
are older than `--wake-stale` counts as having work with no usable path, so the
row never reads "waiting to be claimed" and "queued for six hours" about the
same wakeup. One fresh entry keeps the agent in `waiting` while the older
entries are still reported.

`deferred_issue_execution` is a queue state the scheduler resumes, not a failure,
so it is never counted as a failed wakeup. `claimed` is excluded from the queue
entirely: it records that a run took the wakeup, and not every completion path
advances the row to a terminal status, so counting it would report permanent
backlog.

### Data source, scope and read-only boundary

The panel reads the instance database directly rather than the HTTP API. The
board API exposes aggregate counts (`/api/companies/:id/dashboard`) and a
decision feed (`/api/companies/:id/attention`), both behind board
authorization, and neither carries per-agent run state. Direct SQL is therefore
the only way to render this view without adding a server endpoint; extending the
dashboard API remains the better long-term home if this becomes a product
surface rather than an operator panel.

Every statement runs with `default_transaction_read_only=on`, and the panel
refuses to continue if that setting is not in effect. `statement_timeout` and
`lock_timeout` keep a blocked read from hanging a shell. The panel only reads.

Scope defaults to every company with a non-archived status; `--company` narrows
it by id or by case-insensitive name. The same predicate is applied inside the
aggregate CTEs, so a narrowed scope also reads fewer rows instead of filtering
after a full scan. `terminated` agents are excluded and counted in the footer.
Conversation containers, hidden rows and non-execution harness rows are excluded
from work cards the same way the board excludes them.

Connection string resolution order is `--db`, `PAPERCLIP_FLEET_DATABASE_URL`,
`DATABASE_URL`, then `postgresql://delegra_app@127.0.0.1:5432/delegra`. The
connection needs `SELECT` on `companies`, `agents`, `issues`, `heartbeat_runs`,
`agent_wakeup_requests` and `issue_recovery_actions`; it needs nothing else, and
a read-only role is sufficient.

This panel depends on those six relations. A schema change to any of them needs
a matching change here. A missing relation fails with exit `2` and a named list;
a missing column surfaces as a query failure with the PostgreSQL error.

### Thresholds

Defaults are `--running-slow 25`, `--run-silent 10`, `--todo-idle 8`,
`--review-wait 15`, `--wake-window 3` and `--wake-stale 30` (minutes, except the
window in hours). `--todo-idle` and `--review-wait` grade the wording of a note;
they do not change whether a row is flagged. An in-progress card with no run, no
wake, no monitor and no recovery is anomalous at any age, because a healthy
fleet always leaves one of those behind.

The same values can be set through `FLEET_RUNNING_SLOW`, `FLEET_RUN_SILENT`,
`FLEET_TODO_IDLE`, `FLEET_REVIEW_WAIT`, `FLEET_WAKE_WINDOW_H` and
`FLEET_WAKE_STALE`, which keeps `--watch` invocations short. Every threshold is
echoed in the header and in the JSON `thresholds` block, so a reading is always
attributable to the numbers that produced it.

### Known limits

- Embedded PostgreSQL has no TCP endpoint, so the panel needs an external
  PostgreSQL instance. With `DATABASE_URL` unset it exits `2` and says so.
- The Slack/chat "waiting" conversation check is not evaluated. A chat
  conversation left `in_review` can therefore appear as a review card.
- Run silence is measured from the later of the last output and the current
  attempt's start, so a restarted attempt never inherits silence. It is a
  signal to look, not a stall verdict.
- A fresh queued wakeup, an active recovery action and a live run are treated as
  covering every card of the agent, not just the card they name. That errs
  toward under-reporting a stall, never toward inventing one.
- The panel applies no board authorization. Its only access control is the
  database role it connects with, so treat its output as instance-wide: do not
  hand it to someone who lacks board access to the companies in scope.
- `--watch` clears the screen only on a terminal; a redirected run is a plain
  sequence of frames with no separator between them.

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
