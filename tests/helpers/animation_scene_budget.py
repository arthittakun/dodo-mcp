"""Tiny regression fixtures for scene decoding; no large image allocation."""
import io
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from PIL import Image, ImageSequence

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
import scene_animation as scene


def gif_pair(size):
    output = io.BytesIO()
    Image.new("RGB", size, "red").save(
        output, format="GIF", save_all=True,
        append_images=[Image.new("RGB", size, "blue")], duration=100, optimize=False,
    )
    return bytearray(output.getvalue())


def expanding_gif():
    raw = gif_pair((64, 64))
    offset = 13 + (3 * 2 ** ((raw[10] & 7) + 1) if raw[10] & 128 else 0)
    descriptors = []
    while raw[offset] != 0x3B:
        kind = raw[offset]
        offset += 1
        if kind == 0x21:
            offset += 1
        elif kind == 0x2C:
            descriptors.append(offset - 1)
            packed = raw[offset + 8]
            offset += 9 + (3 * 2 ** ((packed & 7) + 1) if packed & 128 else 0)
            offset += 1
        else:
            raise AssertionError("unexpected GIF fixture block")
        while raw[offset]:
            offset += raw[offset] + 1
        offset += 1
    # Preserve the second local image descriptor at 64x64, but make the logical
    # canvas and first descriptor 4x4. Pillow expands the canvas on frame two.
    raw[6:10] = (4).to_bytes(2, "little") * 2
    first = descriptors[0]
    raw[first + 5:first + 9] = (4).to_bytes(2, "little") * 2
    return raw


def must_reject(path, expected):
    try:
        scene._load_frames(str(path))
    except ValueError as error:
        assert expected in str(error), str(error)
    else:
        raise AssertionError("the decoder accepted an input above its budget")


with TemporaryDirectory(prefix="dodo-scene-budget-") as directory:
    root = Path(directory)
    expanding = root / "expanding.gif"
    expanding.write_bytes(expanding_gif())
    with Image.open(expanding) as image:
        assert image.size == (4, 4) and image.n_frames == 2
        assert [frame.size for frame in ImageSequence.Iterator(image)] == [(4, 4), (64, 64)]
    original_total, original_source = scene.MAX_ANIMATED_PIXELS, scene.MAX_SOURCE_PIXELS
    try:
        scene.MAX_ANIMATED_PIXELS = 1000
        must_reject(expanding, "Animated layer is too large")
        scene.MAX_ANIMATED_PIXELS = original_total
        scene.MAX_SOURCE_PIXELS = 32
        must_reject(expanding, "Animated layer is too large")
    finally:
        scene.MAX_ANIMATED_PIXELS, scene.MAX_SOURCE_PIXELS = original_total, original_source

    over_count = root / "too-many.gif"
    Image.new("RGB", (1, 1), "red").save(
        over_count, format="GIF", save_all=True, duration=10,
        append_images=[Image.new("RGB", (1, 1), "blue" if index % 2 else "red") for index in range(1, 241)],
    )
    with Image.open(over_count) as image:
        assert image.n_frames == 241
    must_reject(over_count, "at most 240 frames")

    normal = root / "normal.gif"
    normal.write_bytes(gif_pair((4, 4)))
    frames, durations = scene._load_frames(str(normal))
    assert len(frames) == 2 and [frame.size for frame in frames] == [(4, 4), (4, 4)]
    prepared = scene.prepare_scene(scene.SceneSpec(width=64, height=64, layers=[scene.LayerSpec(image_path=str(normal))]))
    output = root / "scene.gif"
    scene.save_scene_gif(prepared, output, 8, [120] * 8)
    with Image.open(output) as image:
        assert image.size == (64, 64) and image.n_frames >= 2
    print(json.dumps({"cumulativeExpansionRejected": True, "perFrameExpansionRejected": True, "frameCapRejected": True,
                      "normalFrames": len(frames), "sceneRendered": output.stat().st_size > 0,
                      "fixtureBytes": expanding.stat().st_size}))
