"""Measure planted-foot contour movement in a decoded Gift GIF."""

from itertools import accumulate, combinations
from math import ceil, floor, hypot

from PIL import Image, ImageSequence


MAX_SAMPLES = 240
MAX_FRAME_PIXELS = 64_000_000
MASK_LUT = [0] * 128 + [255] * 128


def _result(status, detail, *, limit_px=None, feet=(), sampled_frames=0):
    return {
        "id": "foot_lock",
        "status": status,
        "detail": detail,
        "metrics": {"feet": list(feet), "limit_px": limit_px, "sampled_frames": sampled_frames},
    }


def _foot_region(part, parts, size):
    width, height = size
    points = ((x * (width - 1), y * (height - 1)) for x, y in (part.tip, part.foot_ik.knee))
    (x, y), (knee_x, knee_y) = points
    length = max(5, hypot(x - knee_x, y - knee_y))
    outline = [u * (width - 1) for u, v in part.polygon if v * (height - 1) >= y - .45 * length]
    margin = max(4, .12 * length)
    left = min([x - .65 * length, *outline]) - margin
    right = max([x + .65 * length, *outline]) + margin

    # Separate nearby feet by their anchors so an adjacent foot cannot stand in for this one.
    for neighbor in parts:
        other_x, other_y = (neighbor.tip[0] * (width - 1), neighbor.tip[1] * (height - 1))
        if neighbor is part or abs(y - other_y) > length:
            continue
        midpoint = (x + other_x) / 2
        if other_x < x:
            left = max(left, midpoint)
        elif other_x > x:
            right = min(right, midpoint)

    box = (
        max(0, floor(left)), max(0, floor(y - max(5, .55 * length))),
        min(width, ceil(right) + 1), min(height, ceil(y + max(5, .60 * length)) + 1),
    )
    return box, max(2, min(8, round(.13 * length))), y - max(3, .35 * length)


def _contour(alpha, box, band_height, min_y):
    left, top, right, bottom = box
    if right - left < 3 or bottom - top < 3:
        return None
    mask = alpha.crop(box).point(MASK_LUT)
    bounds = mask.getbbox()
    if bounds is None:
        return None

    # Take the bottom-most supported row and a short band above it. A lone quantized pixel
    # should not determine the vertical position or horizontal center of a whole foot.
    minimum_width = max(2, round(.025 * mask.width))
    row = bounds[3] - 1
    while row >= bounds[1]:
        pixels = mask.crop((0, row, mask.width, row + 1)).tobytes()
        if pixels.count(255) >= minimum_width:
            break
        row -= 1
    if row < bounds[1] or top + row < min_y or (row == mask.height - 1 and bottom < alpha.height):
        return None

    band = mask.crop((0, max(0, row - band_height + 1), mask.width, row + 1))
    columns = band.resize((mask.width, 1), Image.Resampling.BOX).tobytes()
    center = sum(index * weight for index, weight in enumerate(columns)) / sum(columns)
    return left + center, top + row


def _schedule(parts, cycles, count):
    schedule = []
    for index in range(count):
        clock = index / count * cycles
        planted = []
        for foot, part in enumerate(parts):
            phase = clock % 1 + part.phase_offset
            if phase % 1 < part.foot_ik.stance_fraction:
                # The window that straddles the end and start of the loop has one ID.
                planted.append((foot, (floor(clock) + floor(phase)) % cycles))
        schedule.append(planted)
    return schedule


def _foot_summary(part, windows):
    # Include repeated scheduled samples when a single decoded pose holds several intervals.
    samples = [sample for window in windows.values() for sample in window]
    pairs = []
    for window in windows.values():
        points = (point for _, point in window if point is not None)
        pairs.extend((abs(a[0] - b[0]), abs(a[1] - b[1])) for a, b in combinations(points, 2))
    return {
        "name": part.name,
        "maximum_drift_px": round(max(hypot(x, y) for x, y in pairs), 3) if pairs else None,
        "maximum_x_drift_px": round(max(x for x, _ in pairs), 3) if pairs else None,
        "maximum_y_drift_px": float(max(y for _, y in pairs)) if pairs else None,
        "stance_samples": len(samples),
        "decoded_stance_frames": len({index for index, _ in samples}),
        "stance_windows": sum(len(window) >= 2 for window in windows.values()),
        "untracked_samples": sum(point is None for _, point in samples),
    }


def review_foot_lock(draft_path, rig, delays) -> dict:
    """Check apparent sole movement within each planned stance interval.

    ``delays`` are the original render delays in milliseconds, rounded to GIF centiseconds.
    Decoded frames can combine multiple planned intervals when consecutive poses are identical.
    """
    parts = [part for part in rig.parts if part.foot_ik is not None]
    if not parts:
        return _result("skipped", "The rig has no feet with planned stance intervals.")
    count = len(delays)
    if not 2 <= count <= MAX_SAMPLES or any(type(delay) is not int or delay <= 0 or delay % 10 for delay in delays):
        return _result("fail", "Foot-lock review needs 2–240 positive GIF frame delays in whole centiseconds.")

    schedule = _schedule(parts, rig.cycles, count)
    starts = list(accumulate(delays, initial=0))
    windows = [{} for _ in parts]
    decoded_end = scheduled = 0
    try:
        with Image.open(draft_path) as gif:
            if gif.format != "GIF" or gif.width * gif.height * count > MAX_FRAME_PIXELS:
                return _result("fail", "Foot-lock review needs a bounded GIF draft.")
            limit = max(2.0, round(min(gif.size) * .0035, 3))
            regions = [_foot_region(part, parts, gif.size) for part in parts]
            for index, frame in enumerate(ImageSequence.Iterator(gif)):
                delay = frame.info.get("duration", 0)
                if index >= count or type(delay) is not int or delay <= 0:
                    return _result("fail", "Decoded GIF frames do not match the planned frame delays.")
                decoded_end += delay
                alpha = None
                contours = {}
                while scheduled < count and starts[scheduled] < decoded_end:
                    for foot, window in schedule[scheduled]:
                        if foot not in contours:
                            if alpha is None:
                                alpha = frame.convert("RGBA").getchannel("A")
                            contours[foot] = _contour(alpha, *regions[foot])
                        windows[foot].setdefault(window, []).append((index, contours[foot]))
                    scheduled += 1
    except (OSError, ValueError) as exc:
        return _result("fail", f"Could not measure the decoded GIF draft: {exc}")

    if scheduled != count or decoded_end != starts[-1]:
        return _result("fail", "Decoded GIF duration does not match the planned stance schedule.")
    feet = [_foot_summary(part, window) for part, window in zip(parts, windows)]
    metrics = {"limit_px": limit, "feet": feet, "sampled_frames": scheduled}
    lost = [foot["name"] for foot in feet if foot["untracked_samples"]]
    drift = [foot["name"] for foot in feet if (foot["maximum_drift_px"] or 0) > limit]
    if lost or drift:
        details = []
        if lost:
            details.append(f"Could not locate the sole in some planted frames: {', '.join(lost)}.")
        if drift:
            details.append(f"Planted sole drift exceeded {limit:g} px: {', '.join(drift)}.")
        return _result("fail", " ".join(details), **metrics)
    if any(foot["maximum_drift_px"] is None for foot in feet):
        return _result("skipped", "The GIF does not sample each foot twice within a stance interval.", **metrics)
    return _result("pass", f"Tracked soles stayed within {limit:g} px during each sampled stance interval.", **metrics)
