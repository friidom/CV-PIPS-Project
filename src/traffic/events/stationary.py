"""Stationary-traffic events: stopped vehicles and congestion."""
from __future__ import annotations

import numpy as np

from ..intervals import mask_segments, merge_segments
from ..scene import lookup
from ..signals import AMBER, RED
from ..detector import BUS
from ..trajectories import Trajectory
from .context import EventContext, Evidence


def stationary(tr: Trajectory, window: float = 2.0, tol: float = 0.12) -> np.ndarray:
    """Per sample: the foot point moved less than ``tol`` object sizes over ``window`` seconds."""
    lo = np.searchsorted(tr.t, tr.t - window / 2)
    hi = np.clip(np.searchsorted(tr.t, tr.t + window / 2, side="right") - 1, 0, len(tr.t) - 1)
    moved = np.linalg.norm(tr.foot[hi] - tr.foot[lo], axis=1)
    return (moved < tol * tr.size) & (tr.t[hi] - tr.t[lo] >= 0.5 * window)


def stitch_parked(trajs: list[Trajectory], max_gap: float = 30.0, max_shift: float = 0.35) -> list[Trajectory]:
    """Join track fragments of one standing vehicle (IDs break when a bus occludes it).

    Fragment B continues A if B starts within ``max_gap`` s after A ends, both are
    stationary at the join and B's first position is within ``max_shift`` sizes of A's last.
    """
    order = sorted(trajs, key=lambda tr: tr.t[0])
    still = {id(tr): stationary(tr) for tr in order}
    merged: list[Trajectory] = []
    open_ends: list[Trajectory] = []
    for tr in order:
        target = None
        if still[id(tr)][0]:
            for cand in open_ends:
                gap = tr.t[0] - cand.t[-1]
                shift = np.linalg.norm(tr.foot[0] - cand.foot[-1]) / max(cand.size[-1], 1.0)
                if 0 < gap <= max_gap and shift <= max_shift and still[id(cand)][-1]:
                    target = cand
                    break
        if target is None:
            merged.append(tr)
            open_ends.append(tr)
            continue
        joined = Trajectory(target.tid, target.cls, target.group, np.r_[target.t, tr.t],
                            np.r_[target.box, tr.box], np.r_[target.foot, tr.foot])
        still[id(joined)] = np.r_[still[id(target)], still[id(tr)]]
        merged[merged.index(target)] = joined
        open_ends[open_ends.index(target)] = joined
    return merged


def stopped_vehicle(ctx: EventContext, min_stop: float = 10.0, queue_radius: float = 1.5,
                    queue_size: int = 3, evidence: list[Evidence] | None = None) -> list[tuple[float, float]]:
    """Vehicle stationary on the carriageway for >= ``min_stop`` s outside a queue or a jam.

    Not counted: stops inside the junction (``masks.junction``: past the stop line, on the
    crossings, in the box and at its exits) - a vehicle there is finishing a manoeuvre,
    yielding or held up by traffic; stops in the east-bound approach that overlap red/amber
    (signal queue),
    buses dwelling in the west-bound lanes (bus stop), seconds in which the vehicle is part
    of a congestion event or has >= ``queue_size`` standing vehicles within ``queue_radius``
    of its sizes (a queue). A vehicle left standing after the jam around it clears counts
    from then on.
    Simultaneous stops are one segment (the official convention); a stop that begins just
    before another ends (<= 2 s overlap) is a hand-over and stays a separate event.
    Start = the vehicle stops (or the queue around it clears); end = it moves again or
    disappears (removed / video end).
    """
    vehicles = stitch_parked(ctx.vehicles)
    still = {tr.tid: stationary(tr) for tr in vehicles}
    standing = _standing_by_second(vehicles, still)
    jams: list[Evidence] = []
    congestion(ctx, evidence=jams)
    segs = []
    for tr in vehicles:
        on_road = lookup(ctx.masks.road_depth, tr.foot) > 5
        mask = still[tr.tid] & on_road
        for j in jams:
            if tr.tid in j.tids:
                mask &= (tr.t < j.start) | (tr.t > j.end)
        for s, e in mask_segments(tr.t, mask, max_gap=3.0, min_len=min_stop):   # bridge detector dropouts
            i0 = min(int(np.searchsorted(tr.t, s)), len(tr.t) - 1)
            p = tr.foot[i0]
            if lookup(ctx.masks.junction, p[None])[0] or (tr.cls == BUS and lookup(ctx.masks.zone["wb"], p[None])[0]):
                continue
            during = (ctx.phase_t >= s) & (ctx.phase_t <= e)
            if lookup(ctx.masks.zone["eb_approach"], p[None])[0] and np.isin(ctx.phase[during], (RED, AMBER)).any():
                continue
            radius = queue_radius * tr.size[i0]
            free = [(float(t), float(t) + 1.0) for t in range(int(s), int(e) + 1)
                    if _neighbours(standing.get(t), tr.tid, p, radius) < queue_size]
            for fs, fe in merge_segments(free, max_gap=1.0):
                fs, fe = max(fs, s), min(fe, e)
                if fe - fs >= min_stop:
                    segs.append((fs, fe))
                    if evidence is not None:
                        evidence.append(Evidence(fs, fe, (tr.tid,), "standing on the carriageway"))
    return merge_segments(segs, handover=2.0)


