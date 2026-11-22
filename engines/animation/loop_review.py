"""Measure loop continuity and transparent character integrity before publication."""

from collections.abc import Mapping
from math import ceil, floor
from statistics import median

from PIL import Image, ImageChops, ImageFilter, ImageOps, ImageStat

from character_animation import _components


MAX_SAMPLES = 240
ANALYSIS_SIDE = 192
FOREGROUND_ALPHA = 128
DISCONNECTED_LIMIT = 0.035
ROOT_SHIFT_LIMIT = 0.018
ROOT_ERROR_LIMIT = 0.16
JOINT_MIN_COVERAGE = 0.7
SEAM_DELTA_FLOOR = 0.006
SEAM_ADJACENT_MULTIPLIER = 1.65
MASK_LUT = [0] * FOREGROUND_ALPHA + [255] * (256 - FOREGROUND_ALPHA)


def _check(identifier, status, detail, **metrics):
    return {"id": identifier, "status": status, "detail": detail, "metrics": metrics}


def _normalized(value, length, label):
    if (not isinstance(value, (list, tuple)) or len(value) != length
            or any(type(number) not in (int, float) or not 0 <= number <= 1 for number in value)):
        raise ValueError(f"{label} needs {length} normalized coordinates between 0 and 1.")
    return tuple(value)


def _joint_positions(joints, size):
    width, height = size
    pixels = {}
    for name, value in joints.items():
        x, y = _normalized(value, 2, f"Joint {name}")
        pixels[name] = (round(x * (width - 1)), round(y * (height - 1)))
    return pixels


def _read_samples(frames, joints):
    # Hold only small copies even when a decoder yields full-size frames on demand.
    size = None
    previews = []
    joint_samples = {name: [] for name in joints}
    for frame in frames:
        if len(previews) == MAX_SAMPLES:
            raise ValueError(f"Review at most {MAX_SAMPLES} frames at once.")
        if not isinstance(frame, Image.Image):
            raise ValueError("Every review frame must be a Pillow image.")
        if size is None:
            size = frame.size
            width, height = size
            if min(size) < 2:
                raise ValueError("Review frames need at least two pixels on both axes.")
            positions = _joint_positions(joints, size)
            radius = max(1, round(0.012 * min(size)))
            scale = min(1, ANALYSIS_SIDE / max(size))
            sample_size = max(1, round(width * scale)), max(1, round(height * scale))
        elif frame.size != size:
            raise ValueError("Every review frame must use the same canvas size.")

        rgba = frame if frame.mode == "RGBA" else frame.convert("RGBA")
        previews.append(rgba.resize(sample_size, Image.Resampling.LANCZOS))
        if joints:
            alpha = rgba.getchannel("A")
            for name, (x, y) in positions.items():
                region = (max(0, x - radius), max(0, y - radius), min(width, x + radius + 1), min(height, y + radius + 1))
                window = alpha.crop(region)
                covered = sum(window.histogram()[FOREGROUND_ALPHA:]) / (window.width * window.height)
                joint_samples[name].append((covered, alpha.getpixel((x, y)) >= FOREGROUND_ALPHA))
    if len(previews) < 2:
        raise ValueError("Review needs at least two ordered frames.")
    return size, previews, joint_samples, radius


def _transition(previous, following):
    delta = ImageStat.Stat(ImageChops.difference(previous, following)).sum
    visible = ImageChops.lighter(previous.getchannel("a"), following.getchannel("a"))
    area = ImageStat.Stat(visible).sum[0]
    return sum(delta) / (4 * area) if area else 0.0


def _seam(samples):
    signature = [sample.convert("RGBa") for sample in samples]
    interior = sorted(_transition(a, b) for a, b in zip(signature, signature[1:]))
    middle = median(interior)
    p90 = interior[ceil(0.9 * len(interior)) - 1]
    seam = _transition(signature[-1], signature[0])
    limit = max(SEAM_DELTA_FLOOR, p90 * SEAM_ADJACENT_MULTIPLIER)
    return _check(
        "loop_seam", "pass" if seam <= limit else "fail",
        "The closing frame change is within the range of the other transitions."
        if seam <= limit else "The closing frame changes substantially more than nearby frames.",
        seam_delta=round(seam, 6), median_adjacent_delta=round(middle, 6),
        p90_adjacent_delta=round(p90, 6), limit=round(limit, 6),
        delta_floor=SEAM_DELTA_FLOOR, adjacent_multiplier=SEAM_ADJACENT_MULTIPLIER,
    )


def _luminance(sample):
    alpha = sample.getchannel("A")
    return ImageChops.multiply(ImageOps.grayscale(sample), alpha), alpha


