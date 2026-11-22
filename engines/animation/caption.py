"""Thai-ready sticker captions: shaped once by Chromium, then animated over every frame."""

import base64
from io import BytesIO
from math import pi, sin
import os
from pathlib import Path
from typing import Annotated, Literal

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field

from smooth import affine, downscale, shift_subpixel


ROOT = Path(__file__).resolve().parent
DEFAULT_FONT = ROOT / "assets" / "Sarabun-Bold.ttf"
Color = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]
SUPERSAMPLE = 2

_SCRIPT = """
async ({fontURL, lines, fontPx, maxWidth, fill, outline}) => {
  const face = new FontFace("GiftCaption", `url(${fontURL})`);
  await face.load();
  document.fonts.add(face);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  let size = fontPx;
  const widest = () => {
    ctx.font = `${size}px GiftCaption`;
    return Math.max(...lines.map((line) => {
      const m = ctx.measureText(line);
      return m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    }));
  };
  for (let i = 0; i < 6 && widest() + size * 0.3 > maxWidth; i++) {
    size *= maxWidth / (widest() + size * 0.3) * 0.99;
  }
  const stroke = Math.max(2, size * 0.2);
  const lineHeight = size * 1.5;
  canvas.width = Math.ceil(maxWidth + stroke * 2);
  canvas.height = Math.ceil(lineHeight * lines.length + stroke * 2 + size * 0.4);
  ctx.font = `${size}px GiftCaption`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  lines.forEach((line, index) => {
    const y = stroke + size * 0.2 + lineHeight * index + size * 1.1;
    ctx.lineWidth = stroke;
    ctx.strokeStyle = outline;
    ctx.strokeText(line, canvas.width / 2, y);
    ctx.fillStyle = fill;
    ctx.fillText(line, canvas.width / 2, y);
  });
  return canvas.toDataURL("image/png").split(",")[1];
}
"""


class CaptionSpec(BaseModel):
    """Sticker-style text with an outline, placed in a band above or below the artwork.

    `size` is the font size relative to the frame width. Use a line break in `text`
    for two lines. `motion` animates the caption: bounce hops twice per loop, pulse
    breathes, wiggle tilts, and pop scales in at the start of every loop.
    Set `overlap` to draw over the artwork instead of adding a band.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    text: Annotated[str, Field(min_length=1, max_length=80)]
    position: Literal["top", "bottom"] = "bottom"
    color: Color = "#FFFFFF"
    outline: Color = "#3A2414"
    size: Annotated[float, Field(ge=0.05, le=0.3)] = 0.13
    motion: Literal["none", "bounce", "pulse", "wiggle", "pop"] = "bounce"
    overlap: bool = False
    font_path: Annotated[str, Field(min_length=1, max_length=1024)] | None = None


def _font(spec):
    path = Path(spec.font_path).expanduser() if spec.font_path else DEFAULT_FONT
    if not path.is_absolute() or path.suffix.lower() not in (".ttf", ".otf") or not path.is_file():
        raise ValueError("Use an absolute path to a .ttf or .otf font file for the caption.")
    return path


class _OutlinePen:
    """Collect a glyph's contours as flattened point lists, in font units with y pointing up."""

    STEPS = 8

    def __init__(self):
        self.contours, self._points = [], []

    def moveTo(self, point):  # noqa: N802 - fontTools pen protocol, used by uharfbuzz
        self.closePath()
        self._points = [point]

    def lineTo(self, point):  # noqa: N802
        self._points.append(point)

    def qCurveTo(self, *points):  # noqa: N802
        # TrueType quadratic runs: consecutive off-curve points imply on-curve midpoints.
        start = self._points[-1]
        controls, end = list(points[:-1]), points[-1]
        for index, control in enumerate(controls):
            target = end if index == len(controls) - 1 else (
                (control[0] + controls[index + 1][0]) / 2, (control[1] + controls[index + 1][1]) / 2)
            for step in range(1, self.STEPS + 1):
                t = step / self.STEPS
                a, b, c = (1 - t) ** 2, 2 * (1 - t) * t, t * t
                self._points.append((a * start[0] + b * control[0] + c * target[0],
                                     a * start[1] + b * control[1] + c * target[1]))
            start = target
        if not controls:
            self._points.append(end)

    def curveTo(self, first, second, end):  # noqa: N802
        start = self._points[-1]
        for step in range(1, self.STEPS + 1):
            t = step / self.STEPS
            a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
            self._points.append((a * start[0] + b * first[0] + c * second[0] + d * end[0],
                                 a * start[1] + b * first[1] + c * second[1] + d * end[1]))

    def closePath(self):  # noqa: N802
        if len(self._points) > 2:
            self.contours.append(self._points)
        self._points = []

    endPath = closePath


