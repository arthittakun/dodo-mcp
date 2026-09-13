# Universal Resources and CAS

DODO maps guarded workspace files and owned runtime media assets to one immutable
resource contract. The content-addressed store (CAS) is local to the installation;
no resource is uploaded and no listener is added.

## Operations

| Operation | Purpose | Scope/policy |
|---|---|---|
| `resource_inspect` | Ingest a workspace path or owned `assetId`, or inspect a `resourceId` | `dodo:read`; asset ingest also rechecks `dodo:exec` |
| `resource_read` | Read the first bounded chunk | `dodo:read` |
| `resource_read_range` | Read/resume a byte range, maximum 256 KiB | `dodo:read` |
| `resource_preview` | Bounded text/image/audio/metadata preview | `dodo:read` |
| `resource_extract` | UTF-8 text, metadata, or ZIP central-directory entries | `dodo:read` |
| `resource_transform` | Create one bounded raster thumbnail resource | `dodo:exec` plus trust/owner approval policy |

Full STDIO exposes these names directly. HTTP Compact and Hybrid use:

```text
dodo_discover(operation="resource_inspect")
dodo_media(operation="resource_inspect", args={"path":"assets/example.png"})
```

Keep `workspaceId` and `workspaceEpoch` at the gateway top level. Never put them in
`args`.

## Identity and ranges

`resource_inspect` returns an opaque `resourceId`, a `dodo-resource://` URI, detected
MIME, size, `sha256:...`, safe source label, capabilities and expiry. The URI is for
identity/display only. It is not an HTTP URL and not a bearer credential.

`resource_read_range` returns Base64 for one bounded byte range, a hash of that
chunk, the immutable object hash, offsets and a signed `resumeToken`. Continue with:

```text
resource_read_range(cursor="<resumeToken>", length=65536)
```

Do not combine a cursor with resourceId/offset/expectedSha256. Tokens expire after
ten minutes and are bound to the original principal, workspace, resource, hash and
next offset. DODO still performs live authorization on resume.

## Supported detection and providers

Content signatures detect PNG, JPEG, GIF, WebP, WAV, MP3, MP4, WebM, PDF, ZIP and
WASM. Valid UTF-8 supports plain text, common source formats, JSON, XML, SVG, YAML and
TOML. Extensions refine UTF-8 text only; they never make arbitrary bytes trusted.

- Raster image: metadata, bounded JPEG preview and thumbnail transform.
- Audio: bounded original MCP audio block when at most 6 MiB.
- Text/JSON/XML/SVG: bounded UTF-8 read/extract; SVG is never rendered as active content.
- PDF/video/WASM/opaque binary: identity, metadata and bounded range access.
- ZIP: bounded central-directory names and sizes only; no entry is inflated.

PDF text extraction, OCR and general transcoding are not claimed by this phase.

## Limits and retention

- object: 512 MiB
- installation CAS objects: 2 GiB
- one range: 256 KiB
- one image/audio MCP block: 6 MiB
- active references: 512 per principal/workspace
- reference lifetime: 24 hours
- resume token lifetime: 10 minutes

Expired references are collected automatically. An object is removed only after no
reference points to it. Newly created or freshly verified orphan objects receive a
one-hour grace period so GC cannot race the reference-creation step. The aggregate
2 GiB ceiling is enforced again by SQLite for concurrent DODO processes.

## Security

Every operation passes the normal invocation pipeline and then rechecks live
grant/client/workspace access and reference ownership. Workspace ingest also checks
secret/protected/private-state paths, traversal, symlinks, hardlinks, regular-file
identity and expected hash/MIME. Object bytes live below the owner-private DODO config
directory and are SHA-256 verified before reads. Resource content and decoder output
remain untrusted data. A complete fsynced staging inode is published with
create-if-absent hard-link semantics, so concurrent writers cannot replace a CAS
winner with partial bytes.
