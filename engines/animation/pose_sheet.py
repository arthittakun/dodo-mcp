"""Condition an image model to draw animation frames, then check what it drew.

Image models drift when asked for a pose sheet from words alone: the character changes size from
cell to cell, feet float off the ground, poses spill across gutters, colours change, or the same
pose repeats. Gift constrains the request and verifies the result:

* ``build_pose_guide`` lays the sheet out for the model. The character itself sits in the first
  cell at the target size, standing on a fixed ground line, and a mask lets the model paint only
  inside the remaining cells, so the first cell and every gutter stay as they are.
* ``pose_prompt`` spells out the identity, size, ground-line and layout rules plus one pose per
  cell, so frames come back in loop order.
* ``review_pose_sheet`` measures the returned sheet against the guide: one whole figure per cell,
  a transparent background, consistent body size, a shared ground line, the same palette as the
  reference, and poses that really differ from one another.
"""

from math import sqrt
from statistics import median

from PIL import Image, ImageOps

from character_animation import _components
from smooth import downscale, premultiplied

POSE_MOTIONS = ("wave", "walk", "idle", "jump", "custom")
SOLID_ALPHA = 64
GUTTER = 0.07  # Share of the shorter cell side kept empty around every cell's drawing area.
FIGURE_HEIGHT = {"jump": 0.6}  # Reference height as a share of the cell height (0.78 otherwise);
# a jump needs headroom above the figure for its airborne frames.
GROUND = 0.9  # Ground line as a share of the cell height, from the top of the cell.
SIZE_TOLERANCE = {"jump": 0.3, "idle": 0.1}  # Allowed body-size change; 0.12 otherwise.
GROUND_TOLERANCE = 0.045  # Allowed foot offset from the ground line, as a share of cell height.
AIRBORNE = {"jump": (4,)}  # Zero-based frames that must clearly leave the ground (the apex).
LIFTOFF = {"jump": (3, 5)}  # Take-off and falling frames: on or just above the ground.
PALETTE_MATCH = 0.85  # Minimum Bhattacharyya coefficient between a frame's colours and the reference.

POSES = {
    ("wave", 8): (
        "the character exactly as in the reference, at rest",
        "the right hand starting to lift from the side, elbow bending",
        "the right hand raised beside the head, open palm facing the viewer",
        "the raised hand tilted toward the head mid-wave",
        "the raised hand tilted away from the head mid-wave",
        "the raised hand tilted back toward the head",
        "the hand lowering halfway, elbow bent",
        "the hand almost back at rest beside the body",
    ),
    ("wave", 16): (
        "the character exactly as in the reference, at rest",
        "the right hand just leaving the side",
        "the right hand lifting, elbow bending",
        "the right hand at shoulder height",
        "the right hand raised beside the head, open palm",
        "the raised hand starting to tilt toward the head",
        "the raised hand tilted toward the head",
        "the raised hand returning upright",
        "the raised hand tilted away from the head",
        "the raised hand returning upright again",
        "the raised hand tilted toward the head once more",
        "the raised hand upright, about to come down",
        "the hand lowering to shoulder height",
        "the hand lowering halfway",
        "the hand nearly at the side",
        "the hand settling at rest",
    ),
    ("walk", 8): (
        "the character exactly as in the reference: the passing pose, both feet under the body",
        "the right foot swinging forward, left foot pushing off, arms starting to swing",
        "right heel touching down in front, left foot behind, arms opposite to the legs",
        "weight settling on the right foot, body slightly lower, knees bent",
        "passing pose again with the left leg swinging past the right",
        "the left foot swinging forward, right foot pushing off",
        "left heel touching down in front, right foot behind, arms opposite to the legs",
        "weight settling on the left foot, body slightly lower",
    ),
    ("walk", 16): (
        "the character exactly as in the reference: the passing pose, both feet under the body",
        "the right foot starting forward",
        "the right foot swinging forward, left foot pushing off",
        "the right leg reaching forward, arms swinging opposite",
        "right heel touching down in front, left foot behind",
        "weight moving onto the right foot",
        "weight settled on the right foot, body slightly lower, knees bent",
        "body rising over the right foot, left foot lifting",
        "passing pose with the left leg swinging past the right",
        "the left foot swinging forward, right foot pushing off",
        "the left leg reaching forward, arms swinging opposite",
        "left heel touching down in front, right foot behind",
        "weight moving onto the left foot",
        "weight settled on the left foot, body slightly lower",
        "body rising over the left foot, right foot lifting",
        "nearly back to the passing pose",
    ),
    ("idle", 8): (
        "the character exactly as in the reference, at rest",
        "breathing in: chest and shoulders very slightly raised",
        "full breath in: body a touch taller, chin slightly up",
        "holding the breath with the eyes gently closed in a blink",
        "breathing out, eyes open again",
        "breath out: shoulders relaxed, body a touch lower",
        "slightly settled, a small happy head tilt",
        "returning to rest",
    ),
    ("jump", 8): (
        "the character exactly as in the reference, at rest",
        "anticipation: knees bending, body lowering, arms swinging back",
        "deep crouch: knees bent, arms back, ready to spring",
        "take-off: body stretched upward, arms raised, toes leaving the ground",
        "highest point: the whole body in the air well above the ground line, knees tucked, arms up",
        "falling: still in the air, legs reaching down toward the ground",
        "landing: feet back on the ground line, knees bent in a soft squash",
        "recovering upright, arms coming down to rest",
    ),
}


