# ADR-007 — Preview / hash / idempotency / journal for changes

**Status:** accepted (implemented)

**Decision.** File changes flow through: read (raw-byte SHA-256) → immutable
preview plan → approval → apply (expected-hash recheck + durable journal +
per-file backups + atomic temp/fsync/rename) → audit → optional rollback. Retry
is idempotent via durable keys. Multi-file apply is explicitly **not** one
filesystem transaction; unrecoverable partial failures surface
`PARTIAL_RECOVERY_REQUIRED`. No automatic `git reset/clean/stash`.

**Trade-off.** Much more code than `writeFile`, in exchange for not destroying
the owner's work and surviving crashes with an honest recovery story.

**Evidence / validation.** `integration/changes.test.ts` (14 cases: immutability,
AMBIGUOUS_EDIT, FILE_CHANGED, idempotency replay/conflict, rollback conflict
refusal, dirty-tree preservation, concurrency). See
[src/services/changes/applier.ts](../../src/services/changes/applier.ts).
