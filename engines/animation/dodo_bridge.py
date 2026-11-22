"""DODO MCP bridge to the vendored Gift animation engine.

Run only by DODO's animation worker inside an owned, private job directory:

    python -I -B -X utf8 dodo_bridge.py <job>/spec.json

The spec never names arbitrary paths: the optional source image is always <job>/source.bin and
every output has a fixed name inside the job directory. Expected input problems are reported as
{"error": ...} in result.json with exit code 0, so DODO can relay them; anything else exits 1.
"""

from io import BytesIO
import json
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parent
# Isolated mode (-I) does not put the script directory on sys.path, so add the engine explicitly.
sys.path.insert(0, str(ENGINE))

from PIL import Image, ImageDraw  # noqa: E402
from pydantic import ValidationError  # noqa: E402

import animate  # noqa: E402
from caption import CaptionSpec  # noqa: E402
import exporters  # noqa: E402
from image_animation import MAX_IMAGE_SIDE, MOTIONS, load_still, make_frames  # noqa: E402
from rig_animation import RigSpec  # noqa: E402
from rig_presets import PRESETS, preset_rig  # noqa: E402

VERSION = 1
MAX_SOURCE_BYTES = 16 * 1024 * 1024
RIG_BLUR_SAMPLES = 3
EFFECT_BLUR_SAMPLES = 4
# Stable face boxes for the bundled characters, used to check that the body does not drift.
CORE_BOXES = {"orange_cat": (0.26, 0.19, 0.62, 0.45), "fox_girl": (0.44, 0.29, 0.67, 0.42)}
MIME = {
    "gif": "image/gif", "webp": "image/webp", "apng": "image/png", "png": "image/png", "line": "image/png",
    "spritesheet": "image/png", "webm": "video/webm", "telegram": "video/webm", "mp4": "video/mp4",
}
OUTPUT_SUFFIX = {"gif": ".gif", "webp": ".webp", "webm": ".webm", "telegram": ".webm", "mp4": ".mp4"}


class InputProblem(ValueError):
    """A request the engine cannot render; the message is shown to the user."""


def read_source(directory, *, max_side=MAX_IMAGE_SIDE):
    path = directory / "source.bin"
    if not path.is_file() or path.is_symlink():
        raise InputProblem("This operation needs a source image.")
    data = path.read_bytes()
    if not data or len(data) > MAX_SOURCE_BYTES:
        raise InputProblem("Use a source image between 1 byte and 16 MiB.")
    image = load_still(data, max_side=max_side)
    if not image.getbbox(alpha_only=True):
        raise InputProblem("This image is fully transparent. Choose a visible subject.")
    return image


def caption_spec(value):
    if value is None:
        return None
    if "font_path" in value:
        raise InputProblem("Captions use the bundled Sarabun font; font_path is not accepted.")
    return CaptionSpec.model_validate(value)


def export_options(params):
    return exporters.Options(
        quality=params.get("quality", 86), lossless=params.get("lossless", False),
        gif_dither=params.get("gif_dither", False), edge_matte=params.get("edge_matte"),
        background=params.get("background", "#FFFFFF"),
    )


