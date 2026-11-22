"""Animate visible features in a flattened cartoon with a local 2D rig."""

from collections import Counter
from dataclasses import dataclass
from itertools import combinations
from math import atan2, cos, degrees, hypot, isfinite, pi, sin
from statistics import median

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps


@dataclass
class EyeLayer:
    position: tuple[int, int]
    patch: Image.Image
    cover: Image.Image
    mask: Image.Image
    ink: tuple[int, int, int, int]


@dataclass
class ArmLayer:
    body: Image.Image
    patch: Image.Image
    shoulder: tuple[float, float]
    hand: tuple[float, float]


def _components(mask):
    """Return inclusive centers and exclusive bounding boxes for 4-connected marks."""
    width, height = mask.size
    data = bytearray(mask.tobytes())
    for start, value in enumerate(data):
        if not value:
            continue
        queue = [start]
        data[start] = 0
        center_x = center_y = 0
        left, top, right, bottom = width, height, 0, 0
        for index in queue:
            y, x = divmod(index, width)
            center_x += x
            center_y += y
            left, top = min(left, x), min(top, y)
            right, bottom = max(right, x), max(bottom, y)
            for neighbor in (
                index - 1 if x else -1,
                index + 1 if x + 1 < width else -1,
                index - width if y else -1,
                index + width if y + 1 < height else -1,
            ):
                if neighbor >= 0 and data[neighbor]:
                    queue.append(neighbor)
                    data[neighbor] = 0
        count = len(queue)
        yield (left, top, right + 1, bottom + 1), (center_x / count, center_y / count), count


def _color_distance(rgb, color):
    red, green, blue = ImageChops.difference(rgb, Image.new("RGB", rgb.size, color[:3])).split()
    return ImageChops.lighter(ImageChops.lighter(red, green), blue)


def _subject(image):
    """Find an alpha or edge-connected flat background, leaving the original pixels intact."""
    alpha = image.getchannel("A")
    if alpha.getextrema()[0] < 24:
        return alpha.point(lambda value: 255 if value >= 40 else 0), None

    width, height = image.size
    rgb = image.convert("RGB")
    xs = [round((width - 1) * index / 8) for index in range(9)]
    ys = [round((height - 1) * index / 8) for index in range(9)]
    border = [(x, y) for x in xs for y in (0, height - 1)]
    border.extend((x, y) for y in ys for x in (0, width - 1))
    colors = Counter(rgb.getpixel(point) for point in border)
    neighbors = {
        color: sum(count for candidate, count in colors.items() if max(map(abs, (
            color[0] - candidate[0], color[1] - candidate[1], color[2] - candidate[2],
        ))) <= 24)
        for color in colors
    }
    backdrop = max(neighbors, key=neighbors.get)
    if neighbors[backdrop] < len(border) * .56:
        return Image.new("L", image.size, 255), None

    connected = _color_distance(rgb, backdrop).point(lambda value: 255 if value <= 24 else 0)
    for point in border:
        if connected.getpixel(point) == 255:
            ImageDraw.floodfill(connected, point, 128)
    subject = connected.point(lambda value: 0 if value == 128 else 255)
    if subject.getbbox() is not None:
        return subject, (*backdrop, 255)
    return Image.new("L", image.size, 255), None


def _eye_candidates(image, mask, bounds, cutoff):
    left, top, right, bottom = bounds
    width, height = right - left, bottom - top
    top += round(.08 * height)
    bottom = min(bottom, top + round(.50 * height))
    region = (left, top, right, bottom)
    gray = ImageOps.grayscale(image.crop(region))
    dark = gray.point(lambda value: 255 if value <= cutoff else 0)
    interior = mask.crop(region).filter(ImageFilter.MinFilter(3))
    for box, center, area in _components(ImageChops.multiply(dark, interior)):
        x0, y0, x1, y1 = box
        x, y = center
        eye_width, eye_height = x1 - x0, y1 - y0
        if (area >= 3 and x0 >= .06 * width and x1 <= .94 * width and y0 > 0 and y1 < gray.height
                and 2 <= eye_width <= .23 * width and 2 <= eye_height <= .22 * height
                and .25 <= eye_width / eye_height <= 3.2):
            yield x + left, y + top, eye_width, eye_height, area


