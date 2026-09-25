"""Signal violations on the east-bound approach: red-light running and stopping past the stop line."""
from __future__ import annotations

import numpy as np

from ..intervals import mask_segments, merge_segments, runs
from ..scene import side_of_line
from ..signals import GREEN, RED
from .context import EventContext, Evidence


def _line_coords(ctx: EventContext, pts: np.ndarray, name: str = "eb") -> tuple[np.ndarray, np.ndarray]:
    """(signed distance, position along the line in [0, 1]) of points w.r.t. a stop line.

    Positive distance = upstream (queue side) for the east-bound line.
    """
    line = ctx.scene.stop_lines[name]
    d = line[1] - line[0]
    along = ((pts - line[0]) @ d) / (d @ d)
    return side_of_line(line, pts), along


def red_light(ctx: EventContext, max_exit: float = 8.0,
              evidence: list[Evidence] | None = None) -> list[tuple[float, float]]:
    """Vehicle front crosses the stop line while the vehicle signal is red.

    Start = crossing time (interpolated); end = the vehicle leaves the frame
    (track end), capped at ``max_exit`` s for tracks that are lost mid-intersection.
    """
    segs = []
    for tr in ctx.vehicles:
        dist, along = _line_coords(ctx, tr.foot)
        cross = np.flatnonzero((dist[:-1] > 0) & (dist[1:] <= 0))
        for i in cross:
            if not (-0.05 <= along[i + 1] <= 1.05):
                continue
            w = dist[i] / (dist[i] - dist[i + 1])
            t_cross = tr.t[i] + w * (tr.t[i + 1] - tr.t[i])
            if ctx.phase_at(t_cross) == RED:
                segs.append((float(t_cross), float(min(tr.t[-1], t_cross + max_exit))))
                if evidence is not None:
                    evidence.append(Evidence(*segs[-1], (tr.tid,), "crossed the stop line on red"))
    return merge_segments(segs)


def stop_line(ctx: EventContext, past_px: float = 15.0, zone_px: float = 140.0, still_speed: float = 0.08,
              min_still: float = 2.0, evidence: list[Evidence] | None = None) -> list[tuple[float, float]]:
    """Vehicle standing past the stop line on red without entering the intersection.

    The official definition only: the vehicle stands between the stop line and the far edge of
    the crossing (``zone_px``) on red for >= ``min_still`` s. A vehicle held inside the junction
    on red has entered the intersection and is not counted.
    Start = it stands there on red; end = the signal turns green (or it drives off first).
    """
    green_starts = np.array([ctx.phase_t[s] for s, _, v in runs(ctx.phase) if v == GREEN])
    segs = []
    for tr in ctx.vehicles:
        dist, along = _line_coords(ctx, tr.foot)
        in_zone = (dist < -past_px) & (dist > -zone_px) & (along > 0.0) & (along < 1.0)
        if not in_zone.any():
            continue
        standing_on_red = (tr.rel_speed() < still_speed) & (ctx.phase_at(tr.t) == RED)
        for s, e in mask_segments(tr.t, in_zone & standing_on_red, max_gap=1.0, min_len=min_still):
            nxt = green_starts[green_starts > s]
            # standing until (about) green: the event ends when the signal changes, else when it drives off
            end = float(nxt[0]) if len(nxt) and nxt[0] <= e + 2.0 else e
            segs.append((s, end))
            if evidence is not None:
                evidence.append(Evidence(s, end, (tr.tid,), "standing past the stop line on red"))
    return merge_segments(segs, max_gap=1.0)
