"""Pedestrian events: jaywalking and failure to yield at crossings."""
from __future__ import annotations

import cv2
import numpy as np

from ..intervals import mask_segments, merge_segments
from ..scene import lookup
from ..trajectories import Trajectory
from .context import EventContext, Evidence

WALKER_MAX_SPEED = 2.0   # body heights / s; faster "people" are riders or vehicle occupants


def pedestrian_samples(ctx: EventContext, tr: Trajectory) -> np.ndarray | None:
    """Mask of samples where a person track is a pedestrian on foot, or None for riders/occupants."""
    if len(tr.t) < 10:
        return None
    covered = ctx.covered_by_vehicle(tr)
    if covered.mean() > 0.3 or np.median(tr.rel_speed()) > WALKER_MAX_SPEED:
        return None
    return ~covered


def jaywalking(ctx: EventContext, min_dur: float = 1.5, max_gap: float = 1.0, enter: float = 0.25,
               min_depth: float = 1.0, min_travel: float = 1.0,
               evidence: list[Evidence] | None = None) -> list[tuple[float, float]]:
    """Pedestrian walking on the carriageway outside the crossings.

    Distances are in the person's own body heights, so the test means the same near the
    camera and far away: the person must get ``min_depth`` heights away from both the kerbs
    and the painted crossings (walking right beside the zebra or along the kerb is not
    jaywalking) and walk ``min_travel`` heights (a static false detection is not either).
    Start / end = the person gets / comes back within ``enter`` heights of the kerb or zebra.
    """
    m = ctx.masks
    segs = []
    for tr in ctx.people:
        walker = pedestrian_samples(ctx, tr)
        if walker is None:
            continue
        height = np.maximum(tr.size, 1.0)
        depth = lookup(m.jaywalk_depth, tr.foot) / height
        for s, e in mask_segments(tr.t, (depth > enter) & walker, max_gap, min_dur):
            inside = (tr.t >= s) & (tr.t <= e)
            pts = tr.foot[inside]
            travel = np.linalg.norm(pts.max(0) - pts.min(0)) / np.median(height[inside])
            if depth[inside].max() < min_depth or travel < min_travel:
                continue
            segs.append((s, e))
            if evidence is not None:
                evidence.append(Evidence(s, e, (tr.tid,), "pedestrian on the road"))
    return merge_segments(segs)


def _pedestrians_by_frame(ctx: EventContext, min_depth: float) -> dict[int, tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """Frame -> (foot points (n, 2), track ids (n,), body heights (n,)) of pedestrians on foot
    >= ``min_depth`` px into the road.

    People waiting on the kerb at the end of a crossing are not "on" it.
    """
    rows: dict[int, list] = {}
    for tr in ctx.people:
        walker = pedestrian_samples(ctx, tr)
        if walker is None:
            continue
        on_road = walker & (lookup(ctx.masks.road_depth, tr.foot) >= min_depth)
        for k, p, h in zip(ctx.frame_key(tr.t[on_road]), tr.foot[on_road], tr.size[on_road]):
            rows.setdefault(int(k), []).append((*p, tr.tid, h))
    return {k: (np.asarray(v)[:, :2], np.asarray(v)[:, 2].astype(int), np.asarray(v)[:, 3]) for k, v in rows.items()}


def _strip_overlap(integral: np.ndarray, box: np.ndarray, frac: float = 0.35) -> np.ndarray:
    """Fraction of each box's bottom strip (ground footprint) covered by a mask, via its integral image."""
    h, w = integral.shape[0] - 1, integral.shape[1] - 1
    x1 = np.clip(box[:, 0], 0, w).astype(int)
    x2 = np.clip(box[:, 2], 0, w).astype(int)
    y2 = np.clip(box[:, 3], 0, h).astype(int)
    y1 = np.clip(box[:, 3] - frac * (box[:, 3] - box[:, 1]), 0, h).astype(int)
    area = np.maximum((x2 - x1) * (y2 - y1), 1)
    covered = integral[y2, x2] - integral[y1, x2] - integral[y2, x1] + integral[y1, x1]
    return covered / area


def _distance_to_box(p: np.ndarray, box: np.ndarray) -> np.ndarray:
    """Distance from points (n, 2) to one axis-aligned box (x1, y1, x2, y2); 0 inside."""
    dx = np.maximum(np.maximum(box[0] - p[:, 0], p[:, 0] - box[2]), 0)
    dy = np.maximum(np.maximum(box[1] - p[:, 1], p[:, 1] - box[3]), 0)
    return np.hypot(dx, dy)


def failure_to_yield(ctx: EventContext, min_overlap: float = 0.15, near: float = 0.5,
                     ped_margin: int = 10, ped_depth: float = 12.0, min_speed: float = 0.3,
                     max_pass: float = 4.0, evidence: list[Evidence] | None = None) -> list[tuple[float, float]]:
    """Vehicle drives over a crossing while a pedestrian on that crossing is right next to its path
    (within ``near`` of the pedestrian's body heights of the vehicle's ground footprint).

    Start/end = the vehicle footprint enters / leaves the crossing. A pass longer than
    ``max_pass`` s is a vehicle standing on the crossing (queue), not driving through it.
    """
    peds = _pedestrians_by_frame(ctx, ped_depth)
    segs = []
    for name, cw in ctx.masks.crosswalk.items():
        integral = cv2.integral(cw)
        zone = cv2.dilate(cw, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * ped_margin + 1,) * 2))
        for tr in ctx.vehicles:
            on = _strip_overlap(integral, tr.box) >= min_overlap
            if not on.any():
                continue
            speed = tr.rel_speed()
            for s, e in mask_segments(tr.t, on, max_gap=0.5, min_len=0.2):
                inside = np.flatnonzero((tr.t >= s) & (tr.t <= e))
                if e - s > max_pass or speed[inside].max() < min_speed:
                    continue
                for i, k in zip(inside, ctx.frame_key(tr.t[inside])):
                    if int(k) not in peds:
                        continue
                    pts, tids, heights = peds[int(k)]
                    x1, y1, x2, y2 = tr.box[i]
                    footprint = np.array([x1, y2 - 0.35 * (y2 - y1), x2, y2])
                    close = (lookup(zone, pts) > 0) & (_distance_to_box(pts, footprint) < near * heights)
                    if close.any():
                        segs.append((s, e))
                        if evidence is not None:
                            evidence.append(Evidence(s, e, (tr.tid, *tids[close].tolist()), name))
                        break
    return merge_segments(segs)
