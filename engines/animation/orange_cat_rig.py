"""Landmarks and motion presets calibrated to Gift's original orange cat artwork."""

from motion_physics import BlinkSpec, PhysicsSpec
from rig_animation import BodyMotionSpec, FootIKSpec, RigPartSpec, RigSpec


SOURCE_WIDTH = 1199
SOURCE_HEIGHT = 1312


def _point(x, y):
    return x / SOURCE_WIDTH, y / SOURCE_HEIGHT


def _polygon(*points):
    return [_point(x, y) for x, y in points]


def _legs():
    left_outline = (
        (589, 1036), (568, 1053), (564, 1109), (571, 1128),
        (590, 1167), (578, 1236), (382, 1236), (376, 1170),
        (420, 1120), (410, 1075), (418, 1037),
    )
    right_outline = (
        (767, 1038), (751, 1105), (755, 1127), (788, 1164),
        (793, 1236), (584, 1236), (588, 1160), (604, 1122),
        (599, 1063), (589, 1039),
    )
    return [
        RigPartSpec(
            name="left_leg",
            polygon=_polygon((431, 976), (589, 976), *left_outline, (426, 1009)),
            cut_polygon=_polygon((418, 1028), (589, 1028), *left_outline),
            root=_point(496, 985), tip=_point(484, 1205),
            motion="step", phase_offset=0, movement_x=-0.003, movement_y=0.052,
            rotation_deg=5, anchor_fraction=0.25, behind=True,
        ),
        RigPartSpec(
            name="right_leg",
            polygon=_polygon((589, 976), (767, 976), *right_outline),
            cut_polygon=_polygon((589, 1028), (768, 1028), *right_outline),
            root=_point(679, 985), tip=_point(686, 1205),
            motion="step", phase_offset=0.5, movement_x=-0.003, movement_y=0.052,
            rotation_deg=5, anchor_fraction=0.25, behind=True,
        ),
    ]


def waving_arm(*, rotation=18, physics=None) -> RigPartSpec:
    """The raised right forearm, waving from the sleeve."""
    paw_outline = (
        (831, 708), (922, 710), (985, 704), (1025, 727),
        (1035, 856), (993, 868), (897, 861),
    )
    return RigPartSpec(
        name="right_forearm",
        polygon=_polygon((783, 711), *paw_outline, (753, 841)),
        cut_polygon=_polygon((805, 711), *paw_outline, (771, 841)),
        root=_point(774, 775), tip=_point(988, 787),
        motion="wave", rotation_deg=rotation, rotation_bias=32,
        anchor_fraction=0.21, behind=True, physics=physics,
    )


def tail_part(*, physics=None) -> RigPartSpec:
    """The curled tail behind the left arm, wagging from its hidden base."""
    # The inner edge follows just left of the hanging left arm so the arm never moves with it.
    outline = (
        (318, 1015), (288, 1016), (248, 998), (214, 952), (204, 880), (211, 800),
        (238, 750), (300, 740), (352, 754), (354, 800), (332, 850), (323, 880), (318, 905),
    )
    return RigPartSpec(
        name="tail", polygon=_polygon(*outline), root=_point(305, 985), tip=_point(275, 765),
        motion="swing", rotation_deg=9, anchor_fraction=0.25, behind=True, physics=physics,
    )


def ear_parts(physics: PhysicsSpec) -> list[RigPartSpec]:
    """Both ears, hinged at the head so only the upper part flops."""
    left = (
        (275, 380), (272, 260), (290, 160), (330, 85), (385, 76), (450, 112),
        (540, 188), (548, 218), (460, 265), (370, 330),
    )
    right = (
        (688, 218), (705, 185), (775, 115), (840, 78), (895, 90), (918, 160),
        (928, 260), (922, 380), (830, 330), (750, 270),
    )
    return [
        RigPartSpec(name="left_ear", polygon=_polygon(*left), root=_point(410, 270), tip=_point(345, 108),
                    motion="swing", rotation_deg=1.5, phase_offset=0.15, anchor_fraction=0.35,
                    behind=True, physics=physics),
        RigPartSpec(name="right_ear", polygon=_polygon(*right), root=_point(800, 272), tip=_point(855, 108),
                    motion="swing", rotation_deg=1.5, phase_offset=0.4, anchor_fraction=0.35,
                    behind=True, physics=physics),
    ]


