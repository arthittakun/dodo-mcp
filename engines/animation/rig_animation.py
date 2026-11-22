"""Animate a single drawing with articulated, joint-anchored 2D mesh layers."""

from dataclasses import dataclass
from itertools import pairwise
from math import ceil, cos, floor, hypot, isfinite, pi, radians, sin, sqrt, tau
from typing import Annotated, Literal

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps
from pydantic import BaseModel, ConfigDict, Field, model_validator

from image_animation import MAX_IMAGE_SIDE
from motion_physics import (
    BlinkSpec, PhysicsSpec, blink_closure, breathe_pose, interpolate, jump_pose, periodic_acceleration,
    sample_phases, solve_spring,
)
from smooth import affine, downscale, premultiplied, sample_loop


Fraction = Annotated[float, Field(ge=0, le=1)]
Point = tuple[Fraction, Fraction]
Outline = Annotated[list[Point], Field(min_length=3, max_length=40)]
Movement = Annotated[float, Field(ge=-0.25, le=0.25)]
Degrees = Annotated[float, Field(ge=-65, le=65)]
RIG_FRAME_PIXELS = 64_000_000


class FootIKSpec(BaseModel):
    """Two-bone leg with a fixed contact point for the stance portion of each step."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    knee: Point
    stance_fraction: Annotated[float, Field(ge=0.5, le=0.85)] = 0.58
    foot_fraction: Annotated[float, Field(ge=0.6, le=0.95)] = 0.8


class RigPartSpec(BaseModel):
    """Isolate a visible limb and keep its root attached as the outer portion bends."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: Annotated[str, Field(min_length=1, max_length=48)]
    polygon: Outline
    root: Point
    tip: Point
    motion: Literal["step", "wave", "swing"]
    phase_offset: Fraction = 0.0
    movement_x: Movement = 0.0
    movement_y: Annotated[float, Field(ge=0, le=0.25)] = 0.0
    rotation_deg: Degrees = 0.0
    rotation_bias: Degrees = 0.0
    anchor_fraction: Annotated[float, Field(ge=0.07, le=0.6)] = 0.18
    behind: bool = False
    cut_polygon: Outline | None = None
    foot_ik: FootIKSpec | None = None
    physics: PhysicsSpec | None = None
    # Points inside the part's own paint. When given, the outline only bounds the search: the
    # part becomes everything reachable from the seeds without crossing dark line art, so a
    # loosely drawn outline never leaves slivers of the part behind on the body.
    seeds: Annotated[list[Point], Field(min_length=1, max_length=8)] | None = None

    @model_validator(mode="after")
    def check_limits(self):
        if self.root == self.tip:
            raise ValueError("A rig part needs different root and tip positions")
        if abs(self.rotation_deg) + abs(self.rotation_bias) > 80:
            raise ValueError("The combined rotation amplitude and bias must be at most 80°")
        if self.physics is not None and self.motion == "step":
            raise ValueError("Physics follow-through is for wave and swing parts, not stepping legs")
        if self.foot_ik is not None:
            if self.motion != "step" or self.rotation_deg or self.rotation_bias:
                raise ValueError("Foot IK requires step motion and uses movement_x/y instead of rotation")
            if self.foot_ik.foot_fraction <= self.anchor_fraction + 0.08:
                raise ValueError("Leave space between the fixed hip and the rigid foot")
            if self.foot_ik.knee in (self.root, self.tip):
                raise ValueError("The knee must differ from the hip and foot")
        return self


class BodyMotionSpec(BaseModel):
    """Whole-figure motion about the ground line.

    style "bob": squash and stretch with the feet planted; `bob` is the peak vertical stretch
    as a fraction of the height above the ground and `beats` bobs happen per rig cycle (use 2
    for a walk). style "breathe": a gentle inhale of `bob` that never compresses (use 1 beat).
    style "jump": anticipation squash, launch stretch, a flight of `jump_height` (fraction of
    the figure height), landing impact and a springy settle; `jump_squash` sets how hard.
    `squash` narrows the figure while it stretches. `phase_offset` shifts the timing.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    style: Literal["bob", "breathe", "jump"] = "bob"
    bob: Annotated[float, Field(ge=0, le=0.04)] = 0.012
    squash: Annotated[float, Field(ge=0, le=1)] = 0.5
    beats: Annotated[int, Field(ge=1, le=4)] = 2
    phase_offset: Fraction = 0.0
    jump_height: Annotated[float, Field(ge=0, le=0.5)] = 0.18
    jump_squash: Annotated[float, Field(ge=0, le=0.3)] = 0.14
    ground_y: Fraction | None = None
    center_x: Fraction | None = None


class RigSpec(BaseModel):
    """A small set of layered limbs with periodic movement shared over one loop.

    `body` adds whole-figure motion, and `blink` adds natural eye blinks.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    parts: Annotated[list[RigPartSpec], Field(min_length=1, max_length=8)]
    cycles: Annotated[int, Field(ge=1, le=6)] = 2
    body: BodyMotionSpec | None = None
    blink: BlinkSpec | None = None

    @model_validator(mode="after")
    def unique_parts(self):
        if len({part.name for part in self.parts}) != len(self.parts):
            raise ValueError("Give every rig part a unique name")
        return self


def _pixel(point, size):
    return point[0] * (size[0] - 1), point[1] * (size[1] - 1)


@dataclass(frozen=True, slots=True)
class FootPose:
    planted: bool
    knee: tuple[float, float]
    foot: tuple[float, float]


def _solve_leg(hip, knee, foot, target):
    """Return the intersection of the two bone-length circles on the rest knee side."""
    upper, lower = hypot(knee[0] - hip[0], knee[1] - hip[1]), hypot(foot[0] - knee[0], foot[1] - knee[1])
    x, y = target[0] - hip[0], target[1] - hip[1]
    distance = hypot(x, y)
    if distance < 1e-7:
        x, y = foot[0] - hip[0], foot[1] - hip[1]
        unit_distance = hypot(x, y)
    else:
        unit_distance = distance
    ux, uy = x / unit_distance, y / unit_distance
    distance = min(upper + lower, max(abs(upper - lower), distance, 1e-7))
    along = (upper * upper - lower * lower + distance * distance) / (2 * distance)
    offset = sqrt(max(0, upper * upper - along * along))
    rest_axis = foot[0] - hip[0], foot[1] - hip[1]
    if rest_axis[0] * (knee[1] - hip[1]) - rest_axis[1] * (knee[0] - hip[0]) < 0:
        offset = -offset
    return ((hip[0] + ux * along - uy * offset, hip[1] + uy * along + ux * offset),
            (hip[0] + ux * distance, hip[1] + uy * distance))


