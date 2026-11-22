"""Split a transparent grid of full-character poses into consistently aligned frames."""

from io import BytesIO
from itertools import pairwise

from PIL import Image, ImageFilter, ImageOps, UnidentifiedImageError

from character_animation import _components
from image_animation import MAX_IMAGE_SIDE, MAX_SOURCE_PIXELS


MAX_SHEET_BYTES = 10 * 1024 * 1024
DETECTION_ALPHA = 64
FRAME_MARGIN = 4


def _read_sheet(data):
    if not isinstance(data, bytes) or not 0 < len(data) <= MAX_SHEET_BYTES:
        raise ValueError("Supply a PNG or WebP sprite sheet no larger than 10 MB.")
    try:
        with Image.open(BytesIO(data), formats=("PNG", "WEBP")) as source:
            if source.width * source.height > MAX_SOURCE_PIXELS:
                raise ValueError("The sprite sheet exceeds 24 million pixels. Resize the sheet and try again.")
            if getattr(source, "n_frames", 1) != 1:
                raise ValueError("Supply one still image containing the complete pose grid.")
            sheet = ImageOps.exif_transpose(source).convert("RGBA")
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError) as exc:
        raise ValueError("Could not open the sprite sheet. Export a transparent PNG or WebP and try again.") from exc
    if sheet.getchannel("A").getextrema()[0] > 0:
        raise ValueError("The sprite sheet needs transparent margins and gutters. Export as transparent PNG or WebP.")
    return sheet


def _cuts(projection, sections, axis):
    """Choose empty separators near nominal grid lines, allowing uneven margins."""
    length = len(projection)
    step = length / sections
    boundaries = [0]
    for index in range(1, sections):
        nominal = round(step * index)
        span = round(step * .26)
        start = max(boundaries[-1] + 8, nominal - span, 1)
        stop = min(length - 8, nominal + span, length - 1)
        gaps = [cut for cut in range(start, stop + 1) if not projection[cut - 1] and not projection[cut]]
        if not gaps:
            raise ValueError(f"Cannot separate the {axis}. Leave a transparent gutter between complete poses.")
        boundaries.append(min(gaps, key=lambda cut: abs(cut - nominal)))
    return boundaries + [length]


def _main_silhouette(mask, cell):
    # Detect anatomy-sized disconnected pieces while letting edge specks or small
    # decorations survive in the original pixels. A one-pixel crack may be antialiasing.
    preview = mask.copy()
    preview.thumbnail((384, 384), Image.Resampling.BOX)
    solid = preview.point([0] * 96 + [255] * 160)
    joined = solid.filter(ImageFilter.MaxFilter(3))
    components = sorted(_components(joined), key=lambda component: component[2], reverse=True)
    if not components:
        raise ValueError(f"Pose {cell} is blank. Put one complete character in every grid cell.")
    outline, _, area = components[0]
    fragments = [size for _, _, size in components[1:] if size >= 16]
    if fragments and (fragments[0] >= max(28, area * .045) or sum(fragments) >= max(44, area * .11)):
        raise ValueError(f"Pose {cell} contains a detached piece or another figure. Supply a complete, connected character.")

    if len(components) == 1:
        return mask.getbbox()
    # Use the main figure for alignment. Small floating elements are still rendered.
    left, top, right, bottom = outline
    scale_x, scale_y = mask.width / preview.width, mask.height / preview.height
    region = (round(left * scale_x), round(top * scale_y), round(right * scale_x), round(bottom * scale_y))
    bounds = mask.crop(region).getbbox()
    if bounds is None:
        return mask.getbbox()
    return bounds[0] + region[0], bounds[1] + region[1], bounds[2] + region[0], bounds[3] + region[1]


def _pose(sheet, mask, box, cell, ground=None):
    rgba = sheet.crop(box)
    mask = mask.crop(box)
    silhouette = mask.getbbox()
    if silhouette is None:
        raise ValueError(f"Pose {cell} is blank. Put one complete character in every grid cell.")
    left, top, right, bottom = silhouette
    main_left, main_top, main_right, baseline = _main_silhouette(mask, cell)
    if main_left == 0 or main_top == 0 or main_right == rgba.width or baseline == rgba.height:
        raise ValueError(f"Pose {cell} touches a sheet edge. Leave enough room for the whole character.")

    # The upper middle of the silhouette is less affected by foot, hand and tail swings.
    main_height = baseline - main_top
    sample_top = main_top + int(main_height * .16)
    sample_bottom = max(sample_top + 1, main_top + round(main_height * .46))
    upper = mask.crop((main_left, sample_top, main_right, sample_bottom))
    weights = upper.resize((upper.width, 1), Image.Resampling.BOX).tobytes()
    middle = sum(weights) / 2
    anchor = (main_left + main_right) // 2
    for x, weight in enumerate(weights):
        middle -= weight
        if middle <= 0 and weight:
            anchor = main_left + x
            break

    # Keep the original alpha and a few pixels of fringe outside the detection mask.
    left, top = max(0, left - 3), max(0, top - 3)
    right, bottom = min(rgba.width, right + 3), min(rgba.height, bottom + 3)
    # A known ground line (sheet pixels) keeps airborne poses in the air instead of on their lowest point.
    if ground is not None:
        baseline = ground - box[1]
    return rgba.crop((left, top, right, bottom)), anchor - left, baseline - top


