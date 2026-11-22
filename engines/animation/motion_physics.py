"""Professional secondary motion for Gift rigs.

Spring physics follows the vocabulary of Spine physics constraints (strength, damping,
inertia, wind), but instead of stepping a simulation frame by frame it solves the periodic
steady state of the damped spring in the frequency domain. The result is exactly periodic,
so every loop is seamless, and it cannot become unstable at low frame rates.
"""

from cmath import exp as cexp
from math import cos, pi, sin, sqrt, tanh, tau
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field


SAMPLES = 256
HARMONICS = 72
WHIP_LIMIT = 18.0  # Largest extra bend of a part's outer half, in degrees.
BEND_KNEE = 60.0   # Total bends beyond this ease toward MAX_BEND.
MAX_BEND = 75.0

Fraction = Annotated[float, Field(ge=0, le=1)]
Radius = Annotated[float, Field(gt=0, le=0.25)]
Eye = tuple[Fraction, Fraction, Radius, Radius]


class PhysicsSpec(BaseModel):
    """Spring follow-through: the part lags behind body movement, overshoots and settles.

    `strength` is the spring stiffness (higher snaps back faster), `damping` is the damping
    ratio (low values wobble longer), `inertia` scales how much body acceleration throws the
    part around, `whip` lets the outer half trail the inner half like a tail or ear tip,
    `wind` adds a gusty sway in degrees, and `limit_deg` softly caps the swing.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    strength: Annotated[float, Field(ge=4, le=400)] = 60
    damping: Annotated[float, Field(ge=0.05, le=1.5)] = 0.3
    inertia: Annotated[float, Field(ge=0, le=8)] = 1.5
    whip: Fraction = 0.5
    wind: Annotated[float, Field(ge=0, le=30)] = 0
    limit_deg: Annotated[float, Field(ge=5, le=80)] = 45


class BlinkSpec(BaseModel):
    """Natural eye blinks on the body layer: quick close, brief hold, slower open.

    Omit `eyes` to detect them automatically, or give (x, y, horizontal_radius,
    vertical_radius) normalized to the full image. `count` blinks are spread over each
    loop; `double` turns the first one into a quick double blink.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    eyes: Annotated[list[Eye], Field(min_length=1, max_length=2)] | None = None
    count: Annotated[int, Field(ge=1, le=4)] = 1
    double: bool = False


def smoothstep(value):
    t = max(0.0, min(1.0, value))
    return t * t * (3 - 2 * t)


def _ease_out(value):
    t = max(0.0, min(1.0, value))
    return 1 - (1 - t) ** 3


def _ease_in_out(value):
    t = max(0.0, min(1.0, value))
    return 4 * t ** 3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def jump_pose(u, squash):
    """Vertical scale and normalized lift (0–1 of the jump height) at beat phase `u`.

    Anticipation squash, launch stretch, a parabolic flight, landing impact and a
    damped settle that returns exactly to rest, so jumps loop seamlessly.
    """
    u %= 1
    q = squash
    lift = 0.0
    if u < 0.17:
        scale = 1 - q * _ease_in_out(u / 0.17)
    elif u < 0.22:
        scale = (1 - q) + 1.8 * q * _ease_out((u - 0.17) / 0.05)
    elif u < 0.64:
        s = (u - 0.22) / 0.42
        lift = 4 * s * (1 - s)
        scale = 1 + q * (0.8 * (1 - 2 * s) ** 2 if s < 0.5 else 0.3 * (2 * s - 1) ** 2)
    elif u < 0.72:
        scale = (1 + 0.3 * q) - 1.4 * q * _ease_out((u - 0.64) / 0.08)
    else:
        s = (u - 0.72) / 0.28
        scale = 1 - 1.1 * q * (1 - s) ** 2 * cos(3 * pi * s)
    return scale, lift


def breathe_pose(u, amount):
    """Gentle inhale/exhale: rises smoothly and settles, never compressing below rest."""
    return 1 + amount * (0.5 - 0.5 * cos(tau * u))


def _dft(values, harmonics):
    count = len(values)
    return [sum(value * cexp(-2j * pi * k * index / count) for index, value in enumerate(values)) / count
            for k in range(harmonics + 1)]


