# ADR-034 — Universal Resource Layer and private content-addressed storage

**Status:** Accepted for DODO 1.0.0 Phase 04

## Context

File tools, runtime media assets and generated previews previously used different
identities and lifetimes. Large binary data also had no generic resumable contract;
clients either needed a type-specific tool or risked loading a complete payload.

## Decision

Add six individual full-surface operations:
`resource_inspect`, `resource_read`, `resource_read_range`, `resource_preview`,
`resource_extract`, and `resource_transform`. Compact and Hybrid expose the same
operations through the existing `dodo_media` gateway, so their catalog budgets stay
19 and 49 while Full grows from 74 to 80.

Resource bytes use an installation-private SHA-256 CAS. SQLite stores immutable
object metadata and opaque references separately. A reference is scoped to the
active workspace and a digest of `grantId` + `clientId`; it expires after 24 hours.
Identical bytes share one object, but no reference, URI, hash, or resume token grants
access by itself.

Workspace ingest must pass the shared `WorkspaceFS` secret/protected/link policy,
explicit private-state exclusion, regular-file identity checks before and after a
streaming copy, size/quota limits, SHA-256 verification and optional expected
hash/MIME checks. Owned runtime media assets may enter CAS only after their existing
`MediaStorage` owner and live exec-scope checks pass.

Every read verifies live OAuth/client/grant/workspace ACL, workspace context,
principal ownership, private object identity, byte size and SHA-256. Range responses
are at most 256 KiB. Resume tokens are HMAC-signed, expire after ten minutes and bind
the object/hash/offset/workspace/principal, but still require all live authorization.

Raster previews are bounded JPEG MCP image blocks. Small audio can be returned as an
MCP audio block. SVG remains untrusted text. ZIP extraction reads bounded central
directory metadata only and never inflates entries. Unsupported PDF/OCR/media text
extraction returns an explicit unsupported result rather than inventing content or
executing an external decoder. Transform is currently one bounded raster thumbnail
and retains the existing exec/trust/owner-approval policy.

CAS publication links one complete fsynced staging inode into its hash path with
create-if-absent semantics, so a concurrent writer cannot overwrite the winner. A
SQLite trigger is the authoritative aggregate 2 GiB quota check across processes.
GC deletes expired references and then removes only objects with no remaining
references while holding the SQLite write transaction. Newly created or freshly
verified objects receive a one-hour orphan grace period so GC cannot race reference
creation. Staging and unregistered crash leftovers older than that grace are removed
on startup.

## Consequences

- All supported bytes now have one immutable identity and range contract.
- CAS dedup does not merge ownership or workspace authority.
- Full clients receive six new definitions; remote Compact/Hybrid clients retain
  their established tool counts and discover the operations dynamically.
- Full-hash verification before a range favors integrity over first-byte latency.
- PDF text, OCR, archive inflation and general media transcoding remain provider work
  for later phases; current providers do not silently claim those capabilities.