def _draw_with_harfbuzz(font_path, config):
    """Shape with HarfBuzz (correct Thai mark stacking) and rasterize glyph outlines without a browser.

    Mirrors the Chromium canvas script: the same size fitting, outline width, line spacing and
    centering, drawn at twice the requested resolution for antialiasing.
    """
    import uharfbuzz as hb
    from PIL import ImageChops, ImageDraw, ImageFilter

    face = hb.Face(hb.Blob.from_file_path(str(font_path)))
    font = hb.Font(face)
    upem = face.upem
    shaped = []
    for line in config["lines"]:
        buffer = hb.Buffer()
        buffer.add_str(line)
        buffer.guess_segment_properties()
        hb.shape(font, buffer, {"kern": True, "liga": True})
        shaped.append(list(zip(buffer.glyph_infos, buffer.glyph_positions)))

    def ink(glyphs):
        """Horizontal ink extent in font units, like canvas actualBoundingBoxLeft + Right."""
        left, right, pen = None, None, 0
        for info, position in glyphs:
            extents = font.get_glyph_extents(info.codepoint)
            if extents and extents.width:
                x0 = pen + position.x_offset + extents.x_bearing
                left = x0 if left is None else min(left, x0)
                right = x0 + extents.width if right is None else max(right, x0 + extents.width)
            pen += position.x_advance
        return (left or 0, right or 0, pen)

    extents = [ink(glyphs) for glyphs in shaped]
    max_width, size = config["maxWidth"], config["fontPx"]

    def widest(px):
        return max(right - left for left, right, _ in extents) * px / upem

    for _ in range(6):
        if widest(size) + size * 0.3 <= max_width:
            break
        size *= max_width / (widest(size) + size * 0.3) * 0.99
    stroke, line_height = max(2.0, size * 0.2), size * 1.5
    width = int(-(-(max_width + stroke * 2) // 1))
    height = int(-(-(line_height * len(shaped) + stroke * 2 + size * 0.4) // 1))

    detail = 2  # Extra resolution for polygon antialiasing.
    scale = size * detail / upem
    fill = Image.new("L", (width * detail, height * detail))
    for index, (glyphs, (left, right, _)) in enumerate(zip(shaped, extents)):
        baseline = (stroke + size * 0.2 + line_height * index + size * 1.1) * detail
        pen = width * detail / 2 - (left + right) / 2 * scale
        for info, position in glyphs:
            outline_pen = _OutlinePen()
            font.draw_glyph_with_pen(info.codepoint, outline_pen)
            outline_pen.closePath()
            origin_x, origin_y = pen + position.x_offset * scale, baseline - position.y_offset * scale
            pen += position.x_advance * scale
            contours = [[(origin_x + x * scale, origin_y - y * scale) for x, y in contour]
                        for contour in outline_pen.contours]
            if not contours:
                continue
            xs = [x for contour in contours for x, _ in contour]
            ys = [y for contour in contours for _, y in contour]
            box = (int(min(xs)) - 1, int(min(ys)) - 1, int(max(xs)) + 2, int(max(ys)) + 2)
            glyph = Image.new("1", (box[2] - box[0], box[3] - box[1]))
            for contour in contours:
                # Even-odd filling: each contour toggles coverage, so counters stay open.
                ring = Image.new("1", glyph.size)
                ImageDraw.Draw(ring).polygon([(x - box[0], y - box[1]) for x, y in contour], fill=1)
                glyph = ImageChops.logical_xor(glyph, ring)
            region = fill.crop(box)
            fill.paste(ImageChops.lighter(region, glyph.convert("L")), box)
    # Round-joined outline: grow the fill by half the stroke width (Chromium centers the stroke).
    reach = stroke * detail / 2
    blurred = fill.filter(ImageFilter.GaussianBlur(reach / 2))
    stroke_mask = blurred.point([0 if value < 3 else min(255, (value - 3) * 32) for value in range(256)])
    drawn = Image.new("RGBA", fill.size, config["outline"])
    drawn.putalpha(stroke_mask)
    body = Image.new("RGBA", fill.size, config["fill"])
    body.putalpha(fill)
    drawn.alpha_composite(body)
    return downscale(drawn, (width, height))


def _draw_with_chromium(sync_playwright, playwright_error, config):
    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch()
        except playwright_error as exc:
            raise RuntimeError(f"Could not start Chromium. Run: python -m playwright install chromium\n{exc}") from exc
        try:
            encoded = browser.new_page().evaluate(_SCRIPT, config)
        finally:
            browser.close()
    with Image.open(BytesIO(base64.b64decode(encoded))) as drawn:
        return drawn.convert("RGBA")


def render_caption(spec: CaptionSpec, max_width: int) -> Image.Image:
    """Draw the caption with correct Thai shaping and return a tight RGBA image.

    Uses Chromium when Playwright is installed, otherwise HarfBuzz (the uharfbuzz package).
    """
    font = _font(spec)
    lines = [line.strip() for line in spec.text.splitlines() if line.strip()][:3]
    if not lines:
        raise ValueError("The caption needs visible text.")
    data = base64.b64encode(font.read_bytes()).decode("ascii")
    config = {
        "fontURL": f"data:font/{font.suffix.lower()[1:]};base64,{data}",
        "lines": lines,
        "fontPx": spec.size * max_width / 0.92 * SUPERSAMPLE,
        "maxWidth": max_width * SUPERSAMPLE,
        "fill": spec.color,
        "outline": spec.outline,
    }
    engine = os.environ.get("GIFT_CAPTION_ENGINE", "auto")
    try:
        from playwright.sync_api import Error as PlaywrightError, sync_playwright
    except ImportError:
        sync_playwright = PlaywrightError = None
    if engine == "chromium" or (engine == "auto" and sync_playwright is not None):
        if sync_playwright is None:
            raise RuntimeError("GIFT_CAPTION_ENGINE=chromium needs Playwright: pip install playwright")
        image = _draw_with_chromium(sync_playwright, PlaywrightError, config)
    else:
        try:
            image = _draw_with_harfbuzz(font, config)
        except ImportError as exc:
            raise RuntimeError("Captions need Playwright (Chromium) or HarfBuzz: pip install uharfbuzz") from exc
    box = image.getbbox(alpha_only=True)
    if box is None:
        raise ValueError("The caption font has no visible glyphs for this text.")
    image = image.crop(box)
    size = max(1, round(image.width / SUPERSAMPLE)), max(1, round(image.height / SUPERSAMPLE))
    return downscale(image, size)


def _pose(motion, phase, height):
    """Scale, rotation and vertical offset of the caption at a loop phase."""
    if motion == "bounce":
        return 1.0, 0.0, -0.12 * height * abs(sin(2 * pi * phase))
    if motion == "pulse":
        return 1 + 0.06 * sin(2 * pi * phase), 0.0, 0.0
    if motion == "wiggle":
        return 1.0, 4 * sin(4 * pi * phase), 0.0
    if motion == "pop":
        t = min(1.0, phase / 0.22)
        overshoot = 1.70158
        eased = 1 + (overshoot + 1) * (t - 1) ** 3 + overshoot * (t - 1) ** 2
        return 0.25 + 0.75 * eased, 0.0, 0.0
    return 1.0, 0.0, 0.0


def caption_frames(frames: list[Image.Image], spec: CaptionSpec) -> list[Image.Image]:
    """Return new frames with the caption composited, extending the canvas unless `overlap`."""
    width, height = frames[0].size
    text = render_caption(spec, max(16, round(width * 0.92)))
    # Room for scaling and tilting without clipping, and for the bounce above the text.
    pad = round(0.2 * text.height) + 4
    padded = Image.new("RGBA", (text.width + 2 * pad, text.height + 2 * pad))
    padded.alpha_composite(text, (pad, pad))
    center = padded.width / 2, padded.height / 2
    hop = 0.12 * text.height if spec.motion == "bounce" else 0.0
    margin = max(4, round(0.04 * text.height))

    band = 0 if spec.overlap else round(text.height + hop + 2 * margin)
    canvas_size = width, height + band
    art_y = band if spec.position == "top" and not spec.overlap else 0
    if spec.position == "top":
        text_center_y = margin + hop + text.height / 2
    else:
        text_center_y = canvas_size[1] - margin - text.height / 2
    result = []
    for index, frame in enumerate(frames):
        canvas = Image.new("RGBA", canvas_size)
        canvas.alpha_composite(frame.convert("RGBA"), (0, art_y))
        scale, angle, rise = _pose(spec.motion, index / len(frames), text.height)
        sprite = padded if (scale, angle) == (1.0, 0.0) else affine(padded, scale=(scale, scale), angle=angle, pivot=center)
        left = width / 2 - sprite.width / 2
        top = text_center_y + rise - sprite.height / 2
        column, row = int(left // 1), int(top // 1)
        sprite = shift_subpixel(sprite, left - column, top - row)
        _composite(canvas, sprite, column, row)
        result.append(canvas)
    return result


def _composite(canvas, sprite, x, y):
    left, top = max(0, x), max(0, y)
    right, bottom = min(canvas.width, x + sprite.width), min(canvas.height, y + sprite.height)
    if right > left and bottom > top:
        canvas.alpha_composite(sprite.crop((left - x, top - y, right - x, bottom - y)), (left, top))
