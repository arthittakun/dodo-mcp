# ADR-010 — `better-sqlite3` durable store, chosen in M0

**Status:** accepted (implemented)

**Decision.** Durable state uses `better-sqlite3` `13.0.3` in WAL mode. It
installed from a **prebuilt** binary on macOS arm64 with no compiler required
(verified in M0; `dodo doctor` reports `sqlite-native`). Migrations run under
`BEGIN IMMEDIATE`, and read-only CLI paths open the DB read-only so `dodo status`
never races the server's startup migration. We did not choose `node:sqlite`
because its API status warranted caution on the target Node.

**Trade-off.** A native dependency (prebuilt-binary reliance). If no prebuilt
exists for a target, install fails loudly — no silent in-memory fallback.

**Evidence / validation.** Concurrent open safety is covered by
`integration/cli.test.ts` (status while start boots). Native load is checked by
`dodo doctor` and `packaging/pack.test.ts`. See
[src/store/db.ts](../../src/store/db.ts).