def _standing_by_second(vehicles: list[Trajectory], still: dict[int, np.ndarray]) -> dict[int, tuple[np.ndarray, np.ndarray]]:
    """Second -> (track ids, foot points) of the vehicles standing in it."""
    tids: dict[int, list[int]] = {}
    feet: dict[int, list[np.ndarray]] = {}
    for tr in vehicles:
        idx = np.flatnonzero(still[tr.tid])
        secs, first = np.unique(tr.t[idx].astype(int), return_index=True)
        for sec, i in zip(secs, idx[first]):
            tids.setdefault(int(sec), []).append(tr.tid)
            feet.setdefault(int(sec), []).append(tr.foot[i])
    return {k: (np.array(tids[k]), np.array(feet[k])) for k in tids}


def _neighbours(standing: tuple[np.ndarray, np.ndarray] | None, tid: int, p: np.ndarray, radius: float) -> int:
    if standing is None:
        return 0
    tids, feet = standing
    return int(((np.linalg.norm(feet - p, axis=1) < radius) & (tids != tid)).sum())


CONGESTION_ZONES = ("box", "eb_exit", "wb_near")


def congestion(ctx: EventContext, crawl: float = 0.25, min_vehicles: int = 4,
               max_gap: float = 2.0, min_dur: float = 8.0, parked: float = 60.0,
               evidence: list[Evidence] | None = None) -> list[tuple[float, float]]:
    """Traffic at a standstill or crawling inside the junction or past a crossing: in a zone,
    >= ``min_vehicles`` vehicles whose median speed is below ``crawl`` sizes/s (per 1-s bin,
    each vehicle's own median first). A queue that creeps forward faster ends the event.

    Zones (``CONGESTION_ZONES``): the junction box past the east-bound crossing, the
    east-bound exit and the west-bound carriageway just past its crossing, up to the bus
    stop (buses dwelling there and the queue for the next junction far up the road are not
    congestion here). Queues in front of a
    stop line or a crossing are signal/pedestrian waits, not congestion (a vehicle stopped
    past the stop line on red is ``stop_line``). Vehicles standing for >= ``parked`` s at a
    stretch are parked or stopped, not traffic.
    Start = the queue stops moving; end = it clears (moves again or empties).
    Evidence lists each vehicle with the seconds it was standing or crawling in the jam.
    """
    moving = {}
    for tr in ctx.vehicles:
        keep = np.ones(len(tr.t), bool)
        for s, e in mask_segments(tr.t, stationary(tr), max_gap=1.5, min_len=parked):
            keep &= (tr.t < s) | (tr.t > e)
        moving[tr.tid] = keep
    bins = np.arange(0.0, ctx.duration + 1.0)
    segs = []
    for name in CONGESTION_ZONES:
        mask = ctx.masks.zone[name]
        speeds: list[list[float]] = [[] for _ in bins]
        slow_bins: dict[int, list[int]] = {}
        for tr in ctx.vehicles:
            inside = (lookup(mask, tr.foot) > 0) & moving[tr.tid]
            if not inside.any():
                continue
            k = np.clip(tr.t[inside].astype(int), 0, len(bins) - 1)
            speed = tr.rel_speed(2.0)[inside]
            for b in np.unique(k):   # one vote per vehicle and bin
                v = float(np.median(speed[k == b]))
                speeds[b].append(v)
                if v < crawl:
                    slow_bins.setdefault(tr.tid, []).append(int(b))
        jam = np.array([len(v) >= min_vehicles and np.median(v) < crawl for v in speeds])
        # a bin covers [b, b + 1): the event ends with its last jammed bin
        found = [(s, e + 1.0) for s, e in mask_segments(bins, jam, max_gap=max_gap, min_len=min_dur - 1.0)]
        segs += found
        if evidence is not None:
            for s, e in found:
                for tid, tb in slow_bins.items():
                    runs_in_jam = merge_segments([(b, b + 1.0) for b in tb if s <= b <= e], max_gap=1.0)
                    evidence += [Evidence(vs, ve, (tid,), f"standing or crawling in {name}") for vs, ve in runs_in_jam]
    return merge_segments(segs)
