"""Rule checks on synthetic trajectories placed in the real scene (reference coordinates)."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from traffic.events import EventContext, SceneMasks  # noqa: E402
from traffic.events.lanes import LaneModel, illegal_turn, solid_line_crossing  # noqa: E402
from traffic.events.maneuvers import u_turn, wrong_way  # noqa: E402
from traffic.events.signal_violations import _line_coords, stop_line  # noqa: E402
from traffic.intervals import mask_segments, merge_segments  # noqa: E402
from traffic.scene import Scene, lookup  # noqa: E402
from traffic.signals import GREEN, RED  # noqa: E402
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


def context(scene: Scene, trajs: list[Trajectory], phase: int = GREEN) -> EventContext:
    duration = max(tr.t[-1] for tr in trajs) + 1
    times = np.arange(0, duration, 0.1)
    return EventContext(duration, 29.97, trajs, times, np.full(len(times), phase), scene, SceneMasks.build(scene))


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


def lane_path(model: LaneModel, s_of_dist, dists: np.ndarray) -> np.ndarray:
    """Ground points at the given distances upstream of the stop line and lane coordinates s(dist)."""
    a, d = model.a, model.d
    stop = a + np.outer([s_of_dist(x) for x in dists], d)          # points on the stop line
    ray = stop - model.vp
    ray /= np.linalg.norm(ray, axis=1, keepdims=True)
    normal = np.array([-d[1], d[0]]) / np.linalg.norm(d)
    if normal[1] < 0:
        normal = -normal                                            # pointing downstream (towards the camera)
    back = -ray if (ray @ normal).mean() > 0 else ray               # upstream along each lane ray
    return stop + back * (dists / np.abs(back @ normal))[:, None]


def test_lane_change_on_the_solid_part_is_flagged_and_far_upstream_is_not(scene):
    model = LaneModel.from_scene(scene)
    lane3, lane4 = model.bounds[2:4].mean(), model.bounds[3:5].mean()

    def change(at: float, over: float = 60.0):
        return lambda x: lane3 if x > at else lane4 if x < at - over else lane3 + (lane4 - lane3) * (at - x) / over

    near = np.linspace(260, -120, 60)                               # upstream -> past the stop line, 6 s
    assert len(solid_line_crossing(context(scene, [vehicle(lane_path(model, change(90), near), width=120)]))) == 1
    far = np.linspace(700, -120, 90)                                # lines are dashed that far upstream
    assert not solid_line_crossing(context(scene, [vehicle(lane_path(model, change(600), far), width=120)]))
    assert not solid_line_crossing(context(scene, [vehicle(lane_path(model, lambda x: lane3, near), width=120)]))


def test_stop_line_is_the_official_zone_only_not_a_vehicle_held_in_the_junction(scene):
    a, b = scene.stop_lines["eb"].astype(float)
    normal = np.array([a[1] - b[1], b[0] - a[0]]) / np.linalg.norm(b - a)   # points downstream (+y)

    def drive_in_and_stand(along: float, depth: float) -> np.ndarray:
        """Cross the stop line from 100 px upstream in 4 s, then stand ``depth`` px past it for 8 s."""
        return a + along * (b - a) + np.r_[np.linspace(-100, depth, 40), np.full(80, depth)][:, None] * normal

    zone, box = drive_in_and_stand(0.5, 60.0), drive_in_and_stand(0.8, 220.0)
    ctx = context(scene, [vehicle(box)], RED)
    # in the box (clear of the islands, free road ahead), beyond the crossing: it entered the intersection
    assert _line_coords(ctx, box[-1:])[0][0] < -140 and lookup(ctx.masks.junction, box[-1:])[0]
    found = stop_line(context(scene, [vehicle(zone)], RED))
    assert len(found) == 1 and 3.5 <= found[0][0] <= 5.0 and found[0][1] >= 11.0
    assert not stop_line(ctx), "a vehicle held inside the junction on red is not a stop-line violation"


def test_illegal_turn_is_judged_by_the_lane_held_before_the_stop_line(scene):
    model = LaneModel.from_scene(scene)

    def sharp_right_from(lane: int) -> np.ndarray:
        """3 s down the centre of ``lane`` to the stop line, then a 3 s curve into the SW exit."""
        centre = model.bounds[lane - 1:lane + 1].mean()
        approach = lane_path(model, lambda x: centre, np.linspace(250, 0, 30))
        p0 = approach[-1]
        c = p0 + 150 * (p0 - model.vp) / np.linalg.norm(p0 - model.vp)    # keep heading down the lane first
        tau = np.linspace(0, 1, 31)[1:, None]
        curve = (1 - tau) ** 2 * p0 + 2 * (1 - tau) * tau * c + tau ** 2 * np.array([225.0, 920.0])
        return np.r_[approach, curve]

    assert not illegal_turn(context(scene, [vehicle(sharp_right_from(1))])), "the kerb lane may turn sharp right"
    found = illegal_turn(context(scene, [vehicle(sharp_right_from(3))]))
    assert len(found) == 1 and 2.5 <= found[0][0] <= 4.0 and found[0][1] - found[0][0] >= 1.0