def _leg_points(part, size):
    hip, knee, foot = (_pixel(point, size) for point in (part.root, part.foot_ik.knee, part.tip))
    if min(hypot(knee[0] - hip[0], knee[1] - hip[1]),
           hypot(foot[0] - knee[0], foot[1] - knee[1]),
           hypot(foot[0] - hip[0], foot[1] - hip[1])) < 3:
        raise ValueError(f"{part.name}: keep the hip, knee and foot at least three pixels apart")
    return hip, knee, foot


def foot_ik_pose(part: RigPartSpec, size: tuple[int, int], phase: float, *, cycles: int = 1) -> FootPose:
    """Return the planted state, solved knee and contact point in image pixels."""
    if part.foot_ik is None:
        raise ValueError("The supplied rig part has no foot IK")
    if not isfinite(phase) or not 0 <= phase <= 1 or type(cycles) is not int or not 1 <= cycles <= 6:
        raise ValueError("Use a phase from 0 to 1 and an integer cycle count from 1 to 6")
    hip, knee, foot = _leg_points(part, size)
    local = (((phase % 1) * cycles) + part.phase_offset) % 1
    if local < part.foot_ik.stance_fraction:
        return FootPose(True, knee, foot)
    swing = (local - part.foot_ik.stance_fraction) / (1 - part.foot_ik.stance_fraction)
    envelope = sin(pi * swing) ** 2
    target = (foot[0] + part.movement_x * size[0] * envelope * sin(tau * swing),
              foot[1] - part.movement_y * size[1] * envelope)
    if target == foot:
        return FootPose(False, knee, foot)
    knee, foot = _solve_leg(hip, knee, foot, target)
    return FootPose(False, knee, foot)


def _matte(size, polygon):
    matte = Image.new("L", size)
    ImageDraw.Draw(matte).polygon([_pixel(point, size) for point in polygon], fill=255)
    return matte


LINE_LUMA = 100  # Pixels darker than this are line art that bounds a seeded part.


def _flood(fillable, width, seeds):
    """4-connected flood of non-zero bytes from the seed indices; returns a 0/255 bytearray."""
    from collections import deque

    region = bytearray(len(fillable))
    queue = deque()
    for seed in seeds:
        if fillable[seed] and not region[seed]:
            region[seed] = 255
            queue.append(seed)
    while queue:
        index = queue.popleft()
        x = index % width
        for neighbor in (index - 1 if x else -1, index + 1 if x + 1 < width else -1, index - width, index + width):
            if 0 <= neighbor < len(fillable) and fillable[neighbor] and not region[neighbor]:
                region[neighbor] = 255
                queue.append(neighbor)
    return region


def _nearest_fillable(fillable, width, height, x, y, radius):
    for distance in range(radius + 1):
        for dy in range(-distance, distance + 1):
            for dx in (-distance, distance) if abs(dy) != distance else range(-distance, distance + 1):
                px, py = x + dx, y + dy
                if 0 <= px < width and 0 <= py < height and fillable[py * width + px]:
                    return py * width + px
    return None


PALETTE_MARGIN = 34  # Opponent-colour slack around the seed colours.


def _palette_mask(image, seed_pixels):
    """Pixels whose opponent colours (red-green, yellow-blue) fall in the range sampled at the seeds.

    Line art is often too faint to separate a part from what touches it (an orange tail and a
    lavender sleeve), but their colours sit on opposite sides of the yellow-blue axis.
    """
    from PIL import ImageMath

    rgb = image.convert("RGB")
    alpha = image.getchannel("A")
    red_green, yellow_blue = [], []
    for x, y in seed_pixels:
        for dy in range(-4, 5, 2):
            for dx in range(-4, 5, 2):
                px, py = min(max(0, x + dx), rgb.width - 1), min(max(0, y + dy), rgb.height - 1)
                r, g, b = rgb.getpixel((px, py))
                # Sample only the part's opaque paint, never background or line art.
                if alpha.getpixel((px, py)) < 200 or .299 * r + .587 * g + .114 * b < LINE_LUMA:
                    continue
                red_green.append(r - g)
                yellow_blue.append(r + g - 2 * b)
    if not red_green:
        raise ValueError("Put the seeds on the part's own paint, away from outlines and the background")
    low_rg, high_rg = min(red_green) - PALETTE_MARGIN, max(red_green) + PALETTE_MARGIN
    low_yb, high_yb = min(yellow_blue) - 2 * PALETTE_MARGIN, max(yellow_blue) + 2 * PALETTE_MARGIN
    r, g, b = rgb.split()
    inside = ImageMath.lambda_eval(
        lambda a: ((a["r"] - a["g"]) >= low_rg) & ((a["r"] - a["g"]) <= high_rg)
        & ((a["r"] + a["g"] - a["b"] * 2) >= low_yb) & ((a["r"] + a["g"] - a["b"] * 2) <= high_yb),
        r=r, g=g, b=b,
    )
    return inside.convert("L").point([0] + [255] * 255)


def _fragments(candidates, box, width, limit):
    """Small light islands inside `box` that don't touch its border: bits of the part itself
    (fur tips past the outline, paint between strokes). Large or border-touching islands are
    other objects, such as a sleeve or hand painted in front."""
    from collections import deque

    left, top, right, bottom = box
    keep = bytearray(len(candidates))
    seen = bytearray(len(candidates))
    for y in range(top, bottom):
        for x in range(left, right):
            start = y * width + x
            if not candidates[start] or seen[start]:
                continue
            members, touches = [start], False
            seen[start] = 1
            queue = deque([start])
            while queue:
                index = queue.popleft()
                px, py = index % width, index // width
                if px in (left, right - 1) or py in (top, bottom - 1):
                    touches = True
                for nx, ny in ((px - 1, py), (px + 1, py), (px, py - 1), (px, py + 1)):
                    if left <= nx < right and top <= ny < bottom:
                        neighbor = ny * width + nx
                        if candidates[neighbor] and not seen[neighbor]:
                            seen[neighbor] = 1
                            members.append(neighbor)
                            queue.append(neighbor)
            if not touches and len(members) <= limit:
                for index in members:
                    keep[index] = 255
    return keep


