# Delegra fork metadata

`patches.json` is the machine-readable inventory of code that is intentionally
present on the `deploy` branch but is not part of the upstream stable base.

The branch and release procedure is documented in
[`doc/DELEGRA-BRANCH-WORKFLOW.md`](../doc/DELEGRA-BRANCH-WORKFLOW.md). Validate
the inventory before opening an upgrade or release pull request:

```sh
node scripts/check-delegra-branch-policy.mjs
```

Do not add Delegra-only files to `master`. That branch is an exact mirror of
`upstream/master`.
