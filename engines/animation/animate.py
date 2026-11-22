"""Render a seamless, code-drawn banner and export it as WebP, GIF or APNG."""

import argparse
import base64
from io import BytesIO
import math
import os
from pathlib import Path
import re
import sys
from tempfile import NamedTemporaryFile

from PIL import Image, PngImagePlugin, features

try:
    from playwright.sync_api import Error as PlaywrightError, sync_playwright
except ImportError:  # The animation engine and exporters work without it; only banners need a browser.
    class PlaywrightError(Exception):
        """Stand-in so error handlers keep working when Playwright is not installed."""

    sync_playwright = None


ROOT = Path(__file__).resolve().parent
FORMATS = {".webp": "WEBP", ".gif": "GIF", ".png": "PNG", ".apng": "PNG"}
DEFAULT_OUTPUTS = (Path("out/banner.webp"), Path("out/banner.gif"))
MAX_PIXELS = 64_000_000  # Total pixels across all uncompressed frames.
GIF_TRANSPARENT_INDEX = 255


def size_arg(value):
    match = re.fullmatch(r"(\d+)[xX](\d+)", value)
    if not match or not all(32 <= int(n) <= 4096 for n in match.groups()):
        raise argparse.ArgumentTypeError("expected WIDTHxHEIGHT (32-4096 px each)")
    return tuple(map(int, match.groups()))


def color_arg(value):
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise argparse.ArgumentTypeError("expected a color like #38BDF8")
    return value.lower()


def background_arg(value):
    return "transparent" if value.lower() == "transparent" else color_arg(value)


def get_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-o", "--output", type=Path, action="append",
                        help="output path; repeat for more formats (default: out/banner.webp and out/banner.gif)")
    parser.add_argument("--size", type=size_arg, default="800x200", metavar="WIDTHxHEIGHT")
    parser.add_argument("--fps", type=int, default=20, help="target frames per second (default: 20)")
    parser.add_argument("--duration", type=float, default=2.5, metavar="SECONDS")
    parser.add_argument("--text", default="เปิดให้บริการ 24 ชั่วโมง", help="one-line headline; --text= hides it")
    parser.add_argument("--label", default="ONLINE", help="small status badge; --label= hides it")
    parser.add_argument("--font", type=Path, default=ROOT / "assets" / "Sarabun-Bold.ttf",
                        help="path to a .ttf or .otf file (default: bundled Sarabun Bold)")
    parser.add_argument("--motion", choices=("bounce", "pulse", "slide", "shake", "still"), default="bounce")
    parser.add_argument("--strength", type=float, default=1.0, help="headline motion intensity, 0-2 (default: 1)")
    parser.add_argument("--background", type=background_arg, default="#0F172A", metavar="COLOR",
                        help="'transparent' or #RRGGBB")
    parser.add_argument("--accent", type=color_arg, default="#38BDF8", metavar="COLOR")
    parser.add_argument("--text-color", type=color_arg, default="#F1F7FF", metavar="COLOR")
    parser.add_argument("--quality", type=int, default=86, help="lossy WebP RGB quality, 0-100 (default: 86)")
    parser.add_argument("--lossless", action="store_true", help="use lossless WebP compression")
    parser.add_argument("--gif-dither", action="store_true", help="enable Floyd-Steinberg dithering for GIF")
    parser.add_argument("--gif-alpha-threshold", type=int, default=128,
                        help="GIF pixels below this alpha are transparent, 1-255 (default: 128)")
    parser.add_argument("--overwrite", action="store_true", help="allow replacing an existing output")
    return parser


