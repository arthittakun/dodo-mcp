"""The neon text banner from render_banner.js, drawn with Pillow and HarfBuzz instead of a browser.

It follows the Canvas 2D version element by element in the same 420x200 logical coordinates
(backdrop gradient and glows, dotted texture, frame lines, the comet running around the frame,
the status badge, the headline with its glow and motion, and the three beat dots) and renders
at twice the output resolution for antialiasing. Thai text is shaped with HarfBuzz.
"""

from math import ceil, cos, pi, sin, tau
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from smooth import downscale

ROOT = Path(__file__).resolve().parent
DEFAULT_FONT = ROOT / "assets" / "Sarabun-Bold.ttf"
MOTIONS = ("bounce", "pulse", "slide", "shake", "still")
DETAIL = 2  # Supersampling factor.


def _rgb(value):
    return tuple(int(value[index:index + 2], 16) for index in (1, 3, 5))


def _mix(a, b, weight):
    return tuple(round(x + (y - x) * weight) for x, y in zip(a, b))


def _rgba(color, opacity=1.0):
    return (*color, max(0, min(255, round(255 * opacity))))


class _Track:
    """The rounded frame the comet follows, parameterised by arc length (logical units)."""

    def __init__(self, x, y, width, height, radius):
        self.x, self.y, self.w, self.h, self.r = x, y, width, height, radius
        straight_x, straight_y = width - 2 * radius, height - 2 * radius
        arc = pi * radius / 2
        self.pieces = [("line", straight_x, (x + radius, y), (1, 0)), ("arc", arc, (x + width - radius, y + radius), -pi / 2),
                       ("line", straight_y, (x + width, y + radius), (0, 1)), ("arc", arc, (x + width - radius, y + height - radius), 0),
                       ("line", straight_x, (x + width - radius, y + height), (-1, 0)), ("arc", arc, (x + radius, y + height - radius), pi / 2),
                       ("line", straight_y, (x, y + height - radius), (0, -1)), ("arc", arc, (x + radius, y + radius), pi)]
        self.length = sum(piece[1] for piece in self.pieces)

    def point(self, distance):
        distance %= self.length
        for kind, length, origin, direction in self.pieces:
            if distance <= length:
                if kind == "line":
                    return origin[0] + direction[0] * distance, origin[1] + direction[1] * distance
                angle = direction + distance / self.r
                return origin[0] + self.r * cos(angle), origin[1] + self.r * sin(angle)
            distance -= length
        return self.point(0)

    def trace(self, start, end):
        steps = max(1, ceil((end - start) / 4))
        return [self.point(start + (end - start) * index / steps) for index in range(steps + 1)]


class _Text:
    """One shaped line: ink metrics in font units and a mask rasterised on demand."""

    def __init__(self, text, font_path):
        import uharfbuzz as hb

        self.face = hb.Face(hb.Blob.from_file_path(str(font_path)))
        self.font = hb.Font(self.face)
        buffer = hb.Buffer()
        buffer.add_str(text)
        buffer.guess_segment_properties()
        hb.shape(self.font, buffer, {"kern": True, "liga": True})
        self.glyphs = list(zip(buffer.glyph_infos, buffer.glyph_positions))
        left = top = right = bottom = None
        pen = 0
        for info, position in self.glyphs:
            extents = self.font.get_glyph_extents(info.codepoint)
            if extents and extents.width:
                x0 = pen + position.x_offset + extents.x_bearing
                y_top = position.y_offset + extents.y_bearing
                y_bottom = y_top + extents.height
                left = x0 if left is None else min(left, x0)
                right = x0 + extents.width if right is None else max(right, x0 + extents.width)
                top = y_top if top is None else max(top, y_top)
                bottom = y_bottom if bottom is None else min(bottom, y_bottom)
            pen += position.x_advance
        self.box = (left or 0, top or 0, right or 0, bottom or 0)  # Font units, y up.

    def ink(self, size):
        """(width, height) of the visible glyphs at `size` pixels per em."""
        left, top, right, bottom = self.box
        scale = size / self.face.upem
        return (right - left) * scale, (top - bottom) * scale

    def mask(self, size):
        """An 'L' mask of exactly the ink box at `size` pixels per em."""
        from caption import _OutlinePen

        left, top, right, bottom = self.box
        scale = size * DETAIL / self.face.upem
        width = max(1, ceil((right - left) * scale) + 2)
        height = max(1, ceil((top - bottom) * scale) + 2)
        canvas = Image.new("L", (width, height))
        pen = 0
        for info, position in self.glyphs:
            outline = _OutlinePen()
            self.font.draw_glyph_with_pen(info.codepoint, outline)
            outline.closePath()
            origin_x = (pen + position.x_offset - left) * scale + 1
            origin_y = (top - position.y_offset) * scale + 1
            pen += position.x_advance
            contours = [[(origin_x + x * scale, origin_y - y * scale) for x, y in contour] for contour in outline.contours]
            if not contours:
                continue
            xs = [x for contour in contours for x, _ in contour]
            ys = [y for contour in contours for _, y in contour]
            box = (int(min(xs)) - 1, int(min(ys)) - 1, int(max(xs)) + 2, int(max(ys)) + 2)
            glyph = Image.new("1", (box[2] - box[0], box[3] - box[1]))
            for contour in contours:
                ring = Image.new("1", glyph.size)
                ImageDraw.Draw(ring).polygon([(x - box[0], y - box[1]) for x, y in contour], fill=1)
                glyph = ImageChops.logical_xor(glyph, ring)
            canvas.paste(ImageChops.lighter(canvas.crop(box), glyph.convert("L")), box)
        return canvas  # Supersampled: callers composite at DETAIL resolution.