def _channel_error(a, b):
    return ImageStat.Stat(ImageChops.difference(a, b)).sum[0]


def _template(box, channels):
    gray, alpha = (channel.crop(box) for channel in channels)
    if min(gray.size) < 3:
        return None
    width, height = gray.size
    gradients = []
    for first, second in (((0, 0, width - 1, height), (1, 0, width, height)),
                          ((0, 0, width, height - 1), (0, 1, width, height))):
        area = (first[2] - first[0]) * (first[3] - first[1])
        difference = _channel_error(gray.crop(first), gray.crop(second))
        difference += .35 * _channel_error(alpha.crop(first), alpha.crop(second))
        gradients.append(difference / area)
    return (gray, alpha) if min(gradients) >= .7 else None


def _anchor(channels, given, transparent):
    alpha = channels[1]
    width, height = alpha.size
    if given is not None:
        left, top, right, bottom = given
        box = floor(left * width), floor(top * height), ceil(right * width), ceil(bottom * height)
        return box, _template(box, channels)
    if not transparent:
        return None, None
    bounds = alpha.point(MASK_LUT).getbbox()
    if bounds is None:
        return None, None
    left, top, right, bottom = bounds
    w, h = right - left, bottom - top
    core = (left + round(w * .29), top + round(h * .14), right - round(w * .29), top + round(h * .43))
    template = _template(core, channels)
    if template is not None:
        return core, template

    # A solid-color subject can still be tracked from the upper outline when
    # its interior offers no feature texture. Lower limbs are outside this crop.
    margin = max(1, round(w * .08))
    expanded = (max(0, left - margin), max(0, top - margin), min(width, right + margin), top + round(h * .47))
    return expanded, _template(expanded, channels)


def _match(channels, box, template):
    gray, alpha = template
    width, height = channels[0].size
    left, top, right, bottom = box
    x_budget, y_budget = max(2, round(width * .075)), max(2, round(height * .075))
    x_min, x_max = max(-x_budget, -left), min(x_budget, width - right)
    y_min, y_max = max(-y_budget, -top), min(y_budget, height - bottom)

    def score(x, y):
        shifted = left + x, top + y, right + x, bottom + y
        luma = _channel_error(gray, channels[0].crop(shifted))
        opacity = _channel_error(alpha, channels[1].crop(shifted))
        return luma + .35 * opacity, x * x + y * y, x, y

    initial = score(0, 0)
    if not initial[0]:
        return 0, 0, 0.0
    candidates_x = sorted({*range(x_min, x_max + 1, 2), x_min, x_max, 0})
    candidates_y = sorted({*range(y_min, y_max + 1, 2), y_min, y_max, 0})
    coarse = min(score(x, y) for x in candidates_x for y in candidates_y)
    _, _, bx, by = coarse
    best = min(score(x, y) for x in range(max(x_min, bx - 2), min(x_max, bx + 2) + 1)
               for y in range(max(y_min, by - 2), min(y_max, by + 2) + 1))
    error, _, x, y = best
    return x, y, error / (1.35 * 255 * gray.width * gray.height)


def _drift(samples, original_size, given, transparent):
    box, template = _anchor(_luminance(samples[0]), given, transparent)
    if template is None:
        explicit = given is not None
        return _check(
            "root_drift", "fail" if explicit else "skipped",
            "The selected core has too little detail. Include a face or outline to track."
            if explicit else "No trackable core was found. Supply a box around the face or torso.",
            source="explicit" if explicit else "automatic", limit_fraction=ROOT_SHIFT_LIMIT,
        )
    width, height = original_size
    low_width, low_height = samples[0].size
    shifts = [_match(_luminance(sample), box, template) for sample in samples]
    moves_x = [x * width / low_width for x, _, _ in shifts]
    moves_y = [y * height / low_height for _, y, _ in shifts]
    max_x, max_y = max(map(abs, moves_x)), max(map(abs, moves_y))
    limit_x = max(1.0, width * ROOT_SHIFT_LIMIT)
    limit_y = max(1.0, height * ROOT_SHIFT_LIMIT)
    untracked = [index for index, (_, _, error) in enumerate(shifts) if error > ROOT_ERROR_LIMIT]
    passed = max_x <= limit_x and max_y <= limit_y and not untracked
    detail = "The selected core stays within the horizontal and vertical movement limits."
    if untracked:
        detail = "The selected core could not be consistently tracked. Include a stable face or torso."
    elif not passed:
        detail = "The selected core drifts horizontally or vertically beyond the movement limit."
    return _check(
        "root_drift", "pass" if passed else "fail", detail,
        maximum_shift_x=round(max_x, 3), maximum_shift_y=round(max_y, 3),
        peak_to_peak_x=round(max(moves_x) - min(moves_x), 3), peak_to_peak_y=round(max(moves_y) - min(moves_y), 3),
        limit_x=round(limit_x, 3), limit_y=round(limit_y, 3), limit_fraction=ROOT_SHIFT_LIMIT,
        maximum_tracking_error=round(max(error for _, _, error in shifts), 6), tracking_error_limit=ROOT_ERROR_LIMIT,
        untracked_frames=untracked, source="explicit" if given is not None else "automatic",
        core_box=[round(value / extent, 6) for value, extent in zip(box, (low_width, low_height) * 2)],
    )


