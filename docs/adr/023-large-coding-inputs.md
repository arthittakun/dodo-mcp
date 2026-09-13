# ADR-023: Large coding inputs with owner-controlled budgets

Date: 2026-09-09. Status: accepted in large-input policy (source/local).

## Problem

The original 8,192-character shell field and 4,096-character argv elements
blocked ordinary generated web source. Raising only the schema cap would
still hit native execve limits. Unlimited requests would make memory use
unbounded, and old persisted configs would retain their small limits.

## Decision

Use owner-selected `dodo limits --profile standard|large`; merge only input
budgets into trusted global config and require restart. Preserve saved values
on upgrade. Expose active budgets via project_overview. Command source is
checked in UTF-8 bytes (default 1 MiB, maximum 8 MiB); direct source schemas
support up to 16 MiB with lower active file/plan/request limits enforced.
Native argv remains independently bounded to 64 KiB per element, 128 KiB total.

Shell source above 16 KiB runs as a mode-0600 private script under an owned
mode-0700 job directory. No source in native argv, no stdin consumption, no
workspace source artifact. Record job ownership before spawning. The normal
job lifecycle removes scripts on exit/cancel/spawn failure. Crash residue is
never rerun. Script semantics (`$0` points to the script) are documented.
Scopes, trust, sandbox requests, idempotency and owned process cancellation
still apply. Validate every batch command's size/NUL before launching any.

Keep response/log caps. Bound echoed commands/argv. Skip diff construction for
combined before/after content above 2 MiB; smaller diffs use abortable budgets.
Preflight literal replacement expansion and incrementally bound patch/bulk
result content. Full hashes, backups, immutable plans and rollback are kept.

## Evidence and compatibility

Installed official MCP server SDK 2.0.0 `stdio.d.mts` exposes
`serveStdio({transport})` and `StdioServerTransport(...,{maxBufferSize})`.
Use that API to align STDIO buffer size with HTTP request limits; no custom
wire protocol. HTTP authenticates before parsing larger JSON bodies.
Installed diff 9.0.0 `libesm/patch/create.d.ts` supports abortable
`createTwoFilesPatch` with timeout/maxEditLength and undefined on exhaustion.
No dependency or OAuth protocol changes.

Actual tests include real modern/legacy HTTP, an 11 MiB STDIO file, an exact
8 MiB shell command via STDIO, 3 MiB write/edit/rollback, UTF-8 limits,
parallel commands, stdin, cancellation, sandbox, failed spawn and state writes,
owner CLI profiles and pre-allocation expansion refusal. See TEST_REPORT for
the executed gate, versions and results. External client/proxy input limits
are independent and manual acceptance is not claimed.
