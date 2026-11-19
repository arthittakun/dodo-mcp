# DODO MCP 1.5.1 — Configurable image providers

This version was not published. Its changes are included in
[DODO 1.6.0](RELEASE_1.6.0.md), together with Auto model selection and temporary
download links. Upgrade using the published 1.6.0 package.

The Creative Media panel now creates and edits image provider connections
directly. Owners can enter a name, API protocol, API Base URL, API key, credential
storage and model ID instead of using a fixed OpenAI setup shortcut. OpenAI is
still the editable default; Google Gemini and Custom starting points are also
available. No private test provider, endpoint or credential is built into them.

## Upgrade and configure

```bash
npm install -g dodo-mcp@1.6.0
```

Restart DODO, then open **Local Config → Providers & Profiles → Creative Media →
เพิ่ม / แก้ไข Provider สำหรับสร้างภาพ**. Choose a preset and edit its values, or
choose Custom and enter the service's base URL and key. New configurations and
all presets select **Auto** for the image model, so a concrete model ID is not
required at setup. Previously saved manual model IDs remain unchanged. The URL
must stop at an API base such as `/v1` or `/v1beta`, not a specific operation.
Save the provider, select its connection and allowed projects, then enable media
creation. Saving configuration does not call an image model.

The panel loads and displays model IDs automatically when a saved connection is
opened, selected or saved. **โหลดโมเดลสำหรับภาพ** refreshes the list, and manual
model entry remains available if loading fails. Model listing is a separate
authenticated read request and does not prove that every model supports images.
Gemini `models/` resource prefixes are removed for native Interactions requests.

At execution time, Auto obtains a fresh model list from the same connection,
selects one recognized image model advertised there and sends one image request.
It never sends the literal `auto`, guesses a text/video model, or retries a paid
image request using a different model after an error. If the list is unsupported
or contains no recognized image model, the owner must choose a supported ID
manually. The job's `model` field reports the actual selected model.

Use **แก้ไข connection ที่เลือก** to change an existing connection. A blank key
retains the existing credential only when URL, protocol and storage are unchanged.
Changing those fields requires a newly entered key before any forwarding to the
new target. Keys are not returned to refill the UI or saved in browser storage.
Session keys require reentry after restart; macOS Keychain remains available.

Incomplete credential updates fail closed across restart. The connection cannot
send requests until the owner confirms its settings and reenters a key; this
prevents a newly saved key from being paired with an older endpoint after a
metadata write failure.

## Image protocols

- OpenAI-compatible Images uses fixed generation/edit paths below the selected
  base URL with Bearer authentication. Custom services can use their own names,
  URLs and model IDs when they implement this wire format.
- Google Gemini native uses Interactions and `x-goog-api-key`, with inline PNG
  inputs/outputs. Auto selects only known Gemini image IDs present in the list;
  `gemini-nano-banana-2.1` is preferred when advertised by that connection.
- Gemini accepts automatic quality and requests 1K output with an aspect ratio
  derived from the selected size. The resource metadata reports actual decoded
  dimensions rather than promising OpenAI pixel dimensions.
- Transparent-background edits are checked for real transparent pixels. A
  provider that returns an opaque image is not reported as successful removal.

See the primary [OpenAI image guide](https://developers.openai.com/api/docs/guides/image-generation)
and [Google Gemini image guide](https://aistudio.google.com/docs/image-generation).
Native Gemini contract tests use fixtures; live acceptance with an official
Gemini credential is recorded separately and is not claimed by this release.

The eight Creative Media operations and MCP tool names are unchanged. Full has
170 capabilities (166 when sub-agents are hidden), Compact 20 and Hybrid 49.
Image provider changes do not enable video for the native Gemini protocol;
existing video compatibility still requires its own supported connection/model.

See [Creative Media](CREATIVE_MEDIA.md) for provider-specific limits and
[Test report](TEST_REPORT.md) for measured validation results.