def _foreground(samples, transparent):
    if not transparent:
        return _check("disconnected_foreground", "skipped", "Opaque frames do not expose a foreground mask.")
    failed = []
    absent = []
    worst_ratio = 0.0
    for index, sample in enumerate(samples):
        # One analysis pixel joins antialiasing cracks without hiding separated limbs.
        alpha = sample.getchannel("A").point(MASK_LUT).filter(ImageFilter.MaxFilter(3))
        areas = sorted((count for _, _, count in _components(alpha)), reverse=True)
        if not areas:
            absent.append(index)
            continue
        if len(areas) > 1 and areas[1] >= 12:
            ratio = areas[1] / areas[0]
            worst_ratio = max(worst_ratio, ratio)
            if ratio >= DISCONNECTED_LIMIT:
                failed.append(index)
    return _check(
        "disconnected_foreground", "fail" if failed or absent else "pass",
        "Some frames have no visible subject." if absent else
        "Some frames contain a substantial separated foreground component." if failed else
        "The visible subject stays connected at the analysis scale.",
        failed_frames=sorted(failed + absent), empty_frames=absent, largest_detached_ratio=round(worst_ratio, 6),
        limit=DISCONNECTED_LIMIT, minimum_component_pixels=12, alpha_threshold=FOREGROUND_ALPHA,
        analysis_width=samples[0].width, analysis_height=samples[0].height,
    )


def _joints(samples, radius, transparent):
    if not samples:
        return _check("joint_coverage", "skipped", "No named joint locations were supplied.")
    if not transparent:
        return _check("joint_coverage", "skipped", "Opaque frames do not expose joint alpha coverage.")
    results = []
    for name, values in samples.items():
        worst = min(range(len(values)), key=lambda index: values[index][0])
        uncovered = [index for index, (_, center) in enumerate(values) if not center]
        failed = [index for index, (coverage, center) in enumerate(values) if coverage < JOINT_MIN_COVERAGE or not center]
        results.append({"name": name, "minimum_coverage": round(values[worst][0], 6), "worst_frame": worst,
                        "uncovered_center_frames": uncovered, "failed_frames": failed})
    passed = not any(item["failed_frames"] for item in results)
    return _check(
        "joint_coverage", "pass" if passed else "fail",
        "All named joints stay covered throughout the loop." if passed else
        "Some frames lose alpha coverage at a named joint.",
        joints=results, radius_pixels=radius, coverage_limit=JOINT_MIN_COVERAGE, alpha_threshold=FOREGROUND_ALPHA,
    )


def review_loop(frames, *, core_box=None, joints=None, expect_travel=False) -> dict:
    """Review an iterable of ordered Pillow frames; report checks and zero-based frame indices.

    Set `expect_travel` when the whole figure is meant to move (a jump), which skips the
    body-drift check instead of failing it.
    """
    if core_box is not None:
        core_box = _normalized(core_box, 4, "Core box")
        if core_box[2] <= core_box[0] or core_box[3] <= core_box[1]:
            raise ValueError("Core box must have positive width and height.")
    if joints is None:
        joints = {}
    if (not isinstance(joints, Mapping) or len(joints) > 16
            or any(not isinstance(name, str) or not name.strip() or len(name) > 48 for name in joints)):
        raise ValueError("Supply up to 16 named joints as a mapping of names to normalized points.")

    size, samples, joint_samples, radius = _read_samples(frames, joints)
    transparent = any(sample.getchannel("A").getextrema()[0] < FOREGROUND_ALPHA for sample in samples)
    checks = [
        _seam(samples),
        _check("root_drift", "skipped", "The whole figure travels on purpose in this motion (a jump).")
        if expect_travel else _drift(samples, size, core_box, transparent),
        _foreground(samples, transparent), _joints(joint_samples, radius, transparent),
    ]
    return {"passed": all(check["status"] != "fail" for check in checks), "width": size[0], "height": size[1],
            "frame_count": len(samples), "checks": checks}
