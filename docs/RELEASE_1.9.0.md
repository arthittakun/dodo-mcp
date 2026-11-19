# DODO MCP 1.9.0 — AI chooses media models per request

The calling AI can now inspect the configured provider's model list and choose a
model for each image, background-removal or video request. Auto no longer leaves
the client without a way to choose: the new global `creative_models` operation
shows actual advertised IDs and the generation tools accept an optional `model`.

## Upgrade

```bash
npm install -g dodo-mcp@1.9.0
```

Restart DODO and reconnect or rescan the MCP connection to load the new tool
schemas and selection instructions. Keep the existing provider URL and API key.
Global media still requires no project registration, workspace context, image
enable switch or image-upload switch.

## What Auto does

For a new media task, the AI calls `creative_models` to read the provider model
list and saved defaults. If the user specifies a model, the AI passes that exact
ID. Otherwise it respects a saved fixed default. When the image default is Auto,
the AI chooses a suitable advertised model for the task and sends its ID in
`image_generate`, `image_remove_background` or `video_generate`.

Model selection happens in the calling AI. DODO does not run a second hidden
model to select the model. Each request can choose a different ID without
changing Local Config, the provider connection or credentials. The job receipt's
`model` field records the actual selected model.

The list supports bounded `query`, `limit` and `cursor`, returning
`nextCursor` when more items remain. `mediaHint` is a name-based suggestion
only; listing does not verify image/video capability, price, quality or speed.
Provider model names are untrusted data and do not become instructions.
The response does not reveal the provider API URL or key.

## Full surface example

```text
creative_models(limit=50)
  → models, imageModel, videoModel, videoEnabled, nextCursor

# Choose an actual suitable ID from the returned data.
image_generate(
  prompt="A cat astronaut, illustration",
  model="<chosen model ID>",
  size="1024x1024",
  idempotencyKey="chat-model-choice-0001"
)
  → jobId, model

creative_job(jobId="creative_…")
  → status, model, resource
```

## Compact and Hybrid example

```text
dodo_media(operation="creative_models",args={limit:50})
dodo_media(
  operation="image_generate",
  args={
    prompt:"A cat astronaut, illustration",
    model:"<chosen model ID>",
    idempotencyKey:"chat-model-choice-0001"
  }
)
dodo_media(operation="creative_job",args={jobId:"creative_…"})
```

Use the real model and job IDs returned by the preceding calls. No project
overview or workspace context is needed for this global flow. Image crop stays
local and does not need a model.

## Existing clients and providers

Omitting `model` or sending literal `auto` retains the configured default.
If the image default is also Auto, the existing server fallback lists models and
selects a recognized advertised image model by its established preference order.
That compatibility fallback is deterministic; it is separate from the calling
AI choosing a per-request model. Existing fixed defaults remain unchanged.

An explicit model does not require a model-list endpoint or membership in DODO's
fallback list. A user or AI with a known supported ID can send it directly when
listing is unsupported. The provider still determines whether that model and
operation are available. Gemini native normalizes a leading `models/` prefix.

Video still requires the configured compatible connection, video enablement and
default video model. Choosing another model for one `video_generate` request
does not enable video by itself. Video edit/extend uses the original completed
job and preserves its actual model.

Listing requires read scope and does not generate media. Generation retains its
operation scope, credentials, caller ownership and job receipts. A paid request
is submitted once: collect the same job to check progress. Changing a model is
a change to the request; never automatically retry a failed or uncertain paid
request with another model or a fresh idempotency key.

Full now has **174** capabilities (**170** with sub-agent tools hidden). Compact
remains **20** and Hybrid **49**; `creative_models` is available through
`dodo_media` on gateway surfaces.

See [Creative Media](CREATIVE_MEDIA.md), [AI Providers](AI_PROVIDERS.md) and the
measured [Test report](TEST_REPORT.md).