def _fit(text, size, max_width, max_height):
    """Shrink `size` until the ink fits, as fitText does (four tries)."""
    for attempt in range(4):
        width, height = text.ink(size)
        scale = min(max_width / (width or 1), max_height / (height or 1))
        if scale >= 1 or attempt == 3:
            return size
        size *= scale * 0.99
    return size


class _Painter:
    """Draws in logical units onto a supersampled RGBA canvas, compositing each translucent mark."""

    def __init__(self, size, unit):
        self.size, self.k = size, unit * DETAIL

    def layer(self):
        return Image.new("RGBA", self.size)

    def px(self, value):
        return value * self.k

    def xy(self, point):
        return point[0] * self.k, point[1] * self.k


def _linear_map(size, start, end):
    """Projection t of each pixel onto start->end (0..255), through an affine transform of a ramp."""
    # 0 before the start, a 0-255 ramp from start to end, 255 after it.
    ramp = Image.frombytes("L", (768, 1), bytes([0] * 256 + list(range(256)) + [255] * 256))
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = dx * dx + dy * dy
    # Source x = 256 + 255 * t, with t = ((x - sx) * dx + (y - sy) * dy) / length.
    a, b = 255 * dx / length, 255 * dy / length
    c = 256 - 255 * (start[0] * dx + start[1] * dy) / length
    return ramp.transform(size, Image.Transform.AFFINE, (a, b, c, 0, 0, 0), Image.Resampling.NEAREST, fillcolor=255)


def _radial_alpha(size, center, radius, opacity):
    """Alpha falling linearly from `opacity` at the center to 0 at `radius` (canvas pixels)."""
    # Pillow's gradient rises by sqrt(2) per pixel (about 181 at distance 128). Map the radius to
    # distance 128 so the whole disc lies inside the 256 px source; outside it is fully clear.
    gradient = Image.radial_gradient("L")
    scale = 128 / radius
    distance = gradient.transform(size, Image.Transform.AFFINE,
                                  (scale, 0, 128 - center[0] * scale, 0, scale, 128 - center[1] * scale),
                                  Image.Resampling.BILINEAR, fillcolor=255)
    edge = 128 * 2 ** 0.5
    return distance.point([round(opacity * 255 * max(0.0, 1 - value / edge)) for value in range(256)])


def _rounded(draw, painter, x, y, box_width, box_height, radius, **style):
    draw.rounded_rectangle((painter.px(x), painter.px(y), painter.px(x + box_width), painter.px(y + box_height)),
                           painter.px(radius), **style)


