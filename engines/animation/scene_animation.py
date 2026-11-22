"""Composite bounded, opaque scenes from still-image layers and periodic motion."""

from bisect import bisect_right
from dataclasses import dataclass, replace
from itertools import accumulate
from math import ceil, cos, floor, radians, sin, tau
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Annotated

from PIL import Image, ImageDraw, ImageOps, ImageSequence, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field

from smooth import average, shift_subpixel


MAX_SCENE_FRAME_PIXELS = 150_000_000
MAX_SCENE_FRAMES = 240
MAX_SOURCE_PIXELS = 24_000_000
MAX_SOURCE_BYTES = 10 * 1024 * 1024
MAX_SPRITE_PIXELS = 4_000_000
MAX_TOTAL_SPRITE_PIXELS = 16_000_000
MAX_ANIMATED_PIXELS = 48_000_000
MAX_LAYER_FRAMES = 240

Fraction = Annotated[float, Field(ge=0, le=1)]
Position = Annotated[float, Field(ge=-1, le=2)]
Degrees = Annotated[float, Field(ge=-360, le=360)]
Turns = Annotated[int, Field(ge=-12, le=12)]
AssetPath = Annotated[str, Field(min_length=1, max_length=1024)]


class OrbitSpec(BaseModel):
    """An ellipse around the layer center, with radii relative to the canvas axes."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    radius_x: Fraction
    radius_y: Fraction
    turns: Turns = 1
    phase_deg: Degrees = 0
    tilt_deg: Degrees = 0
    depth_scale: Annotated[float, Field(ge=0, le=0.35)] = 0
    guide: bool = False


class LayerSpec(BaseModel):
    """An image layer positioned by its center and sized by canvas width.

    The image can be a still or an animated GIF, APNG, or WebP (for example a Gift
    character loop); `animation_loops` sets how many times it plays per clip.
    `end_x`/`end_y` move the layer in a straight line from (x, y) over the clip:
    start and end off-canvas (below 0 or above 1) for a seamless walk-through.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    image_path: AssetPath
    x: Position = 0.5
    y: Position = 0.5
    end_x: Position | None = None
    end_y: Position | None = None
    width: Annotated[float, Field(gt=0, le=1.5)] = 0.2
    opacity: Fraction = 1
    rotation_deg: Degrees = 0
    spin_turns: Turns = 0
    orbit: OrbitSpec | None = None
    pulse: Annotated[float, Field(ge=0, le=0.35)] = 0
    mirror: bool = False
    animation_loops: Annotated[int, Field(ge=1, le=12)] = 1