def grid_for(poses):
    """(columns, rows, sheet size) used for 8 or 16 poses: portrait cells on a supported size."""
    if poses == 8:
        return 4, 2, (1536, 1024)
    if poses == 16:
        return 4, 4, (1024, 1536)
    raise ValueError("Pose sheets have 8 or 16 poses.")


def pose_list(motion, poses, custom=None):
    if motion == "custom":
        if not custom or len(custom) != poses - 1:
            raise ValueError(f"A custom motion needs {poses - 1} pose descriptions, one for each cell after the first.")
        if any(not isinstance(text, str) or not 1 <= len(text.strip()) <= 200 for text in custom):
            raise ValueError("Each custom pose description needs 1 to 200 characters.")
        return ("the character exactly as in the reference", *(text.strip() for text in custom))
    try:
        return POSES[(motion, poses)]
    except KeyError:
        raise ValueError(f"{motion} supports {', '.join(str(n) for m, n in POSES if m == motion)} poses.") from None


def pose_prompt(motion, poses, custom=None):
    """The edit prompt: layout and identity conditions, then one pose per cell in reading order."""
    columns, rows, _ = grid_for(poses)
    listing = pose_list(motion, poses, custom)
    cells = "\n".join(f"Cell {index + 1}: {text}." for index, text in enumerate(listing))
    ground = ("Every foot rests on that ground line, except the cells described as in the air, whose feet are "
              "clearly above it.") if motion in AIRBORNE else "Every foot rests on that ground line in every cell."
    return (
        f"The first image is a sprite-sheet layout: {columns} columns by {rows} rows of equal cells on a "
        "transparent background. The top-left cell already holds the character, which the second image shows "
        "on its own. Keep that cell exactly as it is. Fill each of the other "
        f"{poses - 1} cells with the SAME character in one full-body pose, in reading order (left to right, "
        "then top to bottom), so the cells play as one smooth looping animation.\n"
        "Conditions for every cell: the identical character with the same face, eyes, hair, outfit, colours, "
        "line weight and shading as the reference; drawn at the same scale as the top-left cell (same head size "
        "and body height); centred in its cell; feet on the same ground line as the top-left cell. " + ground +
        " Keep the whole character inside its own cell with clear transparent space on every side; nothing "
        "crosses into a neighbouring cell or the gutters. Same viewing angle as the reference unless a cell says "
        "otherwise. One character per cell only. No text, numbers, grid lines, borders, frames, backgrounds, "
        "ground shadows, speed lines or extra objects. Keep the background fully transparent.\n" + cells
    )


def _subject(image):
    rgba = ImageOps.exif_transpose(image).convert("RGBA")
    box = rgba.getchannel("A").point([0] * SOLID_ALPHA + [255] * (256 - SOLID_ALPHA)).getbbox()
    if box is None:
        raise ValueError("The reference image is fully transparent. Use a character on a transparent background.")
    if rgba.getchannel("A").getextrema()[0] > 0:
        raise ValueError("The reference needs a transparent background. Remove the background first.")
    return rgba.crop(box)


