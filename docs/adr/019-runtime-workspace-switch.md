# 019 — Runtime workspace switch from Local Config (workspace lifecycle)

Supersedes the "no runtime root change" statement of ADR-001 for the HTTP
entry. One `dodo start` process still serves exactly one ACTIVE workspace at
any moment, but the owner can move it to another directory from the Local
Config page without restarting, re-authorizing OAuth clients, or losing state.

## Decision

- A `WorkspaceHost` (`src/server/workspaceHost.ts`) owns the active
  `BootstrappedWorkspace`. The MCP server factory, the token verifier, the
  consent router, the IPC dispatcher and the config plane resolve the active
  workspace **per request** instead of capturing it in a closure.
- OAuth and consent state use an installation-scoped store connection that
  outlives any workspace; a workspace's own connection is closed when it is
  switched out.
- The switch is **owner-only**: `POST /api/workspace/switch` on the loopback
  config plane, behind the private capability. There is no MCP tool that can
  change the root, and the boot-time `--allow-unsafe-root` never applies to a
  switch (the strict root policy always does).
- Order of operations: validate (absolute path → realpath → shared root
  policy) → refuse if jobs run → mark `switching` (new MCP calls get 503 +
  Retry-After) → drain in-flight calls (bounded) → re-check jobs → refuse if
  another live process serves the target (its IPC socket answers) → bootstrap
  the new workspace (new workspaceId + fresh epoch, its own trust and ACL rows,
  journal reconcile scoped to it) → readiness check → start its IPC socket →
  **commit** → shut down the old IPC socket and services → deny orphaned
  pending approvals of the old workspace/epoch → audit.
- Any failure before commit discards the half-built workspace and leaves the
  old one serving; failures after commit are logged and never roll back.
- Nothing is copied between workspaces. Managed mode uses the new root's saved
  trust mode and client ACL rows; personal mode derives trusted policy and
  target scopes from the owner-approved installation grant. In both modes,
  context captured from the old workspace fails
  `WORKSPACE_MISMATCH` / `STALE_WORKSPACE`; plans expire; the run mode
  (`--allow --all` / `--bypass`) is a per-process owner capability and
  carries over.
- The IPC socket path follows the workspace id, so `dodo status/stop/approve`
  run from the new directory find the server; the old socket is removed.

## Consequences

- Clients must call `project_overview` again after a switch (the page says so).
- `STALE_WORKSPACE` / `PLAN_EXPIRED` wording now mentions a switch.
- Two `BootstrappedWorkspace` instances coexist briefly (WAL SQLite); the old
  one is only torn down after the swap, so no request sees a closed store.
- Refusals are explicit and typed (409 CONFLICT for jobs/in-flight/other
  process, 400 for invalid targets, 501 for entries without switching).
- Tests: `tests/security/workspaceSwitch.test.ts` (WS-01..06) and the Local
  Config suite; manual browser checks are listed in MANUAL_ACCEPTANCE.md.


## workspace lifecycle corrections

Local admin mutations are bound to the reviewed workspace and epoch, not just
the current root at arrival. Independent tool leases survive client disconnects.
The switch gate stays closed through old-resource teardown. Shutdown closes
old HTTP connections before OAuth stores, and retains handler resources until
completion. Regression evidence: WS-07, WS-08 and WS-09.