def _equalize(poses, tolerance):
    """Scale poses whose body height drifts from the first pose by at most `tolerance` back to it.

    Image models redraw a character a few percent larger or smaller from cell to cell, which plays
    as a pulsing figure. Larger differences are left alone: a crouch or a stretch is intentional.
    """
    from pose_sheet import _body_height

    def height(image):
        solid = image.getchannel("A").point([0] * DETECTION_ALPHA + [255] * (256 - DETECTION_ALPHA))
        box = solid.getbbox()
        return _body_height(solid, box) if box else 0

    target = height(poses[0][0])
    if not target:
        return poses
    result = [poses[0]]
    for image, anchor, baseline in poses[1:]:
        ratio = target / max(1, height(image))
        if 1e-3 < abs(ratio - 1) <= tolerance:
            size = max(1, round(image.width * ratio)), max(1, round(image.height * ratio))
            from smooth import downscale

            image = downscale(image, size) if ratio < 1 else image.resize(size, Image.Resampling.LANCZOS)
            anchor, baseline = round(anchor * ratio), round(baseline * ratio)
        result.append((image, anchor, baseline))
    return result


def load_sprite_frames(data: bytes, *, columns: int = 4, rows: int = 2, equalize: float = 0.0,
                       grounds: list[int] | None = None) -> list[Image.Image]:
    """Read complete poses in row-major order and align their head centers and paw baselines.

    The transparent still sheet must have 2–32 poses with visible gaps between them.
    Columns can shift slightly by row. Frames share one transparent canvas and are
    scaled uniformly if that canvas would exceed the existing Gift size limit.
    `equalize` (0–0.3) scales poses whose body height drifts from the first pose by up to that
    share back to the first pose's size, so a generated sheet does not pulse. `grounds` (one
    sheet-pixel ground line per pose) aligns poses to that line instead of their lowest point,
    so a jump keeps its height.
    """
    if grounds is not None and len(grounds) != columns * rows:
        raise ValueError("Give one ground line per pose.")
    if not 0 <= equalize <= 0.3:
        raise ValueError("equalize is a share between 0 and 0.3.")
    if (type(columns) is not int or type(rows) is not int or not 1 <= columns <= 8
            or not 1 <= rows <= 8 or not 2 <= columns * rows <= 32):
        raise ValueError("Use a grid of 2–32 poses with up to 8 columns and 8 rows.")
    sheet = _read_sheet(data)
    if sheet.width < columns * 8 or sheet.height < rows * 8:
        raise ValueError("The sheet is too small for the requested grid.")

    mask = sheet.getchannel("A").point([0] * DETECTION_ALPHA + [255] * (256 - DETECTION_ALPHA))
    row_cuts = _cuts(mask.getprojection()[1], rows, "rows")
    poses = []
    for top, bottom in pairwise(row_cuts):
        row = mask.crop((0, top, sheet.width, bottom))
        column_cuts = _cuts(row.getprojection()[0], columns, "columns")
        for left, right in pairwise(column_cuts):
            ground = None if grounds is None else grounds[len(poses)]
            poses.append(_pose(sheet, mask, (left, top, right, bottom), len(poses) + 1, ground))
    if equalize:
        poses = _equalize(poses, equalize)

    half_width = max(max(anchor, image.width - anchor) for image, anchor, _ in poses)
    above = max(baseline for _, _, baseline in poses)
    below = max(image.height - baseline for image, _, baseline in poses)
    # Leave one extra pixel before rounding the extents on opposite sides separately.
    scale = min(1, (MAX_IMAGE_SIDE - 2 * FRAME_MARGIN - 1) / max(2 * half_width, above + below))
    center_x = round(half_width * scale) + FRAME_MARGIN
    ground_y = round(above * scale) + FRAME_MARGIN
    size = 2 * center_x, ground_y + round(below * scale) + FRAME_MARGIN

    frames = []
    for image, anchor, baseline in poses:
        if scale < 1:
            scaled_size = max(1, round(image.width * scale)), max(1, round(image.height * scale))
            image = image.resize(scaled_size, Image.Resampling.LANCZOS)
        frame = Image.new("RGBA", size)
        frame.alpha_composite(image, (center_x - round(anchor * scale), ground_y - round(baseline * scale)))
        frames.append(frame)
    return frames