def _complete_hidden(image, known, hidden):
    """Invent paint for `hidden` pixels by pulling colour in from `known` paint, coarse to fine.

    This is a lightweight stand-in for the amodal completion that layer-decomposition tools
    perform: when a part swings out from behind a sleeve, it shows plausible fur instead of a hole.
    """
    from PIL import ImageMath

    box = hidden.getbbox()
    if box is None:
        return image
    margin = 64
    box = (max(0, box[0] - margin), max(0, box[1] - margin),
           min(image.width, box[2] + margin), min(image.height, box[3] + margin))
    rgb = image.convert("RGB").crop(box)
    known_crop, hidden_crop = known.crop(box), hidden.crop(box)
    painted = Image.composite(rgb, Image.new("RGB", rgb.size), known_crop)
    # Start every hidden pixel from the part's average colour, so none keeps the occluder's paint.
    from PIL import ImageStat

    average = tuple(round(value) for value in ImageStat.Stat(rgb, known_crop).mean)
    result = rgb.copy()
    result.paste(Image.new("RGB", rgb.size, average), (0, 0), hidden_crop)
    for radius in (64, 32, 16, 8, 4, 2):
        weight = known_crop.filter(ImageFilter.BoxBlur(radius))
        colour = painted.filter(ImageFilter.BoxBlur(radius))
        channels = [
            ImageMath.lambda_eval(lambda a: a["float"](a["c"]) * 255 / (a["float"](a["w"]) + 0.01),
                                  c=channel, w=weight).convert("L")
            for channel in colour.split()
        ]
        support = ImageChops.multiply(weight.point([0] * 6 + [255] * 250), hidden_crop)
        result.paste(Image.merge("RGB", channels), (0, 0), support)
    completed = image.copy()
    completed.paste(result, box[:2], hidden_crop)
    return completed


def _claim_strokes(own, others, strokes, matte, reach):
    """The line-art and soft-edge pixels that belong to a part, however thick its outline.

    The part's paint and all other paint grow through the strokes together, one pixel per step,
    so each stroke pixel goes to the paint it is closest to: an outline between the part and the
    transparent background goes wholly to the part, and a line it shares with the body splits
    down the middle. The seeds already bound the part, so the outline polygon only limits how far
    this looks (one stroke-reach beyond it): a tight polygon never leaves a second, motionless
    outline on the body.
    """
    steps = 2 * reach
    zone = matte.filter(ImageFilter.MaxFilter(2 * steps + 1))
    box = zone.getbbox()
    if box is None:
        return Image.new("L", own.size)
    crop = lambda image: image.crop(box)  # noqa: E731
    mine, theirs = crop(own), crop(others)
    free = ImageChops.subtract(ImageChops.multiply(crop(strokes), crop(zone)), ImageChops.lighter(mine, theirs))
    claimed = Image.new("L", mine.size)
    grow = ImageFilter.MaxFilter(3)
    for _ in range(steps):
        reach_mine = ImageChops.multiply(mine.filter(grow), free)
        reach_theirs = ImageChops.multiply(theirs.filter(grow), free)
        if reach_mine.getbbox() is None:
            break
        # A pixel both sides reach in the same step stays with the body.
        won = ImageChops.subtract(reach_mine, reach_theirs)
        claimed = ImageChops.lighter(claimed, won)
        mine = ImageChops.lighter(mine, won)
        theirs = ImageChops.lighter(theirs, reach_theirs)
        free = ImageChops.subtract(free, ImageChops.lighter(reach_mine, reach_theirs))
    result = Image.new("L", own.size)
    result.paste(claimed, box[:2])
    return result


def _segment_part(image, matte, spec):
    """Split a seeded part from the body along the drawing's own line art.

    Returns (part matte, body cut). The part owns everything reachable from its seeds without
    crossing line art, plus its small stray bits and the line art and soft edge around them.
    For a part drawn behind the body, outline pixels bordering something painted in front of it
    (a sleeve, a hand, hair) stay on the body, so those occluders keep covering the part.
    """
    width, height = image.size
    alpha = image.getchannel("A")
    opaque = alpha.point([0] * 128 + [255] * 128)
    light = ImageOps.grayscale(image.convert("RGB")).point([0] * LINE_LUMA + [255] * (256 - LINE_LUMA))
    lines = ImageChops.invert(light)
    # Thicken the line art by a pixel so the flood can't slip through thin antialiased strokes.
    barrier = ImageChops.invert(lines.filter(ImageFilter.MaxFilter(3)))
    painted = ImageChops.multiply(light, opaque)
    seed_pixels = [tuple(round(value) for value in _pixel(point, image.size)) for point in spec.seeds]
    palette = _palette_mask(image, seed_pixels)
    # A hand-drawn outline easily runs a few pixels inside the part's silhouette edge, cutting off
    # its rim. Let the flood search a small margin past the outline, but only next to the
    # transparent background: inside the figure, pale neighbours with soft lines (hair, skin)
    # could pass the colour gate, so there the outline stays the bound.
    slack = 2 * max(2, round(0.015 * max(width, height))) + 1
    silhouette = ImageChops.invert(opaque).filter(ImageFilter.MaxFilter(slack))
    search = ImageChops.lighter(matte, ImageChops.multiply(matte.filter(ImageFilter.MaxFilter(slack)), silhouette))
    fillable = ImageChops.multiply(ImageChops.multiply(ImageChops.multiply(barrier, opaque), search), palette)
    data = fillable.tobytes()
    seeds = []
    for x, y in seed_pixels:
        index = _nearest_fillable(data, width, height, x, y, max(3, round(0.01 * max(width, height))))
        if index is None:
            raise ValueError(f"{spec.name}: put each seed on the part's own paint, inside its outline")
        seeds.append(index)
    region = Image.frombytes("L", image.size, bytes(_flood(data, width, seeds)))
    if region.getbbox() is None:
        raise ValueError(f"{spec.name}: the seeds did not reach any of the part's paint")
    reach = 2 * max(2, round(0.0045 * max(width, height))) + 1
    # Recover paint hidden under the thickened barrier, then add the part's own small islands.
    region = ImageChops.multiply(region.filter(ImageFilter.MaxFilter(3)), painted)
    left, top, right, bottom = matte.getbbox()
    box = (max(0, left - reach), max(0, top - reach), min(width, right + reach), min(height, bottom + reach))
    candidates = ImageChops.subtract(painted, region).tobytes()
    limit = max(50, int(0.015 * sum(region.histogram()[1:])))
    islands = Image.frombytes("L", image.size, bytes(_fragments(candidates, box, width, limit)))
    own = ImageChops.lighter(region, ImageChops.multiply(islands, matte))
    # Around the part, take only line art and soft (semi-transparent) edge pixels, never other paint.
    edges = ImageChops.multiply(ImageChops.lighter(lines, ImageChops.invert(opaque)), alpha.point([0] + [255] * 255))
    # Light antialiasing specks just outside an outline are not real neighbours: erode them away.
    others = ImageChops.subtract(painted, own).filter(ImageFilter.MinFilter(5))
    near = _claim_strokes(own, others, edges, matte, reach)
    grown = ImageChops.multiply(ImageChops.lighter(own, near), alpha.point([0] + [255] * 255))
    if not spec.behind:
        # A part drawn in front owns its whole outline; what it overlaps sits behind it.
        return grown, grown, image
    occluders = ImageChops.subtract(painted, own)
    # Outline pixels next to real occluders (not antialiasing specks) stay on the body.
    keep = ImageChops.multiply(ImageChops.multiply(grown, lines), others.filter(ImageFilter.MaxFilter(reach)))
    # Behind the occluders the part was never drawn: extend its paint there (within the outline
    # and near the part) so swinging out from behind a sleeve reveals fur rather than a gap.
    near_part = own.filter(ImageFilter.BoxBlur(2 * reach)).point([0] + [255] * 255)
    hidden = ImageChops.multiply(ImageChops.multiply(ImageChops.lighter(occluders, keep), matte), near_part)
    known = ImageChops.multiply(own, light)
    completed = _complete_hidden(image, known, ImageChops.lighter(hidden, keep))
    return ImageChops.lighter(grown, hidden), ImageChops.subtract(grown, keep), completed