def frame_delays(seconds: float, count: int, quantum_ms: int = 1) -> list[int]:
    """Round cumulative time, not each frame separately, to avoid drift."""
    ticks = round(seconds * 1000 / quantum_ms)
    marks = [(i * ticks + count // 2) // count for i in range(count + 1)]
    return [(end - start) * quantum_ms for start, end in zip(marks, marks[1:])]


def validate(args, parser):
    outputs = args.output or DEFAULT_OUTPUTS
    paths = set()
    for path in outputs:
        if path.suffix.lower() not in FORMATS:
            parser.error(f"unsupported extension: {path}; use .webp, .gif, .png or .apng")
        resolved = path.resolve()
        if resolved in paths:
            parser.error(f"output path listed twice: {path}")
        paths.add(resolved)
        if (path.exists() or path.is_symlink()) and (not path.is_file() or not args.overwrite):
            parser.error(f"output already exists: {path}; use a different path or --overwrite")

    if not 1 <= args.fps <= 60:
        parser.error("--fps must be between 1 and 60")
    if not (math.isfinite(args.duration) and 0 < args.duration <= 60):
        parser.error("--duration must be greater than 0 and at most 60 seconds")
    count = round(args.duration * args.fps)
    if not 2 <= count <= 600:
        parser.error("FPS * duration must give 2-600 frames")
    if math.prod(args.size) * count > MAX_PIXELS:
        parser.error("animation is too large; reduce --size, --fps or --duration")
    if not 0 <= args.strength <= 2:
        parser.error("--strength must be between 0 and 2")
    if not 0 <= args.quality <= 100 or not 1 <= args.gif_alpha_threshold <= 255:
        parser.error("--quality must be 0-100 and --gif-alpha-threshold must be 1-255")
    if len(args.text) > 500 or len(args.label) > 64:
        parser.error("--text must be at most 500 characters and --label at most 64")
    if args.font.suffix.lower() not in (".ttf", ".otf") or not args.font.is_file():
        parser.error(f"font not found or not a .ttf/.otf file: {args.font}")
    formats = {FORMATS[path.suffix.lower()] for path in outputs}
    if "WEBP" in formats and not features.check("webp"):
        parser.error("this Pillow build does not support WebP; install the wheel in requirements.txt")

    delays = {fmt: frame_delays(args.duration, count, 10 if fmt == "GIF" else 1) for fmt in formats}
    if "GIF" in formats and (args.fps > 50 or min(delays["GIF"]) < 20):
        parser.error("GIF requires at most 50 FPS and at least 20 ms per frame for browser playback")
    return outputs, count, delays


def render_frames(args, count):
    width, height = args.size
    font_type = args.font.suffix.lower()[1:]
    font_b64 = base64.b64encode(args.font.read_bytes()).decode("ascii")
    config = {
        "width": width, "height": height, "text": args.text, "label": args.label,
        "fontURL": f"data:font/{font_type};base64,{font_b64}",
        "background": args.background, "accent": args.accent, "textColor": args.text_color,
        "motion": args.motion, "strength": args.strength,
    }
    frames = []
    if sync_playwright is None or os.environ.get("GIFT_BANNER_ENGINE") == "pillow":
        # The same banner drawn with Pillow and HarfBuzz, for machines without a browser.
        from banner_render import render_banner_frames

        return render_banner_frames(
            width=width, height=height, text=args.text, label=args.label, motion=args.motion,
            background=args.background, accent=args.accent, text_color=args.text_color,
            strength=args.strength, count=count, font_path=args.font,
        )
    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except PlaywrightError as exc:
            raise RuntimeError(f"Could not start Chromium. Run: python -m playwright install chromium\n{exc}") from exc
        try:
            page = browser.new_page()
            page.add_script_tag(path=ROOT / "render_banner.js")
            page.evaluate("config => window.initBanner(config)", config)

            # Keep browser-to-Python transfers bounded for large canvases.
            batch_size = max(1, min(8, 2_000_000 // (width * height)))
            for start in range(0, count, batch_size):
                batch = page.evaluate(
                    "([start, end, total]) => window.drawFrames(start, end, total)",
                    [start, min(start + batch_size, count), count],
                )
                for image_b64 in batch:
                    with Image.open(BytesIO(base64.b64decode(image_b64))) as image:
                        frames.append(image.convert("RGBA"))
        finally:
            browser.close()
    return frames


def adaptive_palette(frames, transparent, threshold):
    """Train one palette across the loop to avoid per-frame color flicker."""
    data = bytearray()
    n_samples = min(12, len(frames))
    for i in range(n_samples):
        sample = frames[i * len(frames) // n_samples].copy()
        sample.thumbnail((480, 160), Image.Resampling.BOX)
        if transparent:
            # Do not let invisible colors dominate a mostly transparent palette.
            rgba = sample.tobytes()
            for r, g, b, a in zip(rgba[0::4], rgba[1::4], rgba[2::4], rgba[3::4]):
                if a >= threshold:
                    data.extend((r, g, b))
        else:
            data.extend(sample.convert("RGB").tobytes())

    if not data:
        data.extend((0, 0, 0))
    columns = min(512, len(data) // 3)
    data.extend(data[:3] * (-(len(data) // 3) % columns))
    training = Image.frombytes("RGB", (columns, len(data) // (columns * 3)), bytes(data))
    n_colors = 255 if transparent else 256
    colors = training.quantize(n_colors, Image.Quantize.MEDIANCUT).getpalette()
    colors = colors[:3 * n_colors]
    # Reserve index 255 as a duplicate of color 0; we'll use it only for alpha.
    colors.extend(colors[:3] * (256 - len(colors) // 3))
    palette = Image.new("P", (1, 1))
    palette.putpalette(colors)
    return palette


def save_gif(frames, path, delays, threshold, dither):
    transparent = any(frame.getchannel("A").getextrema()[0] < threshold for frame in frames)
    palette = adaptive_palette(frames, transparent, threshold)
    opaque_indices = [*range(255), 0]
    alpha_to_mask = [255] * threshold + [0] * (256 - threshold)
    indexed = []
    for frame in frames:
        converted = frame.convert("RGB").quantize(palette=palette, dither=dither)
        if transparent:
            # Keep opaque pixels opaque even if quantization selected the duplicate.
            converted = converted.point(opaque_indices)
            mask = frame.getchannel("A").point(alpha_to_mask)
            converted.paste(GIF_TRANSPARENT_INDEX, mask=mask)
        indexed.append(converted)
    options = {"transparency": GIF_TRANSPARENT_INDEX, "background": GIF_TRANSPARENT_INDEX} if transparent else {}
    indexed[0].save(path, format="GIF", save_all=True, append_images=indexed[1:],
                    duration=delays, loop=0, disposal=2, optimize=False, **options)


def publish_output(source, destination, *, overwrite=False):
    if overwrite:
        source.replace(destination)
    elif os.name == "nt":
        source.rename(destination)
    else:
        # POSIX rename can overwrite, but creating a hard link cannot.
        destination.hardlink_to(source)


def export(frames, path, fmt, delays, args, *, overwrite=False):
    # Publish only after the encoder has completed successfully.
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=path.parent, suffix=path.suffix, delete=False) as file:
        temp_path = Path(file.name)
    try:
        shared = {"save_all": True, "append_images": frames[1:], "duration": delays, "loop": 0}
        if fmt == "WEBP":
            frames[0].save(temp_path, format="WEBP", **shared, quality=args.quality,
                           lossless=args.lossless, alpha_quality=100, method=4, minimize_size=True)
        elif fmt == "PNG":
            frames[0].save(temp_path, format="PNG", **shared,
                           disposal=PngImagePlugin.Disposal.OP_NONE, blend=PngImagePlugin.Blend.OP_SOURCE)
        else:
            dither = Image.Dither.FLOYDSTEINBERG if args.gif_dither else Image.Dither.NONE
            save_gif(frames, temp_path, delays, args.gif_alpha_threshold, dither)
        publish_output(temp_path, path, overwrite=overwrite)
    except FileExistsError as exc:
        raise FileExistsError(f"output already exists: {path}; use a different path or --overwrite") from exc
    finally:
        temp_path.unlink(missing_ok=True)


def main():
    parser = get_parser()
    args = parser.parse_args()
    outputs, count, delays = validate(args, parser)
    width, height = args.size
    print(f"Rendering {count} frames at {width}x{height} ({args.duration:g} s per loop)...", flush=True)
    try:
        frames = render_frames(args, count)
        for path in outputs:
            fmt = FORMATS[path.suffix.lower()]
            export(frames, path, fmt, delays[fmt], args, overwrite=args.overwrite)
            print(f"Saved {path} ({path.stat().st_size / 1024:.0f} KiB)")
    except (OSError, RuntimeError, ValueError, PlaywrightError) as exc:
        parser.exit(1, f"error: {exc}\n")


if __name__ == "__main__":
    # Keep redirected output usable even when its encoding cannot represent a filename.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="backslashreplace")
    main()