def _auto_eyes(image, mask):
    thumbnail = image.copy()
    thumbnail.thumbnail((320, 320), Image.Resampling.LANCZOS)
    mask = mask.resize(thumbnail.size, Image.Resampling.NEAREST)
    bounds = mask.getbbox()
    left, top, right, bottom = bounds or (0, 0, *thumbnail.size)
    width, height = right - left, bottom - top
    if min(width, height) < 12:
        raise ValueError("The subject is too small to locate eyes. Supply their normalized landmarks.")

    for cutoff in (80, 115):
        scored = []
        for first, second in combinations(_eye_candidates(thumbnail, mask, (left, top, right, bottom), cutoff), 2):
            separation = abs(first[0] - second[0]) / width
            height_difference = abs(first[1] - second[1]) / height
            size_match = min(first[4], second[4]) / max(first[4], second[4])
            if not (.11 <= separation <= .70 and height_difference <= .075 and size_match >= .35):
                continue
            center = (first[0] + second[0]) / 2
            face_y = ((first[1] + second[1]) / 2 - top) / height
            score = (1.5 * size_match - 5 * height_difference - abs(separation - .30)
                     - abs(center - left - width / 2) / width - abs(face_y - .32))
            scored.append((score, first, second))
        if scored:
            _, first, second = max(scored)
            scale_x, scale_y = image.width / thumbnail.width, image.height / thumbnail.height
            return [
                (x * scale_x, y * scale_y, max(2, w * .77 * scale_x), max(2, h * .77 * scale_y))
                for x, y, w, h, _ in (first, second)
            ]
    raise ValueError("Couldn't locate a pair of eyes. Supply eye centers and radii or use a clear frontal cartoon.")


def _make_eye(image, eye):
    x, y, rx, ry = eye
    left = max(0, round(x - rx))
    top = max(0, round(y - ry))
    right = min(image.width, round(x + rx) + 1)
    bottom = min(image.height, round(y + ry) + 1)
    patch = image.crop((left, top, right, bottom))
    if min(patch.size) < 2:
        raise ValueError("The eye landmark must cover at least two pixels in both directions.")

    samples = []
    for index in range(16):
        angle = 2 * pi * index / 16
        sx = round(x + 1.35 * rx * cos(angle))
        sy = round(y + 1.34 * ry * sin(angle))
        if 0 <= sx < image.width and 0 <= sy < image.height:
            color = image.getpixel((sx, sy))
            if color[3] > 160:
                samples.append(color)
    if not samples:
        raise ValueError("The eye is too near a transparent edge. Place its center on the face.")
    skin = tuple(round(median(channel)) for channel in zip(*samples))
    colors = [color for color in patch.get_flattened_data() if color[3] > 160]
    ink = min(colors, default=(30, 24, 30, 255), key=lambda color: sum(color[:3]))
    mask = Image.new("L", patch.size)
    ImageDraw.Draw(mask).ellipse((0, 0, patch.width - 1, patch.height - 1), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(max(.45, min(rx, ry) * .12)))
    patch.putalpha(ImageChops.multiply(patch.getchannel("A"), mask))
    cover = _eyelid_fill(image, (left, top, right, bottom), skin)
    return EyeLayer((left, top), patch, cover, mask, ink)


def _eyelid_fill(image, box, skin):
    """Skin for the closed eyelid, blended column by column from just above the eye to the cheek below.

    A flat colour shows as a pale disc on shaded or blushing faces; following the surrounding
    gradient keeps the closed eye looking painted. Dark samples (lashes, outlines) fall back to skin.
    """
    left, top, right, bottom = box
    width, height = right - left, bottom - top
    pixels = image.load()
    skin_level = sum(skin[:3])

    def sample(x, rows):
        found = [pixels[x, row] for row in rows if 0 <= row < image.height]
        found = [color for color in found if color[3] > 160 and sum(color[:3]) > .72 * skin_level]
        if not found:
            return skin[:3]
        return tuple(round(median(channel)) for channel in list(zip(*found))[:3])

    fill = Image.new("RGB", (width, height))
    out = fill.load()
    for column in range(width):
        x = left + column
        above = sample(x, range(top - 8, top - 1))
        below = sample(x, range(bottom + 1, bottom + 9))
        # Lean toward the overall skin tone so stray hair strands don't streak through the lid.
        above = tuple(round(.6 * a + .4 * s) for a, s in zip(above, skin[:3]))
        for row in range(height):
            t = row / max(1, height - 1)
            out[column, row] = tuple(round(a + (b - a) * t) for a, b in zip(above, below))
    fill = fill.filter(ImageFilter.GaussianBlur(max(1, width / 40)))
    return fill.convert("RGBA")