def _stationary_cut(cut, root, axis, anchor_fraction):
    # Keep a strip of original skin under the part on the fixed side of the joint.
    # The same pixels are present in the layered limb, where the mesh remains at rest.
    dx, dy = axis
    length = (dx * dx + dy * dy) ** 0.5
    nx, ny = -dy / length, dx / length
    tx, ty = dx / length, dy / length
    joint_x, joint_y = root[0] + dx * anchor_fraction * 0.58, root[1] + dy * anchor_fraction * 0.58
    reach = 2 * sum(cut.size)
    a = joint_x + nx * reach, joint_y + ny * reach
    b = joint_x - nx * reach, joint_y - ny * reach
    moving = Image.new("L", cut.size)
    ImageDraw.Draw(moving).polygon((a, b, (b[0] + tx * reach, b[1] + ty * reach),
                                  (a[0] + tx * reach, a[1] + ty * reach)), fill=255)
    return ImageChops.multiply(cut, moving)


def _axis_grid(length):
    sections = min(18, max(2, ceil(length / 13)))
    return sorted({round(length * index / sections) for index in range(sections + 1)})


def _mesh(alpha, root, axis, anchor_fraction):
    xs, ys = _axis_grid(alpha.width), _axis_grid(alpha.height)
    span = axis[0] ** 2 + axis[1] ** 2
    vertices = []
    width = len(xs)
    for y in ys:
        for x in xs:
            projected = ((x - root[0]) * axis[0] + (y - root[1]) * axis[1]) / span
            t = max(0, min(1, (projected - anchor_fraction) / (1 - anchor_fraction)))
            # The outer weight lets physics bend the far half more, like a second bone.
            outer = max(0, min(1, (projected - 0.45) / 0.55))
            vertices.append((x, y, t * t * (3 - 2 * t), outer * outer * (3 - 2 * outer)))
    triangles = []
    for j, (y0, y1) in enumerate(pairwise(ys)):
        for i, (x0, x1) in enumerate(pairwise(xs)):
            near = (max(0, x0 - 1), max(0, y0 - 1), min(alpha.width, x1 + 1), min(alpha.height, y1 + 1))
            if alpha.crop(near).getbbox() is None:
                continue
            a = j * width + i
            b, c, d = a + 1, a + width, a + width + 1
            triangles.extend(((a, b, c), (b, d, c)))
    return tuple(vertices), tuple(triangles)


@dataclass(frozen=True, slots=True)
class _Part:
    spec: RigPartSpec
    image: Image.Image
    premultiplied: Image.Image
    position: tuple[int, int]
    root: tuple[float, float]
    vertices: tuple[tuple[int, int, float, float], ...]
    triangles: tuple[tuple[int, int, int], ...]


def _prepare_part(image, spec):
    root, tip = _pixel(spec.root, image.size), _pixel(spec.tip, image.size)
    axis = tip[0] - root[0], tip[1] - root[1]
    if axis[0] ** 2 + axis[1] ** 2 < 9:
        raise ValueError(f"{spec.name}: put the root and tip at least three pixels apart")
    if spec.foot_ik is not None:
        _, knee, _ = _leg_points(spec, image.size)
        knee_fraction = ((knee[0] - root[0]) * axis[0] + (knee[1] - root[1]) * axis[1]) / (axis[0] ** 2 + axis[1] ** 2)
        if not spec.anchor_fraction + 0.03 < knee_fraction < spec.foot_ik.foot_fraction - 0.03:
            raise ValueError(f"{spec.name}: place the knee between the fixed hip area and the rigid foot")

    matte = _matte(image.size, spec.polygon)
    segmented_cut = None
    paint = image
    if spec.seeds:
        matte, segmented_cut, paint = _segment_part(image, matte, spec)
    alpha = ImageChops.multiply(image.getchannel("A"), matte)
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError(f"{spec.name}: outline does not include visible artwork")
    cut = matte if segmented_cut is None else segmented_cut
    if spec.cut_polygon is not None:
        cut = ImageChops.multiply(cut, _matte(image.size, spec.cut_polygon))
    cut = _stationary_cut(cut, root, axis, spec.anchor_fraction)
    if ImageChops.multiply(alpha, ImageChops.invert(cut)).getbbox() is None:
        raise ValueError(f"{spec.name}: leave visible overlap around the fixed joint")

    left, top, right, bottom = bounds
    bounds = max(0, left - 2), max(0, top - 2), min(image.width, right + 2), min(image.height, bottom + 2)
    crop = paint.crop(bounds)
    crop_alpha = alpha.crop(bounds)
    crop.putalpha(crop_alpha)
    local_root = root[0] - bounds[0], root[1] - bounds[1]
    vertices, triangles = _mesh(crop_alpha, local_root, axis, spec.anchor_fraction)
    if not any(vertex[2] > 0 for vertex in vertices):
        raise ValueError(f"{spec.name}: outline needs a flexible section beyond the root")
    return _Part(spec, crop, premultiplied(crop), bounds[:2], local_root, vertices, triangles), cut


