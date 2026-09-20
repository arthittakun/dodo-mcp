# ADR 055 — Reviewed Docker deployments and image recovery

Status: accepted in unreleased working source; native platform release gates pending.

A source checkpoint does not prove which image is running or that a database can
be undone. Deployment is an opt-in owner-registered adapter, separate from
source recovery, which remains enabled by default.

The first adapter controls one explicitly named Docker Compose service/context.
It builds a bounded tar stream from verified, policy-filtered CAS bytes and uses
an immutable image ID. It never consumes repository Compose hooks. Source labels
are metadata, not proof: declared source mappings are compared against actual
image/container bytes, with archive traversal/link/mount exclusions. A stopped,
network-disabled probe records its identity before creation and is never started.

Every effect uses the shared invocation authority, project mutation queue,
JobManager, sandbox and exec policy. A plan binds workspace/epoch, target revision,
source manifest and required test evidence. Health checks have separately declared
network permission, DNS pinning, redirect rejection and private/admin endpoint
restrictions. Stabilization and a final container identity check precede a
revisioned known-good pointer update. Image rollback uses a new reviewed plan,
exact old image and fresh health; it never runs database migrations.

Durable state precedes external effects. Restart converts in-flight records to
UNKNOWN. Retries inspect the receipt rather than repeat commands. Owner-only
maintenance previews re-observe exact state before acknowledgement or cleanup;
acknowledging UNKNOWN is not a success/health assertion. The original unknown
receipt remains available. Private owner review IDs/hashes and expiry protect
maintenance; these controls are not MCP tools.

Retention groups immutable IDs, protects current/previous known-good, active
containers, unexpired plans, unresolved outcomes, owner pins and other target
references. Cleanup is explicit, uses exact managed tags/IDs without force, and
never prunes volumes. Interrupted cleanup is resolved by observation before a new
review. Source manifests stay protected by deployment provenance independently
of image retention. Each target admits at most 500 records; owner maintenance
reviews are bounded at 2,000 per project.

Limits: Docker access can affect resources beyond the workspace. Generic shell,
external CI and owner terminal commands remain outside this adapter's deployment
guards. Missing/compiled source is not reconstructed, unavailable manifests are
not fabricated, and source recovery does not include database or secret data.
