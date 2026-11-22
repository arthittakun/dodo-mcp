"""Platform-ready exports for Gift loops.

Every target receives already-rendered RGBA frames and a timing plan. Besides the
classic GIF, WebP and APNG files this covers transparent WebM, MP4, game sprite
sheets, and stickers that meet the LINE Creators Market and Telegram rules.
"""

from dataclasses import dataclass, field
import json
from math import ceil, sqrt
from pathlib import Path

from PIL import Image

import animate
from smooth import downscale
from video_export import H264_ARGS, encode_video, vp9_args


TARGETS = {
    "gif": ".gif", "webp": ".webp", "apng": ".png", "png": ".png",
    "webm": ".webm", "mp4": ".mp4", "spritesheet": ".png",
    "line": ".png", "telegram": ".webm",
}
ANIMATED_IMAGES = {"gif": "GIF", "webp": "WEBP", "apng": "PNG", "png": "PNG"}

# LINE Creators Market, animated stickers (creator.line.me/en/guideline/animationsticker/).
LINE_MAX_SIZE = (320, 270)
LINE_MIN_SIDE = 270
LINE_FRAMES = (5, 20)
LINE_SECONDS = (1, 2, 3, 4)
LINE_MAX_TOTAL_SECONDS = 4
LINE_MAX_BYTES = 1_000_000  # "1 MB"; the decimal reading is the safe one.
# Telegram video stickers (core.telegram.org/stickers).
TELEGRAM_SIDE = 512
TELEGRAM_MAX_SECONDS = 3
TELEGRAM_MAX_FPS = 30
TELEGRAM_MAX_BYTES = 256 * 1024
WEBM_CRF_LADDER = (30, 36, 42, 48, 54, 60, 63)
SHEET_MAX_SIDE = 8192
SHEET_SPACING = 2
MATTE_ALPHA = 48


@dataclass
class Plan:
    """How many frames to render for a target, and how long each one shows."""

    target: str
    count: int
    delays: list[int]
    fps: int
    loops: int = 0
    notes: list[str] = field(default_factory=list)

    @property
    def duration_ms(self):
        return sum(self.delays)


@dataclass
class Exported:
    path: Path
    format: str
    width: int
    height: int
    frames: int
    duration_ms: int
    bytes: int
    loops: int = 0
    companions: list[Path] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class Options:
    quality: int = 86
    lossless: bool = False
    gif_dither: bool = False
    gif_alpha_threshold: int = 128
    edge_matte: str | None = None
    background: str = "#FFFFFF"
    sheet_columns: int | None = None


def plan(target: str, duration: float, fps: int, *, loops: int | None = None) -> Plan:
    """Choose the frame count and per-frame delays that satisfy a target's rules."""
    if target not in TARGETS:
        raise ValueError(f"Unsupported export target {target!r}.")
    notes = []
    if target == "line":
        seconds = min(LINE_SECONDS, key=lambda value: abs(value - duration))
        if abs(seconds - duration) > 1e-6:
            notes.append(f"LINE accepts whole-second loops, so the playback time is {seconds} s.")
        wanted = round(seconds * fps)
        count = min(LINE_FRAMES[1], max(LINE_FRAMES[0], wanted))
        if count != wanted:
            notes.append(f"LINE allows {LINE_FRAMES[0]}–{LINE_FRAMES[1]} frames, so this sticker uses {count}.")
        plays = LINE_MAX_TOTAL_SECONDS // seconds if loops is None else loops
        if not 1 <= plays <= 4 or plays * seconds > LINE_MAX_TOTAL_SECONDS:
            raise ValueError(f"LINE allows 1–4 plays and at most {LINE_MAX_TOTAL_SECONDS} s in total; "
                             f"a {seconds} s sticker can play at most {LINE_MAX_TOTAL_SECONDS // seconds} times.")
        delays = animate.frame_delays(seconds, count, 10)
        return Plan(target, count, delays, round(count / seconds), plays, notes)

    if target == "telegram":
        if duration > TELEGRAM_MAX_SECONDS + 1e-6:
            raise ValueError(f"Telegram video stickers last at most {TELEGRAM_MAX_SECONDS} seconds. Shorten the loop.")
        if fps > TELEGRAM_MAX_FPS:
            notes.append(f"Telegram allows at most {TELEGRAM_MAX_FPS} FPS, so the sticker uses {TELEGRAM_MAX_FPS}.")
            fps = TELEGRAM_MAX_FPS

    count = round(duration * fps)
    if count < 2:
        raise ValueError("Use a duration and frame rate that give at least two frames.")
    if loops not in (None, 0) and target not in ("apng", "png", "webp"):
        raise ValueError("A fixed play count applies to WebP, APNG, and LINE stickers only; the others loop forever.")
    quantum = 10 if target == "gif" else 1
    delays = animate.frame_delays(duration, count, quantum)
    if target == "gif":
        if min(delays) < 20:
            raise ValueError("GIF frames need at least 20 ms each; use 50 FPS or less.")
        if len(set(delays)) > 1:
            notes.append(
                f"GIF stores time in 10 ms steps, so frames alternate {sorted(set(delays))} ms. "
                "Use 20, 25 or 50 FPS for perfectly even timing."
            )
    return Plan(target, count, delays, fps, loops or 0, notes)


