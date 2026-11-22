"""Shared helpers that make looping frames smoother: premultiplied resampling,
temporal motion blur, and sub-pixel affine placement."""

from math import cos, radians, sin

from PIL import Image


BLUR_SAMPLES = 3
SHUTTER = 0.5  # Fraction of one frame interval covered by motion blur (a 180° shutter).


def premultiplied(image):
    """Return a premultiplied copy so resampling never pulls dark fringes from transparent pixels."""
    return image if image.mode == "RGBa" else image.convert("RGBA").convert("RGBa")


def straight(image):
    return image.convert("RGBA") if image.mode == "RGBa" else image


def downscale(image, size):
    """Resize an RGBA (or RGB) frame with Lanczos filtering in premultiplied space."""
    if image.size == tuple(size):
        return image
    if image.mode in ("RGBA", "RGBa"):
        return straight(premultiplied(image).resize(size, Image.Resampling.LANCZOS))
    return image.resize(size, Image.Resampling.LANCZOS)


def average(frames):
    """Average equally weighted frames; RGBA frames are blended in premultiplied space."""
    frames = list(frames)
    if not frames:
        raise ValueError("Motion blur needs at least one sample.")
    rgba = frames[0].mode in ("RGBA", "RGBa")
    result = None
    for index, frame in enumerate(frames, 1):
        sample = premultiplied(frame) if rgba else frame
        result = sample if result is None else Image.blend(result, sample, 1 / index)
    return straight(result) if rgba else result


def sample_phases(index, count, samples=1, shutter=SHUTTER):
    """Phases spread across one frame interval, centered on the frame's own time."""
    if samples <= 1:
        return [index / count]
    return [((index + shutter * ((sample + 0.5) / samples - 0.5)) / count) % 1 for sample in range(samples)]


def sample_loop(render, count, *, samples=1, shutter=SHUTTER):
    """Render one loop of `count` frames from a periodic `render(phase)` callback.

    With `samples` above one, each frame averages that many sub-frames, which gives
    fast limbs and objects a soft motion trail instead of visible jumps.
    """
    if type(count) is not int or count < 1:
        raise ValueError("Frame count must be a positive integer.")
    frames = []
    for index in range(count):
        phases = sample_phases(index, count, samples, shutter)
        renders = [render(phase) for phase in phases]
        frames.append(renders[0] if len(renders) == 1 else average(renders))
    return frames


def affine(image, size=None, *, scale=(1.0, 1.0), angle=0.0, pivot=(0.0, 0.0), offset=(0.0, 0.0),
           resample=Image.Resampling.BICUBIC):
    """Scale, rotate (degrees, counterclockwise on screen) about `pivot`, then translate.

    Works on premultiplied pixels so soft edges stay clean, and keeps sub-pixel offsets.
    """
    size = size or image.size
    scale_x, scale_y = scale
    c, s = cos(radians(angle)), sin(radians(angle))
    px, py = pivot
    tx, ty = offset
    data = (
        c / scale_x, -s / scale_x, px - (c * (px + tx) - s * (py + ty)) / scale_x,
        s / scale_y, c / scale_y, py - (s * (px + tx) + c * (py + ty)) / scale_y,
    )
    source = premultiplied(image) if image.mode in ("RGBA", "RGBa") else image
    result = source.transform(size, Image.Transform.AFFINE, data, resample)
    return straight(result) if image.mode in ("RGBA", "RGBa") else result


def shift_subpixel(sprite, fraction_x, fraction_y):
    """Move a sprite right/down by less than one pixel, growing it by one pixel to fit."""
    if abs(fraction_x) < 0.02 and abs(fraction_y) < 0.02:
        return sprite
    size = sprite.width + 1, sprite.height + 1
    return affine(sprite, size, offset=(fraction_x, fraction_y), resample=Image.Resampling.BILINEAR)
