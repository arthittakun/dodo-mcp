# ADR 054: Source verification evidence and owner checkpoint labels

Status: implemented in the unreleased Recovery candidate; deployment/database recovery are separate work.

`verify_changes` remains the only verification executor. Its existing scope,
trust, approval, sandbox, job budget and idempotency gates remain authoritative.
When Recovery is enabled for a registered project it captures a complete source
checkpoint BEFORE launching the selected recipes, binds its manifest digest to
the private verification record, and rechecks source before launch and at report.
The independent before-exec copies are retained as well.

The binding references workspace, caller and immutable snapshot. Evidence records
contain selected recipe digests, actual job IDs/exits and recognized count scalars,
parser version, timestamps and an allowlisted Node/platform/epoch description.
They contain neither log contents nor raw environment variables. Jobs and their
output are read through existing services; no endpoint accepts a caller-supplied
pass result. The selected checks are the required set for that run, not every
possible repository check. Missing recommended checks remain explicitly listed.

Recovery compares its full included-source manifest (including previously tracked
ignored targets) as well as the narrower assistance snapshot. Recipe, runtime,
parser or observed source drift invalidates freshness, including an observed edit
subsequently reverted. Truncated output, unknown/zero test counts, inconsistent
counts and skipped tests cannot establish VERIFIED. Build/lint command success is
only evidence for that selected command, not proof of unrun tests. Generated source
requires a new snapshot and verification. Changes reverted BETWEEN observations,
unmeasured dependencies/environment and deceptive repository test scripts remain
outside the guarantee. This is not an OS sandbox or proof of program correctness.

SAVED means independent bytes passed integrity checks at capture. VERIFIED,
FAILED, INCONCLUSIVE and STALE describe bounded verification evidence. Lists are
historical observations marked refresh-required; explicit inspection rechecks
current source, recipes and jobs. Overview exposes only a historical timestamp,
never a cross-caller verification ID. Recovery metadata does not display logs or
private filesystem locations.

Owner checkpoint names are a separate revisioned table. Updates use an exact
expected revision under the project mutation queue and a SQLite transaction,
rechecking owner authority after asynchronous integrity reads. Removing a name
leaves a revision tombstone, preventing ABA overwrites. A durable event records
both old and new targets with the audit entry. Names never alter manifest bytes,
certify tests, grant permission or set PRODUCTION_KNOWN_GOOD. Production names are
reserved; production evidence is NOT_CONFIGURED and database recovery NOT_SUPPORTED.

Named targets and explicit pins retain their snapshots and associated session
references. Retention preview and automatic pruning share one selection function;
preview has no delete side effects. Byte estimates are logical, not a promise of
immediate physical reclamation because objects can be shared and have a GC grace
period. Reviewed plans, active/unresolved history and the latest baselines remain
protected. No public purge/mark/pin tools are introduced.

The owner web panel lives in a separate bundled module. It uses authenticated
fetch, current project/epoch and the existing confirmation UI/CSP. Text-only DOM
construction escapes names, paths, errors and diffs. Durable journal receipts are
queried after reconnect; an uncertain restore is never repeated with a new key.
Full catalog stays 148 and Compact 20; existing Recovery operations expose only
caller-owned records under current ACLs. Private owner web and CLI share IPC
validation for evidence, names, pins and retention preview.
