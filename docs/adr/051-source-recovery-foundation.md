# ADR-051 — Default-on source backup foundation

Status: implemented in unreleased working source. Reviewed restore and session
pins are implemented in [ADR-052](052-reviewed-source-restore.md); publication
still requires an explicit owner release request.

Each leased project runtime owns a RecoveryService. Only owner-registered roots
activate scanning. Missing versioned private project policy means enabled;
explicit owner opt-out is preserved. Owner web and CLI share IPC validation.
Repository configuration and model output cannot alter this policy.

Storage is an independent CAS under private installation state. Immutable
manifests bind project/workspace/root identity, epoch, implicit operation session,
actor, trigger, scope and policy digest to actual source bytes. SQLite migration
adds snapshot states, object references, policies and reservations. Older binaries
refuse the newer schema; no old journal or authority records are rewritten.

Capture hashes the scoped inventory, reserves installation/project capacity and
free disk, streams private object copies, fsyncs, resamples source paths/hashes,
verifies stored objects, publishes an immutable manifest, then transactionally
commits refs and READY. Nothing labeled READY is merely a list of hashes.
PREPARING records interrupted by restart become INCOMPLETE under the project
lease; no command is replayed. Resource GC cannot remove Recovery objects.

The existing Applier adds targeted before-images before journal creation and
rechecks expected hashes after asynchronous capture. JobManager's async
startProtected captures a fresh full scope while holding the shared mutation
queue; its sync entry refuses registered-project bypasses. All production job
producers use that path. The scheduler rechecks durable approval after capture,
and tool invocation rechecks caller authority after capture before effects.
Git commit (including hooks) and directory creation also require checkpoints.

Full baselines and explicit mutation targets have different coverage. Policy
exclusions never silently remove a named target; an allowed ordinary-ignored
source target is included, while excluded data/secret targets are refused.
Snapshot retention preserves newest complete full/target points and pins.
Journal before-images remain independent. ADR-052 adds restore/session pins so
those consumers can safely retain their old CAS references.

Consequences: scans cost I/O and can block mutation on quota, corruption or
unstable files. This is neither an OS sandbox nor a filesystem-wide atomic
snapshot. No database/volume/secret, remote side-effect, or full filesystem
metadata recovery is implied. Session restore is implemented by ADR-052;
verification-bound stable points remain a later phase. Backup-only releases
without reviewed restore are not sufficient for default-on Recovery acceptance.