def _backdrop(painter, w, h, track, base, accent, transparent):
    size = painter.size
    canvas = Image.new("RGBA", size)
    if not transparent:
        projection = _linear_map(size, (0, 0), (painter.px(w * 0.82), painter.px(h)))
        dark, darker = _mix(base, (0, 0, 0), 0.5), _mix(base, (0, 0, 0), 0.32)

        def stop(t):
            if t <= 0.55:
                return _mix(dark, base, t / 0.55)
            return _mix(base, darker, (t - 0.55) / 0.45)

        lut = [stop(value / 255) for value in range(256)]
        canvas = Image.merge("RGB", [projection.point([color[channel] for color in lut]) for channel in range(3)]).convert("RGBA")
        clip = Image.new("L", size)
        _rounded(ImageDraw.Draw(clip), painter, track.x, track.y, track.w, track.h, track.r, fill=255)
        for center, radius, color, opacity in (((w * 0.13, 0), 190, accent, 0.18),
                                               ((w * 0.87, h), 220, _mix(accent, (112, 90, 244), 0.55), 0.14)):
            wash = Image.new("RGBA", size, color)
            alpha = _radial_alpha(size, painter.xy(center), painter.px(radius), opacity)
            wash.putalpha(ImageChops.multiply(alpha, clip))
            canvas.alpha_composite(wash)
        dots = painter.layer()
        draw = ImageDraw.Draw(dots)
        x = 29
        while x < w - 26:
            intensity = (abs(x - w / 2) / (w / 2)) ** 1.9
            y = 29
            while y < h - 26:
                draw.rectangle((painter.px(x), painter.px(y), painter.px(x + 1.2), painter.px(y + 1.2)), fill=_rgba(accent, intensity * 0.30))
                y += 12
            x += 12
        dots.putalpha(ImageChops.multiply(dots.getchannel("A"), clip))
        canvas.alpha_composite(dots)
    lines = painter.layer()
    draw = ImageDraw.Draw(lines)
    stroke = max(1, round(painter.px(1)))
    _rounded(draw, painter, track.x, track.y, track.w, track.h, track.r, outline=_rgba(accent, 0.72 if transparent else 0.34), width=stroke)
    canvas.alpha_composite(lines)
    lines = painter.layer()
    _rounded(ImageDraw.Draw(lines), painter, 19, 19, w - 38, h - 38, 15, outline=_rgba(accent, 0.24 if transparent else 0.12), width=stroke)
    canvas.alpha_composite(lines)
    if w >= 580:
        marks = painter.layer()
        draw = ImageDraw.Draw(marks)
        for side in (-1, 1):
            x, y = w / 2 + side * (w / 2 - 49), h / 2
            draw.line([painter.xy((x - side * 12, y - 15)), painter.xy((x, y - 15)), painter.xy((x, y + 15)),
                       painter.xy((x - side * 12, y + 15))], fill=_rgba(accent, 0.45), width=stroke)
            draw.rectangle((painter.px(x - side * 4 - 1), painter.px(y - 1), painter.px(x - side * 4 + 1), painter.px(y + 1)),
                           fill=_rgba(accent, 0.70))
        canvas.alpha_composite(marks)
    return canvas


def _comet(frame, painter, track, phase, accent, unit):
    head = track.length * (phase + 0.31)
    tail = min(230, track.length * 0.22)
    start = head - tail
    glow_path = [painter.xy(point) for point in track.trace(head - tail * 0.64, head)]
    stroke = painter.layer()
    ImageDraw.Draw(stroke).line(glow_path, fill=_rgba(accent, 1), width=max(1, round(painter.px(5))), joint="curve")
    shadow = Image.new("RGBA", painter.size, accent)
    shadow.putalpha(stroke.getchannel("A").filter(ImageFilter.GaussianBlur(13 * unit * DETAIL / 2)).point(lambda v: round(v * 0.95)))
    frame.alpha_composite(shadow)
    stroke.putalpha(stroke.getchannel("A").point(lambda v: round(v * 0.28)))
    frame.alpha_composite(stroke)
    trail = painter.layer()
    draw = ImageDraw.Draw(trail)
    segments = 27
    for index in range(segments):
        t = (index + 1) / segments
        color = _rgba(_mix(accent, (234, 253, 255), t ** 5), 0.08 + 0.92 * t ** 1.6)
        points = [painter.xy(point) for point in track.trace(start + tail * index / segments, start + tail * t + 0.4)]
        draw.line(points, fill=color, width=max(1, round(painter.px(1.75))))
    frame.alpha_composite(trail)
    tip = painter.layer()
    x, y = painter.xy(track.point(head))
    radius = painter.px(1.75)
    ImageDraw.Draw(tip).ellipse((x - radius, y - radius, x + radius, y + radius), fill=_rgba(_mix(accent, (255, 255, 255), 0.8)))
    frame.alpha_composite(tip)


def _paste_text(frame, mask, center, color, scale=(1.0, 1.0)):
    if scale != (1.0, 1.0):
        mask = mask.resize((max(1, round(mask.width * scale[0])), max(1, round(mask.height * scale[1]))), Image.Resampling.LANCZOS)
    sprite = Image.new("RGBA", mask.size, color[:3])
    sprite.putalpha(mask.point(lambda v: round(v * color[3] / 255)) if len(color) == 4 else mask)
    layer = Image.new("RGBA", frame.size)
    layer.paste(sprite, (round(center[0] - mask.width / 2), round(center[1] - mask.height / 2)))
    frame.alpha_composite(layer)
    return mask


