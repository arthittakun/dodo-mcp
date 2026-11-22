# Gift animation engine (vendored)

This directory holds the Python animation engine from the Gift project, used by DODO's
`animation_*` tools. See [Creative Media](../../docs/CREATIVE_MEDIA.md) for the tools.

- Every Gift file here is pinned by SHA-256 in `MANIFEST.json`. DODO refuses to render if a pinned
  file changes, and the packaging test re-checks the hashes. Do not edit these files by hand:
  change them in Gift, then run `node scripts/vendor-animation.mjs --from <path to Gift>`.
- `dodo_bridge.py` and this README belong to DODO and are not part of the manifest.
- DODO 1.11.1 includes a local decoder hardening in `scene_animation.py`: every
  frame's actual dimensions and cumulative decoded pixels are checked before RGBA
  conversion, including GIF frames that expand beyond the initial canvas. Preserve
  this bound when refreshing the vendored engine; its manifest hash is updated.
- Runtime packages: `Pillow==13.0.0`, `pydantic==2.14.4`, `uharfbuzz==0.57.0`
  on Python 3.11+ (installed by `dodo-media-setup --install-animation`). These are
  direct dependency pins; transitive dependencies retain upstream version ranges.
  Playwright is not needed; captions
  are shaped with HarfBuzz.
- Bundled art: the orange cat and fox girl characters belong to the Gift project. Sarabun
  is licensed under the SIL Open Font License (`assets/OFL.txt`). See `CREDITS.md`.
