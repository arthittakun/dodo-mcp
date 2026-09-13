# 029 — Compact MCP tool surface with capability gateways (tool surface policy)

Status: accepted, 2026-09-10.

## Problem

The catalog contains 74 tools. The full `tools/list` serializes to roughly
236 KB. Remote MCP clients ingest every tool definition at connection time,
and clients differ in the catalog/schema volume they retain. HTTP+OAuth and
STDIO fixtures prove the direct write/edit path independently. No hard
per-client tool limit is claimed; compact mode reduces catalog/schema load and
avoids requiring clients to ingest every detailed operation schema at
connection time.

## Decision

Two tool surfaces over ONE unchanged capability set:

- **full** — the existing 74-tool catalog, byte-for-byte the same names,
  order, schemas and behavior. Default for STDIO (Codex, Claude Code, Cursor).
- **compact** — 19 tools: `project_overview`, `dodo_discover`, and 17 domain
  gateways (`dodo_read`, `dodo_write`, `dodo_exec`, `dodo_git_read`,
  `dodo_git_write`, `dodo_desktop_view`, `dodo_desktop_control`,
  `dodo_assist_read`, `dodo_assist_change`, `dodo_media`, `dodo_browser`,
  `dodo_game`, `dodo_workflow_read`, `dodo_workflow_write`,
  `dodo_workflow_run`, `dodo_schedule`, `dodo_web`). Default for HTTP.
  A gateway call is `{ workspaceId, workspaceEpoch, operation, args }` where
  `operation` is enum-bound to that gateway's fixed allowlist; every
  full-catalog tool except `project_overview` is reachable through exactly one
  gateway. `dodo_discover` searches operations and returns one operation's
  args-only JSON Schema plus a deterministic `schemaHash`; workspace context
  remains top-level gateway input and cannot be overridden inside `args`.

Selection: `toolSurface` in the global config overrides the transport default;
`--tools compact|full|hybrid` on `dodo start`/`dodo stdio` overrides both for one
run. The setting changes tool exposure only — never permissions.

## Security invariants (unchanged, now single-pathed)

`registerTool` and the gateways route through one function,
`invokeToolDefinition` (src/tools/context.ts): live principal →
WORKSPACE_ACCESS_REQUIRED on empty workspace ACL → the TARGET tool's
`requiredScope` → workspaceId/epoch context → request byte budget → the
target's ORIGINAL strict Zod input schema → the target handler (which runs its
own `policyGate`/local approvals, idempotency and journaling) → envelope →
audit. Consequences, all covered by tests:

- A read-only token calling `dodo_write(write_file)` fails `FORBIDDEN` with
  the target's scope in `detail`, exactly like the direct call.
- In `inspect` mode an effectful gateway call produces an approval bound to
  the TARGET operation (`tool: write_file`), never a blanket gateway approval.
- `args` may not carry `workspaceId`/`workspaceEpoch` (rejected
  `INVALID_INPUT`); the gateway injects the top-level context itself.
- Target error codes (`FILE_CHANGED`, `AMBIGUOUS_EDIT`, `SECRET_PATH_DENIED`,
  `APPROVAL_REQUIRED`, …) pass through unchanged via `fromErrorInfo`.
- Image/audio MCP content blocks pass through unchanged.
- Gateways cannot target other gateways, `project_overview`, owner IPC
  controls or anything outside the fixed allowlists (construction-time
  invariant + tests). Each gateway's own `requiredScope` is computed as the
  minimum of its targets, so it can never be broader than the catalog.
- Both the gateway call and the target invocation are audited.

## Evidence

- Serialized tools/list-equivalent payload (name+title+description+annotations+
  input+output schemas): 74 tools = 237 755 bytes; compact 19 = 46 834 (−80.3%);
  measured live tools/list: 236 518 → 46 707 bytes. Recorded by the
  `[dodo] mcp tool surface` startup diagnostic and `schemas/tools.compact.json`.
- Suites: `tests/unit/compactSurface.test.ts`,
  `tests/security/compactGateway.test.ts`,
  `tests/integration/compactHttp.test.ts`,
  `tests/integration/compactStdio.test.ts`,
  `tests/integration/compactCapabilities.test.ts`, packaging PACK-12; the 24
  direct-contract suites pin `toolSurface: 'full'` explicitly.
- Live ChatGPT re-scan against the compact surface is a MANUAL gate
  (MANUAL_ACCEPTANCE.md); no client-side limit figure is asserted.

## Addendum (tool surface policy): hybrid surface

The owner's live ChatGPT connector displayed exactly 49 tools against a
74-tool catalog — the first 49 in catalog order — consistent with a
client-side tool-count cap near ~50 (still not asserted as a universal
constant). For clients in that range that prefer direct tools, the
opt-in `hybrid` surface: 49 tools, compact coverage core first (truncation-
safe), then 30 direct coding tools (`HYBRID_DIRECT_OPERATIONS`). Selection
via config/CLI as before; defaults unchanged; every path keeps the shared
invocation pipeline.

## Addendum (Phase 04): resource operations

ADR-034 adds six individual resource definitions to Full, so the Phase 04 surfaces
became Full 89, Compact 19 and Hybrid 49. Compact/Hybrid route the new operations
through the existing `dodo_media` gateway; no new gateway or direct Hybrid duplicate
was added. The historical 74-tool measurements above remain the evidence captured
when this ADR was first accepted. Generated schemas and `docs/TEST_REPORT.md` carry
the current byte measurements.

## Addendum (Phase 07): owner-reviewed memory operations

ADR-037 adds five individual memory definitions to Full, so the current surfaces are
Full 94, Compact 19 and Hybrid 49. Compact/Hybrid route read operations through
`dodo_assist_read` and proposal operations through `dodo_assist_change`. Owner approval,
rejection, prune and learning review remain private IPC commands and are never added
to any MCP surface.
