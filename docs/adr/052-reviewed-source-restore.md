# ADR-052: Caller-owned Recovery sessions and reviewed source restore

Status: implemented in the unreleased development candidate; release verification
and platform evidence must match the final source fingerprint.

Recovery adds ten operations to the end of the full catalog; compact HTTP keeps
20 gateways. `recoverySessionId` is optional top-level invocation context and is
rejected inside gateway arguments. Sessions are project/root/caller-bound private
records, independent of conversational memory. An implicit session covers one
operation; a sub-agent run has an independent recovery session per runtime epoch.
Restart interrupts open sessions without resuming effects. A fresh session is
required for new mutations after restart.

Before-images are independently stored CAS bytes. Session events link snapshots,
journaled changesets, jobs and verification IDs, not raw tokens, command contents
or model reasoning. Changeset attribution is recorded in the journal transaction
before source writes. Job IDs are linked before process launch. Session baseline
Git status records bounded allowed dirty/staged/untracked/deleted path metadata;
it never modifies the index. Shell authorship is unknown. Session undo containing
jobs is refused; a caller may review a particular checkpoint instead, without
claiming to undo external effects.

Preview stores private immutable plan metadata only. It reads current authorized
paths, verifies manifest/object integrity and displays bounded diffs plus hashes.
Ordinary restore leaves unrelated extras alone. Explicit exact mirror includes
extra allowed source-file deletions and requires a full-source checkpoint. Session
undo coalesces before-images and checks the entire receipt chain and current
post-state; interleaved edits refuse the whole selection. Owned directory removal
requires its recorded identity and planned children, then an empty directory at
the actual syscall. Unjournaled parent directories are conservatively retained.

Apply requires the exact reviewed plan ID/hash, same principal/project/epoch,
live access and existing trust/approval policy. An independent pre-restore backup
is mandatory (disabled Recovery must be re-enabled first). The shared project
queue and R00 journal validate all files before writing; each step persists intent
before IO. Restore is a forward changeset with pre-restore compensation bytes.
Ordinary apply_changes cannot execute a recovery plan outside its rechecks.

Idempotency is durable. An uncertain reservation never reruns effects; status can
be inspected after reconnect. Boot classifies actual states as committed, failed
without change, or recovery-required; it does not replay or force overwrite.
Directory creation records the resulting identity; a crash before identity receipt
is conservative recovery-required. Mode/existence are verified where supported;
this is not a global filesystem snapshot or a complete ACL/xattr backup.

Active/interrupted sessions, unresolved journals, live jobs, pinned snapshots and
unexpired reviewed plans retain backup references. Closed history ages out as a
unit under owner retention policy. Snapshot references cannot be collected by the
resource cache. Owner cross-caller actions are only on authenticated private IPC /
Config with reviewed context and explicit apply confirmation, never an MCP flag.
