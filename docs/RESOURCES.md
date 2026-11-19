# Universal Resources and CAS

DODO maps guarded workspace files and owned runtime media assets to one immutable
resource contract. The content-addressed store (CAS) is local to the installation.
Ingesting a resource keeps it private. An explicit `download_link_create` call can
publish that one immutable object through the existing HTTP listener.

## Operations

| Operation | Purpose | Scope/policy |
|---|---|---|
| `resource_inspect` | Ingest a workspace path or owned `assetId`, or inspect a `resourceId` | `dodo:read`; asset ingest also rechecks `dodo:exec` |
| `resource_read` | Read the first bounded chunk | `dodo:read` |
| `resource_read_range` | Read/resume a byte range, maximum 256 KiB | `dodo:read` |
| `resource_preview` | Bounded text/image/audio/metadata preview | `dodo:read` |
| `resource_extract` | UTF-8 text, metadata, or ZIP central-directory entries | `dodo:read` |
| `resource_transform` | Create one bounded raster thumbnail resource | `dodo:exec` plus trust/owner approval policy |
| `download_link_create` | Issue a temporary token URL for one owned resource | `dodo:write` and `dodo:read`; execution trust/approval policy |
| `download_link_list` | List owned, unexpired link metadata without tokens/URLs | `dodo:read` |
| `download_link_revoke` | Revoke an owned link before expiry | `dodo:write`; stopping a link needs no execution approval |

Full STDIO exposes these names directly. HTTP Compact and Hybrid use:

```text
dodo_discover(operation="resource_inspect")
dodo_media(operation="resource_inspect", args={"path":"assets/example.png"})
```

Keep `workspaceId` and `workspaceEpoch` at the gateway top level. Never put them in
`args`.

## Temporary token download links

Available in DODO 1.6.0. Start the HTTP server with its configured public origin
and keep the server/tunnel running. A normal resource URI cannot be downloaded
over HTTP until its owner explicitly creates a link. No extra listener or external
file-hosting provider is used. The base URL comes from the running server, not
tool arguments or forwarded request headers. STDIO alone returns `NOT_SUPPORTED`;
Local mode produces a loopback URL usable only on that machine. For remote
recipients, configure the public HTTPS origin and route `/file/*` through the same
tunnel as `/mcp`.

Use `resource_inspect` for one guarded workspace file first, or use the resource
returned by `creative_job`/`image_crop`. Create a link using the returned ID and
exact SHA-256:

```text
dodo_media(
  workspaceId="…", workspaceEpoch="…",
  operation="resource_inspect",
  args={path:"assets/image.png"}
)
  → resourceId, sha256

dodo_media(
  workspaceId="…", workspaceEpoch="…",
  operation="download_link_create",
  args={
    resourceId:"res_…",
    expectedSha256:"sha256:…",
    expiresInDays:7,
    fileName:"image.png"
  }
)
  → linkId, url, fileName, mimeType, bytes, sha256,
    createdAt, expiresAt, revokedAt
```

`expiresInDays` accepts **1, 2, 7, 14 or 30**, with a default of 7. `fileName` is
optional; the default uses the detected MIME type, such as `download.png` or
`download.mp4`. A custom name must be one filename, at most 180 characters, with no
path separators or control characters. Neither the name nor the URL can select
an arbitrary filesystem path. A URL looks like
`https://mcp.example.com/file/<random-token>/image.png`.

Creation requires read and write access to the source project, plus the execution
trust/approval policy. The resource must belong to the same caller/workspace and
still be valid at creation. Sharing does not run an image model or upload bytes to
an AI provider. Each create call issues a separate link; there is no automatic
retry. If a response is lost, inspect the owned links and revoke unwanted ones
before issuing another.

The **URL is a bearer secret**: anyone holding it can download without a separate
MCP OAuth login. DODO returns the plaintext token only in the create response and
stores its hash in private state. Do not place the URL in public logs or a Git
repository. `download_link_list(limit=50)` returns metadata only (maximum 128 per
call), including `linkId`, expiry and revocation time, with no token or URL. It
cannot recover a lost URL. Revoked metadata can disappear after its object is
collected; expired links are not listed. Use the original caller and project
context to revoke:

```text
dodo_media(
  workspaceId="…", workspaceEpoch="…",
  operation="download_link_revoke",
  args={linkId:"dl_…"}
)
```

Revocation is safe to repeat. It stops subsequent access; bytes already downloaded
cannot be recalled. Expired, revoked, invalid or no-longer-authorized links are
unavailable. Downloads recheck the current underlying client/grant and project
read/write authority, including managed ACL and project access level. Removing a
registered source project or making its registered root unavailable also stops
its links. A link's requested lifetime is independent of the issuing MCP access
token's shorter lifetime; the underlying
grant must still be valid.

Downloads support GET/HEAD and one byte range for resuming; malformed or multiple
ranges are refused. Files are served as attachments with no-store and nosniff
headers. SVG/HTML resource bytes are not deliberately rendered as an application
page on the MCP origin.

Links survive DODO restarts and workspace switches while the same installation
state/CAS and public origin remain available. They point to immutable CAS bytes,
so editing/deleting the original workspace file does not replace the download.
Each active link pins its object for the selected lifetime independently of the
resource reference's 24-hour expiry. Expiry/revocation releases that pin; normal
GC can remove bytes once no other reference or active link needs them. The server
does not extend a link when it is downloaded or listed.

There are at most 128 active links per caller/workspace and 1,024 per installation.
Unexpired metadata, including revoked history, is also bounded to 512 entries per
caller/workspace and 4,096 per installation. Listing puts active links first, so a
limit of 128 can find every active owned link before revoked history.
Existing object/CAS byte limits still apply. Creating several links to the same
object does not duplicate its stored bytes. Full exposes the three names directly;
Compact/Hybrid use `dodo_media` and `dodo_discover` with the same permissions.

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
reference or active download link points to it. Newly created or freshly verified
orphan objects receive a
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