def _lid_line(frame, layer, lid_y):
    """A smooth, tapered closed-eye curve that dips slightly in the middle."""
    x, _ = layer.position
    width, height = layer.patch.size
    start, end = width * .14, width * .86
    bow = height * .16
    thickness = max(1.5, height * .11)
    points = []
    for index in range(17):
        s = index / 16
        points.append((x + start + (end - start) * s, lid_y + bow * sin(pi * s)))
    draw = ImageDraw.Draw(frame)
    for index, (a, b) in enumerate(zip(points, points[1:])):
        taper = .35 + .65 * sin(pi * (index + .5) / 16)
        draw.line((a, b), fill=layer.ink, width=max(1, round(thickness * taper)))


def _blink(frame, layers, closure):
    alpha = frame.getchannel("A")
    for layer in layers:
        x, y = layer.position
        frame.paste(layer.cover, layer.position, layer.mask)
        width, height = layer.patch.size
        # Eyelids meet a little below the middle of the eye, as upper lids travel further.
        lid_y = y + round(height * .56)
        if closure < .89:
            shrunk = max(1, round(height * (1 - closure)))
            compressed = layer.patch.resize((width, shrunk), Image.Resampling.LANCZOS)
            frame.alpha_composite(compressed, (x, lid_y - round(shrunk * .56)))
        else:
            _lid_line(frame, layer, lid_y)
    frame.putalpha(alpha)


def _auto_arm(mask):
    reduced = mask.copy()
    reduced.thumbnail((320, 320), Image.Resampling.NEAREST)
    left, top, right, bottom = reduced.getbbox() or (0, 0, *reduced.size)
    width, height = right - left, bottom - top
    if min(width, height) < 16:
        raise ValueError("The subject is too small to locate an arm. Supply shoulder, elbow and hand landmarks.")
    profiles = [reduced.crop((0, y, reduced.width, y + 1)).getbbox()
                for y in range(top + round(.60 * height), top + round(.84 * height))]
    profiles = [profile for profile in profiles if profile]
    candidates = []
    for side in (-1, 1):
        if not profiles:
            continue
        edges = sorted(profile[0 if side < 0 else 2] for profile in profiles)
        boundary = edges[round(.63 * (len(edges) - 1)) if side < 0 else round(.37 * (len(edges) - 1))]
        x0, x1 = (left, boundary) if side < 0 else (boundary, right)
        y0, y1 = top + round(.40 * height), top + round(.79 * height)
        if x1 - x0 < max(5, .068 * width):
            continue
        outer = reduced.crop((x0, y0, x1, y1))
        for (a, b, c, d), _, area in _components(outer):
            reach, limb_height = c - a, d - b
            attaches = c == outer.width if side < 0 else a == 0
            if not attaches or reach < max(5, .068 * width) or area < max(9, .0015 * width * height):
                continue
            if limb_height > .38 * height or limb_height > max(8, reach * 2.5):
                continue
            join_x = c - 1 if side < 0 else a
            tip_x = a + min(2, reach - 1) if side < 0 else c - min(3, reach)
            middle_x = (join_x + tip_x) // 2
            join_rows = [row for row in range(b, d) if outer.getpixel((join_x, row))]
            tip_rows = [row for row in range(b, d) if outer.getpixel((tip_x, row))]
            middle_rows = [row for row in range(b, d) if outer.getpixel((middle_x, row))]
            if not (join_rows and tip_rows and middle_rows):
                continue
            radius = max(2, len(middle_rows) * .66, len(tip_rows) * .61)
            shoulder = (boundary - side * min(radius * .24, width * .026), median(join_rows) + y0)
            elbow = (x0 + middle_x, y0 + median(middle_rows))
            hand = (x0 + tip_x, y0 + median(tip_rows))
            candidates.append((reach - abs(limb_height - 2 * radius) * .2, shoulder, elbow, hand, radius))
    if not candidates:
        raise ValueError("Couldn't identify a visible side arm. Use a PNG with an arm separated from the body, or supply arm landmarks.")
    _, shoulder, elbow, hand, radius = max(candidates)
    sx, sy = mask.width / reduced.width, mask.height / reduced.height
    return (*(value for x, y in (shoulder, elbow, hand) for value in (x * sx, y * sy)), radius * min(sx, sy))