class SceneSpec(BaseModel):
    """An opaque background and a list of sprites in back-to-front order."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    width: Annotated[int, Field(ge=32, le=1280)] = 960
    height: Annotated[int, Field(ge=32, le=1280)] = 540
    background_image_path: AssetPath | None = None
    background_color: Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")] = "#000000"
    layers: Annotated[list[LayerSpec], Field(min_length=1, max_length=20)]
    depth_order: bool = False


def _load_frames(path, *, animated=True):
    """Load a still, or every frame and its duration in milliseconds of an animated image."""
    asset = Path(path).expanduser()
    try:
        if not asset.is_absolute() or not asset.is_file():
            raise ValueError(f"Provide an absolute local scene image path: {path}")
        with asset.open("rb") as source:
            if os.fstat(source.fileno()).st_size > MAX_SOURCE_BYTES:
                raise ValueError(f"Scene image exceeds the 10 MiB input limit: {path}")
            with Image.open(source, formats=("PNG", "JPEG", "WEBP", "GIF")) as image:
                if image.width * image.height > MAX_SOURCE_PIXELS:
                    raise ValueError(f"Scene image exceeds 24 megapixels: {path}")
                if not getattr(image, "is_animated", False):
                    return [ImageOps.exif_transpose(image).convert("RGBA")], [1]
                if not animated:
                    raise ValueError(f"Use a still image for the scene background: {path}")
                if image.n_frames > MAX_LAYER_FRAMES:
                    raise ValueError(f"Animated layers can have at most {MAX_LAYER_FRAMES} frames: {path}")
                if image.n_frames * image.width * image.height > MAX_ANIMATED_PIXELS:
                    raise ValueError(f"Animated layer is too large; use fewer or smaller frames: {path}")
                frames, durations = [], []
                decoded_pixels = 0
                for frame in ImageSequence.Iterator(image):
                    # GIF local image descriptors may expand the logical canvas
                    # after the first frame, so initial dimensions are insufficient.
                    pixels = frame.width * frame.height
                    decoded_pixels += pixels
                    if pixels > MAX_SOURCE_PIXELS or decoded_pixels > MAX_ANIMATED_PIXELS:
                        raise ValueError("Animated layer is too large; use fewer or smaller frames")
                    if len(frames) >= MAX_LAYER_FRAMES:
                        raise ValueError(f"Animated layers can have at most {MAX_LAYER_FRAMES} frames: {path}")
                    frames.append(frame.convert("RGBA"))
                    durations.append(max(1, int(frame.info.get("duration") or 100)))
                return frames, durations
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError) as exc:
        raise ValueError(f"Cannot open a PNG, JPEG, WebP, or GIF image: {path}") from exc


def _load_image(path):
    return _load_frames(path, animated=False)[0][0]


def _orbit_offset(orbit, theta, width, height):
    tilt = radians(orbit.tilt_deg)
    x = orbit.radius_x * width * cos(theta)
    y = orbit.radius_y * height * sin(theta)
    return x * cos(tilt) - y * sin(tilt), x * sin(tilt) + y * cos(tilt)


def _draw_guides(background, layers):
    width, height = background.size
    guides = Image.new("RGBA", (width * 2, height * 2))
    draw = ImageDraw.Draw(guides)
    for layer in layers:
        orbit = layer.orbit
        if orbit is None or not orbit.guide:
            continue
        points = []
        for index in range(361):
            dx, dy = _orbit_offset(orbit, tau * index / 360, width, height)
            points.append((round(2 * (layer.x * width + dx)), round(2 * (layer.y * height + dy))))
        for index, (a, b) in enumerate(zip(points, points[1:])):
            opacity = round(24 + 8 * sin(tau * index / 360))
            draw.line((*a, *b), fill=(108, 140, 193, opacity), width=2)
    background.alpha_composite(guides.resize(background.size, Image.Resampling.LANCZOS))


def _transform(sprite, width, angle):
    dimensions = width, max(1, round(sprite.height * width / sprite.width))
    if dimensions != sprite.size:
        sprite = sprite.resize(dimensions, Image.Resampling.LANCZOS)
    if angle % 360:
        sprite = sprite.rotate(angle, Image.Resampling.BICUBIC, expand=True)
    return sprite


@dataclass(frozen=True, slots=True)
class _Layer:
    spec: LayerSpec
    sources: tuple[Image.Image, ...]
    ends: tuple[int, ...]
    fixed: tuple[Image.Image, ...] | None

    @property
    def source(self):
        return self.sources[0]

    def index(self, phase):
        if len(self.sources) == 1:
            return 0
        elapsed = ((phase * self.spec.animation_loops) % 1) * self.ends[-1]
        return min(len(self.sources) - 1, bisect_right(self.ends, elapsed))


@dataclass(frozen=True, slots=True)
class PreparedScene:
    _background: Image.Image
    _layers: tuple[_Layer, ...]
    _depth_order: bool
    _blur_samples: int = 1
    _blur_spread: float = 0.0

    def with_motion_blur(self, frame_count: int, samples: int = 3, shutter: float = 0.5) -> "PreparedScene":
        """Average `samples` sub-frames spread over `shutter` of each frame interval."""
        if samples <= 1:
            return replace(self, _blur_samples=1, _blur_spread=0.0)
        return replace(self, _blur_samples=samples, _blur_spread=shutter / frame_count)

    @property
    def size(self):
        return self._background.size

    @property
    def width(self):
        return self._background.width

    @property
    def height(self):
        return self._background.height

    def frame(self, phase: float) -> Image.Image:
        """Render an opaque RGB frame at a normalized phase from 0 through 1."""
        if not 0 <= phase <= 1:
            raise ValueError("Scene phase must be between 0 and 1")
        if self._blur_samples <= 1:
            return self._frame(phase % 1)
        offsets = [self._blur_spread * ((index + 0.5) / self._blur_samples - 0.5) for index in range(self._blur_samples)]
        return average(self._frame((phase + offset) % 1) for offset in offsets)

    def _frame(self, phase: float) -> Image.Image:
        image = self._background.copy()
        width, height = image.size
        placements = []
        for layer in self._layers:
            spec = layer.spec
            x, y = spec.x * width, spec.y * height
            if spec.end_x is not None:
                x += (spec.end_x - spec.x) * width * phase
            if spec.end_y is not None:
                y += (spec.end_y - spec.y) * height * phase
            scale, depth = 1 + spec.pulse * sin(tau * phase), 0
            if spec.orbit is not None:
                orbit = spec.orbit
                theta = radians(orbit.phase_deg) + tau * orbit.turns * phase
                dx, dy = _orbit_offset(orbit, theta, width, height)
                x, y = x + dx, y + dy
                depth = sin(theta)
                scale *= 1 + orbit.depth_scale * depth
            index = layer.index(phase)
            if layer.fixed is not None:
                sprite = layer.fixed[index]
            else:
                sprite = _transform(
                    layer.sources[index], max(1, round(spec.width * width * scale)),
                    spec.rotation_deg + 360 * spec.spin_turns * phase,
                )
            # Keep the fractional position so slow movement glides instead of stepping by whole pixels.
            left, top = x - sprite.width / 2, y - sprite.height / 2
            column, row = floor(left), floor(top)
            sprite = shift_subpixel(sprite, left - column, top - row)
            placements.append((depth, sprite, column, row))
        if self._depth_order:
            placements.sort(key=lambda item: item[0])
        for _, sprite, x, y in placements:
            _composite_clipped(image, sprite, x, y)
        return image.convert("RGB")


def _composite_clipped(image, sprite, x, y):
    """Alpha-composite a sprite that may hang partly or fully outside the canvas."""
    left, top = max(0, x), max(0, y)
    right, bottom = min(image.width, x + sprite.width), min(image.height, y + sprite.height)
    if right <= left or bottom <= top:
        return
    if (left, top, right, bottom) != (x, y, x + sprite.width, y + sprite.height):
        sprite = sprite.crop((left - x, top - y, right - x, bottom - y))
    image.alpha_composite(sprite, (left, top))


def prepare_scene(spec: SceneSpec) -> PreparedScene:
    """Load and bound the assets used repeatedly when rendering frames."""
    background = Image.new("RGBA", (spec.width, spec.height), spec.background_color)
    if spec.background_image_path:
        source = _load_image(spec.background_image_path)
        background.alpha_composite(ImageOps.fit(source, background.size, Image.Resampling.LANCZOS))
    if any(layer.orbit is not None and layer.orbit.guide for layer in spec.layers):
        _draw_guides(background, spec.layers)

    layers = []
    total_pixels = 0
    for layer in spec.layers:
        frames, durations = _load_frames(layer.image_path)
        first = frames[0]
        depth_scale = layer.orbit.depth_scale if layer.orbit else 0
        maximum_width = ceil(spec.width * layer.width * (1 + layer.pulse) * (1 + depth_scale))
        maximum_height = max(1, ceil(first.height * maximum_width / first.width))
        pixels = maximum_width * maximum_height
        if layer.rotation_deg or layer.spin_turns:
            pixels = maximum_width ** 2 + maximum_height ** 2
        total_pixels += pixels * len(frames) if len(frames) > 1 else pixels
        if pixels > MAX_SPRITE_PIXELS or total_pixels > max(MAX_TOTAL_SPRITE_PIXELS, MAX_ANIMATED_PIXELS):
            raise ValueError("Scene layers are too large after scaling or rotation")
        sources = []
        for source in frames:
            source.thumbnail((maximum_width, maximum_height), Image.Resampling.LANCZOS)
            if layer.mirror:
                source = ImageOps.mirror(source)
            if layer.opacity != 1:
                source.putalpha(source.getchannel("A").point([round(value * layer.opacity) for value in range(256)]))
            sources.append(source)
        fixed = None
        if not (layer.spin_turns or layer.pulse or depth_scale):
            fixed = tuple(_transform(source, max(1, round(spec.width * layer.width)), layer.rotation_deg)
                          for source in sources)
        layers.append(_Layer(layer, tuple(sources), tuple(accumulate(durations)), fixed))
    return PreparedScene(background, tuple(layers), spec.depth_order)


def _make_palette(scene):
    # Sample time and reserve enough colors for sprites that cover few screen pixels.
    width = min(420, scene.width)
    height = max(1, round(scene.height * width / scene.width))
    samples = Image.new("RGB", (width, (height * 10) + (34 * ceil(len(scene._layers) / 10))))
    for index in range(10):
        samples.paste(scene.frame(index / 10).resize((width, height), Image.Resampling.LANCZOS), (0, index * height))
    cell_width = max(1, width // 10)
    for index, layer in enumerate(scene._layers):
        chip = layer.source.copy()
        chip.thumbnail((cell_width, 34), Image.Resampling.LANCZOS)
        row, column = divmod(index, 10)
        samples.paste(chip, (column * cell_width, height * 10 + row * 34), chip)
    quantized = samples.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    palette_bytes = quantized.getpalette()
    used = sorted(index for _, index in quantized.getcolors(256))
    colors = list(dict.fromkeys(tuple(palette_bytes[index * 3:index * 3 + 3]) for index in used))
    replacement = next((0, green, 255) for green in range(256) if (0, green, 255) not in colors)
    fallback = min(range(len(colors)), key=lambda index: sum((a - b) ** 2 for a, b in zip(replacement, colors[index])))
    transparent = len(colors)
    palette = Image.new("P", (1, 1))
    palette.putpalette([channel for color in (*colors, replacement) for channel in color])
    return palette, transparent, fallback


def save_scene_gif(scene, path, frame_count, delays, *, overwrite=False):
    """Encode opaque frames with one palette and optimized GIF delta updates."""
    if not 2 <= frame_count <= MAX_SCENE_FRAMES or scene.width * scene.height * frame_count > MAX_SCENE_FRAME_PIXELS:
        raise ValueError("Scene animation is too large, reduce the frame count or dimensions")
    if len(delays) != frame_count or any(delay < 20 or delay % 10 for delay in delays):
        raise ValueError("Supply one GIF delay of at least 20 ms in 10 ms units per frame")
    path = Path(path)
    if not overwrite and path.exists():
        raise FileExistsError(f"Output already exists: {path}")

    palette, transparent, fallback = _make_palette(scene)
    remap = list(range(256))
    remap[transparent] = fallback

    def indexed_frame(index):
        frame = scene.frame(index / frame_count).quantize(palette=palette, dither=Image.Dither.NONE)
        if frame.getextrema()[1] >= transparent:
            frame = frame.point(remap)
        # The first frame is opaque. Later frames use this index for unchanged screen pixels.
        if index:
            frame.info["transparency"] = transparent
        return frame

    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=path.parent, suffix=".gif", delete=False) as stream:
        temporary = Path(stream.name)
    try:
        indexed_frame(0).save(
            temporary, format="GIF", save_all=True,
            append_images=(indexed_frame(index) for index in range(1, frame_count)),
            duration=delays, loop=0, disposal=1, optimize=True, palette=bytes(palette.getpalette()),
        )
        if overwrite:
            temporary.replace(path)
        elif os.name == "nt":
            temporary.rename(path)
        else:
            path.hardlink_to(temporary)
    finally:
        temporary.unlink(missing_ok=True)
