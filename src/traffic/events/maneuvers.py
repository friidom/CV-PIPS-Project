"""Manoeuvre events judged against the learned traffic flow: wrong-way driving and U-turns."""
from __future__ import annotations

import numpy as np

from ..intervals import mask_segments, merge_segments
from ..scene import REF_SIZE
from .context import EventContext, Evidence

MIN_CONSISTENCY = 0.85   # cell counts as one-way when unit velocities agree this much
MIN_COUNT = 40           # ... and enough vehicles passed through it
MIN_WIDTH = 50.0         # px; tracks of tiny far-away vehicles are too noisy for heading tests


def _flow_alignment(ctx: EventContext, tr) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Per sample: cosine between the vehicle's heading and the cell's flow, the flow direction,
    whether the cell is reliably one-way, and the speed in vehicle widths per second."""
    vel = tr.velocity(1.0)
    speed = np.linalg.norm(vel, axis=1)
    direction, consistency, count = ctx.scene.flow.at(tr.foot)
    cos = (vel * direction).sum(1) / np.maximum(speed, 1e-6)
    oneway = (consistency >= MIN_CONSISTENCY) & (count >= MIN_COUNT) & (tr.size >= MIN_WIDTH)
    return cos, direction, oneway, speed / np.maximum(tr.size, 1.0)


def wrong_way(ctx: EventContext, cos_thr: float = -0.6, min_speed: float = 1.2, min_dur: float = 2.0,
              min_cells: int = 3, evidence: list[Evidence] | None = None) -> list[tuple[float, float]]:
    """Vehicle moving against the one-way flow of its lane for >= ``min_dur`` s across >= ``min_cells`` cells.

    Start = the vehicle starts moving against the flow (enters the opposing lane);
    end = it moves with the flow again or leaves the frame.
    """
    if ctx.scene.flow is None:
        return []
    cell = ctx.scene.flow.cell
    segs = []
    for tr in ctx.vehicles:
        cos, _, oneway, rel_speed = _flow_alignment(ctx, tr)
        against = oneway & (rel_speed > min_speed) & (cos < cos_thr)
        for s, e in mask_segments(tr.t, against, max_gap=0.5, min_len=min_dur):
            inside = (tr.t >= s) & (tr.t <= e) & against
            if len(np.unique((tr.foot[inside] // cell).astype(int), axis=0)) >= min_cells:
                segs.append((s, e))
                if evidence is not None:
                    evidence.append(Evidence(s, e, (tr.tid,), "moving against the lane direction"))
    return merge_segments(segs)


def u_turn(ctx: EventContext, align: float = 0.7, min_turn: float = 2.5, max_turn: float = 15.0,
           min_side: float = 1.0, max_step: float = 0.6, border: float = 120.0,
           evidence: list[Evidence] | None = None) -> list[tuple[float, float]]:
    """Vehicle that drives with one flow and, within ``max_turn`` s, with the opposite flow.

    Both legs must follow their flow (cosine > ``align``) for >= ``min_side`` s, the turn
    must take >= ``min_turn`` s and happen >= ``border`` px inside the frame, and the track
    must be continuous (no jump over ``max_step`` widths between samples). These reject
    identity switches, e.g. an east-bound car leaving at the frame edge while a west-bound
    one enters there.
    Start = heading leaves the first flow; end = heading settles on the opposite flow.
    """
    if ctx.scene.flow is None:
        return []
    segs = []
    for tr in ctx.vehicles:
        cos, direction, oneway, rel_speed = _flow_alignment(ctx, tr)
        good = np.flatnonzero(oneway & (cos > align) & (rel_speed > 0.5))
        if len(good) < 4:
            continue
        first = good[0]
        opposite = good[(direction[good] @ direction[first]) < -align]
        opposite = opposite[tr.t[opposite] - tr.t[first] <= max_turn + 2 * min_side]
        if not len(opposite):
            continue
        j = opposite[0]
        leg1 = good[(good < j) & ((direction[good] @ direction[first]) > align)]
        leg2 = opposite[opposite >= j]
        if tr.t[leg1[-1]] - tr.t[leg1[0]] < min_side or tr.t[leg2[-1]] - tr.t[leg2[0]] < min_side:
            continue
        i = leg1[-1]
        steps = np.linalg.norm(np.diff(tr.foot[i:j + 1], axis=0), axis=1) / np.maximum(tr.size[i:j], 1.0)
        if len(steps) and steps.max() > max_step:
            continue
        turn = tr.foot[i:j + 1]
        inside = ((turn >= border) & (turn <= np.array(REF_SIZE) - border)).all()
        s, e = float(tr.t[i]), float(tr.t[j])
        if inside and min_turn <= e - s <= max_turn:
            segs.append((s, e))
            if evidence is not None:
                evidence.append(Evidence(s, e, (tr.tid,), "turned into the opposite flow"))
    return merge_segments(segs)