def _sample_pixels(mask, count=60):
    """Up to `count` pixel positions spread evenly over a mask's set pixels."""
    width = mask.width
    positions = [index for index, value in enumerate(mask.tobytes()) if value]
    step = max(1, len(positions) // count)
    return [(index % width, index // width) for index in positions[::step]]


SEAM_WARNING = 0.1  # Above this share, a hand-drawn outline leaves a visible sliver.


def seam_report(image: Image.Image, spec: "RigSpec", *, max_side: int = MAX_IMAGE_SIDE) -> dict[str, float]:
    """Share of each hand-outlined part's cut edge that runs through its own paint.

    A cut that follows the drawing's outlines (or a seeded part) is seamless. A cut through
    paint leaves a sliver of the part on the body, which tears away as a crack when the part
    moves. The deliberate cut across the fixed joint is not counted. Returns {part: ratio}.
    """
    rgba = ImageOps.exif_transpose(image).convert("RGBA")
    rgba.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    opaque = rgba.getchannel("A").point([0] * 128 + [255] * 128)
    light = ImageOps.grayscale(rgba.convert("RGB")).point([0] * LINE_LUMA + [255] * (256 - LINE_LUMA))
    painted = ImageChops.multiply(light, opaque)
    report = {}
    for part in spec.parts:
        _, cut = _prepare_part(rgba, part)
        if part.seeds:
            # Seeded parts are cut along the drawing's line art by construction.
            report[part.name] = 0.0
            continue
        ring = ImageChops.subtract(cut.filter(ImageFilter.MaxFilter(3)), cut)
        inner_edge = ImageChops.subtract(cut, cut.filter(ImageFilter.MinFilter(3)))
        # A sliver is the part's own colour just outside the cut; a different colour across the
        # edge (a sleeve against fur) is a correct cut even where the line art is faint.
        own_colour = _palette_mask(rgba, _sample_pixels(ImageChops.multiply(cut, painted)))
        through = ImageChops.multiply(
            ImageChops.multiply(ImageChops.multiply(ring, painted), own_colour),
            ImageChops.multiply(inner_edge, painted).filter(ImageFilter.MaxFilter(3)),
        )
        # Ignore the band around the joint, where the fixed strip is cut through paint on purpose.
        root, tip = _pixel(part.root, rgba.size), _pixel(part.tip, rgba.size)
        dx, dy = tip[0] - root[0], tip[1] - root[1]
        length = hypot(dx, dy)
        nx, ny, tx, ty = -dy / length, dx / length, dx / length, dy / length
        centre = part.anchor_fraction * 0.58 * length
        half = 0.06 * length + 3
        reach = 2 * sum(rgba.size)
        band = Image.new("L", rgba.size)
        corners = []
        for along, side in ((centre - half, reach), (centre - half, -reach), (centre + half, -reach), (centre + half, reach)):
            corners.append((root[0] + tx * along + nx * side, root[1] + ty * along + ny * side))
        ImageDraw.Draw(band).polygon(corners, fill=255)
        through = ImageChops.subtract(through, band)
        ring_size = sum(ImageChops.subtract(ring, band).histogram()[1:])
        report[part.name] = round(sum(through.histogram()[1:]) / max(1, ring_size), 4)
    return report


def _smoothstep(value):
    t = max(0.0, min(1.0, value))
    return t * t * (3 - 2 * t)


def _move_leg_vertices(part, phase, size):
    spec = part.spec
    pose = foot_ik_pose(spec, size, phase % 1)
    if pose.planted:
        return None
    _, knee, foot = _leg_points(spec, size)
    if pose.foot == foot:
        return None
    ox, oy = part.position
    root = part.root
    knee, foot = (knee[0] - ox, knee[1] - oy), (foot[0] - ox, foot[1] - oy)
    knee_dx, knee_dy = pose.knee[0] - ox - knee[0], pose.knee[1] - oy - knee[1]
    foot_dx, foot_dy = pose.foot[0] - ox - foot[0], pose.foot[1] - oy - foot[1]
    ax, ay = foot[0] - root[0], foot[1] - root[1]
    span = ax * ax + ay * ay
    knee_fraction = ((knee[0] - root[0]) * ax + (knee[1] - root[1]) * ay) / span
    anchor, foot_fraction = spec.anchor_fraction, spec.foot_ik.foot_fraction
    # Move each skin cross-section along the solved joint displacement field.
    # This retains the width of thick cartoon legs while bending their centerline,
    # and keeps the cuff and paw as rigid patches on either side of the bend.
    positions = []
    for x, y, *_ in part.vertices:
        t = ((x - root[0]) * ax + (y - root[1]) * ay) / span
        if t <= knee_fraction:
            blend = _smoothstep((t - anchor) / (knee_fraction - anchor))
            positions.append((x + knee_dx * blend, y + knee_dy * blend))
        else:
            blend = _smoothstep((t - knee_fraction) / (foot_fraction - knee_fraction))
            positions.append((x + knee_dx + (foot_dx - knee_dx) * blend,
                              y + knee_dy + (foot_dy - knee_dy) * blend))
    return positions


def target_angle(spec, clock):
    """The animated rest angle of a wave or swing part, before any physics."""
    return spec.rotation_bias + spec.rotation_deg * sin(tau * (clock + spec.phase_offset))


def _move_vertices(part, phase, size, angles=None):
    """Vertex positions at `phase`; `angles` (inner, outer) from physics replace the plain bend."""
    spec = part.spec
    if spec.foot_ik is not None:
        return _move_leg_vertices(part, phase, size)
    angle = tau * (phase + spec.phase_offset)
    swing = sin(angle)
    if spec.motion == "step":
        shift_x = spec.movement_x * size[0] * cos(angle)
        shift_y = -spec.movement_y * size[1] * max(0, swing) ** 1.35
        bend = spec.rotation_bias + spec.rotation_deg * cos(angle)
    else:
        shift_x = spec.movement_x * size[0] * swing
        shift_y = -spec.movement_y * size[1] * swing
        bend = target_angle(spec, phase)
    inner, outer = angles if angles is not None else (bend, bend)

    root_x, root_y = part.root
    turned = []
    for x, y, weight, tip in part.vertices:
        angle = radians(inner * weight + (outer - inner) * tip)
        horizontal, vertical = x - root_x, y - root_y
        turned.append((
            root_x + horizontal * cos(angle) + vertical * sin(angle) + shift_x * weight,
            root_y - horizontal * sin(angle) + vertical * cos(angle) + shift_y * weight,
        ))
    return turned


def _paint_triangle(result, source, original, target, left, top):
    box_left = floor(min(x for x, _ in target))
    box_top = floor(min(y for _, y in target))
    box_right = ceil(max(x for x, _ in target)) + 1
    box_bottom = ceil(max(y for _, y in target)) + 1
    size = box_right - box_left, box_bottom - box_top

    (x0, y0), (x1, y1), (x2, y2) = target
    xu, yu, xv, yv = x1 - x0, y1 - y0, x2 - x0, y2 - y0
    determinant = xu * yv - xv * yu
    if determinant <= 0.02:
        return False
    (p0, q0), (p1, q1), (p2, q2) = original
    a = ((p1 - p0) * yv - (p2 - p0) * yu) / determinant
    b = ((p2 - p0) * xu - (p1 - p0) * xv) / determinant
    d = ((q1 - q0) * yv - (q2 - q0) * yu) / determinant
    e = ((q2 - q0) * xu - (q1 - q0) * xv) / determinant
    tx, ty = box_left - x0, box_top - y0
    affine = a, b, p0 + a * tx + b * ty, d, e, q0 + d * tx + e * ty
    transformed = source.transform(size, Image.Transform.AFFINE, affine, Image.Resampling.BILINEAR)
    mask = Image.new("1", size)
    # Painting the outline too makes neighbouring triangles share their edge pixels,
    # so no hairline cracks open along the mesh as it bends.
    ImageDraw.Draw(mask).polygon([(round(x) - box_left, round(y) - box_top) for x, y in target], fill=1, outline=1)
    result.paste(transformed, (box_left - left, box_top - top), mask)
    return True


def _warp(part, phase, size, angles=None):
    targets = _move_vertices(part, phase, size, angles)
    if targets is None:
        return part.image, part.position
    left = floor(min(x for x, _ in targets))
    top = floor(min(y for _, y in targets))
    right = ceil(max(x for x, _ in targets)) + 1
    bottom = ceil(max(y for _, y in targets)) + 1
    # Warp premultiplied pixels so bilinear filtering never mixes in dark transparent colors.
    result = Image.new("RGBa", (right - left, bottom - top))
    for indices in part.triangles:
        original = tuple(part.vertices[index][:2] for index in indices)
        target = tuple(targets[index] for index in indices)
        if not _paint_triangle(result, part.premultiplied, original, target, left, top):
            raise ValueError(f"{part.spec.name}: reduce movement so the mesh does not fold over")
    result = result.convert("RGBA")
    position = part.position[0] + left, part.position[1] + top
    ink = result.getchannel("A").point([0] * 64 + [255] * 192).getbbox()
    if ink is None or not (0 <= position[0] + ink[0] < position[0] + ink[2] <= size[0]
                          and 0 <= position[1] + ink[1] < position[1] + ink[3] <= size[1]):
        raise ValueError(f"{part.spec.name}: keep visible pixels on the canvas or reduce movement")
    return result, position


def _body_transform(motion, cycles, figure_height, phase):
    """Horizontal scale, vertical scale and lift (pixels, upward) of the whole figure."""
    if motion is None:
        return 1.0, 1.0, 0.0
    beat = motion.beats * (phase % 1) * cycles - motion.phase_offset
    lift = 0.0
    if motion.style == "bob":
        scale_y = 1 + motion.bob * cos(tau * beat)
    elif motion.style == "breathe":
        scale_y = breathe_pose(beat, motion.bob)
    else:
        scale_y, height = jump_pose(beat, motion.jump_squash)
        lift = motion.jump_height * figure_height * height
    return 1 - motion.squash * (scale_y - 1), scale_y, lift


@dataclass(frozen=True, slots=True)
class PreparedRig:
    """Reusable, ordered mesh layers built from one transparent original."""

    _body: Image.Image
    _back: tuple[_Part, ...]
    _front: tuple[_Part, ...]
    _cycles: int
    _motion: BodyMotionSpec | None = None
    _pivot: tuple[float, float] = (0.0, 0.0)
    _bounds: tuple[int, int, int, int] = (0, 0, 0, 0)
    _period: float = 3.0
    _angles: tuple[tuple[str, tuple[float, ...], tuple[float, ...]], ...] = ()
    _eyes: tuple = ()
    _blink: BlinkSpec | None = None

    @property
    def size(self):
        return self._body.size

    @property
    def pivot(self) -> tuple[float, float]:
        return self._pivot

    @property
    def bounds(self) -> tuple[int, int, int, int]:
        """Visible artwork box in rig pixels."""
        return self._bounds

    def body_transform(self, phase: float) -> tuple[float, float, float]:
        """(scale_x, scale_y, lift_pixels) of the whole figure about the ground pivot."""
        return _body_transform(self._motion, self._cycles, self._pivot[1] - self._bounds[1], phase)

    def body_scale(self, phase: float) -> tuple[float, float]:
        scale_x, scale_y, _ = self.body_transform(phase)
        return scale_x, scale_y

    def physics_angles(self, name: str, phase: float) -> tuple[float, float] | None:
        """Inner and outer bend (degrees) of a physics-driven part at `phase`."""
        for part_name, inner, outer in self._angles:
            if part_name == name:
                return interpolate(inner, phase), interpolate(outer, phase)
        return None

    def blink_closure(self, phase: float) -> float:
        if self._blink is None or not self._eyes:
            return 0.0
        return blink_closure((phase % 1) * self._period, self._period, self._blink.count, self._blink.double)

    def frame(self, phase: float, *, body: bool = True) -> Image.Image:
        """Compose the limbs at `phase`; `body=False` leaves the whole-figure motion to the caller."""
        if not isfinite(phase) or not 0 <= phase <= 1:
            raise ValueError("Rig phase must be between 0 and 1")
        frame = Image.new("RGBA", self.size)
        clock = (phase % 1) * self._cycles
        for part in self._back:
            sprite, xy = _warp(part, clock, self.size, self.physics_angles(part.spec.name, phase))
            frame.alpha_composite(sprite, xy)
        frame.alpha_composite(self._body)
        for part in self._front:
            sprite, xy = _warp(part, clock, self.size, self.physics_angles(part.spec.name, phase))
            frame.alpha_composite(sprite, xy)
        closure = self.blink_closure(phase)
        if closure > 0.01:
            from character_animation import _blink

            _blink(frame, self._eyes, closure)
        scale_x, scale_y, lift = self.body_transform(phase)
        if body and (scale_x, scale_y, lift) != (1.0, 1.0, 0.0):
            # Scaling about the ground line keeps planted soles in place while the body bobs.
            frame = affine(frame, scale=(scale_x, scale_y), pivot=self._pivot, offset=(0, -lift))
        return frame

    def part_overflow(self, samples: int = 64) -> tuple[float, float, float, float]:
        """How far (pixels) the moving parts' meshes reach past each canvas edge over one loop."""
        width, height = self.size
        reach = [0.0, 0.0, 0.0, 0.0]
        for index in range(samples):
            phase = index / samples
            clock = phase * self._cycles
            for part in (*self._back, *self._front):
                targets = _move_vertices(part, clock, self.size, self.physics_angles(part.spec.name, phase))
                if targets is None:
                    continue
                xs = [part.position[0] + x for x, _ in targets]
                ys = [part.position[1] + y for _, y in targets]
                reach = [max(reach[0], -min(xs)), max(reach[1], -min(ys)),
                         max(reach[2], max(xs) - width), max(reach[3], max(ys) - height)]
        return tuple(reach)


def _visible_bounds(alpha):
    # Ignore faint antialiasing haze, which can sit far below the visible feet.
    return alpha.point([0] * 64 + [255] * 192).getbbox() or alpha.getbbox()


def _body_pivot(alpha, motion):
    # Continuous coordinates: the default pivot sits exactly on the lower edge of the soles.
    left, _, right, bottom = _visible_bounds(alpha)
    width, height = alpha.size
    x = motion.center_x * width if motion is not None and motion.center_x is not None else (left + right) / 2
    y = motion.ground_y * height if motion is not None and motion.ground_y is not None else bottom
    return x, y


def _folds(part, clock, size, angles):
    """True when bending `part` to `angles` would turn any mesh triangle inside out."""
    targets = _move_vertices(part, clock, size, angles)
    if targets is None:
        return False
    for a, b, c in part.triangles:
        (x0, y0), (x1, y1), (x2, y2) = targets[a], targets[b], targets[c]
        if (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0) <= 0.02:
            return True
    return False


def _tame(prepared, cycles, size, phases, target, inner, outer):
    """Scale the physics offset down until the extreme poses no longer fold the mesh."""
    candidates = set()
    for values in (inner, outer, [o - i for i, o in zip(inner, outer)]):
        candidates.add(max(range(len(values)), key=values.__getitem__))
        candidates.add(min(range(len(values)), key=values.__getitem__))
    scale = 1.0
    for _ in range(12):
        scaled = [(t + scale * (i - t), t + scale * (o - t)) for t, i, o in zip(target, inner, outer)]
        if not any(_folds(prepared, phases[index] * cycles, size, scaled[index]) for index in candidates):
            break
        scale *= 0.8
    return [i for i, _ in scaled], [o for _, o in scaled]


def _physics_tables(spec, size, pivot, figure_height, period, prepared=None):
    """Solve every physics part's steady-state bend over one loop, never folding its mesh."""
    phases = sample_phases()
    transforms = [_body_transform(spec.body, spec.cycles, figure_height, phase) for phase in phases]
    tables = []
    for part in spec.parts:
        if part.physics is None:
            continue
        root, tip = _pixel(part.root, size), _pixel(part.tip, size)
        length = hypot(tip[0] - root[0], tip[1] - root[1])
        direction = (tip[0] - root[0]) / length, (tip[1] - root[1]) / length
        xs = [pivot[0] + scale_x * (root[0] - pivot[0]) for scale_x, _, _ in transforms]
        ys = [pivot[1] + scale_y * (root[1] - pivot[1]) - lift for _, scale_y, lift in transforms]
        accel_x, accel_y = periodic_acceleration(xs, period), periodic_acceleration(ys, period)
        # Pseudo-force of the accelerating root on the part, as a counterclockwise angular push.
        drive = [part.physics.inertia * (direction[0] * ay - direction[1] * ax) / length * 180 / pi
                 for ax, ay in zip(accel_x, accel_y)]
        target = [target_angle(part, phase * spec.cycles) for phase in phases]
        inner, outer = solve_spring(target, drive, period, part.physics)
        if prepared is not None and part.name in prepared:
            inner, outer = _tame(prepared[part.name], spec.cycles, size, phases, target, inner, outer)
        tables.append((part.name, tuple(inner), tuple(outer)))
    return tuple(tables)


def _eye_layers(rgba, blink):
    from character_animation import _auto_eyes, _make_eye, _subject

    width, height = rgba.size
    if blink.eyes is None:
        points = _auto_eyes(rgba, _subject(rgba)[0])
    else:
        points = [(x * (width - 1), y * (height - 1), rx * width, ry * height) for x, y, rx, ry in blink.eyes]
    return tuple(_make_eye(rgba, eye) for eye in points)


def prepare_rig(image: Image.Image, spec: RigSpec, *, max_side: int = MAX_IMAGE_SIDE,
                duration: float = 3.0) -> PreparedRig:
    """Prepare cutout meshes, physics tables and eyelids for one loop of `duration` seconds."""
    if not isfinite(duration) or not 0.2 <= duration <= 30:
        raise ValueError("Rig loops must last 0.2 to 30 seconds")
    rgba = ImageOps.exif_transpose(image).convert("RGBA")
    rgba.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    alpha = rgba.getchannel("A")
    low, high = alpha.getextrema()
    if low != 0 or high < 64:
        raise ValueError("Rigging needs visible artwork surrounded by a transparent background")
    back, front = [], []
    cuts = Image.new("L", rgba.size)
    for part in spec.parts:
        layer, cut = _prepare_part(rgba, part)
        cuts = ImageChops.lighter(cuts, cut)
        (back if part.behind else front).append(layer)
    body = rgba.copy()
    body.putalpha(ImageChops.multiply(alpha, ImageChops.invert(cuts)))
    bounds = _visible_bounds(alpha)
    pivot = _body_pivot(alpha, spec.body)
    layers = {layer.spec.name: layer for layer in (*back, *front)}
    angles = _physics_tables(spec, rgba.size, pivot, pivot[1] - bounds[1], duration, layers)
    eyes = _eye_layers(rgba, spec.blink) if spec.blink is not None else ()
    return PreparedRig(body, tuple(back), tuple(front), spec.cycles, spec.body, pivot, bounds,
                       duration, angles, eyes, spec.blink)


def rig_output_size(image: Image.Image) -> tuple[int, int]:
    width, height = image.size
    scale = min(1, MAX_IMAGE_SIDE / max(width, height))
    return max(1, round(width * scale)), max(1, round(height * scale))


def pad_for_swing(image: Image.Image, spec: RigSpec, *, duration: float = 3.0):
    """Give parts that swing past the canvas edge transparent room, keeping every landmark in place.

    Generated or cropped art often puts long ears, tails or hands right at the edge, where a swing
    would carry them off the canvas. This measures each part's real reach over one loop (physics
    included) and, only when something leaves the frame, pads the image on those sides.

    Returns (image, spec, remap): the RGBA image (padded or not), the rig moved onto it, and a
    function that maps other normalized (x, y) points, such as review boxes, the same way.
    """
    rgba = ImageOps.exif_transpose(image).convert("RGBA")
    probe_size = rig_output_size(rgba)
    probe = rgba if rgba.size == probe_size else premultiplied(rgba).resize(
        probe_size, Image.Resampling.LANCZOS).convert("RGBA")
    overflow = prepare_rig(probe, spec, max_side=max(probe_size), duration=duration).part_overflow()
    if not any(value > 0 for value in overflow):
        return rgba, spec, lambda point: tuple(point)
    scale = rgba.width / probe.width
    margin = 0.02 * max(probe_size)
    left, top, right, bottom = (ceil((value + margin) * scale) if value > 0 else 0 for value in overflow)
    width, height = rgba.size
    padded = Image.new("RGBA", (width + left + right, height + top + bottom))
    padded.paste(rgba, (left, top))
    new_width, new_height = padded.size

    def remap(point):
        x, y = point
        return (x * (width - 1) + left) / (new_width - 1), (y * (height - 1) + top) / (new_height - 1)

    data = spec.model_dump()
    for part in data["parts"]:
        for key in ("polygon", "cut_polygon", "seeds"):
            if part[key] is not None:
                part[key] = [remap(point) for point in part[key]]
        part["root"], part["tip"] = remap(part["root"]), remap(part["tip"])
        if part["foot_ik"] is not None:
            part["foot_ik"]["knee"] = remap(part["foot_ik"]["knee"])
        # Movement is a fraction of the canvas, so keep the same distance in pixels.
        part["movement_x"] *= width / new_width
        part["movement_y"] *= height / new_height
    if data["blink"] is not None and data["blink"]["eyes"] is not None:
        data["blink"]["eyes"] = [(*remap((x, y)), rx * width / new_width, ry * height / new_height)
                                 for x, y, rx, ry in data["blink"]["eyes"]]
    if data["body"] is not None:
        if data["body"]["center_x"] is not None:
            data["body"]["center_x"] = (data["body"]["center_x"] * width + left) / new_width
        if data["body"]["ground_y"] is not None:
            data["body"]["ground_y"] = (data["body"]["ground_y"] * height + top) / new_height
    return padded, RigSpec.model_validate(data), remap


def _canvas_padding(rig, factor):
    """Extra room on each side so jumps and squashes never leave the frame."""
    left, top, right, bottom = rig.bounds
    pivot_x, pivot_y = rig.pivot
    width, height = rig.size
    xs, ys = [], []
    for phase in sample_phases(128):
        scale_x, scale_y, lift = rig.body_transform(phase)
        xs += [pivot_x + scale_x * (left - pivot_x), pivot_x + scale_x * (right - pivot_x)]
        ys += [pivot_y + scale_y * (top - pivot_y) - lift, pivot_y + scale_y * (bottom - pivot_y) - lift]

    def room(amount):
        return factor * ceil((amount + 3) / factor) if amount > 0 else 0

    return room(-min(xs)), room(-min(ys)), room(max(xs) - width), room(max(ys) - height)


def render_rig_frames(image: Image.Image, spec: RigSpec, count: int, *, antialias: bool = False,
                      motion_blur: int = 1, duration: float | None = None) -> list[Image.Image]:
    """Render one loop of joint-anchored poses for Gift's animation encoders.

    `antialias` renders the mesh at twice the output resolution and downsamples it, which
    smooths bent edges and sub-pixel limb motion. `motion_blur` averages that many
    sub-frames per output frame for a softer trail on fast movement. `duration` (seconds)
    sets the real-time scale for physics and blinks; it defaults to `count` frames at 25 FPS.
    Jumps extend the canvas upward so the figure never leaves the frame.
    """
    source = ImageOps.exif_transpose(image).convert("RGBA")
    size = rig_output_size(source)
    if type(count) is not int or not 2 <= count <= 240 or count * size[0] * size[1] > RIG_FRAME_PIXELS:
        raise ValueError("Reduce the frame count or image size for this rig")
    if type(motion_blur) is not int or not 1 <= motion_blur <= 5:
        raise ValueError("Motion blur uses 1 to 5 samples per frame")
    factor = 2 if antialias else 1
    work_size = size[0] * factor, size[1] * factor
    if source.size != work_size:
        resampled = premultiplied(source).resize(work_size, Image.Resampling.LANCZOS)
        source = resampled.convert("RGBA")
    rig = prepare_rig(source, spec, max_side=max(work_size), duration=duration or count / 25)
    if spec.body is None:
        return sample_loop(lambda phase: downscale(rig.frame(phase), size), count, samples=motion_blur)

    # Fold the body motion into the single downsampling pass: scaling about the ground pivot
    # and lifting is the same as resizing a shifted source box. A transparent margin keeps
    # that box inside the canvas, and padding keeps jumps inside the output.
    pad_left, pad_top, pad_right, pad_bottom = _canvas_padding(rig, factor)
    width, height = work_size
    out_size = (width + pad_left + pad_right) // factor, (height + pad_top + pad_bottom) // factor
    pivot_x, pivot_y = rig.pivot

    def source_box(phase):
        scale_x, scale_y, lift = rig.body_transform(phase)
        return (
            pivot_x + (-pad_left - pivot_x) / scale_x,
            pivot_y + (-pad_top - pivot_y + lift) / scale_y,
            pivot_x + (width + pad_right - pivot_x) / scale_x,
            pivot_y + (height + pad_bottom - pivot_y + lift) / scale_y,
        )

    boxes = [source_box(phase) for phase in sample_phases(128)]
    overshoot = max([0.0] + [-value for box in boxes for value in box[:2]]
                    + [box[2] - width for box in boxes] + [box[3] - height for box in boxes])
    margin = ceil(overshoot + 0.02 * max(work_size)) + 4
    padded_size = width + 2 * margin, height + 2 * margin

    def render(phase):
        canvas = Image.new("RGBa", padded_size)
        canvas.paste(premultiplied(rig.frame(phase, body=False)), (margin, margin))
        x0, y0, x1, y1 = source_box(phase)
        box = (margin + x0, margin + y0, margin + x1, margin + y1)
        return canvas.resize(out_size, Image.Resampling.LANCZOS, box=box).convert("RGBA")

    return sample_loop(render, count, samples=motion_blur)
