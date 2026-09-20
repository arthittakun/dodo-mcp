# Recovery: source, deployments and private configuration

This documents the 1.3.0 source candidate. Publication and supported-platform
results are recorded separately in [release notes](RELEASE_1.3.0.md) and
[the test report](TEST_REPORT.md). Source backup is default-on for registered
projects; deployment/database/config adapters require separate owner opt-in.

Registered projects default to automatic source backups on first activation.
Existing projects without a Recovery policy also default to enabled; an explicit
owner opt-out persists. Merely starting DODO from an arbitrary directory does
not scan that directory, the launcher workspace, or your home directory.

In Local Config, select a project and open **Recovery · สำรอง source**. The card
shows initializing, ready, blocked, or disabled by owner, the last saved
checkpoint (integrity checked at capture), included/excluded counts and logical project storage. Advanced
settings cover the project's quota, retention, and relative runtime/data roots.
Installation storage/free-space limits are under Settings → system JSON →
`recovery`. Changing that configuration never grants access to source or commands.

From the registered project's directory, while its server is running:

```sh
dodo recovery status
dodo recovery checkpoint
dodo recovery configure --enabled false --yes
dodo recovery configure --enabled true --yes
```

These commands use private owner IPC. There are no public MCP tools for changing
Recovery policy. Disabling requires owner confirmation, is audited, preserves
old points and does not turn off the existing file journal. Re-enabling schedules
a new baseline; saving a preference alone does not mean a backup has completed.

Writes and directory creation capture their targets before mutation. Commands,
verification recipes, runtime/media jobs, schedules, and Git commits capture the
source scope before executing. These paths keep the shared project mutation queue,
authorization, hash/conflict and sandbox checks. A caller cannot bypass backups
by hiding an operation from discover or selecting a more permissive trust mode.

Backups hold actual independent bytes, modes and existence tombstones in private
`recovery/objects`, with versioned manifests and SQLite references separate from
resource/media cache. No working Git repository, branch or commit is modified, and nothing is pushed.
Independent private Git copies are described below.
Deleting a working file does not delete its backup. Hash verification and a source
rescan precede readiness. Corruption, changing files, scan limits, insufficient
disk space or a failed backup stop the pending source mutation.

Defaults: 5 GiB of referenced objects per project, 20 GiB physical objects per
installation, 500 MiB free-space floor, 30 days/200 unpinned points, 64 MiB per
file, and 100,000 scanned entries. Reservations account for concurrent projects
and temporary copies. Content is deduplicated; the newest full baseline, newest
point and pinned points are retained. Unreferenced objects/staging have a 24-hour
grace period and are collected only without active captures. Storage reclamation
can therefore require waiting or extra space; it never evicts protected points
just to allow another write.

This is **source-only coverage**. Default exclusions include secret/protected
paths, `.git`, dependencies/build/cache directories, database/dump/log files and
owner-declared data roots. Ordinary ignore rules reduce baseline scanning; an
explicit allowed source target is captured even if ordinarily ignored. Explicit
targets excluded by the source/data policy are refused while protection is on.
Do not interpret this as a backup of databases, volumes, secrets, OS settings,
Desktop/ADB effects or remote systems.

Credential screening is bounded and heuristic, not a guarantee that every
secret is recognizable. Backup storage has the same private filesystem/ACL
requirements as DODO state. It is not protected against an administrator or the
same OS owner intentionally tampering with both data and metadata.

A checkpoint is not an atomic filesystem-wide snapshot. DODO queues its own
writers but cannot stop an IDE or unrelated process. It verifies paths, identity,
hashes and inventory; detected drift fails closed. Modes are preserved, not all
ACLs/xattrs/alternate streams. On Windows directory fsync is unavailable. Private
Git copy files use write-capable handles for mandatory file flushes, with fresh
ACL and file identity checks. See [platform evidence](TEST_REPORT.md) for the
tested revision; a macOS/Linux result alone does not certify Windows.

An abrupt restart marks incomplete captures as incomplete, releases only the
leased project's abandoned reservation, and rebuilds/rechecks the active
baseline. It never repeats a command. It cannot recover source lost before the
first complete backup. Use the reviewed flow below rather than copying private
backup objects directly into the workspace.

## Preview and restore