def _make_arm(image, subject, backdrop, landmarks):
    sx, sy, ex, ey, hx, hy, radius = landmarks
    shoulder, elbow, hand = (sx, sy), (ex, ey), (hx, hy)
    if hypot(hx - sx, hy - sy) < max(4, radius):
        raise ValueError("The shoulder and hand should be farther apart than the arm radius.")
    if backdrop is None and image.getchannel("A").getextrema()[0] >= 24:
        raise ValueError("Waving needs a transparent PNG or a flat-color background to separate the arm.")

    direction_x, direction_y = ex - sx, ey - sy
    distance = hypot(direction_x, direction_y)
    if distance < 1:
        direction_x, direction_y = hx - sx, hy - sy
        distance = hypot(direction_x, direction_y)
    direction_x, direction_y = direction_x / distance, direction_y / distance

    # When the arm contrasts with the torso, follow its paint beyond the guide tube.
    # A tight geometry-only cut remains available for characters painted in one color.
    torso_point = (round(sx - radius * direction_x), round(sy - radius * direction_y))
    torso_color = image.getpixel(torso_point) if 0 <= torso_point[0] < image.width and 0 <= torso_point[1] < image.height else None
    arm_colors = [image.getpixel((round(x), round(y))) for x, y in (elbow, hand)]
    separate_paint = torso_color is not None and torso_color[3] > 160 and all(
        color[3] > 160 and max(abs(first - second) for first, second in zip(color[:3], torso_color[:3])) > 46
        for color in arm_colors
    )
    tube_radius = radius * 1.42 if separate_paint else radius
    tube = Image.new("L", image.size)
    draw = ImageDraw.Draw(tube)
    draw.line((shoulder, elbow, hand), fill=255, width=max(2, round(tube_radius * 2)), joint="curve")
    for x, y in (shoulder, elbow, hand):
        draw.ellipse((x - tube_radius, y - tube_radius, x + tube_radius, y + tube_radius), fill=255)
    if separate_paint:
        arm_paint = _color_distance(image.convert("RGB"), torso_color).point(lambda value: 255 if value > 36 else 0)
        tube = ImageChops.multiply(tube, arm_paint)

    normal_x, normal_y = -direction_y, direction_x
    spread = hypot(*image.size) * 2
    seam_x, seam_y = sx - radius * .26 * direction_x, sy - radius * .26 * direction_y
    near_left = (seam_x + normal_x * spread, seam_y + normal_y * spread)
    near_right = (seam_x - normal_x * spread, seam_y - normal_y * spread)
    seam = Image.new("L", image.size)
    ImageDraw.Draw(seam).polygon((
        near_left, near_right,
        (near_right[0] + direction_x * spread, near_right[1] + direction_y * spread),
        (near_left[0] + direction_x * spread, near_left[1] + direction_y * spread),
    ), fill=255)
    selection = ImageChops.multiply(tube, seam)
    if backdrop is not None:
        selection = ImageChops.multiply(selection, subject)

    patch = image.copy()
    alpha = image.getchannel("A")
    part = ImageChops.multiply(alpha, selection)
    if part.getbbox() is None:
        raise ValueError("The arm landmarks do not cover any visible part of the character.")
    patch.putalpha(part)
    body = image.copy()
    if backdrop is None:
        body.putalpha(ImageChops.subtract(alpha, part))
    else:
        body.paste(backdrop, mask=selection)
    return ArmLayer(body, patch, shoulder, hand)