def blur_samples(motion_blur, target, samples, *, count=None, travels=False):
    """Motion blur is on by default for LINE stickers, except whole-body jumps (it reads as ghosting)."""
    enabled = (target == "line" and not travels) if motion_blur is None else motion_blur
    if not enabled:
        return 1
    if count:
        samples = max(samples, min(5, -(-100 // count)))
    return samples


def contact_sheet(frames, path):
    """Six evenly spaced frames on a light page, so a chat client can judge the motion at a glance."""
    count = len(frames)
    picks = sorted({round(index * (count - 1) / 5) for index in range(6)})
    sheet = Image.new("RGB", (660, 420), "#e8eef6")
    draw = ImageDraw.Draw(sheet)
    for cell, index in enumerate(picks):
        x, y = (cell % 3) * 220, (cell // 3) * 210
        thumb = frames[index].convert("RGBA")
        thumb.thumbnail((210, 182), Image.Resampling.LANCZOS)
        sheet.paste(thumb, (x + (220 - thumb.width) // 2, y + 20), thumb)
        draw.text((x + 10, y + 6), f"frame {index + 1}/{count}", fill="#253448")
    sheet.save(path, format="PNG", optimize=True)


def deliver(directory, frames, plan, params):
    max_side = params.get("max_side")
    if max_side is not None and max(frames[0].size) > max_side:
        from smooth import downscale

        # Premultiplied resampling keeps soft edges clean; captions are sized after this.
        scale = max_side / max(frames[0].size)
        size = max(1, round(frames[0].width * scale)), max(1, round(frames[0].height * scale))
        frames = [downscale(frame, size) for frame in frames]
    caption = caption_spec(params.get("caption"))
    if caption is not None:
        from caption import caption_frames

        frames = caption_frames(frames, caption)
    target = plan.target
    path = directory / f"animation{OUTPUT_SUFFIX.get(target, '.png')}"
    result = exporters.export(frames, plan, path, export_options(params))
    contact_sheet(frames, directory / "preview.png")
    return {
        "animation": {
            "file": result.path.name, "mimeType": MIME[target], "format": result.format,
            "width": result.width, "height": result.height, "frames": result.frames,
            "durationMs": result.duration_ms, "bytes": result.bytes, "loops": result.loops,
        },
        "companions": [{"file": item.name, "mimeType": "application/json"} for item in result.companions],
        "preview": {"file": "preview.png"},
        "notes": list(result.notes),
    }


def render_image(directory, params):
    actions = params["actions"]
    if len(set(actions)) != len(actions):
        raise InputProblem("List each action once.")
    character_motion = set(actions) <= {"blink", "wave"}
    if not character_motion and (len(actions) != 1 or actions[0] not in MOTIONS):
        raise InputProblem("Combine blink with wave, or select a single image effect.")
    eyes, arm = params.get("eyes"), params.get("arm")
    if (eyes and "blink" not in actions) or (arm and "wave" not in actions):
        raise InputProblem("Eye landmarks are for blink; arm landmarks are for wave.")
    strength = params.get("strength", 1.0)
    if not character_motion and strength != 1.0:
        raise InputProblem("strength applies to blink and wave.")
    target = params["format"]
    plan = exporters.plan(target, params["duration"], params["fps"], loops=params.get("loops"))
    image = read_source(directory)
    if plan.count * image.width * image.height > animate.MAX_PIXELS:
        raise InputProblem("The image and frame count are too large. Reduce FPS or duration.")
    if character_motion:
        from character_animation import character_frames

        frames = character_frames(image, actions, plan.count, eyes=eyes, arm=arm, strength=strength)
    else:
        samples = blur_samples(params.get("motion_blur"), target, EFFECT_BLUR_SAMPLES)
        frames = make_frames(image, actions[0], plan.count, motion_blur=samples)
    return deliver(directory, frames, plan, params)


def seam_check(source, rig):
    from rig_animation import SEAM_WARNING, seam_report

    report = seam_report(source, rig)
    worst = sorted(((ratio, name) for name, ratio in report.items() if ratio > SEAM_WARNING), reverse=True)
    metrics = {"parts": report, "limit": SEAM_WARNING}
    if not worst:
        return {"id": "part_seams", "status": "pass", "metrics": metrics,
                "detail": "Every part is cut along its line art, so nothing tears away as it moves."}
    names = ", ".join(f"{name} ({ratio:.0%})" for ratio, name in worst)
    return {"id": "part_seams", "status": "fail", "metrics": metrics,
            "detail": f"Outlines of {names} cut through the part's own paint, leaving a sliver on the body that "
                      "tears as it moves. Add seeds inside those parts (or trace their outlines along the line art)."}


def review_rig(directory, frames, rig, duration, body_core, seams):
    """Gift's loop review: seamless loop, body drift, limbs attached, part seams and foot lock."""
    from loop_review import review_loop

    travels = rig.body is not None and rig.body.style == "jump"
    report = review_loop(frames, core_box=None if travels else body_core,
                         joints={} if travels else {part.name: part.root for part in rig.parts},
                         expect_travel=travels)
    checks = list(report["checks"])
    checks.append(seams)
    if any(part.foot_ik is not None for part in rig.parts):
        from foot_lock_review import review_foot_lock

        delays = animate.frame_delays(duration, len(frames), 10)
        draft = directory / "review-draft.gif"
        animate.export(frames, draft, "GIF", delays, animate.get_parser().parse_args([]))
        checks.append(review_foot_lock(draft, rig, delays))
        draft.unlink(missing_ok=True)
    return checks, all(check["status"] != "fail" for check in checks)


def render_rig(directory, params):
    from rig_animation import pad_for_swing, render_rig_frames

    preset, custom = params.get("preset"), params.get("rig")
    if (preset is None) == (custom is None):
        raise InputProblem("Choose one bundled preset or provide one custom rig.")
    body_core = params.get("body_core")
    has_source = (directory / "source.bin").is_file()
    if preset is not None:
        if preset not in PRESETS:
            raise InputProblem(f"Unknown preset {preset!r}.")
        rig, character_image, character = preset_rig(preset)
        body_core = body_core or CORE_BOXES[character]
        source = read_source(directory, max_side=2 * MAX_IMAGE_SIDE) if has_source else load_still(
            character_image.read_bytes(), max_side=2 * MAX_IMAGE_SIDE)
    else:
        rig = RigSpec.model_validate(custom)
        source = read_source(directory, max_side=2 * MAX_IMAGE_SIDE)
    target = params["format"]
    plan = exporters.plan(target, params["duration"], params["fps"], loops=params.get("loops"))
    if has_source:
        # Generated art often puts ears, tails or hands at the edge: give swinging parts room.
        source, rig, remap = pad_for_swing(source, rig, duration=plan.duration_ms / 1000)
        if body_core is not None:
            body_core = (*remap(body_core[:2]), *remap(body_core[2:]))
    travels = rig.body is not None and rig.body.style == "jump"
    seams = seam_check(source, rig)
    frames = render_rig_frames(
        source, rig, plan.count, antialias=params.get("antialias", True),
        motion_blur=blur_samples(params.get("motion_blur"), target, RIG_BLUR_SAMPLES, count=plan.count, travels=travels),
        duration=plan.duration_ms / 1000,
    )
    delivered = deliver(directory, frames, plan, params)
    checks, passed = review_rig(directory, frames, rig, plan.duration_ms / 1000, body_core, seams)
    delivered["checks"], delivered["passed"] = checks, passed
    if seams["status"] == "fail":
        delivered["notes"].append(seams["detail"])
    return delivered


def render_sprite(directory, params):
    from hashlib import blake2b

    from sprite_animation import load_sprite_frames

    path = directory / "source.bin"
    if not path.is_file() or path.is_symlink():
        raise InputProblem("Provide the transparent pose sheet as the source image.")
    data = path.read_bytes()
    if not data or len(data) > MAX_SOURCE_BYTES:
        raise InputProblem("The sprite sheet must be an image of up to 16 MiB.")
    poses, motion = params["poses"], params["motion"]
    layout = params.get("layout")
    checks, passed = [], None
    if layout is not None:
        # A sheet drawn from an animation_frames_plan guide: check it against that layout first.
        from pose_sheet import SIZE_TOLERANCE, review_pose_sheet

        if layout.get("poses") != poses:
            raise InputProblem("The layout is for a different number of poses than this request.")
        reference_path = directory / "reference.bin"
        reference = load_still(reference_path.read_bytes(), max_side=1600) if reference_path.is_file() else None
        sheet = Image.open(BytesIO(data))
        sheet.load()
        checks, passed = review_pose_sheet(sheet, layout, motion, reference=reference)
    # Small size drift between generated cells plays as pulsing; a jump's crouch is intentional.
    equalize = 0.0 if layout is None or motion == "jump" else SIZE_TOLERANCE.get(motion, 0.12)
    grounds = None
    if layout is not None and motion == "jump":
        # Align to each row's measured ground line so airborne poses keep their height.
        from pose_sheet import cell_grounds, sheet_figures

        figures, scale = sheet_figures(sheet, layout)
        grounds = cell_grounds(figures, layout, motion, scale)
    frames = load_sprite_frames(data, columns=4, rows=poses // 4, equalize=equalize, grounds=grounds)
    if len({blake2b(frame.tobytes(), digest_size=16).digest() for frame in frames}) < len(frames) // 2:
        raise InputProblem("The sheet repeats too many identical poses. Supply distinct stages of the action.")
    duration_ms = 10 * round(100 * (params.get("duration") or (1.0 if motion == "walk" else 1.6)))
    if motion == "walk" and poses == 8:
        # Contact and passing poses hold a little longer than the in-betweens.
        ticks = [round(duration_ms * mark / 1000) for mark in (0, 14, 28, 41, 50, 64, 78, 91, 100)]
        delays = [10 * (end - start) for start, end in zip(ticks, ticks[1:])]
    else:
        delays = animate.frame_delays(duration_ms / 1000, len(frames), 10)
    plan, indices = exporters.plan_fixed(params["format"], delays)
    delivered = deliver(directory, [frames[index] for index in indices], plan, params)
    if layout is not None:
        delivered["checks"], delivered["passed"] = checks, passed
        if not passed:
            failed = [check["detail"] for check in checks if check["status"] == "fail" and not check["metrics"]["advisory"]]
            delivered["notes"].append("The generated sheet missed some conditions: " + " ".join(failed))
    return delivered


def plan_frames(directory, params):
    """Lay out a pose sheet for an image model: guide, edit mask, prompt and layout (no rendering)."""
    from pose_sheet import build_pose_guide, guide_preview, pose_prompt

    poses, motion = params["poses"], params["motion"]
    prompt = pose_prompt(motion, poses, params.get("custom"))
    reference = read_source(directory, max_side=1600)
    guide, mask, layout = build_pose_guide(reference, poses=poses, motion=motion)
    guide.save(directory / "guide.png", format="PNG", optimize=True)
    mask.save(directory / "mask.png", format="PNG", optimize=True)
    guide_preview(guide, mask).save(directory / "preview.png", format="PNG", optimize=True)
    return {
        "plan": {"prompt": prompt, "layout": layout, "size": f"{layout['sheet'][0]}x{layout['sheet'][1]}",
                 "guide": {"file": "guide.png"}, "mask": {"file": "mask.png"}},
        "preview": {"file": "preview.png"},
        "notes": [f"Cell 1 holds the character at the size and ground line every frame should use; "
                  f"the mask lets the model paint only inside the other {poses - 1} cells."],
    }


def render_banner(directory, params):
    """Gift's neon text banner, drawn with Pillow and HarfBuzz (no browser)."""
    from banner_render import render_banner_frames

    width, height = params["size"]
    target = params["format"]
    plan = exporters.plan(target, params["duration"], params["fps"], loops=params.get("loops"))
    if plan.count * width * height > animate.MAX_PIXELS:
        raise InputProblem("The banner is too large for this many frames. Reduce the size, FPS or duration.")
    frames = render_banner_frames(
        width=width, height=height, text=params.get("text", ""), label=params.get("label", ""),
        motion=params["motion"], background=params["banner_background"], accent=params["accent"],
        text_color=params["text_color"], strength=params.get("strength", 1.0), count=plan.count,
    )
    return deliver(directory, frames, plan, params)


SCENE_FILE = r"^(?:layer-[0-9]{1,2}|background)\.bin$"
MAX_SCENE_PIXELS = 100_000_000
SCENE_BLUR_SAMPLES = 3


def render_scene(directory, params):
    """A multi-layer scene: a background and up to 20 still or animated layers, or the Solar System."""
    import re

    from scene_animation import MAX_SCENE_FRAMES, SceneSpec, prepare_scene, save_scene_gif

    if params.get("preset") == "solar_system":
        from solar_scene import solar_scene

        width, height = params.get("size") or (960, 540)
        scene = solar_scene(width, height, guides=params.get("guides", True))
    else:
        data = dict(params["scene"])
        layers = []
        for layer in data.pop("layers"):
            layer = dict(layer)
            name = layer.pop("file")
            if not re.fullmatch(SCENE_FILE, name) or not (directory / name).is_file():
                raise InputProblem("Each scene layer needs its image.")
            layers.append({**layer, "image_path": str(directory / name)})
        background = data.pop("background_file", None)
        if background is not None:
            if not re.fullmatch(SCENE_FILE, background) or not (directory / background).is_file():
                raise InputProblem("The scene background image is missing.")
            data["background_image_path"] = str(directory / background)
        scene = SceneSpec.model_validate({**data, "layers": layers})
    target, fps = params["format"], params["fps"]
    count = round(params["duration"] * fps)
    if target == "mp4" and (scene.width % 2 or scene.height % 2):
        raise InputProblem("Use even canvas dimensions for MP4.")
    if target == "gif" and count > MAX_SCENE_FRAMES:
        raise InputProblem(f"GIF supports at most {MAX_SCENE_FRAMES} scene frames. Reduce duration or FPS.")
    samples = SCENE_BLUR_SAMPLES if params.get("motion_blur") else 1
    if scene.width * scene.height * count > MAX_SCENE_PIXELS:
        raise InputProblem("This scene exceeds the render budget. Reduce canvas size, duration, or FPS.")
    prepared = prepare_scene(scene).with_motion_blur(count, samples)
    path = directory / f"animation.{target}"
    seconds = count / fps
    if target == "mp4":
        from video_export import save_scene_mp4

        save_scene_mp4((prepared.frame(index / count) for index in range(count)), path, fps)
        duration_ms = round(seconds * 1000)
    else:
        delays = animate.frame_delays(seconds, count, 10)
        save_scene_gif(prepared, path, count, delays)
        duration_ms = sum(delays)
    contact_sheet([prepared.frame(index / 6) for index in range(6)], directory / "preview.png")
    return {
        "animation": {"file": path.name, "mimeType": "video/mp4" if target == "mp4" else "image/gif", "format": target,
                      "width": scene.width, "height": scene.height, "frames": count, "durationMs": duration_ms,
                      "bytes": path.stat().st_size, "loops": 0},
        "preview": {"file": "preview.png"}, "notes": [],
    }


OPERATIONS = {"image": render_image, "rig": render_rig, "sprite": render_sprite, "plan": plan_frames,
              "banner": render_banner, "scene": render_scene}


def main(argv):
    if len(argv) != 2:
        raise SystemExit("usage: dodo_bridge.py <job>/spec.json")
    spec_path = Path(argv[1]).resolve()
    directory = spec_path.parent
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    if spec.get("version") != VERSION or spec.get("operation") not in OPERATIONS:
        raise SystemExit("unsupported animation spec")
    if Path(spec.get("directory", "")).resolve() != directory:
        raise SystemExit("spec directory mismatch")
    result = {"version": VERSION, "operation": spec["operation"], "error": None, "animation": None,
              "companions": [], "preview": None, "checks": [], "passed": None, "notes": [], "plan": None}
    try:
        result.update(OPERATIONS[spec["operation"]](directory, spec["params"]))
    except ValidationError as exc:
        result["error"] = "; ".join(f"{'.'.join(map(str, item['loc'])) or 'input'}: {item['msg']}"
                                    for item in exc.errors()[:8])
    except (InputProblem, ValueError, RuntimeError, OSError) as exc:
        result["error"] = str(exc).replace(str(directory), "<job>")[:1500]
    (directory / "result.json").write_text(json.dumps(result), encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv)