On the selected project's Recovery card, choose checkpoint or session history,
optionally select a relative file/directory, then click **ดู preview**. Review the
create/modify/delete list, diffs, hashes and conflicts before **กู้คืนตามแผนนี้**.
Confirmation applies only that immutable plan. Changed files refuse the selection;
there is no force overwrite or automatic merge. Use the journal status button
after reconnect or an uncertain response, rather than sending another apply.

CLI (private owner IPC; capture the IDs from preview):

```sh
dodo recovery list
dodo recovery list --sessions
dodo recovery preview SNAPSHOT_ID --path src
dodo recovery preview SESSION_ID --session
dodo recovery apply PLAN_ID --hash PLAN_HASH --key SAME_RETRY_KEY --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
```

`--exact-mirror` is an explicit preview option for a full-source checkpoint. It
includes deletion of extra allowed source files. The default preserves unrelated
extras; excluded secrets, databases, runtime data and volumes remain excluded.
Recovery must be enabled to apply, so a verified pre-restore backup is mandatory.
Binary source files are restored as exact bytes within the existing file/plan
budgets. Oversized selections fail with a smaller-selection hint, never truncate.

MCP full operations: `checkpoint_list`, `checkpoint_inspect`, `checkpoint_create`,
`recovery_session_list`, `recovery_session_inspect`, `recovery_session_begin`,
`recovery_session_end`, `restore_preview`, `restore_apply`, `restore_status`.
Use the existing `dodo_read` and `dodo_write` compact gateways and discover schemas.
Full catalog: 158 capabilities (154 with sub-agents hidden); Compact remains 20.
Gateway arguments cannot override top-level workspace/project/recovery context.

For several edits belonging to one task, call `recovery_session_begin`, then pass
its `sessionId` as top-level `recoverySessionId` on each mutation. Close it with
`recovery_session_end`. Calls without this context retain automatic before-images
in separate implicit sessions. Different conversations are never guessed to be
one task. Session undo preserves pre-existing dirty/untracked files and coalesces
repeated edits, moves, creations and deletions; external/interleaved edits conflict.
Shell jobs have unknown authorship: session-wide undo is refused when jobs appear,
but a specific checkpoint can still be reviewed. External effects are never undone.

Only your own historical records are exposed over MCP, under current target ACLs.
Private owner controls can review other callers' records. Session/snapshot/plan
IDs grant no permission. Inspect mode still requires approval of the exact restore
plan; read-only clients cannot restore. Old journal-only `rollback_changes` and
`dodo recover` remain available. Directory journal changes use the reviewed recovery
flow; directories created implicitly as file parents may be retained conservatively.
Existing directories whose permission modes differ from the checkpoint require
owner review and produce a conflict; this version does not silently chmod them.
Missing structural parents of a selected directory appear as explicit creations
in preview. Parents outside the selection use the normal default directory mode.

After restart, sessions are interrupted and old previews expire. Create a fresh
context/preview for new recovery. A completed retry returns the original receipt;
a key with uncertain outcome reports recovery-required without repeating writes.
Closed history obeys retention, while open/interrupted sessions, unresolved changes,
active jobs, pinned points and unexpired plans retain their backup references.

## External changes and Git copies

DODO now keeps the **expected source state** separately from its snapshots. When a mutation target was changed outside the journal, the write fails with `FILE_CHANGED` even when the caller rereads its new hash. Other non-conflicting file edits remain possible. Significant source drift blocks new commands until the owner reviews it. Defaults: at least 20 changed files and more than 20% of the baseline, or 10 deletions. Commands still run under the existing exec/sandbox policy; backups cannot undo database or volume effects.

In the project's Recovery card choose **ตรวจไฟล์และเปรียบเทียบ**. The comparison shows paths and before/observed hashes, with pagination, not raw credential/file contents. **ยอมรับสถานะที่ตรวจนี้** accepts exactly the reviewed state; it neither restores files nor marks tests as passed. To restore previous source instead, use the existing checkpoint/session preview and confirm that exact plan.

Equivalent owner terminal flow:

```sh
dodo recovery scan --limit 50
# If nextCursor is present:
dodo recovery scan --cursor 50 --limit 50
# Only after reviewing the digest and current project context:
dodo recovery acknowledge 'sha256:THE_REVIEWED_DIGEST' --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
```

