# DODO MCP 1.6.0 — Image providers, Auto models and temporary downloads

This release combines configurable image providers, automatic image model
discovery/selection and temporary token download links. The previously drafted
1.5.1 changes are delivered here; 1.5.1 was not published separately.

## Upgrade

```bash
npm install -g dodo-mcp@1.6.0
```

Restart DODO and refresh/rescan the MCP client catalog. Full now has 173
capabilities, or 169 with the four sub-agent operations hidden by default.
Compact remains 20 tools and Hybrid remains 49. The new download operations are
available through `dodo_media` as well as their direct Full names.

## Configurable image providers and Auto

Open **Local Config → Providers & Profiles → Creative Media → เพิ่ม / แก้ไข
Provider สำหรับสร้างภาพ**. Enter a provider name, API protocol, API Base URL, key,
credential storage and image model. OpenAI remains the editable default; Google
Gemini and Custom starting points are also available. Private test endpoints or
credentials are not built into the application, presets or examples.

New configurations and presets select **Auto**. The panel loads model IDs when a
saved connection is opened, selected or saved. Manual entry and an explicit
refresh button remain available when discovery is unsupported or fails. Existing
manually saved model IDs remain unchanged. Custom setup needs the API base URL
and key without a concrete Model ID first. Saving settings or listing models does
not perform image inference.

At execution, Auto fetches a fresh list from the same connection, chooses one
recognized image model advertised there and makes one generation/edit request.
It does not send the literal `auto`, choose a text/video model, switch providers,
or retry a paid request with another model. If discovery fails or lists no known
image model, choose an ID manually. `creative_job.model` records the actual model.
Model listing has a 15-second absolute deadline, including credentials, DNS and
streamed responses. A discovery failure can be retried before any paid request.

OpenAI-compatible Images uses generation/edit endpoints under the configured base
URL and Bearer authentication. Native Gemini uses Interactions and
`x-goog-api-key`, with inline PNG input/output. Provider labels do not override
the selected protocol. Base URLs must end at the API base, not at an operation.
Native Gemini uses automatic quality, requests 1K output by aspect ratio and
reports the decoded image dimensions. Transparent output is checked for actual
transparent pixels. Native Gemini image support does not enable video.

An unchanged endpoint/protocol/storage can retain its key when the edit form is
left blank. Changing any of them requires reentry; no existing key is forwarded
to a new target. Keys are not returned to refill forms or persisted in browser
storage. Incomplete credential/metadata updates quarantine the connection across
restart until explicit repair. Session keys still require reentry after restart;
macOS Keychain is available for persistent credentials.

Video remains an explicitly configured compatibility adapter with no enabled
default. Official OpenAI Videos API support remains disabled following its
retirement. See [Creative Media](CREATIVE_MEDIA.md) and
[AI Providers](AI_PROVIDERS.md) for protocol and permission details.

## Token download tools

| Tool | Behavior |
|---|---|
| `download_link_create` | Publish one owned resource with exact `expectedSha256`, optional `fileName`, and `expiresInDays` of 1, 2, 7, 14 or 30; default 7 |
| `download_link_list` | List owned, unexpired metadata without tokens or URLs; default 50, maximum 128 |
| `download_link_revoke` | Revoke one owned `linkId`; repeat safely |

Use a resource returned by `creative_job`/`image_crop`, or ingest a guarded file
with `resource_inspect` first. Creation returns a URL such as
`https://mcp.example.com/file/<random-token>/image.png`, plus `linkId`, hash,
size and expiry. The origin comes from the running HTTP server. There is no tool
argument for an arbitrary public URL or filesystem download path.

The returned URL is a **bearer secret**. Anyone holding it can download without
another MCP login; the private database stores only the token hash. Only the
create response contains the URL, so listing links cannot recover a lost token.
Each create call issues a separate link and is not automatically retried. After
a lost response, list/revoke unwanted links before creating another.

Links serve immutable CAS bytes and pin those bytes independently of the
resource reference's 24-hour lifetime. Editing the original file does not change
an issued download. Links survive restarts/workspace switches using the same
installation state. Expiry or revocation releases the pin, allowing normal GC
when no other reference/link needs the object.

Creation requires read/write access and the execution trust/approval policy;
listing requires read and revocation requires write. Downloads also check the
current client/grant and project read/write authority. Revoked grants, removed
registered projects and lost required project permissions stop access. The
explicit link lifetime may outlast the issuing MCP access token, while the
underlying grant must remain valid. Revocation cannot recall previously
downloaded bytes.

The existing HTTP server/tunnel must remain reachable. STDIO alone does not host
downloads; Local mode produces URLs usable only on that machine. A public
installation routes `/file/*` through the same HTTPS origin as `/mcp`. Existing
CAS limits still apply: 512 MiB per object and 2 GiB total; at most 128 active
links per caller/workspace and 1,024 per installation.

See [Universal Resources](RESOURCES.md#temporary-token-download-links) for call
examples, retention and access details. Measured validation is recorded in the
[Test report](TEST_REPORT.md); this document does not claim live acceptance for
every provider or model.