def _synthesize(coefficients, count):
    result = []
    for index in range(count):
        total = coefficients[0].real
        for k in range(1, len(coefficients)):
            total += 2 * (coefficients[k] * cexp(2j * pi * k * index / count)).real
        result.append(total)
    return result


def periodic_acceleration(positions, period):
    """Exact second derivative of a periodic sample sequence (spectral differentiation)."""
    count = len(positions)
    harmonics = min(HARMONICS, count // 2 - 1)
    coefficients = _dft(positions, harmonics)
    return _synthesize([-((tau * k / period) ** 2) * c for k, c in enumerate(coefficients)], count)


def solve_spring(target, drive, period, physics: PhysicsSpec):
    """Steady-state angles (inner, outer) in degrees for one loop sampled like `target`.

    `target` is the animated rest angle in degrees, `drive` the angular acceleration from
    body motion in degrees/s² (already multiplied by inertia), and `period` the loop length
    in seconds. Both outputs are periodic and softly limited.
    """
    count = len(target)
    harmonics = min(HARMONICS, count // 2 - 1)
    w0 = sqrt(physics.strength)
    zeta = physics.damping
    gusts = [physics.wind * (0.6 * sin(tau * index / count) + 0.4 * sin(tau * 3 * index / count + 1.1))
             for index in range(count)]
    forcing = [w0 * w0 * (angle + gust) + push for angle, gust, push in zip(target, gusts, drive)]
    inner_f = _dft(forcing, harmonics)
    push_f = _dft(drive, harmonics)
    # The outer half is a second, softer spring that follows the inner one.
    w1 = w0 * (2.2 - 1.6 * physics.whip)
    inner, outer = [], []
    for k in range(harmonics + 1):
        omega = tau * k / period
        response = 1 / complex(w0 * w0 - omega * omega, 2 * zeta * w0 * omega)
        angle = inner_f[k] * response
        follow = 1 / complex(w1 * w1 - omega * omega, 2 * zeta * w1 * omega)
        inner.append(angle)
        outer.append((w1 * w1 * angle + 0.5 * push_f[k]) * follow)
    limit = physics.limit_deg
    # The outer half may trail the inner half, but a large difference would kink the mesh.
    whip_limit = min(WHIP_LIMIT, 0.6 * limit)

    def knee(value):
        # Total bend eases into MAX_BEND so fast motion can never fold a limb over itself.
        size = abs(value)
        if size <= BEND_KNEE:
            return value
        eased = BEND_KNEE + (MAX_BEND - BEND_KNEE) * tanh((size - BEND_KNEE) / (MAX_BEND - BEND_KNEE))
        return eased if value > 0 else -eased

    # Cap only the physics offset from the animated pose, never the pose itself.
    inner_angles = [angle + limit * tanh((value - angle) / limit) for value, angle in zip(_synthesize(inner, count), target)]
    outer_angles = [base + whip_limit * tanh((value - base) / whip_limit)
                    for value, base in zip(_synthesize(outer, count), inner_angles)]
    return [knee(value) for value in inner_angles], [knee(value) for value in outer_angles]


def blink_closure(time, period, count, double):
    """Eyelid closure from 0 (open) to 1 (closed) at `time` seconds into a `period` loop."""
    closure = 0.0
    starts = [period * (0.28 + index) / count for index in range(count)]
    if double and starts:
        starts.append(starts[0] + 0.32)
    for start in starts:
        elapsed = (time - start) % period
        if elapsed < 0.07:
            closure = max(closure, _ease_in_out(elapsed / 0.07))
        elif elapsed < 0.11:
            closure = 1.0
        elif elapsed < 0.25:
            closure = max(closure, 1 - _ease_out((elapsed - 0.11) / 0.14))
    return closure


def sample_phases(count=SAMPLES):
    return [index / count for index in range(count)]


def interpolate(table, phase):
    """Linear interpolation into a periodic table sampled at index / len(table)."""
    count = len(table)
    position = (phase % 1) * count
    index = int(position)
    fraction = position - index
    return table[index % count] * (1 - fraction) + table[(index + 1) % count] * fraction