MCP can call `restore_status` with `scan:true` (through `dodo_read` in Compact mode). It has no operation to acknowledge drift or change backup policy. Restart and creating a checkpoint do not acknowledge external changes. A bounded scan runs every 60 seconds when the project is idle, and commands receive a preflight scan. The default 15-second scan budget is a limit, not a completion guarantee for every repository. Busy or incomplete scans report their status; they do not silently accept the files.

External changes are labeled **unknown author**, including changes observed after a shell job. An emergency snapshot saves the state DODO actually observes, without replacing the protected baseline. DODO cannot recreate bytes overwritten before any backup existed. A reviewed source restore remains possible while drift is present, with all existing plan/hash/path checks intact.

For Git projects, DODO creates independent private bare copies at source checkpoint boundaries. No working branch, HEAD, staged/unstaged split or user index changes. Each copy contains only approved source bytes and a create-only `refs/dodo/snapshots/<snapshot-id>`; not old Git history, secrets or remotes. Hooks, filters, helpers and network protocols are disabled for this builder. The source manifest also records modes/empty directories that Git alone cannot represent.

The advanced Recovery settings can require Git copies and select a separate backup directory. Prepare an **empty, dedicated private directory** outside projects and DODO state; its existing filesystem identity is verified. Removing or replacing that directory stops configured copies rather than redirecting them elsewhere. Copies count toward Recovery quotas. With no Git repository, ordinary source recovery still works; Git-required mode blocks full checkpoints until Git is available.

If `.git` and source files are deleted but the registered root directory remains, preview/restore still uses the independent source checkpoint. If the entire root or installation state was lost, automatic restore cannot validate its old identity. Inspect the separately stored bare copy and `dodo-source-manifest.json` locally, extract approved files to a new directory, review it, then register that directory. For a single reviewed file, an owner may use `git --git-dir=/absolute/backup/snap_ID.git show refs/dodo/snapshots/snap_ID:path/to/file` to inspect the independent bytes. Do not pipe an unreviewed archive over an existing project. Git copies do not back up Git history, external LFS objects, databases or volumes.

## Test evidence and named checkpoints

The Recovery dashboard now separates three things:

- **SAVED**: source bytes passed integrity checks at capture. No test claim.
- **VERIFIED / FAILED / INCONCLUSIVE / STALE**: results of the selected
  `verify_changes` recipes against a specific before-run snapshot and manifest.
  Open **ตรวจหลักฐานปัจจุบัน** to recheck freshness. List entries and the last
  verified time are historical observations, not a claim about current files.
- **OWNER_MARKED_STABLE**: a name selected by the owner. It does not change a
  failed test into a pass or expand any permission.

Use `verify_changes` plan → run → report through the existing assistance gateway.
Select exact recipe digests and use the plan's source digest and an idempotency key.
With Recovery enabled, the response includes the checkpoint ID, manifest hash,
verification state, reason and check timestamp. Read-only clients cannot execute
verification; inspect trust still requires approval. Checks not selected remain
listed as not run. An empty, skipped, inconsistent or truncated test report does
not certify the snapshot. Ordinary successful build/lint commands prove only
those commands, not tests that were never run.

DODO compares included source and selected recipes before/after verification.
Source generation or formatting makes the old evidence stale; capture and verify
again. Changes reverted between observations, external dependencies/environment,
and dishonest test scripts are not covered. Evidence is not an OS sandbox or a
proof of correctness. Restart/parser changes require new verification.

In checkpoint history choose **Pin สำเนานี้** or **ตั้งชื่อสำเนา**. Names such as
`before-refactor`, `stable`, and `release candidate` refer to immutable snapshots.
A name update uses the revision shown by the owner API; a concurrent edit is
refused rather than overwritten. Pins and active names both protect retention.
Unpinning a named point alone will not delete it. Old/new name changes appear in
owner history. Naming never rewrites source or the snapshot manifest.

Advanced settings include **ดู preview การล้างตาม retention**. It shows eligible
points and why others are retained without deleting anything. Shared objects,
Git copies and orphan grace periods mean the logical byte total is not immediate
free disk space. This version does not expose a manual destructive purge.

Owner CLI, in the registered project's directory:

