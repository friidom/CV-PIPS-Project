"""Offline trajectories: run the tracker over cached detections and index the result."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .perception import Detections
from .tracker import Tracker, TrackerConfig, class_group


@dataclass
class TrackTable:
    """All track observations of a video, sorted by (track, frame).

    Columns: tid, frame, x1, y1, x2, y2, conf, cls (video pixels, COCO ids).
    """
    fps: float
    rows: np.ndarray  # (N, 8) float64

    @property
    def tid(self) -> np.ndarray:
        return self.rows[:, 0].astype(np.int64)

    @property
    def frame(self) -> np.ndarray:
        return self.rows[:, 1].astype(np.int64)

    def track_ids(self) -> np.ndarray:
        return np.unique(self.tid)

    def split(self) -> dict[int, np.ndarray]:
        """tid -> (n, 8) rows of that track, in frame order."""
        tid = self.tid
        starts = np.flatnonzero(np.r_[True, tid[1:] != tid[:-1]])
        ends = np.r_[starts[1:], len(tid)]
        return {int(tid[s]): self.rows[s:e] for s, e in zip(starts, ends)}


def build_tracks(dets: Detections, config: TrackerConfig | None = None) -> TrackTable:
    tracker = Tracker(config)
    out = []
    for idx, boxes in dets.per_frame():
        tracked = tracker.update(boxes)
        if len(tracked):
            out.append(np.column_stack([tracked[:, 6], np.full(len(tracked), idx), tracked[:, :6]]))
    rows = np.concatenate(out) if out else np.zeros((0, 8))
    rows = rows[np.lexsort((rows[:, 1], rows[:, 0]))]
    return TrackTable(dets.fps, rows)


def majority_class(rows: np.ndarray) -> int:
    """Most frequent COCO class of a track, weighted by confidence."""
    classes = rows[:, 7].astype(np.int64)
    votes = np.bincount(classes, weights=rows[:, 6])
    return int(np.argmax(votes))


def track_group(rows: np.ndarray) -> int:
    return int(class_group(np.array([majority_class(rows)]))[0])
