"""Turn an uploaded still image into a loop with image or character motion."""

from io import BytesIO
from itertools import pairwise
from math import ceil, cos, exp, hypot, sin, tau

from PIL import Image, ImageOps, UnidentifiedImageError

from smooth import affine, premultiplied, sample_loop, straight


CLASSIC_MOTIONS = ("wiggle", "zoom", "pan", "bounce")
FREE_MOTIONS = ("float", "sway", "heartbeat", "shake", "spin", "jelly")
MOTIONS = CLASSIC_MOTIONS + FREE_MOTIONS
FPS = 20
MAX_IMAGE_SIDE = 800
MAX_SOURCE_PIXELS = 24_000_000


def load_still(data, *, max_side=MAX_IMAGE_SIDE):
    """Decode an oriented PNG, JPEG, or WebP into a bounded RGBA canvas."""
    try:
        with Image.open(BytesIO(data), formats=("PNG", "JPEG", "WEBP")) as uploaded:
            if uploaded.width * uploaded.height > MAX_SOURCE_PIXELS:
                raise ValueError("รูปต้นฉบับมีขนาดเกิน 24 ล้านพิกเซล")
            if getattr(uploaded, "n_frames", 1) != 1:
                raise ValueError("กรุณาเลือกไฟล์ภาพนิ่ง")
            image = ImageOps.exif_transpose(uploaded).convert("RGBA")
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError) as exc:
        raise ValueError("เปิดรูปไม่ได้ กรุณาเลือกภาพนิ่ง PNG, JPEG หรือ WebP ที่เปิดได้") from exc

    if max(image.size) > max_side:
        image = straight(premultiplied(image).resize(_fit(image.size, max_side), Image.Resampling.LANCZOS))
    image.info.clear()
    return image


def _fit(size, side):
    scale = side / max(size)
    return max(1, round(size[0] * scale)), max(1, round(size[1] * scale))


class _Wiggle:
    """Bend the figure sideways above a pivot near its feet, keeping the canvas sides fixed."""

    def __init__(self, image):
        width, height = image.size
        bounds = image.getbbox(alpha_only=True)
        if bounds is None:
            raise ValueError("รูปไม่มีส่วนที่มองเห็น กรุณาเลือกรูปอื่น")
        left, top, right, bottom = bounds
        figure_height = bottom - top
        self.image = premultiplied(image)
        self.amplitude = min(0.12 * (right - left), 0.18 * figure_height)
        pivot = bottom - 0.15 * figure_height
        active_height = max(1, pivot - top)

        # Keep the sides of the canvas fixed, including for images with a solid background.
        feather = max(1, 0.14 * width)
        edge = round(feather)
        self.columns = sorted({0, edge, width - edge, width})
        self.rows = sorted({*range(0, height, ceil(height / 28)), top, round(pivot), height})
        self.horizontal = {x: min(1, x / feather, (width - x) / feather) for x in self.columns}
        self.vertical = {}
        for y in self.rows:
            t = min(1, max(0, (pivot - y) / active_height))
            self.vertical[y] = t * t * (3 - 2 * t)

    def __call__(self, phase):
        angle = tau * phase
        displacement = self.amplitude * (0.75 * sin(angle) + 0.25 * sin(2 * angle))
        mesh = []
        for y0, y1 in pairwise(self.rows):
            shift_top = displacement * self.vertical[y0]
            shift_bottom = displacement * self.vertical[y1]
            for x0, x1 in pairwise(self.columns):
                left_weight, right_weight = self.horizontal[x0], self.horizontal[x1]
                quad = (
                    x0 - shift_top * left_weight, y0,
                    x0 - shift_bottom * left_weight, y1,
                    x1 - shift_bottom * right_weight, y1,
                    x1 - shift_top * right_weight, y0,
                )
                mesh.append(((x0, y0, x1, y1), quad))
        return straight(self.image.transform(self.image.size, Image.Transform.MESH, mesh, Image.Resampling.BICUBIC))


def _classic(image, motion, phase):
    width, height = image.size
    angle = tau * phase
    offset_x, offset_y = 0, 0
    if motion == "zoom":
        scale = 1 + 0.08 * (1 - cos(angle))
    elif motion == "pan":
        scale = 1.16
        offset_x = 0.06 * width * sin(angle)
    else:
        scale = 1.14
        offset_y = 0.05 * height * sin(angle)

    inverse = 1 / scale
    left = width * (1 - inverse) / 2 - offset_x * inverse
    top = height * (1 - inverse) / 2 - offset_y * inverse
    return straight(premultiplied(image).transform(
        image.size,
        Image.Transform.AFFINE,
        (inverse, 0, left, 0, inverse, top),
        Image.Resampling.BICUBIC,
    ))


def _pulse(phase, center, width):
    distance = min(abs(phase - center), 1 - abs(phase - center))
    return exp(-0.5 * (distance / width) ** 2)