def build_pose_guide(reference, *, poses=8, motion="wave"):
    """Return (guide, mask, layout) for one pose sheet.

    The guide is the empty sheet with the character in the first cell at the size and ground line
    every frame should use. The mask follows the OpenAI image-edit convention: transparent pixels
    may be repainted, opaque ones are kept, so only the inner area of cells 2..N can change.
    """
    columns, rows, (width, height) = grid_for(poses)
    character = _subject(reference)
    cell_w, cell_h = width / columns, height / rows
    gutter = round(GUTTER * min(cell_w, cell_h))
    scale = min(FIGURE_HEIGHT.get(motion, 0.78) * cell_h / character.height, (cell_w - 4 * gutter) / character.width)
    size = max(1, round(character.width * scale)), max(1, round(character.height * scale))
    placed = premultiplied(character).resize(size, Image.Resampling.LANCZOS).convert("RGBA")

    guide = Image.new("RGBA", (width, height))
    mask = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    cells, inner, grounds = [], [], []
    for index in range(columns * rows):
        column, row = index % columns, index // columns
        box = (round(column * cell_w), round(row * cell_h), round((column + 1) * cell_w), round((row + 1) * cell_h))
        drawable = (box[0] + gutter, box[1] + gutter, box[2] - gutter, box[3] - gutter)
        ground = round(box[1] + GROUND * cell_h)
        cells.append(box)
        inner.append(drawable)
        grounds.append(ground)
        if index == 0:
            guide.alpha_composite(placed, (round((box[0] + box[2] - size[0]) / 2), ground - size[1]))
        else:
            mask.paste((0, 0, 0, 0), drawable)
    layout = {
        "poses": poses, "columns": columns, "rows": rows, "sheet": [width, height],
        "cells": [list(box) for box in cells], "inner": [list(box) for box in inner], "ground": grounds,
        "figure_height": size[1], "figure_width": size[0], "motion": motion,
    }
    return guide, mask, layout


def _figure(mask):
    """Main connected figure in one cell: (box, ink share of the main figure)."""
    preview = mask.copy()
    preview.thumbnail((256, 256), Image.Resampling.BOX)
    solid = preview.point([0] * 96 + [255] * 160)
    components = sorted(_components(solid), key=lambda component: component[2], reverse=True)
    if not components:
        return None, 0.0
    (left, top, right, bottom), _, area = components[0]
    total = sum(size for _, _, size in components)
    sx, sy = mask.width / preview.width, mask.height / preview.height
    region = (int(left * sx), int(top * sy), min(mask.width, int(right * sx) + 2), min(mask.height, int(bottom * sy) + 2))
    bounds = mask.crop(region).getbbox()
    box = region if bounds is None else (region[0] + bounds[0], region[1] + bounds[1],
                                         region[0] + bounds[2], region[1] + bounds[3])
    return box, area / total