def plan_fixed(target: str, delays: list[int]) -> tuple[Plan, list[int]]:
    """Plan an export for already-drawn poses with their own delays (such as a sprite sheet).

    Returns the plan and, for each output frame, the index of the source pose it shows.
    """
    count, total = len(delays), sum(delays)
    if target in ANIMATED_IMAGES or target == "spritesheet":
        return Plan(target, count, list(delays), max(1, round(count * 1000 / total))), list(range(count))
    if target == "line":
        if not LINE_FRAMES[0] <= count <= LINE_FRAMES[1]:
            raise ValueError(f"LINE needs {LINE_FRAMES[0]}–{LINE_FRAMES[1]} frames; this animation has {count}.")
        line_plan = plan("line", total / 1000, 25)
        line_plan.count = count
        line_plan.fps = max(1, round(count * 1000 / line_plan.duration_ms))
        line_plan.notes = [note for note in line_plan.notes if "frames" not in note]
        # Keep each pose's share of the loop, rescaled to whole LINE seconds in 10 ms steps.
        target_ms = line_plan.duration_ms
        ticks = target_ms // 10
        marks = [0]
        elapsed = 0
        for delay in delays:
            elapsed += delay
            marks.append(round(elapsed * ticks / total))
        scaled = [10 * max(1, end - start) for start, end in zip(marks, marks[1:])]
        scaled[-1] += target_ms - sum(scaled)
        if scaled[-1] < 10:
            raise ValueError("The poses are too uneven to fit LINE's whole-second timing.")
        line_plan.delays = scaled
        return line_plan, list(range(count))
    fps = TELEGRAM_MAX_FPS if target == "telegram" else 25
    video_plan = plan(target, total / 1000, fps)
    starts, elapsed = [], 0
    for delay in delays:
        starts.append(elapsed)
        elapsed += delay
    indices = []
    for frame in range(video_plan.count):
        moment = frame * total / video_plan.count
        indices.append(max(index for index, start in enumerate(starts) if start <= moment))
    return video_plan, indices


def export(frames, plan: Plan, path: Path, options: Options | None = None) -> Exported:
    """Write `frames` for `plan.target` at `path` (and any companion file) and describe the result."""
    options = options or Options()
    frames = [frame if frame.mode == "RGBA" else frame.convert("RGBA") for frame in frames]
    if len(frames) != plan.count:
        raise ValueError("The rendered frame count does not match the export plan.")
    if len({frame.size for frame in frames}) != 1:
        raise ValueError("Every exported frame must use the same canvas size.")
    target = plan.target
    if target in ANIMATED_IMAGES:
        return _animated_image(frames, plan, path, options)
    if target == "webm":
        return _webm(frames, plan, path, notes=list(plan.notes))
    if target == "mp4":
        return _mp4(frames, plan, path, options)
    if target == "spritesheet":
        return _spritesheet(frames, plan, path, options)
    if target == "line":
        return _line(frames, plan, path)
    return _telegram(frames, plan, path)


def companion_paths(target: str, path: Path) -> list[Path]:
    """Extra files a target writes next to its main output."""
    return [path.with_suffix(".json")] if target == "spritesheet" else []