```sh
dodo recovery status
dodo recovery evidence
dodo recovery evidence --id VERIFICATION_ID
dodo recovery cleanup-preview
# Read the existing name's revision first (0 only when the name never existed):
dodo recovery mark stable SNAPSHOT_ID --revision REVIEWED_REVISION --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
```

After browser reconnect, refresh evidence and query the existing restore receipt.
Do not repeat uncertain effects. These are private owner controls; MCP/public
HTTP has no mark/pin/purge endpoint. Without an owner-registered deployment target its state is **NOT_CONFIGURED**;
database row rollback remains **NOT_SUPPORTED**. Optional adapters are described below. Windows/Android and live
production recovery require their own acceptance; results from macOS/Linux
fixtures are not substitutes.

## Reviewed Docker deployment

Source backup continues to work without a deployment target. To opt in, open
**Projects → Deployment · Docker → เพิ่มหรือแก้ปลายทาง**. Select the Docker context,
Compose project/service, source build folder and Dockerfile, an existing test
recipe, health URL and optional source mapping. The daemon must already be
available to your OS account. DODO neither installs/starts it nor disables your
command sandbox. Docker access is broader than workspace file access.

Use advanced definition JSON for multiple required checks, HTTP status checks
(such as a protected route returning 401), OpenAPI operations, stabilization,
explicit LAN endpoints, ports and existing named volumes. No credentials, bind
mounts or privileged Docker arguments are accepted. Source mappings cannot overlap
volumes. A public URL requires HTTPS; metadata and DODO administration URLs are
denied. This permission does not turn on `allowWebFetch`.

1. Run `verify_changes` with the current source/required recipe. A passing exit
   without complete required evidence is insufficient.
2. Select the target revision and verification ID and create a deployment plan.
   Review the immutable plan/hash. No build or deployment has happened yet.
3. Confirm **Build ตามแผนนี้**. DODO streams only the reviewed snapshot, records
   the actual image ID, and verifies declared source bytes inside a stopped probe.
4. Confirm **Deploy image นี้**. Source, authority and target are rechecked;
   deployment does not rebuild. All required health checks must pass throughout
   stabilization before the known-good pointer advances.
5. Read the durable result after reconnect. `UNKNOWN` means inspect first; do not
   make a new plan merely to repeat a command whose result is uncertain.

The same flow is available to an authorized MCP client through `dodo_discover`
and `dodo_exec` operations `deployment_prepare`, `deployment_build` and
`deployment_apply`. `dodo_read` exposes bounded targets/list/inspect/compare.
The full surface retains individual definitions; compact remains at 20 gateways.
Target registration, image pins and cleanup stay private owner controls.

Private owner CLI commands use the current workspace ID/epoch and explicit
confirmation. Start with `dodo deployment targets` and `dodo deployment list`.
For example, after reviewing a real target JSON file:

```sh
dodo deployment configure --file /absolute/path/target.json --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
dodo deployment prepare --target TARGET_ID --revision 1 --verification VERIFICATION_ID --key UNIQUE_RETRY_KEY --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
dodo deployment build DEPLOYMENT_ID --hash PLAN_HASH --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
dodo deployment apply DEPLOYMENT_ID --hash PLAN_HASH --image sha256:IMAGE_DIGEST --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
```

`--file` contains owner-reviewed data, not executable repository configuration.
The configure file shape is `{"expectedRevision":0,"enabled":true,
"confirmDaemonAccess":true,"definition":{...}}`; copy current recipe digests from
`deployment targets`, and use the exact reviewed ID/hash returned by each step.
`dodo deployment --help` lists observe, source-preview and rollback-prepare.

### Rollback and source recovery

A known-good deployment can prepare a **new image-only rollback plan** after
inspecting the current service. Apply that plan explicitly. It reuses the exact
recorded image and requires fresh health; its original tests are historical. It
does not change workspace source, database rows, migrations, volumes or secrets.

`deployment_source_preview` checks actual running-container bytes for the declared
mapping against the recorded manifest, then produces the normal Recovery restore
preview. Review and call `restore_apply` to change source, with a mandatory current
backup and conflict checks. The container keeps running. Mounted data, image
labels, missing source, compiled-only artifacts or a missing/corrupt CAS manifest
cannot be substituted for verified source. DODO does not reconstruct source from
binaries or treat a copied container root as a project backup.

### Uncertain outcomes, probes and image retention

