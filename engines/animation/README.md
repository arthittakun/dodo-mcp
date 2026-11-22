# Gift animation engine (vendored)

This directory holds the Python animation engine from the Gift project, used by DODO's
`animation_*` tools. See [Creative Media](../../docs/CREATIVE_MEDIA.md) for the tools.

- Every Gift file here is pinned by SHA-256 in `MANIFEST.json`. DODO refuses to render if a pinned
  file changes, and the packaging test re-checks the hashes. Do not edit these files by hand:
  change them in Gift, then run `node scripts/vendor-animation.mjs --from <path to Gift>`.
- `dodo_bridge.py` and this README belong to DODO and are not part of the manifest.
- Runtime packages: `Pillow==13.0.0`, `pydantic==2.14.4`, `uharfbuzz==0.57.0`
  (installed by `dodo-media-setup --install-animation`). Playwright is not needed; captions
  are shaped with HarfBuzz.
- Bundled art: the orange cat and fox girl characters belong to the Gift project. Sarabun
  is licensed under the SIL Open Font License (`assets/OFL.txt`). See `CREDITS.md`.
