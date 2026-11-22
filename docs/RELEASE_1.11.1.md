# DODO MCP 1.11.1 — Animation and image-edit release checks

This patch includes the [1.11 animation studio and reference image edits](RELEASE_1.11.0.md),
with fixes found during release review. Git's existing `v1.11.0` tag is preserved.

## Upgrade

```bash
npm install -g dodo-mcp@1.11.1
dodo-media-setup --install-animation
dodo status --json
```

Restart the intended DODO service using the updated executable and the same
configuration directory, then reconnect/rescan MCP. Local animation needs Python
3.11+ with Pillow, pydantic and uharfbuzz; the opt-in setup creates its private
environment. FFmpeg is needed for WebM, MP4 and Telegram output.

## Corrections

- Completed animation history no longer acts as a hidden 32-render quota.
  Active render limits still bound CPU and memory use.
- Concurrent collection of the same animation shares its work. Partial output
  collection can reuse saved resources and retry without rendering again.
  Once a job is accepted, a collection error preserves its temporary output.
- Queued animation dispatch rechecks live authorization before starting work.
- JobManager owns timeout and cancellation for the worker, Python and its
  encoder descendants. Captions explicitly use HarfBuzz instead of selecting
  an optional browser renderer from an external Python environment.
- Image-edit masks require a PNG alpha channel with a transparent editable area,
  matching the first reference image. Invalid masks fail before a paid request.
  Normalized reference images and mask together are limited to 16 MiB.
- Animation setup validates private directories and the selected interpreter
  before running it, and uses a restricted child environment. The pinned wheel
  versions require Python 3.11 or newer; transitive Python dependencies are not
  a fully locked environment.
- Generated JSON atlas metadata is validated in full, within a 1 MiB bound,
  instead of misclassifying valid files larger than a 64 KiB prefix.
- Animated scene inputs account for each frame's actual dimensions and total
  decoded pixels, including GIFs that expand beyond the initial canvas.

The supplied renderer performs local image processing and has no network
operation. JobManager requests `network:false`; OS-level network isolation is
enforced when DODO's optional command sandbox is active. Python isolated mode
does not itself provide an OS network sandbox.

Full remains **185** capabilities (**181** by default), Compact **20**, Hybrid
**49**. No private test API endpoint or credential is included. See
[Creative Media](CREATIVE_MEDIA.md) and the measured [test report](TEST_REPORT.md).