The owner dashboard offers **ตรวจและรับทราบผลที่ไม่แน่นอน**. It records the live
observation and acknowledges the old uncertainty without retrying or declaring
production healthy. Historical `UNKNOWN` remains visible. Recover via a separately
reviewed known-good image rollback or an owner-controlled external repair.

A crash can leave a stopped source probe. **ตรวจ container probe ที่ค้าง** compares
its durable name/ID/image/claim and requires it to remain stopped and mount-free
before exact-ID removal. It never stops or force-removes a running container.

**การเก็บ image** previews candidates outside the target's retained image count
(default 5). Current/previous known-good, active containers, pins, live plans,
unresolved outcomes and other targets protect images even if the count is above
the budget. Nothing is deleted automatically. Confirm the exact preview to remove
only eligible DODO tags/IDs; changed references block deletion. No broad prune,
volume removal or migration is performed. An uncertain cleanup needs a fresh
observation; repeating the same review returns its recorded result.

CLI maintenance takes a bounded JSON file. Examples of its input objects:
`{"action":"cleanup_preview","targetId":"TARGET_ID"}`,
`{"action":"pin","deploymentId":"DEPLOYMENT_ID","pinned":true,"expectedPinned":false}`,
`{"action":"resolve_preview","deploymentId":"DEPLOYMENT_ID"}` or
`{"action":"apply","reviewId":"REVIEW_ID","reviewHash":"sha256:REVIEW_HASH"}`.
Pass it with `dodo deployment maintenance --file ... --workspace ... --epoch ... --yes`.

Deployment manifests remain protected source evidence independently of image
cleanup. History is bounded at 500 deployment records per target and 2,000 owner
maintenance reviews per project; reaching a bound stops new records rather than
silently evicting recovery evidence. Target changes invalidate pending plans;
restore the reviewed target definition before inspecting its old Docker resources.

These guards apply to this adapter. Generic shell commands, owner terminals and
external CI can still change production independently. Historical known-good is
not a continuous live health monitor. No live owner production deployment or
manual platform acceptance is implied by disposable automated fixtures.

## Database awareness and encrypted private config

Source recovery remains enabled by default for registered projects. **Database
inspection and secret-file backup remain separate owner opt-ins.** Nothing connects
to a database, reads a secret or creates an encryption key merely because source
backup is on. These controls are under **Projects → Database / Private config**;
they are not MCP operations.

### Read-only migration compatibility

The first adapter supports an existing, project-relative SQLite `.db`, `.sqlite`
or `.sqlite3` file and an ordinary migration table with a string ID column. Choose
the exact file/table/column and explicitly permit metadata access. There is no
remote SQL endpoint, credential field, arbitrary query or database rollback API.
Readiness checks canonical file identity, links, sidecars and bounded IDs. File
replacement requires a new owner review; a missing/changed schema is not success.

For a source checkpoint, the owner specifies required migration IDs and whether
extra IDs are allowed. This rule is bound to the checkpoint manifest and target
revision. SQL text, repository instructions and AI guesses do not create a rule.
A bound rule protects its checkpoint from retention. Use the owner-only
**ถอนกติกาของ checkpoint นี้** control or `database unbind --file ...` with
`{"targetId":"TARGET_ID","expectedRevision":1,"checkpointId":"CHECKPOINT_ID","confirmCompatibilityRemoval":true}`
to remove the rule and its retention reference; fresh previews then return UNKNOWN.
`COMPATIBLE` means only that the **explicit owner's ID rule** matched; it does not
prove arbitrary application/data compatibility. No adapter or rule means
`UNKNOWN`. The default rule blocks source restore when unknown/incompatible; the
owner can explicitly choose a warning-only policy for that target.

Source restore shows bounded compatibility, checks it again under the mutation
queue and after the mandatory pre-restore backup. Changed evidence invalidates a
preview. The database is external to the source transaction: another process can
still migrate it during a write. A final observation reports that drift without
silently undoing source or data. Quotas/orders/customer records and migration rows
are not restored; no up/down migration is executed. Generic `run_command` SQL is
not a fully audited or reversible database operation. Database rollback/PITR is
`NOT_SUPPORTED`; arrange backups with the database operator separately.

Private owner CLI examples (review the JSON, never put credentials in it):

