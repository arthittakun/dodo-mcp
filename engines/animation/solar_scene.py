"""The bundled Solar System scene and its continuous orbit motions."""

from pathlib import Path

from scene_animation import LayerSpec, OrbitSpec, SceneSpec


ASSETS = Path(__file__).resolve().parent / "assets" / "solar_system"
REFERENCE_WIDTH = 960
REFERENCE_HEIGHT = 540
ORBIT_TILT = -7
FORESHORTENING = 0.545

# Asset name, reference orbit radius, reference diameter or ring span, turns, opening angle.
PLANETS = (
    ("mercury", 116, 18, -3, 324),
    ("venus", 137, 25, -3, 261),
    ("earth", 173, 31, -2, 174),
    ("mars", 212, 22, -2, 74),
    ("jupiter", 259, 58, -1, 37),
    ("saturn", 308, 94, -1, 120),
    ("uranus", 356, 32, -1, 225),
    ("neptune", 407, 33, -1, 310),
)


def solar_scene(width: int = REFERENCE_WIDTH, height: int = REFERENCE_HEIGHT, *, guides: bool = True) -> SceneSpec:
    """Return an opaque space scene using only assets bundled with Gift."""
    if type(width) is not int or type(height) is not int or min(width, height) <= 0:
        raise ValueError("Solar scene width and height must be positive integers.")
    scale = min(width / REFERENCE_WIDTH, height / REFERENCE_HEIGHT)
    center_x, center_y = 0.5, 268 / REFERENCE_HEIGHT
    layers = [
        LayerSpec(
            image_path=str(ASSETS / "sun.webp"),
            x=center_x,
            y=center_y,
            width=130 * scale / width,
            pulse=1.8 / 130,
        ),
    ]
    for name, radius, diameter, turns, phase in PLANETS:
        layers.append(LayerSpec(
            image_path=str(ASSETS / f"{name}.webp"),
            x=center_x,
            y=center_y,
            width=diameter * scale / width,
            orbit=OrbitSpec(
                radius_x=radius * scale / width,
                radius_y=radius * FORESHORTENING * scale / height,
                turns=turns,
                phase_deg=phase,
                tilt_deg=ORBIT_TILT,
                depth_scale=0.043,
                guide=guides,
            ),
        ))
    return SceneSpec(
        width=width,
        height=height,
        background_image_path=str(ASSETS / "space.webp"),
        background_color="#000000",
        depth_order=True,
        layers=layers,
    )
