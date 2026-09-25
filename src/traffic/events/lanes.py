"""Lane-level events on the east-bound approach: crossing a solid lane line and turning from the
wrong lane.

Lanes are measured in perspective: all lane lines meet in one vanishing point, so a vehicle's
lane coordinate is where the ray from that point through its ground point hits the stop line
(0 = kerb end, 1 = median end). The lane lines are solid for the last ~300 px before the stop
line, so any lane change there crosses a solid line.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..intervals import merge_segments
from ..scene import Scene, lookup
from .context import EventContext, Evidence
from .signal_violations import _line_coords

FOOT_BIAS = 0.04   # the box bottom-centre sits ~0.2 lane kerb-side of a car's centreline (queued cars)
HALF_CAR = 0.035   # half a car's width in lane coordinates (one lane is ~0.2)
ZONE_PX = 180.0    # a vehicle this close upstream of the stop line (solid lane lines) has picked its lane


def _cross(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]


@dataclass
class LaneModel:
    vp: np.ndarray            # vanishing point of the lane lines
    a: np.ndarray             # stop line, kerb end
    d: np.ndarray             # stop line, kerb end -> median end
    bounds: np.ndarray        # lane boundaries in lane coordinates: kerb 0, the lines, median 1
    lines: np.ndarray         # (n, 2, 2) solid part of each line: upstream end, stop-line end
    rules: dict[int, list[str]]

    @classmethod
    def from_scene(cls, scene: Scene, name: str = "eb") -> "LaneModel | None":
        if name not in scene.lane_lines:
            return None
        lines = scene.lane_lines[name].astype(float)
        u = lines[:, 1] - lines[:, 0]
        normals = np.c_[-u[:, 1], u[:, 0]]
        vp = np.linalg.lstsq(normals, (normals * lines[:, 1]).sum(1), rcond=None)[0]
        a, b = scene.stop_lines[name].astype(float)
        model = cls(vp, a, b - a, np.zeros(0), lines, scene.lane_rules.get(name, {}))
        model.bounds = np.r_[0.0, model.coord(lines[:, 1], bias=0.0), 1.0]
        return model

    def coord(self, pts: np.ndarray, bias: float = FOOT_BIAS) -> np.ndarray:
        """Lane coordinate of ground points (a car's bottom-centre by default, bias-corrected)."""
        v = np.atleast_2d(pts) - self.vp
        return _cross(self.a - self.vp, v) / _cross(v, self.d) + bias

    def lane(self, s: np.ndarray) -> np.ndarray:
        """1 = kerb lane ... n = median lane; 0 / n + 1 outside the carriageway."""
        return np.searchsorted(self.bounds, s)

    def along(self, k: int, pts: np.ndarray) -> np.ndarray:
        """Distance (px) upstream of the stop line along lane line ``k`` (1-based); solid within [0, length]."""
        up, stop = self.lines[k - 1]
        u = (stop - up) / np.linalg.norm(stop - up)
        return (stop - np.atleast_2d(pts)) @ u

    def solid_length(self, k: int) -> float:
        up, stop = self.lines[k - 1]
        return float(np.linalg.norm(stop - up))


def _approach_tracks(ctx: EventContext):
    """East-bound vehicles that cross the stop line: (track, index of the first sample past it, signed distance)."""
    for tr in ctx.vehicles:
        dist, along = _line_coords(ctx, tr.foot)
        cross = np.flatnonzero((dist[:-1] > 0) & (dist[1:] <= 0) & (along[1:] > -0.05) & (along[1:] < 1.05))
        if len(cross):
            yield tr, int(cross[0]) + 1, dist


def solid_line_crossing(ctx: EventContext, min_side: float = 0.3, min_shift: float = 0.06, window: float = 3.0,
                        evidence: list[Evidence] | None = None) -> list[tuple[float, float]]:
    """Lane change across a solid lane line near the stop line.

    The car's centre passes from one side of a lane line to the other (it held each side for
    >= ``min_side`` s and moved sideways by >= ``min_shift``, about a third of a lane), and its
    side touched the line - or its centre passed it - on the solid part. A car may finish the
    manoeuvre just past the stop line; it started on the solid line.
    Start = the wheel reaches the line (the car leaves the clear part of its lane); end = the
    car is fully in the new lane (its centre a car's width past the line, or settled if it
    rides closer).
    """
    model = LaneModel.from_scene(ctx.scene)
    if model is None:
        return []
    segs = []
    for tr, entered, dist in _approach_tracks(ctx):
        s = model.coord(tr.foot)
        for k in range(1, len(model.bounds) - 1):
            rel = s - model.bounds[k]
            side = np.sign(np.where(np.abs(rel) > 0.01, rel, 0.0))
            for i in range(1, len(side)):              # carry the side through the dead band
                if side[i] == 0:
                    side[i] = side[i - 1]
            for p in np.flatnonzero(side[1:] * side[:-1] < 0) + 1:
                before = np.flatnonzero((tr.t < tr.t[p]) & (tr.t >= tr.t[p] - window))
                after = np.flatnonzero((tr.t > tr.t[p]) & (tr.t <= tr.t[p] + window))
                if not len(before) or not len(after):
                    continue
                sig = side[p - 1]
                run_b = before[side[before] == sig]
                run_a = after[side[after] == -sig]
                if tr.t[p - 1] - tr.t[run_b[0]] < min_side if len(run_b) else True:
                    continue
                if len(run_a) < 2 or (tr.t[run_a[-1]] - tr.t[p] < min_side and run_a[-1] != len(tr.t) - 1):
                    continue
                if (sig * rel[run_b]).max() + (-sig * rel[run_a]).max() < min_shift:
                    continue
                clear_b = run_b[sig * rel[run_b] >= HALF_CAR]
                start = int(clear_b[-1]) if len(clear_b) else int(run_b[np.argmax(sig * rel[run_b])])
                settled = run_a[-sig * rel[run_a] >= min(2 * HALF_CAR, 0.95 * (-sig * rel[run_a]).max())]
                end = int(settled[0])
                along = model.along(k, tr.foot[[start, p]])
                if not ((0 <= along) & (along <= model.solid_length(k))).any():
                    continue
                segs.append((float(tr.t[start]), float(tr.t[end])))
                if evidence is not None:
                    evidence.append(Evidence(*segs[-1], (tr.tid,), f"crossed solid lane line {k}"))
    return merge_segments(segs)


def _exit_of(ctx: EventContext, pts: np.ndarray) -> str | None:
    """Which junction leg a path past the stop line ends up in."""
    exits = ctx.masks.exit
    if "SW" in exits and (lookup(exits["SW"], pts) > 0).any():
        return "SW"
    wb = ctx.masks.zone["wb_approach"] | ctx.masks.zone["wb"] | ctx.masks.crosswalk["cw1_wb"]
    if (lookup(wb, pts) > 0).any():
        return "U"
    if "S" in exits and (lookup(exits["S"], pts) > 0).any():
        return "S"
    if (lookup(ctx.masks.zone["eb_exit"], pts) > 0).any():
        return "E"
    return None


def _manoeuvre(model: LaneModel, tr, start: int, turn: float = 10.0, settle: float = 15.0) -> tuple[float, float]:
    """(start, end) of the turn: heading leaves the lane direction by > ``turn`` degrees ->
    heading within ``settle`` degrees of the final direction (or the track ends)."""
    vel = tr.velocity(1.0)
    ray = tr.foot - model.vp
    speed = np.linalg.norm(vel, axis=1)
    moving = speed > 0.3 * tr.size
    dev = np.degrees(np.abs(np.arctan2(_cross(ray, vel), (ray * vel).sum(1))))
    idx = np.flatnonzero(moving[start:] & (dev[start:] > turn))
    if not len(idx):
        return float(tr.t[start]), float(tr.t[-1])
    i0 = start + int(idx[0])
    tail = np.flatnonzero(moving)[-10:]
    final = vel[tail].mean(0) if len(tail) else vel[-1]
    to_final = np.degrees(np.abs(np.arctan2(_cross(vel, final), (vel * final).sum(1))))
    done = np.flatnonzero(moving[i0:] & (to_final[i0:] < settle))
    i1 = i0 + int(done[0]) if len(done) else len(tr.t) - 1
    return float(tr.t[i0]), float(tr.t[max(i1, i0 + 1)])


def illegal_turn(ctx: EventContext, min_after: int = 10, lead: float = 3.0, min_dur: float = 1.0,
                 evidence: list[Evidence] | None = None) -> list[tuple[float, float]]:
    """Movement a lane does not allow (``lane_rules`` in the scene): e.g. the sharp right turn
    from any lane but the kerb lane, straight on from the kerb (right-turn) lane, a U-turn from
    any lane but the median lane.

    The lane is the one the vehicle held when it reached the solid-line zone (``ZONE_PX`` before
    the stop line), i.e. before any last-moment lane change; the turn is looked for from
    ``lead`` s before the vehicle crosses the stop line (earlier it may still be queuing).
    Start = the vehicle starts turning; end = it completes the turn.
    """
    model = LaneModel.from_scene(ctx.scene)
    if model is None or not model.rules:
        return []
    segs = []
    for tr, entered, dist in _approach_tracks(ctx):
        zone = np.flatnonzero((np.arange(len(tr.t)) < entered) & (dist > 0) & (dist < ZONE_PX))
        if len(zone) < 3 or len(tr.t) - entered < min_after:
            continue
        lane = int(np.median(model.lane(model.coord(tr.foot[zone[:5]]))))
        allowed = model.rules.get(lane)
        leg = _exit_of(ctx, tr.foot[entered:])
        if allowed is None or leg is None or leg in allowed:
            continue
        s, e = _manoeuvre(model, tr, max(int(zone[0]), int(np.searchsorted(tr.t, tr.t[entered] - lead))))
        if e - s < min_dur:                    # the track ends as the manoeuvre starts: nothing to time
            continue
        segs.append((s, e))
        if evidence is not None:
            evidence.append(Evidence(s, e, (tr.tid,), f"lane {lane} -> {leg}"))
    return merge_segments(segs)
