# ADR-001 — One process = one CWD workspace = one endpoint profile

**Status:** accepted (implemented)

**Decision.** A DODO process serves exactly one workspace root — the realpath of
`process.cwd()` captured at the CLI entrypoint — and one public issuer/profile.
There is no remote tool to change root or lower policy. `workspaceId` is
server-minted (derived from a per-install secret + canonical root) and every
tool except `project_overview` must present a matching `workspaceId` +
`workspaceEpoch`.

**Trade-off.** Switching projects means restarting and re-consenting. In return,
scope confusion is impossible and a stolen token cannot be pointed at another
folder on the same host.

**Evidence / validation.** Root-switch grant isolation and workspace-context
enforcement are covered by `security/auth.test.ts` (AUTH-07/AUTH-18) and
`integration/m0` (WORKSPACE_MISMATCH / STALE_WORKSPACE). CWD-not-install-dir is
covered by `integration/cli.test.ts` (CLI-03). See
[src/workspace/root.ts](../../src/workspace/root.ts),
[src/workspace/identity.ts](../../src/workspace/identity.ts).
