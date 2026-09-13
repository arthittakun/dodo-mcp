# ADR-009 — Jobs + polling as the execution baseline

**Status:** accepted (implemented)

**Decision.** Long work returns a `jobId` immediately; clients poll
`job_status` / `job_output`. Jobs live in a service layer, not in any MCP
session, so a dropped HTTP connection never kills a job and a reconnect can
resume reading. Output is a bounded segmented on-disk spool. Cancellation
signals only the owned process group; jobs from a previous boot become
`interrupted_on_restart` and are never auto-rerun.

**Trade-off.** No reliance on long-lived streaming or experimental task
transports; the client must poll.

**Evidence / validation.** `integration/jobs.test.ts` (prompt jobId, output after
reconnect, stdin pipe, cancel, no-shell argv, idempotent single job, concurrency
limit, PATH safety). Spool rollover in `unit/spoolAndConfig.test.ts`. See
[src/services/jobs/jobManager.ts](../../src/services/jobs/jobManager.ts).