```sh
dodo recovery database targets
dodo recovery database configure --file /absolute/path/database-target.json --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
dodo recovery database inspect TARGET_ID --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
dodo recovery database bind --file /absolute/path/checkpoint-rule.json --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
```

Target JSON:

```json
{"expectedRevision":0,"enabled":true,"confirmReadOnlyAccess":true,"definition":{"name":"App migrations","adapter":"sqlite-migration-table","databaseFile":"data/app.sqlite","table":"migrations","column":"id","onMismatch":"block"}}
```

Checkpoint rule JSON:

```json
{"targetId":"TARGET_ID","expectedRevision":1,"checkpointId":"CHECKPOINT_ID","requiredMigrationIds":["001_initial"],"allowExtra":false,"confirmCompatibilityRule":true}
```

### Private configuration backup

Register an existing private file such as `.env`, by exact project-relative path.
It must already be denied to source tools and private to the OS user, with no
symlink/hardlink/alias and at most 1 MiB. DODO does not chmod the workspace or
expand source permissions. The owner UI/CLI never accepts or displays its contents.

Each target gets a random AES-256 key in **macOS Keychain**, **Windows Credential
Manager**, or **Linux Secret Service**. The backup store contains authenticated
AES-256-GCM ciphertext and opaque key references in private state, separately from
source CAS/Git. Fresh nonces and associated data bind project/root, target,
revision and backup ID. Keys travel to the OS helper over stdin, never argv/config
JSON/logs. No session/plaintext fallback exists. Unlock/setup the OS store locally;
headless Linux without `secret-tool` and an available Secret Service cannot use
this opt-in feature. Android currently has no reviewed recovery-key provider.

Use **สำรอง config ตอนนี้** to capture, **ตรวจแผนคืน config** to review redacted sizes
and impact, then explicitly confirm the exact plan. Stop any dependent program
before restoring. DODO encrypts a pre-restore copy before the first write, checks
live owner/context/hash/identity again and reads back the result. It preserves the
existing private file and writes **in place**, not by an atomic file swap. A crash
may leave a partial file; the durable receipt then says `UNKNOWN`. Repeating that
plan never rewrites. Inspect locally and make a fresh reviewed plan from the
listed encrypted pre-restore backup. DODO never restarts a service automatically.

Rotating a key invalidates old previews. New backups use the new OS key; old
backups still require their original key and are not silently re-encrypted. **A
lost OS key makes those backups unrecoverable.** State copies alone are not a
portable/disaster backup. Secure OS key-store recovery is the owner's separate
responsibility; DODO offers no plaintext key export. Same-user processes and
administrators remain outside this storage isolation guarantee.

Separate retention defaults to 10 backups per target (2–100). Lowering it deletes
only older unreferenced ciphertext rows. Restore plans/receipts protect their
source/pre-restore backups, even above the count. Keys are not automatically
removed from the OS store. There are at most 10 targets, 32 MiB of plaintext-size
accounted ciphertext per project and 1,000 restore reviews; reaching a bound
refuses new work instead of silently evicting recovery evidence. Disabling a
missing target is allowed and retains its backups. Database/config settings have
independent revisions and do not grant AI any additional access.

```sh
dodo recovery private-config list
dodo recovery private-config configure --file /absolute/path/private-config-target.json --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
dodo recovery private-config backup TARGET_ID --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
dodo recovery private-config preview BACKUP_ID --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
dodo recovery private-config apply PLAN_ID --hash PLAN_HASH --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
dodo recovery private-config rotate TARGET_ID --revision REVIEWED_REVISION --workspace WORKSPACE_ID --epoch WORKSPACE_EPOCH --yes
```

Registration JSON contains only metadata:

```json
{"expectedRevision":0,"enabled":true,"confirmEncryptedPrivateBackup":true,"definition":{"name":"App config","path":".env","retention":10}}
```

Do not put secret values into that JSON, an MCP argument, screenshots or chat.
Anonymous/OAuth calls cannot use these owner controls; public MCP has no admin
routes. Existing private owner expiry, Host/Origin, project context and rate limits
remain in force. Automated fixtures and manual provider/platform tests are reported
separately in [TEST_REPORT](TEST_REPORT.md) and [MANUAL_ACCEPTANCE](MANUAL_ACCEPTANCE.md).
