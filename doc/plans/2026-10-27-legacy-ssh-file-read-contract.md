# Legacy SSH optional-file read contract

The DEL-52 Legacy qualification run completed provider
work but failed during the Codex home restore: its managed routed API-key home
correctly had no `auth.json`. `copyBackCodexAuth` already treats `ENOENT` as a
keep-host outcome, but the SSH asset reader forwarded the shell's numeric exit
code from `base64 < path`. The successful provider result was therefore replaced
by a required restore failure. Before this fix, the relevant source was
byte-identical in r8 and the checkout; this predates the structured launch-policy
change.

The SSH runtime owns normalization of remote file errors. After a shell read
exits 1 or 2, it performs one metadata-only probe. It reports `ENOENT` only when
the immediate parent exists and is searchable and the target is absent without
an unresolved symbolic link (which could conceal EACCES/ELOOP). The probe has
the existing SSH timeout and a 1 KiB output limit. A failed or
inconclusive probe preserves the original read error. SSH/authentication exit
255, signals, timeouts and local SSH setup errors do not enter the probe. A
local setup `ENOENT` becomes `ERR_SSH_READ_SETUP` with the original cause so
optional-file callers cannot swallow a missing SSH executable/key file.
Paths ending in `/` retain the original read error without an absence probe:
the shell's `-L` check cannot identify a final symlink through trailing separators.
Permission errors, missing parents and transport faults remain required restore
failures. No credential content is inspected by the probe, and subscription
copy-back, workspace restore and their error priority remain unchanged.

Verification uses synthetic temporary files and an intercepted SSH transport.
Real POSIX shell commands exercise quoted paths, absent files, missing parents,
unreadable files, unsearchable parents, a symlink loop and directory paths with
single/multiple trailing separators. Injected transport
faults cover exit 255, missing SSH executable, timeout and a failing absence
probe. The Legacy
Codex execute regression retains the actual restore/copy-back functions and
proves that a successful managed API-key run without remote auth finalizes
successfully without creating host auth, while local SSH setup `ENOENT` remains
a fatal restore error. With managed remote environment cleanup installed, the
same regression confirms cleanup after successful auth recovery and retention
after a fatal auth read. Fault injection selects the auth read command directly,
so preparation/cleanup cannot consume it. Root execution skips the real chmod case because root
bypasses DAC permissions; it is exercised on the local
non-root macOS test run.

Run the focused checks from the repository root:

```sh
pnpm exec vitest run packages/adapter-utils/src/remote-managed-runtime.test.ts packages/adapters/codex-local/src/server/execute.remote.test.ts
pnpm --filter @paperclipai/adapter-utils typecheck
pnpm --filter @paperclipai/adapter-codex-local typecheck
```

This change does not decide whether a managed connection should register auth
copy-back or change environment precedence. Reverting the SSH reader and its
regressions restores the previous behavior; no data migration or live change is
needed. Live SSH acceptance remains a release check.
