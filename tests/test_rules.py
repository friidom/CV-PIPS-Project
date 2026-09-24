"""Rule checks on synthetic trajectories placed in the real scene (reference coordinates)."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from traffic.events import EventContext, SceneMasks  # noqa: E402
from traffic.events.maneuvers import u_turn, wrong_way  # noqa: E402
from traffic.intervals import mask_segments, merge_segments  # noqa: E402
from traffic.scene import Scene  # noqa: E402
from traffic.signals import GREEN  # noqa: E402
from traffic.detector import CAR  # noqa: E402
from traffic.tracker import GROUP_VEHICLE  # noqa: E402
from traffic.trajectories import Trajectory  # noqa: E402

FPS = 10.0


@pytest.fixture(scope="module")
def scene() -> Scene:
    return Scene.load(ROOT / "configs")


def vehicle(path: np.ndarray, width: float = 150.0, tid: int = 1) -> Trajectory:
    t = np.arange(len(path)) / FPS
    box = np.c_[path[:, 0] - width / 2, path[:, 1] - 0.6 * width, path[:, 0] + width / 2, path[:, 1]]
    return Trajectory(tid, CAR, GROUP_VEHICLE, t, box, path.astype(float))


def context(scene: Scene, trajs: list[Trajectory]) -> EventContext:
    duration = max(tr.t[-1] for tr in trajs) + 1
    times = np.arange(0, duration, 0.1)
    return EventContext(duration, 29.97, trajs, times, np.full(len(times), GREEN), scene, SceneMasks.build(scene))


def follow_flow(scene: Scene, start, steps: int, speed: float, sign: float = 1.0) -> np.ndarray:
    """Integrate a path along (sign=1) or against (sign=-1) the learned flow field."""
    pts = [np.asarray(start, float)]
    for _ in range(steps - 1):
        d, _, _ = scene.flow.at(pts[-1][None])
        pts.append(pts[-1] + sign * d[0] * speed / FPS)
    return np.array(pts)


def test_intervals_merge_and_bridge():
    t = np.arange(10) / FPS
    mask = np.array([1, 1, 0, 1, 1, 0, 0, 0, 1, 1], bool)
    # one missing sample leaves a 0.2 s gap between runs: bridged; three missing (0.4 s) are not
    assert mask_segments(t, mask, max_gap=0.25) == [(0.0, 0.4), (0.8, 0.9)]
    assert merge_segments([(0, 2), (1, 3), (5, 6)]) == [(0, 3), (5, 6)]
    # a stop that starts 0.5 s before another ends is a hand-over; a real overlap is merged
    assert merge_segments([(0, 10), (9.5, 20)], handover=2.0) == [(0, 9.5), (9.5, 20)]
    assert merge_segments([(0, 10), (5, 20)], handover=2.0) == [(0, 20)]


def test_wrong_way_fires_against_the_flow_and_not_with_it(scene):
    start = (1300, 420)  # west-bound carriageway
    against = vehicle(follow_flow(scene, start, 40, speed=250, sign=-1))
    along = vehicle(follow_flow(scene, start, 40, speed=250, sign=1), tid=2)
    assert wrong_way(context(scene, [against])), "driving against the flow must be flagged"
    assert not wrong_way(context(scene, [along])), "normal driving must not be flagged"


def straight(start, heading, seconds: float, speed: float) -> np.ndarray:
    steps = np.arange(int(seconds * FPS))[:, None] / FPS
    return np.asarray(start, float) + steps * speed * np.asarray(heading, float)


def test_u_turn_from_east_bound_into_west_bound(scene):
    heading = np.array([0.91, 0.41])                                 # east-bound lanes
    leg1 = straight((600, 330), heading, 3.0, speed=170)
    left = np.array([heading[1], -heading[0]])                        # the driver's left in image coordinates
    centre = leg1[-1] + 70 * left
    a0 = np.arctan2(*(leg1[-1] - centre)[::-1])
    angles = np.linspace(a0, a0 - np.pi, 31)                          # ~3 s turn
    arc = centre + 70 * np.stack([np.cos(angles), np.sin(angles)], axis=1)
    leg2 = straight(arc[-1], -heading, 3.0, speed=170)               # west-bound lanes
    tr = vehicle(np.vstack([leg1, arc[1:], leg2[1:]]), width=140)
    found = u_turn(context(scene, [tr]))
    assert len(found) == 1
    s, e = found[0]
    assert 2.0 <= s <= 3.5 and 5.0 <= e <= 7.0   # the turn itself spans 3.0-6.0 s
    assert not u_turn(context(scene, [vehicle(leg1)])), "a straight drive is not a U-turn"
