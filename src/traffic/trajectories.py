"""Trajectories in reference-frame coordinates with the kinematics the event rules need."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .scene import REF_SIZE, apply_homography
from .tracker import class_group
from .tracks import TrackTable, majority_class


@dataclass
class Trajectory:
    tid: int
    cls: int               # majority COCO class
    group: int             # tracker.GROUP_*
    t: np.ndarray          # (n,) seconds
    box: np.ndarray        # (n, 4) x1 y1 x2 y2, reference pixels
    foot: np.ndarray       # (n, 2) bottom-centre (ground contact), smoothed, reference pixels

    @property
    def size(self) -> np.ndarray:
        """Object scale per sample: box width (vehicles) or height (people), for scale-free thresholds."""
        w = self.box[:, 2] - self.box[:, 0]
        h = self.box[:, 3] - self.box[:, 1]
        return h if self.group == 0 else w

    def velocity(self, window: float = 1.0) -> np.ndarray:
        """(n, 2) central-difference velocity of the foot point over ~``window`` seconds (px/s)."""
        n = len(self.t)
        if n < 2:
            return np.zeros((n, 2))
        lo = np.searchsorted(self.t, self.t - window / 2)
        hi = np.clip(np.searchsorted(self.t, self.t + window / 2, side="right") - 1, 0, n - 1)
        dt = np.maximum(self.t[hi] - self.t[lo], 1e-6)
        v = (self.foot[hi] - self.foot[lo]) / dt[:, None]
        v[hi == lo] = 0.0
        return v

    def rel_speed(self, window: float = 1.0) -> np.ndarray:
        """Speed in object sizes per second (perspective-independent)."""
        return np.linalg.norm(self.velocity(window), axis=1) / np.maximum(self.size, 1.0)


def _smooth(x: np.ndarray, k: int) -> np.ndarray:
    if len(x) < k or k <= 1:
        return x
    pad = k // 2
    xp = np.pad(x, ((pad, pad), (0, 0)), mode="edge")
    kernel = np.ones(k) / k
    return np.stack([np.convolve(xp[:, j], kernel, mode="valid") for j in range(x.shape[1])], axis=1)


def build_trajectories(table: TrackTable, video_width: int, video_to_ref: np.ndarray,
                       min_samples: int = 5) -> list[Trajectory]:
    """Map every track into reference coordinates (video pixels -> 1920-wide frame -> homography)."""
    scale = REF_SIZE[0] / video_width
    out = []
    for tid, rows in table.split().items():
        if len(rows) < min_samples:
            continue
        x1, y1, x2, y2 = (rows[:, 2 + k] * scale for k in range(4))
        corners = np.stack([np.c_[x1, y1], np.c_[x2, y1], np.c_[x2, y2], np.c_[x1, y2]], axis=1)  # (n, 4, 2)
        mapped = apply_homography(video_to_ref, corners.reshape(-1, 2)).reshape(-1, 4, 2)
        box = np.c_[mapped[..., 0].min(1), mapped[..., 1].min(1), mapped[..., 0].max(1), mapped[..., 1].max(1)]
        foot = apply_homography(video_to_ref, np.c_[(x1 + x2) / 2, y2])
        cls = majority_class(rows)
        out.append(Trajectory(
            tid=tid, cls=cls, group=int(class_group(np.array([cls]))[0]),
            t=rows[:, 1] / table.fps, box=box, foot=_smooth(foot, 5),
        ))
    return out
