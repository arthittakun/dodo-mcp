# DODO MCP 1.5.0 — Creative Media

Adds image generation, lossless PNG crops/grid slicing, background removal and
explicitly configured video compatibility tools. Eight operations are available
directly on Full or through `dodo_media` on Compact/Hybrid: `image_generate`,
`image_crop`, `image_remove_background`, `video_generate`, `video_edit`,
`video_extend`, `creative_job` and `media_save`. No 3D generation is included.

## Set up and upgrade

```bash
npm install -g dodo-mcp@1.5.0
```

Restart DODO and reconnect clients to refresh the catalog. Open **Local Config →
Providers & Profiles → Creative Media**. Image configuration defaults to OpenAI;
cloud work is disabled until the owner chooses a connection, projects and model.
Image upload requires separate permission. Session credentials must be entered
again after restart; model/project settings persist. No private test endpoint or
credential is included in the UI, source or package.

## Behavior

- Generate one image or transparent-background edit per paid submission. Jobs
  return a receipt immediately; `creative_job` retrieves the actual output.
- Crop exact regions or a grid locally, preserving alpha and encoded source
  coordinates. PNG results enter the immutable resource store.
- Prepare video from text or a selected image; edit/continue completed owned
  video jobs on an explicitly enabled compatible service. Image references must
  match the requested resolution. Sources never accept arbitrary remote IDs/URLs.
- Save generated PNG/MP4 resources through the existing path/hash checks,
  byte budgets, journal and rollback. Read larger output through bounded resource
  ranges. Existing files require an explicit expected hash before replacement.

Paid requests are never automatically resubmitted. Failed/uncertain/interrupted
jobs retain their original identity; metadata persistence retries do not repeat
creation. Job and resource access remains bound to the caller and workspace.

## Video availability

The [official OpenAI deprecation notice](https://developers.openai.com/api/docs/deprecations)
and [historical video guide](https://developers.openai.com/api/docs/guides/video-generation)
state that Videos API and Sora 2 shut down on **2026-09-24**, with no direct
replacement. Consequently this release selects no default video model, disables
video compatibility by default and refuses video requests to `api.openai.com`.
Image generation retains the official OpenAI default. A compatible service must
independently support each requested video operation; model listing or successful
image/chat requests do not establish video support.

The adapter implements fixed create/status/content endpoints, multipart image
references, JSON video edits and extensions. It does not follow provider URLs,
redirect credentials, or import provider-specific fields from example projects.

## Validation

See the [current test report](TEST_REPORT.md) for focused automated checks,
fresh-install packaging and live smoke results. The supplied private test
connection returned real images/background edits but rejected video creation
with HTTP 403. Video compatibility is tested with HTTP/adapter fixtures; this
release does not claim live acceptance for an unavailable video service or a
full native platform gate.

See [Creative Media](CREATIVE_MEDIA.md) for examples and detailed limits.