def _parser_options(options):
    args = animate.get_parser().parse_args([])
    args.quality, args.lossless = options.quality, options.lossless
    args.gif_dither, args.gif_alpha_threshold = options.gif_dither, options.gif_alpha_threshold
    return args


def apply_matte(frames, color):
    """Blend soft GIF edges onto the page color they will be shown on, so they stay smooth."""
    rgb = tuple(int(color[index:index + 2], 16) for index in (1, 3, 5))
    cutoff = [0] * MATTE_ALPHA + [255] * (256 - MATTE_ALPHA)
    result = []
    for frame in frames:
        flattened = Image.new("RGBA", frame.size, (*rgb, 255))
        flattened.alpha_composite(frame)
        flattened.putalpha(frame.getchannel("A").point(cutoff))
        result.append(flattened)
    return result


def _describe(path, fmt, plan, *, loops=None, companions=(), notes=()):
    with Image.open(path) as result:
        return Exported(
            path=path, format=fmt, width=result.width, height=result.height,
            frames=getattr(result, "n_frames", 1), duration_ms=plan.duration_ms,
            bytes=path.stat().st_size, loops=plan.loops if loops is None else loops,
            companions=list(companions), notes=list(notes),
        )


def _animated_image(frames, plan, path, options):
    encoder = ANIMATED_IMAGES[plan.target]
    notes = list(plan.notes)
    if encoder == "GIF" and options.edge_matte:
        frames = apply_matte(frames, options.edge_matte)
        notes.append(f"Soft edges are blended onto {options.edge_matte} for display on that background.")
    args = _parser_options(options)
    if plan.loops:
        _save_counted_loop(frames, path, encoder, plan.delays, args, plan.loops)
    else:
        animate.export(frames, path, encoder, plan.delays, args)
    fmt = "apng" if encoder == "PNG" else plan.target
    return _describe(path, fmt, plan, notes=notes)


