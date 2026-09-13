# ADR-033: Read-only project federation before effectful multi-project runtime

## Status

Accepted — DODO MCP 1.0.0 development baseline.

## Context

The owner Project Registry provides stable project IDs and readiness metadata,
but registry membership is deliberately not authority. DODO needs bounded
cross-project retrieval without changing the active workspace or weakening the
existing OAuth, workspace ACL, path, secret and audit boundaries.

Bootstrapping every target as another full runtime would also start or recover
jobs, schedules, planners, workers and mutable resources. That would introduce
effectful behavior before per-project locking and ownership contracts exist.

## Decision

DODO adds an isolated `FederationService` for read-only retrieval:

- targets are selected only by opaque IDs already in the owner registry;
- remote access requires a live installation identity grant, `dodo:read` in the
  grant/current principal, and `dodo:read` in the target workspace ACL;
- local STDIO is the owner principal and may read owner-registered targets;
- target canonical path and directory identity are checked before each access;
- each cached target has its own workspace filesystem policy, read/list/search/
  overview services and process-local federation epoch; the runtime cache is
  bounded to 16 least-recently-used targets;
- cross-project search is capped at eight projects and one shared result budget;
- authorized unavailable targets are explicit partial failures; an unauthorized
  target rejects the whole request before any result is returned;
- source hashes and target identity accompany results, while MCP envelope context
  remains the active workspace;
- target-scoped audit rows are written in addition to the outer tool audit.

The existing tool names are retained. `project_overview`, `list_files` and
`read_files` accept optional `projectId`; `search_code` accepts `projectId` or
`projectIds`. Compact and Hybrid clients reach the same contract through
`dodo_read`, so the surfaces remain 74/19/49 tools.

## Security consequences

Registry metadata, search results, workflows and source hashes never become
authority. The implementation does not change `process.cwd()`, active workspace,
trust or ACL. Unknown/unauthorized project IDs return a generic refusal without
paths. The target uses the same shared path/secret policy as an active workspace.

Write, exec, jobs, plans, approvals, desktop and resource handles remain limited
to the one active `BootstrappedWorkspace`. Clients must ask the owner to switch,
call `project_overview` again and re-read current source before an effect.

## Follow-up gate

Effectful federation requires a separate ADR and evidence for per-project intent
locks, stale-context binding, approval digests, journal/rollback recovery, job
ownership/cancellation and bounded service shutdown. It must route target tools
through the common invocation pipeline and may not infer permission from this
read-only federation.