def render_banner_frames(*, width=800, height=200, text="", label="", motion="bounce", background="#0F172A",
                         accent="#38BDF8", text_color="#F1F7FF", strength=1.0, count=50, font_path=DEFAULT_FONT):
    """Render `count` evenly spaced frames of one seamless banner loop as RGBA images."""
    if motion not in MOTIONS:
        raise ValueError(f"motion must be one of {', '.join(MOTIONS)}")
    if not 32 <= width <= 4096 or not 32 <= height <= 4096 or not 2 <= count <= 600:
        raise ValueError("Use 32-4096 px per side and 2-600 frames.")
    unit = min(width / 420, height / 200)
    w, h = width / unit, height / unit
    painter = _Painter((width * DETAIL, height * DETAIL), unit)
    transparent = background == "transparent"
    base, colour_accent, colour_text = _rgb("#0f172a" if transparent else background), _rgb(accent), _rgb(text_color)
    track = _Track(14, 14, w - 28, h - 28, 20)
    backdrop = _backdrop(painter, w, h, track, base, colour_accent, transparent)

    label = " ".join(label.split())
    headline = " ".join(text.split())
    title_margin = 158 if w >= 580 else 106
    label_mask = headline_mask = None
    label_width = 0.0
    if label:
        shaped = _Text(label, font_path)
        size = _fit(shaped, 11.5, 120, 11)
        label_width = shaped.ink(size)[0]
        label_mask = shaped.mask(painter.k * size / DETAIL)
    if headline:
        shaped = _Text(headline, font_path)
        size = _fit(shaped, 51, (w - title_margin) / 1.1, 56)
        headline_mask = shaped.mask(painter.k * size / DETAIL)
    title_y = h / 2 + (14 if label else 0)

    frames = []
    for index in range(count):
        phase = index / count
        angle = tau * phase
        pulse = (1 - cos(angle)) / 2
        frame = backdrop.copy()
        _comet(frame, painter, track, phase, colour_accent, unit)
        if label_mask is not None:
            x, y = w / 2, h / 2 - 47
            badge_width = max(65, label_width + 34)
            badge = painter.layer()
            draw = ImageDraw.Draw(badge)
            _rounded(draw, painter, x - badge_width / 2, y - 11, badge_width, 22, 11,
                     fill=_rgba(_mix(base, colour_accent, 0.12), 0.92), outline=_rgba(colour_accent, 0.45),
                     width=max(1, round(painter.px(1))))
            dot_x = x - badge_width / 2 + 13
            for radius, opacity in ((4.8 + 1.3 * pulse, 0.26 - 0.10 * pulse), (2.3, 1.0)):
                ring = painter.layer()
                cx, cy = painter.xy((dot_x, y))
                r = painter.px(radius)
                ImageDraw.Draw(ring).ellipse((cx - r, cy - r, cx + r, cy + r), fill=_rgba(colour_accent, opacity))
                badge.alpha_composite(ring)
            frame.alpha_composite(badge)
            _paste_text(frame, label_mask, painter.xy((x + 6, y)), _rgba(_mix(colour_text, colour_accent, 0.32)))
        if headline_mask is not None:
            dx = dy = 0.0
            sx = sy = 1.0
            if motion == "bounce":
                dy = -9 * pulse * strength
                sx += (0.5 - pulse) * 0.034 * strength
                sy += (pulse - 0.5) * 0.064 * strength
            elif motion == "pulse":
                sx = sy = 1 + (pulse - 0.5) * 0.09 * strength
            elif motion == "slide":
                dx = 13 * sin(angle) * strength
            elif motion == "shake":
                dx = 4.5 * sin(4 * angle) * pulse * strength
            center = painter.xy((w / 2 + dx, title_y + dy))
            scaled = headline_mask if (sx, sy) == (1.0, 1.0) else headline_mask.resize(
                (max(1, round(headline_mask.width * sx)), max(1, round(headline_mask.height * sy))), Image.Resampling.LANCZOS)
            glow = Image.new("RGBA", frame.size, colour_accent)
            shape = Image.new("L", frame.size)
            shape.paste(scaled, (round(center[0] - scaled.width / 2), round(center[1] - scaled.height / 2)))
            opacity = 0.22 + 0.24 * pulse
            glow.putalpha(shape.filter(ImageFilter.GaussianBlur(10 * unit * DETAIL / 2)).point(lambda v: round(v * opacity)))
            frame.alpha_composite(glow)
            _paste_text(frame, scaled, center, _rgba(colour_text))
        beats = painter.layer()
        draw = ImageDraw.Draw(beats)
        for offset in (-1, 0, 1):
            opacity = 0.28 + 0.48 * (1 + cos(angle - offset * 0.9)) / 2
            _rounded(draw, painter, w / 2 + offset * 14 - 4, h / 2 + 57, 8, 2, 1, fill=_rgba(colour_accent, opacity))
        frame.alpha_composite(beats)
        frames.append(downscale(frame, (width, height)))
    return frames
