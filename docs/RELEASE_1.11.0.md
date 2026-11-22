# DODO MCP 1.11.0 — Local animation studio (Gift engine) and reference image edits

This release embeds the Gift animation engine so the AI can turn images into smooth
looping animations, stickers, banners and scenes on the machine running DODO, with no
model call and no cost. It also adds reference-conditioned image edits, which let an
image model draw animation frames that Gift checks and assembles.

## Upgrade

```bash
npm install -g dodo-mcp@1.11.0
dodo-media-setup --install-animation
dodo status --json
```

`--install-animation` creates a private Python venv in the DODO config directory
(`animation/venv`) and installs wheels with three direct dependency pins: `Pillow==13.0.0`,
`pydantic==2.14.4`, `uharfbuzz==0.57.0`. Transitive dependencies retain their upstream
version ranges. This setup needs Python 3.11+ on the trusted PATH and changes no
DODO access configuration. Alternatively start DODO with
`DODO_ANIMATION_PYTHON` set to an absolute Python (outside any workspace) that has
those packages. FFmpeg on the trusted PATH is needed only for `webm`, `mp4` and
`telegram` output. Restart DODO and reconnect/rescan MCP to load the new schemas.

## New capabilities

| Tool | What it does |
|---|---|
| `animation_catalog` | Presets, effects, formats and readiness (Python, engine integrity, FFmpeg). |
| `animation_image` | One still → seamless loop: wiggle, zoom, pan, bounce, float, sway, heartbeat, shake, spin, jelly, or blink/wave on a clean drawing. |
| `animation_rig` | Rigged characters with spring physics (ears, tails, hands), natural blinks and body motion (bob, breathe, jump). Bundled orange cat and fox girl presets or a custom Gift-format rig with `seeds`. Returns Gift's loop review checks. |
| `animation_sprite` | Assembles a 4×2 or 4×4 transparent pose sheet into an aligned loop; with a plan layout it checks the sheet first. |
| `animation_frames_plan` | Plans frames for an image model: a guide sheet with the character in cell 1, an edit mask, a per-cell prompt and the layout. Local and free. |
| `animation_banner` | Neon text banners (Thai or Latin) with a badge, comet and five motions; drawn with Pillow and HarfBuzz, no browser. |
| `animation_scene` | Multi-layer scenes: the Solar System preset, or a background plus up to 20 still or animated layers that walk across, orbit, spin or pulse. GIF or MP4. |
| `animation_job` | Collects a render that is still running. |
| `image_edit` | Paid: draws from 1–4 reference images with an optional mask (transparent = repaint). OpenAI-compatible `/images/edits`; Gemini without a mask. |

Image, rig, sprite and banner rendering support GIF, WebP, APNG, WebM, MP4,
sprite sheet + JSON, LINE animated stickers and Telegram video stickers within
each platform's limits. Scene rendering supports GIF/MP4; frame planning returns
PNG guide and mask resources. Supported rendering tools add
Thai or Latin captions shaped with HarfBuzz, and accepts `maxSide` for lighter chat
files. Results are owned resources with a six-frame contact-sheet preview, so
`media_save` and `download_link_create` work directly. `media_save` now also accepts
generated GIF, WebP, APNG, WebM and sprite-sheet JSON with the matching extension.

### Drawing frames with an image model

`animation_frames_plan` → `image_edit` (guide + character, mask, plan prompt,
`background: transparent`) → `creative_job` → `animation_sprite` with the plan
`layout` and the character as `reference`. Conditions before drawing: the character
fixed in cell 1 at the target size and ground line, a mask that only lets the model
paint inside the other cells, jump sheets with headroom, and a prompt with one pose
per cell. Checks after drawing: transparent background, one whole figure per cell
(nothing spilling across cells), consistent size, a shared ground line per row (the
jump apex must leave it), the reference's colours, distinct poses and a smooth
sequence. Small size drift is scaled back to cell 1, and jumps are aligned to the
measured ground so airborne frames keep their height. A failing sheet is still
assembled for inspection with `passed: false` and the reasons in `notes`; DODO never
redraws on its own because another edit is a new paid request.

### Generated art is handled robustly

Rigs drawn on AI-generated images get two engine improvements: bold outlines are split
between a part and its surroundings by proximity, so a tightly traced part never leaves
a second outline on the body, and parts that would swing past the canvas edge get
transparent padding automatically, with every rig coordinate remapped.

## Security and integrity

Each render runs as an owned JobManager job requesting `network:false`. OS-level
network denial requires DODO's optional command sandbox; Python isolated mode
alone does not deny network access. The supplied renderer has no network operation. A Node worker
starts Python in isolated mode (`-I -B -X utf8`) inside a private temporary
directory; source images are copied in under fixed names and every output name is
fixed by the bridge, so clients cannot pass file paths or fonts to the engine. All 34
vendored engine files are pinned by SHA-256 in `engines/animation/MANIFEST.json`;
DODO verifies them before the first render in each process and refuses a modified
engine, and the packaging test re-checks every hash. Update the engine from a Gift
checkout with `node scripts/vendor-animation.mjs --from <path>`.

`image_edit` follows the existing paid-media rules: one submission per idempotency
key, durable receipts, no automatic retry, preflight validation (a mask must match the
first image's pixel size) before anything is sent.

## Counts and compatibility

Full surface 185 capabilities (181 with sub-agent tools hidden by default), Compact
20 and Hybrid 49; the new operations are reachable through `dodo_media`. Existing tool
names and order are unchanged; the new tools are appended.

## Validation

Animation rendering tests require `DODO_TEST_ANIMATION_PYTHON`; without it,
readiness checks run but real-render cases are skipped. The frame-edit pipeline
uses a local provider fixture. See the [current test report](TEST_REPORT.md) and
[1.11.1 release review](RELEASE_1.11.1.md) for measured results, packaging checks
and platform limitations. No additional live paid-provider acceptance is claimed
by that review.
