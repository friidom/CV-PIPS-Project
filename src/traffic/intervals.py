"""Run-length and time-interval helpers shared by the signal reader and the event rules."""
from __future__ import annotations

import numpy as np


def runs(values: np.ndarray) -> list[tuple[int, int, int]]:
    """Maximal runs of equal values as (start, end_exclusive, value)."""
    if len(values) == 0:
        return []
    change = np.flatnonzero(np.diff(values) != 0) + 1
    starts = np.r_[0, change]
    ends = np.r_[change, len(values)]
    return [(int(s), int(e), int(values[s])) for s, e in zip(starts, ends)]


def mask_segments(times: np.ndarray, mask: np.ndarray, max_gap: float = 0.0,
                  min_len: float = 0.0) -> list[tuple[float, float]]:
    """Time segments where ``mask`` holds, gaps <= ``max_gap`` bridged, shorter than ``min_len`` dropped.

    A run covering samples i..j becomes [times[i], times[j]].
    """
    segs = [(float(times[s]), float(times[e - 1])) for s, e, v in runs(mask.astype(np.int8)) if v]
    return merge_segments(segs, max_gap, min_len)


def merge_segments(segs: list[tuple[float, float]], max_gap: float = 0.0, min_len: float = 0.0,
                   handover: float = 0.0) -> list[tuple[float, float]]:
    """Union of segments (touching or closer than ``max_gap`` are merged), then length filter.

    A segment that overlaps the previous one by at most ``handover`` s and outlasts it is a
    hand-over, not the same event: the previous segment is cut at its start instead.
    """
    out: list[list[float]] = []
    for s, e in sorted(segs):
        if out and 0 < out[-1][1] - s <= handover and e > out[-1][1] and s > out[-1][0]:
            out[-1][1] = s
            out.append([s, e])
        elif out and s - out[-1][1] <= max_gap:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out if e - s >= min_len]