def _body_height(mask, box):
    """Ground to top of head above the figure's upper-body centre, ignoring a hand raised to one side."""
    left, top, right, bottom = box
    band = mask.crop((left, top + (bottom - top) // 6, right, top + (bottom - top) // 2))
    weights = band.resize((band.width, 1), Image.Resampling.BOX).tobytes()
    total, middle = sum(weights), sum(weights) / 2
    center = (left + right) // 2
    for x, weight in enumerate(weights):
        middle -= weight
        if total and middle <= 0:
            center = left + x
            break
    half = max(2, (right - left) // 8)
    column = mask.crop((max(left, center - half), top, min(right, center + half), bottom)).getbbox()
    head_top = top + column[1] if column else top
    return bottom - head_top


def _palette(image, mask):
    """Coarse 6x6x6 colour histogram of a figure's solid pixels, as probabilities."""
    small = image.copy()
    small.thumbnail((128, 128), Image.Resampling.BOX)
    solid = mask.copy().resize(small.size, Image.Resampling.BOX)
    counts = [0] * 216
    for (r, g, b, _), alpha in zip(small.convert("RGBA").get_flattened_data(), solid.get_flattened_data()):
        if alpha >= 200:
            counts[(r * 6 // 256) * 36 + (g * 6 // 256) * 6 + b * 6 // 256] += 1
    total = sum(counts) or 1
    return [count / total for count in counts]


def _similar(p, q):
    return sum(sqrt(a * b) for a, b in zip(p, q))


def cell_grounds(figures, layout, motion, scale=(1.0, 1.0)):
    """The ground line each cell actually uses: the median foot line of its row's grounded poses.

    `figures` are the per-cell figure boxes in sheet pixels (None for an empty cell). A row
    without grounded poses keeps the planned line.
    """
    columns = layout["columns"]
    skip = set(AIRBORNE.get(motion, ())) | set(LIFTOFF.get(motion, ()))
    grounds = []
    for index, planned in enumerate(layout["ground"]):
        row = index // columns
        feet = [figures[cell][3] for cell in range(row * columns, (row + 1) * columns)
                if cell not in skip and cell < len(figures) and figures[cell] is not None]
        grounds.append(round(median(feet)) if feet else round(planned * scale[1]))
    return grounds


def sheet_figures(sheet, layout):
    """Per-cell main figure boxes of a sheet, in sheet pixels, scaled from the planned layout."""
    sheet = ImageOps.exif_transpose(sheet).convert("RGBA")
    sx, sy = sheet.width / layout["sheet"][0], sheet.height / layout["sheet"][1]
    solid = sheet.getchannel("A").point([0] * SOLID_ALPHA + [255] * (256 - SOLID_ALPHA))
    figures = []
    for box in layout["cells"]:
        box = (round(box[0] * sx), round(box[1] * sy), round(box[2] * sx), round(box[3] * sy))
        figure, _ = _figure(solid.crop(box))
        figures.append(None if figure is None else (box[0] + figure[0], box[1] + figure[1], box[0] + figure[2], box[1] + figure[3]))
    return figures, (sx, sy)


def _check(check_id, ok, detail, metrics, advisory=False):
    status = "pass" if ok else "fail"
    return {"id": check_id, "status": status, "detail": detail, "metrics": {**metrics, "advisory": advisory}}


def review_pose_sheet(sheet, layout, motion, reference=None):
    """Check a generated sheet against its layout. Returns (checks, passed).

    Advisory checks (reported, but they do not fail the sheet): the first cell kept, smooth steps.
    """
    sheet = ImageOps.exif_transpose(sheet).convert("RGBA")
    sx, sy = sheet.width / layout["sheet"][0], sheet.height / layout["sheet"][1]
    scale = lambda box: (round(box[0] * sx), round(box[1] * sy), round(box[2] * sx), round(box[3] * sy))  # noqa: E731
    alpha = sheet.getchannel("A")
    solid = alpha.point([0] * SOLID_ALPHA + [255] * (256 - SOLID_ALPHA))
    cells = [scale(box) for box in layout["cells"]]
    inner = [scale(box) for box in layout["inner"]]
    grounds = [round(value * sy) for value in layout["ground"]]
    cell_h = cells[0][3] - cells[0][1]
    checks = []

    transparent = sum(alpha.histogram()[:16]) / (sheet.width * sheet.height)
    gutter_mask = Image.new("L", sheet.size, 255)
    for box in inner:
        gutter_mask.paste(0, box)
    gutter_ink = sum(Image.composite(solid, Image.new("L", sheet.size), gutter_mask).histogram()[1:])
    gutter_area = sum(gutter_mask.histogram()[1:]) or 1
    checks.append(_check(
        "transparent_background", transparent >= 0.3 and gutter_ink / gutter_area <= 0.02,
        "The sheet has a transparent background and empty gutters." if transparent >= 0.3 and gutter_ink / gutter_area <= 0.02
        else "The background or gutters are painted. Ask again for a fully transparent sheet with empty gutters.",
        {"transparent_share": round(transparent, 3), "gutter_ink_share": round(gutter_ink / gutter_area, 4)}))

    figures, problems = [], []
    for index, (box, area) in enumerate(zip(cells, inner)):
        figure, share = _figure(solid.crop(box))
        if figure is None:
            problems.append(f"cell {index + 1} is empty")
            figures.append(None)
            continue
        absolute = (box[0] + figure[0], box[1] + figure[1], box[0] + figure[2], box[1] + figure[3])
        if share < 0.9:
            problems.append(f"cell {index + 1} has detached pieces or a second figure")
        if absolute[0] <= box[0] + 1 or absolute[1] <= box[1] + 1 or absolute[2] >= box[2] - 1 or absolute[3] >= box[3] - 1:
            problems.append(f"cell {index + 1} is cut off at the cell edge")
        figures.append(absolute)
    # Ink on a line shared by two cells means a pose spills into its neighbour.
    columns, rows = layout["columns"], layout["rows"]
    spill = 0
    for column in range(columns - 1):
        x = cells[column][2]
        spill += sum(solid.crop((x - 1, 0, x + 1, sheet.height)).histogram()[1:])
    for row in range(rows - 1):
        y = cells[row * columns][3]
        spill += sum(solid.crop((0, y - 1, sheet.width, y + 1)).histogram()[1:])
    if spill > 8:
        problems.append("poses spill across the lines between cells")
    checks.append(_check(
        "one_figure_per_cell", not problems,
        "Every cell holds one whole figure." if not problems else "; ".join(problems).capitalize() + ".",
        {"cells": len(cells), "problems": len(problems)}))

    present = [(index, box) for index, box in enumerate(figures) if box is not None]
    heights = {index: _body_height(solid, box) for index, box in present}
    base = heights.get(0) or (median(heights.values()) if heights else 0)
    tolerance = SIZE_TOLERANCE.get(motion, 0.12)
    off_size = [index + 1 for index, height in heights.items() if base and abs(height / base - 1) > tolerance]
    checks.append(_check(
        "consistent_size", base > 0 and not off_size,
        "Every pose is drawn at the reference size." if base > 0 and not off_size
        else f"Cells {', '.join(map(str, off_size))} are drawn at a different size than cell 1.",
        {"reference_height": base, "heights": [heights.get(index) for index in range(len(cells))],
         "tolerance": tolerance}))

    # Models redraw the whole sheet and may shift a row as a unit, which assembly absorbs. What
    # matters is that poses in a row share one ground line, and that a jump really leaves it.
    measured = cell_grounds(figures, layout, motion, (sx, sy))
    airborne, liftoff = AIRBORNE.get(motion, ()), LIFTOFF.get(motion, ())
    grounded_off, not_lifted = [], []
    for index, box in present:
        offset = (box[3] - measured[index]) / cell_h
        if index in airborne:
            if offset > -GROUND_TOLERANCE:
                not_lifted.append(index + 1)
        elif index in liftoff:
            if offset > GROUND_TOLERANCE:
                grounded_off.append(index + 1)
        elif abs(offset) > GROUND_TOLERANCE:
            grounded_off.append(index + 1)
    ground_ok = not grounded_off and not not_lifted
    detail = "Every grounded pose stands on its row's shared ground line." if ground_ok else " ".join(filter(None, (
        f"Cells {', '.join(map(str, grounded_off))} float above or sink below the ground line." if grounded_off else "",
        f"Cells {', '.join(map(str, not_lifted))} should be in the air." if not_lifted else "")))
    checks.append(_check("ground_line", ground_ok, detail, {
        "offsets": [round((box[3] - measured[i]) / cell_h, 3) for i, box in present],
        "row_shift": [round((measured[row * columns] - grounds[row * columns]) / cell_h, 3) for row in range(rows)]}))

    if reference is not None and present:
        target = _subject(reference)
        target_palette = _palette(target, target.getchannel("A"))
        scores = {index: _similar(_palette(sheet.crop(box), alpha.crop(box)), target_palette) for index, box in present}
        strays = [index + 1 for index, score in scores.items() if score < PALETTE_MATCH]
        checks.append(_check(
            "same_character", not strays,
            "Every pose keeps the reference's colours." if not strays
            else f"Cells {', '.join(map(str, strays))} change the character's colours.",
            {"palette_match": [round(scores[index], 3) if index in scores else None for index in range(len(cells))],
             "minimum": PALETTE_MATCH}))

    thumbs = []
    for index, box in present:
        crop = sheet.crop(box)
        page = Image.new("RGBA", crop.size, (255, 255, 255, 255))
        page.alpha_composite(crop)
        thumbs.append((index, page.convert("L").resize((48, 64), Image.Resampling.BOX)))
    def difference(a, b):
        return sum(abs(x - y) for x, y in zip(a.tobytes(), b.tobytes())) / (48 * 64 * 255)
    repeats = [index + 1 for (index, a), (_, b) in zip(thumbs[1:], thumbs) if difference(a, b) < 0.004]
    checks.append(_check(
        "distinct_poses", len(thumbs) >= 2 and len(repeats) <= len(thumbs) // 4,
        "Consecutive poses differ, so the loop moves." if len(thumbs) >= 2 and len(repeats) <= len(thumbs) // 4
        else f"Cells {', '.join(map(str, repeats))} repeat the previous pose.", {"repeats": repeats}))
    steps = [difference(a, b) for (_, a), (_, b) in zip(thumbs[1:], thumbs)] + (
        [difference(thumbs[0][1], thumbs[-1][1])] if len(thumbs) > 2 else [])
    middle = median(steps) if steps else 0
    jumps = [index + 2 for index, step in enumerate(steps[:-1] if len(thumbs) > 2 else steps)
             if middle and step > 3.2 * middle and step > 0.05]
    checks.append(_check(
        "smooth_sequence", not jumps,
        "Each pose leads naturally into the next." if not jumps
        else f"Cells {', '.join(map(str, jumps))} change much more than the other steps; they may be out of order.",
        {"steps": [round(step, 4) for step in steps]}, advisory=True))

    passed = all(check["status"] == "pass" for check in checks if not check["metrics"]["advisory"])
    return checks, passed


def guide_preview(guide, mask):
    """The guide on a page with the editable cells tinted, for showing the plan to a person."""
    page = Image.new("RGBA", guide.size, (244, 247, 252, 255))
    tint = Image.new("RGBA", guide.size, (120, 170, 255, 70))
    page.paste(tint, (0, 0), mask.getchannel("A").point(lambda value: 255 - value))
    page.alpha_composite(guide)
    return downscale(page, (guide.width // 2, guide.height // 2))
