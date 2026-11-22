"""Rig and motion presets for Kitsune, Gift's chibi fox-girl demo character.

Landmarks were measured on the artwork with a 120 px left margin; OFFSET_X shifts them to
assets/characters/fox_girl.png, which has extra room on the left for the tail to swing.
"""

from pathlib import Path

from motion_physics import BlinkSpec, PhysicsSpec
from rig_animation import BodyMotionSpec, RigPartSpec, RigSpec


SOURCE = Path(__file__).resolve().parent / "assets" / "characters" / "fox_girl.png"
SOURCE_WIDTH = 1756
SOURCE_HEIGHT = 2249
OFFSET_X = 180


def _point(x, y):
    return (x + OFFSET_X) / (SOURCE_WIDTH - 1), y / (SOURCE_HEIGHT - 1)


def _polygon(*points):
    return [_point(x, y) for x, y in points]


def _eye(x, y, radius_x, radius_y):
    left, top = _point(x, y)
    return left, top, radius_x / SOURCE_WIDTH, radius_y / SOURCE_HEIGHT


# Anime eyes are larger than their dark lash line, so they are placed by hand.
EYES = [_eye(678, 802, 76, 70), _eye(922, 760, 76, 70)]


def ears(physics: PhysicsSpec, twitch: float = 2.0) -> list[RigPartSpec]:
    """Both fox ears. Their bases sit under the hair, inside the fixed zone, so the hair never moves."""
    left = ((420, 600), (412, 450), (420, 300), (440, 185), (470, 172), (560, 240), (650, 300),
            (712, 370), (712, 420), (640, 470), (560, 540), (480, 610))
    right = ((850, 380), (870, 330), (960, 240), (1060, 178), (1110, 160), (1138, 200), (1152, 320),
             (1168, 450), (1172, 600), (1100, 560), (1010, 520), (920, 470))
    return [
        RigPartSpec(name="left_ear", polygon=_polygon(*left), root=_point(575, 470), tip=_point(455, 205),
                    motion="swing", rotation_deg=twitch, phase_offset=0.1, anchor_fraction=0.35,
                    behind=True, physics=physics, seeds=_polygon((470, 270), (520, 340), (600, 330))),
        RigPartSpec(name="right_ear", polygon=_polygon(*right), root=_point(1010, 470), tip=_point(1100, 195),
                    motion="swing", rotation_deg=twitch, phase_offset=0.35, anchor_fraction=0.35,
                    behind=True, physics=physics, seeds=_polygon((1085, 260), (1050, 340), (960, 330))),
    ]


def tail(physics: PhysicsSpec, wag: float = 10.0) -> RigPartSpec:
    """The big fluffy tail behind the left hand, separated from the sleeve and hand by its line art."""
    # Deliberately loose: the seeds stop at the sleeve, hand and shorts line art.
    outline = (
        (230, 1010), (360, 1005), (480, 1090), (610, 1180), (660, 1320), (665, 1560), (690, 1700),
        (630, 1765), (300, 1765), (165, 1705), (90, 1550), (85, 1300), (115, 1160), (185, 1065),
    )
    return RigPartSpec(name="tail", polygon=_polygon(*outline), root=_point(630, 1630), tip=_point(290, 1070),
                       motion="swing", rotation_deg=wag, anchor_fraction=0.2, behind=True, physics=physics,
                       seeds=_polygon((330, 1300), (220, 1150), (290, 1130), (420, 1600), (560, 1690)))


def waving_hand(physics: PhysicsSpec, wave: float = 14.0) -> RigPartSpec:
    """The raised hand and cuff, waving from the middle of the forearm."""
    outline = (
        (1120, 1290), (1110, 1150), (1135, 1060), (1150, 1000), (1166, 945), (1185, 898), (1224, 894),
        (1230, 850), (1262, 838), (1300, 852), (1345, 898), (1378, 950), (1340, 1000), (1315, 1060),
        (1325, 1150), (1300, 1250), (1240, 1310),
    )
    return RigPartSpec(name="waving_hand", polygon=_polygon(*outline), root=_point(1235, 1150),
                       tip=_point(1268, 860), motion="wave", rotation_deg=wave, anchor_fraction=0.3,
                       physics=physics)


def fox_girl_idle_rig() -> RigSpec:
    """Breathe, wave hello, wag the tail in a breeze, twitch the ears and blink twice."""
    parts = [
        waving_hand(PhysicsSpec(strength=110, damping=0.35, inertia=1.5, whip=0.4, limit_deg=30)),
        tail(PhysicsSpec(strength=22, damping=0.22, inertia=3, whip=0.75, wind=6, limit_deg=30)),
        *ears(PhysicsSpec(strength=80, damping=0.2, inertia=3, whip=0.5, wind=1.5, limit_deg=14)),
    ]
    body = BodyMotionSpec(style="breathe", bob=0.014, squash=0.4, beats=1)
    return RigSpec(parts=parts, cycles=2, body=body, blink=BlinkSpec(eyes=EYES, count=1, double=True))


def fox_girl_bounce_rig() -> RigSpec:
    """Happy little hops in place, four per loop, with floppy ears and tail."""
    parts = [
        waving_hand(PhysicsSpec(strength=110, damping=0.35, inertia=1.2, whip=0.4, limit_deg=30), wave=18),
        tail(PhysicsSpec(strength=26, damping=0.25, inertia=4, whip=0.75, limit_deg=32), wag=12),
        *ears(PhysicsSpec(strength=70, damping=0.22, inertia=4, whip=0.6, limit_deg=18)),
    ]
    body = BodyMotionSpec(style="jump", beats=2, squash=0.6, jump_height=0.05, jump_squash=0.12)
    return RigSpec(parts=parts, cycles=2, body=body, blink=BlinkSpec(eyes=EYES, count=1))


def fox_girl_jump_rig() -> RigSpec:
    """Hop with anticipation, stretch, landing squash, and ears and tail that fly behind."""
    parts = [
        waving_hand(PhysicsSpec(strength=110, damping=0.4, inertia=1.0, whip=0.4, limit_deg=25), wave=8),
        tail(PhysicsSpec(strength=30, damping=0.3, inertia=4, whip=0.7, limit_deg=35), wag=6),
        *ears(PhysicsSpec(strength=70, damping=0.28, inertia=4, whip=0.6, limit_deg=22)),
    ]
    body = BodyMotionSpec(style="jump", beats=1, squash=0.5, jump_height=0.18, jump_squash=0.13)
    return RigSpec(parts=parts, cycles=2, body=body, blink=BlinkSpec(eyes=EYES, count=1))


PRESETS = {
    "fox_girl_idle": fox_girl_idle_rig,
    "fox_girl_bounce": fox_girl_bounce_rig,
    "fox_girl_jump": fox_girl_jump_rig,
}
