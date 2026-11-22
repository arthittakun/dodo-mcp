"""One registry of bundled characters and their motion presets."""

from pathlib import Path

import fox_girl_rig
import orange_cat_rig


CHARACTERS_DIR = Path(__file__).resolve().parent / "assets" / "characters"
CHARACTER_IMAGES = {
    "orange_cat": CHARACTERS_DIR / "orange_cat.png",
    "fox_girl": CHARACTERS_DIR / "fox_girl.png",
}
PRESETS = {
    **{name: (factory, "orange_cat") for name, factory in orange_cat_rig.PRESETS.items()},
    **{name: (factory, "fox_girl") for name, factory in fox_girl_rig.PRESETS.items()},
}


def preset_rig(name):
    """Return (rig spec, character image path, character name) for a bundled preset."""
    factory, character = PRESETS[name]
    return factory(), CHARACTER_IMAGES[character], character
