# ADR 056 — Owner-controlled database awareness and private config recovery

Status: implemented in unreleased working source; platform/release gates remain independent.

Source snapshots cannot reverse database transactions or safely include secrets.
We keep both data classes outside source CAS/Git and outside MCP restore authority.

`RecoveryDatabases` is a bounded read-only SQLite migration-table adapter. Owner
registration pins the canonical file identity and policy. Explicit compatibility
rules bind manifest hash and target revision. Only ordinary tables, bounded string
IDs and strict identifiers are accepted; read connections use query-only and
trusted-schema-off. No SQL, remote DB, mutation or generic rollback API exists.
Source preview/apply checks the rule and rechecks after the pre-restore checkpoint;
post-apply drift is reported without auto-undo. This is not a cross-process database
lock or a proof of semantic compatibility. Missing information is UNKNOWN.

`RecoveryConfigVault` registers existing private, source-denied project files.
AES-256-GCM uses a fresh nonce and associated data binding version, project/root,
backup, target/revision and key reference. Ciphertext goes into dedicated private
SQLite tables; a random 256-bit key stays in the OS credential store. `OSRecoveryKeys`
uses fixed helper protocols with stdin for secret input, bounded output, no shell,
minimal environment and no plaintext fallback. Owner UI/CLI see redacted metadata,
not decrypted bytes. No new public MCP tools, credential-export endpoint or
permission bypass is introduced.

Owner actions use shared per-project mutation queues, live owner leases and context.
Restore previews bind expiry, epoch, target revision, authenticated ciphertext,
original file identity and a keyed content digest. An encrypted pre-restore backup
and UNKNOWN receipt commit before any write. A single existing file is rewritten in
place to preserve its private metadata and avoid temporary plaintext copies. This
is explicitly not crash-atomic; read-back certifies only completed writes. UNKNOWN
never auto-replays; a separate owner review may restore the encrypted before-copy.
The owner must stop/restart dependent services. Same-user external writers are not
confined by DODO's mutation queue.

Keys rotate by creating a new OS reference; old backups retain old keys. Key loss
is unrecoverable through DODO. Retention is separate from source, bounded, and
protects restore-referenced copies. Full metadata/receipt history is intentionally
bounded instead of evicting uncertain recovery evidence. SQLite row deletion is
logical retention, not guaranteed physical secure erasure of storage pages.

Tests use real SQLite/files and authenticated private HTTP for permissions,
compatibility drift, ciphertext tampering, missing/wrong keys, rotation, stale
context, file conflicts and crash receipts. Protocol fixtures separately exercise
all three OS-helper boundaries; actual credential-store tests opt in with
`DODO_TEST_OS_RECOVERY_KEYS=1` and create/delete only a random fixture item.
Fixtures do not substitute for live manual production recovery.