TAIL_PHYSICS = PhysicsSpec(strength=30, damping=0.25, inertia=4, whip=0.65, limit_deg=40)
EAR_PHYSICS = PhysicsSpec(strength=90, damping=0.22, inertia=3, whip=0.5, limit_deg=16)
ARM_PHYSICS = PhysicsSpec(strength=140, damping=0.35, inertia=2, whip=0.3, limit_deg=60)


def orange_cat_rig() -> RigSpec:
    """Walk in place and wave, with a springy tail, floppy ears, a body bob and a blink."""
    parts = [*_legs(), waving_arm(physics=ARM_PHYSICS), tail_part(physics=TAIL_PHYSICS), *ear_parts(EAR_PHYSICS)]
    # Highest at each passing pose, when one paw is lifted the most.
    body = BodyMotionSpec(bob=0.012, squash=0.5, beats=2, phase_offset=0.5)
    return RigSpec(parts=parts, cycles=2, body=body, blink=BlinkSpec(count=1))


def orange_cat_ik_rig() -> RigSpec:
    """Keep the planted paws at their source pixels while the opposite knee bends."""
    original = orange_cat_rig()
    left, right, *upper = original.parts
    walking = []
    for leg, knee, travel in (
        (left, (453, 1101), -0.009),
        (right, (721, 1101), 0.009),
    ):
        values = leg.model_dump()
        values.update(
            movement_x=travel, movement_y=0.028, rotation_deg=0, rotation_bias=0,
            # Pin the crotch overlap before allowing the knee to bend.
            anchor_fraction=0.29,
            foot_ik=FootIKSpec(knee=_point(*knee), stance_fraction=0.57, foot_fraction=0.86),
        )
        walking.append(RigPartSpec.model_validate(values))
    # Each swing peaks 78.5% into a leg's cycle, so the body rises at that passing pose.
    body = BodyMotionSpec(bob=0.01, squash=0.5, beats=2, phase_offset=0.57)
    return RigSpec(parts=[*walking, *upper], cycles=original.cycles, body=body, blink=original.blink)


def orange_cat_idle_rig() -> RigSpec:
    """Stand and breathe, wave slowly, sway the tail in a breeze and blink twice."""
    tail = PhysicsSpec(strength=30, damping=0.25, inertia=4, whip=0.65, wind=5, limit_deg=40)
    ears = PhysicsSpec(strength=90, damping=0.22, inertia=3, whip=0.5, wind=1.5, limit_deg=16)
    parts = [waving_arm(rotation=10, physics=ARM_PHYSICS), tail_part(physics=tail), *ear_parts(ears)]
    body = BodyMotionSpec(style="breathe", bob=0.016, squash=0.4, beats=1)
    return RigSpec(parts=parts, cycles=1, body=body, blink=BlinkSpec(count=1, double=True))


def orange_cat_jump_rig() -> RigSpec:
    """Hop twice per loop with anticipation, stretch, landing squash and flopping ears and tail."""
    tail = PhysicsSpec(strength=34, damping=0.3, inertia=5, whip=0.7, limit_deg=45)
    ears = PhysicsSpec(strength=80, damping=0.28, inertia=4, whip=0.6, limit_deg=22)
    arm = PhysicsSpec(strength=120, damping=0.4, inertia=1.1, whip=0.4, limit_deg=40)
    parts = [waving_arm(rotation=8, physics=arm), tail_part(physics=tail), *ear_parts(ears)]
    body = BodyMotionSpec(style="jump", beats=1, squash=0.5, jump_height=0.2, jump_squash=0.14)
    return RigSpec(parts=parts, cycles=2, body=body, blink=BlinkSpec(count=1))


PRESETS = {
    "orange_cat": orange_cat_rig,
    "orange_cat_ik": orange_cat_ik_rig,
    "orange_cat_idle": orange_cat_idle_rig,
    "orange_cat_jump": orange_cat_jump_rig,
}