def _save_counted_loop(frames, path, encoder, delays, args, plays):
    """Like animate.export, but with a fixed number of plays instead of an infinite loop."""
    from tempfile import NamedTemporaryFile
    from PIL import PngImagePlugin

    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=path.parent, suffix=path.suffix, delete=False) as file:
        temporary = Path(file.name)
    try:
        # GIF and WebP count repeats after the first play; APNG counts total plays.
        loop = plays if encoder == "PNG" else plays - 1
        if loop == 0 and encoder != "PNG":
            # A loop value of 0 means "forever" for GIF and WebP; omit it to play once.
            loop = None
        shared = {"save_all": True, "append_images": frames[1:], "duration": delays}
        if loop is not None:
            shared["loop"] = loop
        if encoder == "PNG":
            frames[0].save(temporary, format="PNG", **shared,
                           disposal=PngImagePlugin.Disposal.OP_NONE, blend=PngImagePlugin.Blend.OP_SOURCE)
        elif encoder == "WEBP":
            frames[0].save(temporary, format="WEBP", **shared, quality=args.quality, lossless=args.lossless,
                           alpha_quality=100, method=4, minimize_size=True)
        else:
            raise ValueError("A fixed play count for GIF is not supported; GIF loops forever.")
        animate.publish_output(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _even_canvas(frame):
    width, height = frame.size
    if width % 2 == 0 and height % 2 == 0:
        return frame
    canvas = Image.new(frame.mode, (width + width % 2, height + height % 2))
    canvas.paste(frame, (0, 0))
    return canvas


def _webm(frames, plan, path, *, max_bytes=None, notes=None, fmt="webm"):
    notes = list(notes or [])
    frames = [_even_canvas(frame) for frame in frames]
    fps = plan.fps
    attempts = [(crf, fps, frames) for crf in WEBM_CRF_LADDER] if max_bytes else [(WEBM_CRF_LADDER[0], fps, frames)]
    if max_bytes and fps >= 20 and fps % 2 == 0 and len(frames) % 2 == 0:
        halved = frames[::2]
        attempts += [(crf, fps // 2, halved) for crf in WEBM_CRF_LADDER[2:]]
    for index, (crf, rate, sequence) in enumerate(attempts):
        overwrite = index > 0
        encode_video(sequence, path, rate, mode="RGBA", codec_args=vp9_args(crf), overwrite=overwrite)
        size = path.stat().st_size
        if not max_bytes or size <= max_bytes:
            if rate != fps:
                notes.append(f"Reduced to {rate} FPS to fit {max_bytes // 1024} KB.")
            if max_bytes and crf != WEBM_CRF_LADDER[0]:
                notes.append(f"Encoded at VP9 CRF {crf} to fit {max_bytes // 1024} KB.")
            width, height = sequence[0].size
            return Exported(path=path, format=fmt, width=width, height=height, frames=len(sequence),
                            duration_ms=plan.duration_ms, bytes=size, loops=0, notes=notes)
    path.unlink(missing_ok=True)
    raise ValueError(f"Could not fit the WebM within {max_bytes // 1024} KB. Use a shorter loop or simpler artwork.")


def _mp4(frames, plan, path, options):
    color = options.background or "#FFFFFF"
    rgb = tuple(int(color[index:index + 2], 16) for index in (1, 3, 5))
    flat = []
    for frame in frames:
        canvas = Image.new("RGBA", frame.size, (*rgb, 255))
        canvas.alpha_composite(frame)
        flat.append(canvas.convert("RGB"))
    encode_video(flat, path, plan.fps, mode="RGB", codec_args=H264_ARGS)
    width, height = flat[0].width + flat[0].width % 2, flat[0].height + flat[0].height % 2
    notes = [*plan.notes, f"MP4 has no transparency, so the background is {color}."]
    return Exported(path=path, format="mp4", width=width, height=height, frames=len(flat),
                    duration_ms=plan.duration_ms, bytes=path.stat().st_size, notes=notes)


def _spritesheet(frames, plan, path, options):
    count = len(frames)
    columns = options.sheet_columns or ceil(sqrt(count))
    columns = max(1, min(count, columns))
    rows = ceil(count / columns)
    width, height = frames[0].size
    sheet_width = columns * width + (columns - 1) * SHEET_SPACING
    sheet_height = rows * height + (rows - 1) * SHEET_SPACING
    notes = list(plan.notes)
    scale = min(1, SHEET_MAX_SIDE / max(sheet_width, sheet_height))
    if scale < 1:
        width, height = max(1, int(width * scale)), max(1, int(height * scale))
        frames = [downscale(frame, (width, height)) for frame in frames]
        sheet_width = columns * width + (columns - 1) * SHEET_SPACING
        sheet_height = rows * height + (rows - 1) * SHEET_SPACING
        notes.append(f"Frames were scaled to {width}×{height} to keep the sheet within {SHEET_MAX_SIDE} px.")
    sheet = Image.new("RGBA", (sheet_width, sheet_height))
    entries = []
    for index, (frame, delay) in enumerate(zip(frames, plan.delays)):
        x = (index % columns) * (width + SHEET_SPACING)
        y = (index // columns) * (height + SHEET_SPACING)
        sheet.paste(frame, (x, y))
        entries.append({
            "filename": f"{path.stem} {index}", "frame": {"x": x, "y": y, "w": width, "h": height},
            "rotated": False, "trimmed": False,
            "spriteSourceSize": {"x": 0, "y": 0, "w": width, "h": height},
            "sourceSize": {"w": width, "h": height}, "duration": delay,
        })
    # Aseprite-compatible "array" JSON, which Phaser, Godot importers and others read.
    atlas = {
        "frames": entries,
        "meta": {
            "app": "Gift", "version": "1", "image": path.name, "format": "RGBA8888",
            "size": {"w": sheet_width, "h": sheet_height}, "scale": "1",
            "frameTags": [{"name": "loop", "from": 0, "to": count - 1, "direction": "forward"}],
        },
    }
    json_path = path.with_suffix(".json")
    if json_path.exists() or json_path.is_symlink():
        raise FileExistsError(f"{json_path.name} already exists. Choose a new file name.")
    from tempfile import NamedTemporaryFile

    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=path.parent, suffix=".png", delete=False) as file:
        temporary = Path(file.name)
    try:
        sheet.save(temporary, format="PNG", optimize=True)
        animate.publish_output(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    try:
        with json_path.open("x", encoding="utf-8") as stream:
            json.dump(atlas, stream, ensure_ascii=False, indent=1)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    notes.append(f"{columns}×{rows} grid with {SHEET_SPACING} px spacing; per-frame durations are in the JSON.")
    return Exported(path=path, format="spritesheet", width=sheet_width, height=sheet_height, frames=count,
                    duration_ms=plan.duration_ms, bytes=path.stat().st_size, companions=[json_path], notes=notes)


def _union_box(frames):
    union = None
    for frame in frames:
        box = frame.getbbox(alpha_only=True)
        if box is None:
            continue
        union = box if union is None else (min(union[0], box[0]), min(union[1], box[1]),
                                           max(union[2], box[2]), max(union[3], box[3]))
    if union is None:
        raise ValueError("Every frame is fully transparent. Choose a visible subject.")
    return union


def _fit_frames(frames, max_width, max_height):
    """Trim to the visible area shared by the loop, then scale to fill the allowed box."""
    box = _union_box(frames)
    cropped = [frame.crop(box) for frame in frames]
    width, height = cropped[0].size
    scale = min(max_width / width, max_height / height)
    size = max(1, min(max_width, round(width * scale))), max(1, min(max_height, round(height * scale)))
    return [downscale(frame, size) if frame.size != size else frame for frame in cropped]


def _line(frames, plan, path):
    if not LINE_FRAMES[0] <= len(frames) <= LINE_FRAMES[1]:
        raise ValueError(f"LINE stickers need {LINE_FRAMES[0]}–{LINE_FRAMES[1]} frames.")
    fitted = _fit_frames(frames, *LINE_MAX_SIZE)
    width, height = fitted[0].size
    if max(width, height) < LINE_MIN_SIDE and not (width == LINE_MAX_SIZE[0] or height == LINE_MAX_SIZE[1]):
        raise ValueError("LINE needs the sticker's width or height to be at least 270 px.")
    if len({frame.tobytes() for frame in fitted}) == 1:
        raise ValueError("LINE rejects stickers whose frames are all identical. Choose a visible motion.")
    args = animate.get_parser().parse_args([])
    _save_counted_loop(fitted, path, "PNG", plan.delays, args, plan.loops)
    result = _describe(path, "line", plan)
    palette_note = None
    if result.bytes > LINE_MAX_BYTES:
        # Flat cartoon colors survive a shared 256-color palette with alpha almost unchanged.
        path.unlink(missing_ok=True)
        _save_counted_loop(_shared_palette(fitted), path, "PNG", plan.delays, args, plan.loops)
        result = _describe(path, "line", plan)
        palette_note = "Saved with a shared 256-color palette (with transparency) to stay under 1 MB."
    problems = []
    if result.bytes > LINE_MAX_BYTES:
        problems.append(f"the file is {result.bytes / 1024:.0f} KB (LINE allows 1 MB)")
    if not LINE_FRAMES[0] <= result.frames <= LINE_FRAMES[1]:
        problems.append(f"identical neighbouring frames merged into {result.frames} frames")
    if problems:
        path.unlink(missing_ok=True)
        raise ValueError("The LINE sticker does not meet the guidelines: " + "; ".join(problems)
                         + ". Use more varied motion, fewer frames, or simpler artwork.")
    seconds = plan.duration_ms // 1000
    result.notes = [*plan.notes, *([palette_note] if palette_note else []),
                    f"LINE animated sticker: {width}×{height} APNG, {result.frames} frames, {seconds} s, "
                    f"plays {plan.loops}× ({seconds * plan.loops} s total), {result.bytes / 1024:.0f} KB."]
    return result


def _shared_palette(frames):
    """Quantize all frames together so they share one palette, as APNG requires."""
    width, height = frames[0].size
    strip = Image.new("RGBA", (width, height * len(frames)))
    for index, frame in enumerate(frames):
        strip.paste(frame, (0, index * height))
    # No dithering: dithered alpha turns soft outlines into speckles.
    indexed = strip.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    return [indexed.crop((0, index * height, width, (index + 1) * height)) for index in range(len(frames))]


def _telegram(frames, plan, path):
    fitted = _fit_frames(frames, TELEGRAM_SIDE, TELEGRAM_SIDE)
    result = _webm(fitted, plan, path, max_bytes=TELEGRAM_MAX_BYTES, notes=plan.notes, fmt="telegram")
    result.notes.append(
        f"Telegram video sticker: {result.width}×{result.height} VP9 WebM with transparency, no audio, "
        f"{plan.duration_ms / 1000:g} s, {result.bytes / 1024:.0f} KB."
    )
    return result
