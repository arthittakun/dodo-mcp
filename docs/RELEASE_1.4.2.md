# DODO MCP 1.4.2 — Recovery best effort across restart

Automatic source backups no longer make ordinary editing or
commands depend on Recovery availability. A project with an old strict policy,
a missing backup volume, or a credential-like example file can continue normal
work while Recovery reports its failure.

## Changes

- Automatic activation, before-write and before-exec captures are best effort,
  including stored `strictEnforcement`, `gitRequired` and `gitDirectory` settings.
  Backup failure no longer turns a permitted `echo ok` or source edit into
  `RECOVERY_REQUIRED`.
- The per-project `skipSecretContentFiles` preference persists across restart.
  Capture reports credential-like files it skips without storing their contents
  as a completed backup. The Recovery quick action changes this project preference
  rather than disabling global file permissions or secret screening.
- `project_overview` includes `blockedPath`, `skippedSecretFiles`, `lastWarning`
  and `operationsBlocked:false`. `blockedPath` is a relative source path when
  known, or `null` for a failure without a specific source file. A later global
  failure clears a previous path instead of pointing at an unrelated file.
- Recovery storage initializes on first disk access. A broken Recovery directory
  can no longer prevent the server from booting, while canonical directory
  identity and private-path checks still reject replacement storage.
- History, drift and agent bookkeeping failures report diagnostics without
  hiding a completed operation or repeating its effects. Corrupt Recovery
  metadata remains visible from the overview.
- The Recovery dashboard replaces the Strict Blocking switch with the best-effort
  behavior and describes `BLOCKED` as backup unavailable, not a lock on normal work.

Explicit owner/verified checkpoints and reviewed restores still require their
backup and integrity checks to succeed. Authorization, secret/path policy,
expected hashes, and recovery guards for an actual partial file journal remain
authoritative. A warning means the operation may have no new Recovery checkpoint.

## Upgrade

```sh
npm install -g dodo-mcp@1.4.2
dodo --version
```

Restart the DODO process using the service or launcher that normally runs it.
Installing the package does not replace code already loaded by a running process.
Refresh the MCP connection and call `project_overview` again for its current
workspace epoch. The updated overview exposes `operationsBlocked:false` alongside
the backup diagnostics. For Docker installations, update the package in the DODO
image and recreate that service with its existing persistent state.

No live production instance was updated during the patch validation. Installation
and a real server restart are separate from the fixture restart tests.

## Validation

Windows / Node 24.22.1 patch checks: build, typecheck and lint passed; the main
Recovery regression group passed 69 tests with 2 platform/dependency skips.
Storage boot/identity checks passed 2 tests, the owner UI passed 1 test in system
Chrome, and fresh-install packaging passed 17 tests: 89 passed in total across
these focused checks. See [the test report](TEST_REPORT.md).

This is focused patch evidence, not a completed full native release gate.
Native Linux/macOS and live production acceptance were not run for this patch.
The existing production dependency advisories are not remediated by this change.

See [Recovery usage and limits](RECOVERY.md) for checkpoint, restore and storage
behavior.