def _wave_angle(layer, phase, strength):
    ramp = min(1, phase * 5, (1 - phase) * 5)
    ramp *= ramp * (3 - 2 * ramp)
    difference_x = layer.hand[0] - layer.shoulder[0]
    difference_y = layer.hand[1] - layer.shoulder[1]
    side = 1 if difference_x >= 0 else -1
    initial_angle = degrees(atan2(difference_y, abs(difference_x)))
    raise_angle = min(78, max(8, initial_angle + 30))
    return min(1.3, strength) * side * ramp * (raise_angle + 20 * sin(4 * pi * phase))


def _landmark(values, length):
    if (not isinstance(values, (list, tuple)) or len(values) != length
            or any(type(value) not in (int, float) or not 0 <= value <= 1 for value in values)):
        raise ValueError(f"A landmark must have {length} normalized values between 0 and 1.")
    return values


def character_frames(image, actions, count, *, eyes=None, arm=None, strength=1.0):
    """Render blink/wave frames using automatic features or normalized landmark overrides.

    Eye landmarks are (x, y, horizontal_radius, vertical_radius). Arm landmarks
    are (shoulder_x, shoulder_y, elbow_x, elbow_y, hand_x, hand_y, radius), with
    radius measured relative to the shorter image side. Coordinates use the
    complete image including any transparent margins.
    """
    actions = (actions,) if isinstance(actions, str) else actions
    if (not isinstance(actions, (list, tuple, set, frozenset)) or not actions
            or any(action not in ("blink", "wave") for action in actions)):
        raise ValueError("Choose blink, wave, or both for character animation.")
    if type(count) is not int or not 2 <= count <= 600:
        raise ValueError("Character animation needs 2–600 frames.")
    if type(strength) not in (int, float) or not isfinite(strength) or not 0 <= strength <= 2:
        raise ValueError("Strength must be between 0 and 2.")
    rgba = image.convert("RGBA")
    if not rgba.getbbox(alpha_only=True):
        raise ValueError("The uploaded image is fully transparent.")
    if not strength:
        return [rgba.copy() for _ in range(count)]
    subject, backdrop = _subject(rgba)
    width, height = rgba.size
    eye_layers = []
    if "blink" in actions:
        if eyes is None:
            points = _auto_eyes(rgba, subject)
        else:
            if not isinstance(eyes, (list, tuple)) or not 1 <= len(eyes) <= 2:
                raise ValueError("Supply one or two eye landmarks.")
            points = []
            for eye in eyes:
                x, y, rx, ry = _landmark(eye, 4)
                if not 0 < rx <= .25 or not 0 < ry <= .25:
                    raise ValueError("Eye radii must be greater than 0 and at most 0.25.")
                points.append((x * (width - 1), y * (height - 1), rx * width, ry * height))
        eye_layers = [_make_eye(rgba, eye) for eye in points]

    arm_layer = None
    if "wave" in actions:
        if arm is None:
            points = _auto_arm(subject)
        else:
            sx, sy, ex, ey, hx, hy, radius = _landmark(arm, 7)
            if not 0 < radius <= .25:
                raise ValueError("Arm radius must be greater than 0 and at most 0.25.")
            points = (sx * (width - 1), sy * (height - 1), ex * (width - 1), ey * (height - 1),
                      hx * (width - 1), hy * (height - 1), radius * min(width, height))
        arm_layer = _make_arm(rgba, subject, backdrop, points)

    result = []
    blink_center, blink_width = round(count * .36), max(1.5, count * .085)
    for index in range(count):
        angle = _wave_angle(arm_layer, index / count, strength) if arm_layer else 0
        frame = (arm_layer.body if arm_layer and angle else rgba).copy()
        distance = abs(index - blink_center) / blink_width
        if eye_layers and distance < 1:
            closure = min(1, strength) * (1 + cos(pi * distance)) / 2
            _blink(frame, eye_layers, closure)
        if arm_layer and angle:
            lifted = arm_layer.patch.rotate(angle, Image.Resampling.BICUBIC, center=arm_layer.shoulder)
            frame.alpha_composite(lifted)
        result.append(frame)
    return result