def _free_pose(motion, phase, box):
    """Scale, rotation, pivot and offset for the free-moving effects at one phase."""
    left, top, right, bottom = box
    width, height = right - left, bottom - top
    center = (left + right) / 2, (top + bottom) / 2
    foot = (left + right) / 2, bottom
    angle = tau * phase
    if motion == "float":
        return (1, 1), 1.6 * sin(angle + tau / 4), center, (0, -0.045 * height * sin(angle))
    if motion == "sway":
        return (1, 1), 7 * sin(angle), foot, (0, 0)
    if motion == "heartbeat":
        beat = _pulse(phase, 0.14, 0.045) + 0.7 * _pulse(phase, 0.34, 0.05)
        grow = 1 + 0.1 * beat
        return (grow, grow), 0, center, (0, 0)
    if motion == "shake":
        shift = 0.03 * width * (0.6 * sin(6 * angle) + 0.4 * sin(10 * angle))
        return (1, 1), 2.2 * sin(8 * angle), foot, (shift, 0)
    if motion == "spin":
        return (1, 1), -360 * phase, center, (0, 0)
    # Jelly: squash and stretch anchored at the feet, with a quicker secondary wobble.
    squash = 0.06 * sin(2 * angle) + 0.025 * sin(4 * angle)
    return (1 + 0.8 * squash, 1 - squash), 0, foot, (0, 0)


def _free_canvas(image, motion):
    """Leave room around transparent subjects, or cover the frame for opaque photos."""
    bounds = image.getbbox(alpha_only=True)
    if bounds is None:
        raise ValueError("รูปไม่มีส่วนที่มองเห็น กรุณาเลือกรูปอื่น")
    transparent = image.getchannel("A").getextrema()[0] < 250
    if not transparent:
        return image, (0, 0, *image.size), False
    left, top, right, bottom = bounds
    width, height = right - left, bottom - top
    if motion == "spin":
        side = ceil(hypot(width, height)) + 4
        pad_x, pad_y = ceil((side - width) / 2), ceil((side - height) / 2)
    else:
        pad_x = pad_y = ceil(0.16 * max(width, height)) + 2
    canvas = Image.new("RGBA", (width + 2 * pad_x, height + 2 * pad_y))
    canvas.alpha_composite(image.crop(bounds), (pad_x, pad_y))
    return canvas, (pad_x, pad_y, pad_x + width, pad_y + height), True


def _cover_scale(motion, size):
    """Zoom an opaque photo just enough that motion never reveals its edges."""
    width, height = size
    if motion == "spin":
        return 1.0
    ratio = max(width / height, height / width)
    turn = {"float": 1.6, "sway": 7, "shake": 2.2}.get(motion, 0)
    rotation = cos(turn * tau / 360) + ratio * sin(turn * tau / 360)
    travel = {"float": 1 + 2 * 0.05, "shake": 1 + 2 * 0.035, "jelly": 1.09}.get(motion, 1)
    # A little extra keeps edge pixels from sampling outside the photo.
    return rotation * travel * 1.03


def make_frames(image, motion, count, *, motion_blur=1):
    """Render one loop of a Gift image effect; motion_blur averages that many sub-frames."""
    if motion not in MOTIONS:
        raise ValueError(f"Unsupported image motion {motion!r}")
    if count < 1:
        raise ValueError("Frame count must be positive")
    if motion == "wiggle":
        render = _Wiggle(image)
    elif motion in CLASSIC_MOTIONS:
        def render(phase):
            return _classic(image, motion, phase)
    else:
        canvas, box, transparent = _free_canvas(image, motion)
        cover = 1.0 if transparent else _cover_scale(motion, canvas.size)
        middle = canvas.width / 2, canvas.height / 2

        def render(phase):
            (scale_x, scale_y), angle, pivot, offset = _free_pose(motion, phase, box)
            if not transparent:
                # Photos move about their center so the cover zoom hides every edge.
                pivot = middle
            frame = affine(canvas, scale=(scale_x, scale_y), angle=angle, pivot=pivot, offset=offset)
            if cover != 1.0:
                frame = affine(frame, scale=(cover, cover), pivot=middle)
            return frame

    frames = sample_loop(render, count, samples=motion_blur)
    return _trim_common(frames) if motion in FREE_MOTIONS else frames


def _trim_common(frames):
    """Crop every frame to the union of visible pixels plus a small margin."""
    union = None
    for frame in frames:
        box = frame.getbbox(alpha_only=True)
        if box is None:
            continue
        union = box if union is None else (min(union[0], box[0]), min(union[1], box[1]),
                                           max(union[2], box[2]), max(union[3], box[3]))
    if union is None:
        return frames
    width, height = frames[0].size
    margin = 2
    crop = (max(0, union[0] - margin), max(0, union[1] - margin),
            min(width, union[2] + margin), min(height, union[3] + margin))
    if crop == (0, 0, width, height):
        return frames
    return [frame.crop(crop) for frame in frames]
