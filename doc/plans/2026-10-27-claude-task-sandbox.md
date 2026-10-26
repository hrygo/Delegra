# Managed Claude task safety configuration

Status: implemented with source regressions passing. Release and live agent qualification remain pending. This is part of the authorized seven-agent configuration repair.

The two macOS Claude CLI roles currently bypass all tool permissions. Passing an arbitrary `--settings` or `--setting-sources` override to a managed AI connection is correctly rejected. Preserve that authentication boundary and add a narrow adapter-owned configuration rather than a command wrapper or alternate argument spelling.

A closed versioned `claudeSafetyPolicy` provides `workspace-build` and `candidate-review` profiles. It rejects unknown versions/keys, conflicting bypass and raw argument overrides. The adapter derives paths from the actual execution directory, compiled prompt bundle and resolved Git metadata; callers cannot supply arbitrary settings, paths or endpoints. The selected model, effort and managed AI environment remain unchanged.

The build profile preserves file editing and Bash builds inside the native Claude macOS/Linux sandbox, requires successful sandbox startup and forbids unsandboxed fallback. Protect prompt bundles and Git metadata. Default to offline execution. The review profile exposes read-only file tools and a final report. Neither profile claims that the Bash sandbox also encloses file tools or MCP servers; apply corresponding tool permissions.

Keep complete selected skills. Prefer existing metadata and explicit reads; if native discovery needs a plugin entry, generate a skills-only adapter-owned entry from the resolved selection, with no hooks, MCP servers or arbitrary plugin configuration. Do not enable untrusted user/project configuration to make discovery work.

Probe and execution share the same builder. A successful hello proves argument/configuration acceptance, not tool boundaries. Unit regressions cover closed-schema rejection, bypass/argument conflicts, derived paths, sandbox escape settings, selected-skill isolation and probe/execution parity. Live qualification separately proves workspace writes/builds, rejected controlled outside writes and unapproved network, and durable final-output reception. Legacy final output must not be mislabeled as a native finish tool.

Ownership: one implementer owns only `packages/adapters/claude-local/**`; the Codex launch-policy implementer owns `packages/paperclip-runner/**`. No worker commits, pushes, deploys or modifies live agents. The primary agent reviews, applies configuration through the authenticated normal API, verifies actual results and preserves prior values for rollback.
