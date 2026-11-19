# DODO MCP 1.5.1 — Configurable image providers

The Creative Media panel now creates and edits image provider connections
directly. Owners can enter a name, API protocol, API Base URL, API key, credential
storage and model ID instead of using a fixed OpenAI setup shortcut. OpenAI is
still the editable default; Google Gemini and Custom starting points are also
available. No private test provider, endpoint or credential is built into them.

## Upgrade and configure

```bash
npm install -g dodo-mcp@1.5.1
```

Restart DODO, then open **Local Config → Providers & Profiles → Creative Media →
เพิ่ม / แก้ไข Provider สำหรับสร้างภาพ**. Choose a preset and edit its values, or
choose Custom and enter the service's base URL and supported model ID. The URL
must stop at an API base such as `/v1` or `/v1beta`, not a specific operation.
Save the provider, select its connection and allowed projects, then enable media
creation. Saving configuration does not call an image model.

Use **โหลดโมเดลสำหรับภาพ** to query the selected connection, or enter a model ID
manually. Model listing is a separate authenticated request and does not prove
that every listed model supports image generation. Gemini `models/` resource
prefixes are removed when presenting IDs for native Interactions requests.

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
  inputs/outputs. The default preset is `gemini-nano-banana-2.1`.
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
