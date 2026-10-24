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

## Deployment and rollback

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
