"""Part B: causal accident-risk score from tracked road users.

Every ``stride``-th frame is downscaled, detected and tracked online. The score
combines interpretable danger cues, each mapped to [0, 1]:

* conflict   - two road users on converging paths: time to closest approach
               under constant velocity, and how close they would get (in object sizes);
* red runner - a vehicle crossing the east-bound stop line on red at speed;
* braking    - sharp deceleration of a vehicle.

Cues are combined with a noisy-OR and smoothed with fast attack / slow decay, so
a warning persists for about a second after the cue disappears. Thresholds are set
so that ordinary traffic in the sample videos stays well below 0.5.
"""
from __future__ import annotations

from collections import defaultdict, deque

import cv2
import numpy as np

from .detector import Detector
from .scene import REF_SIZE, Scene, apply_homography, estimate_homography, lookup, side_of_line
from .signals import RED, CausalPhase, LampSampler
from .tracker import GROUP_PERSON, GROUP_TWO_WHEELER, GROUP_VEHICLE, Tracker, class_group

HISTORY_SEC = 1.5
REALIGN_AT = (10.0, 60.0)  # s; the camera may still settle right after recording starts


class RiskModel:
    def __init__(self, detector: Detector, scene: Scene, road: np.ndarray, stride: int = 5,
                 size: tuple[int, int] = (1280, 720)):
        self.detector, self.scene, self.road = detector, scene, road
        self.stride, self.size = stride, size
        self.stop_line = scene.stop_lines["eb"]
        self.trace: list | None = None  # set to [] to record observations (t, phase, tracks) for calibration

    def reset(self, meta: dict) -> None:
        self.meta = meta
        self.tracker = Tracker()
        self.H: np.ndarray | None = None
        self.lamps: LampSampler | None = None
        self.phase = CausalPhase()
        self.history: dict[int, deque] = defaultdict(lambda: deque(maxlen=int(HISTORY_SEC * 30 / self.stride) + 1))
        self.frame_idx = 0
        self.score = 0.0
        self.realign = list(REALIGN_AT)

    def step(self, frame: np.ndarray, t: float) -> float:
        idx = self.frame_idx
        self.frame_idx += 1
        if idx % self.stride:
            return self.score
        if self.H is None or (self.realign and t >= self.realign[0]):
            if self.H is not None:
                self.realign.pop(0)
            self.H, _ = estimate_homography(cv2.resize(frame, REF_SIZE, interpolation=cv2.INTER_AREA), self.scene.reference)
            self.lamps = LampSampler(self.scene, self.H, frame.shape[1] / REF_SIZE[0])
        phase = self.phase.update(self.lamps(frame))
        small = cv2.resize(frame, self.size, interpolation=cv2.INTER_LINEAR)
        tracked = self.tracker.update(self.detector([small], REF_SIZE[0] / self.size[0])[0])
        if self.trace is not None:
            self.trace.append((t, phase, tracked))
        return self.observe(tracked, t, phase)

    def observe(self, tracked: np.ndarray, t: float, phase: int) -> float:
        """Update the score from one processed frame of tracks (1920-wide video pixels)."""
        raw = 1.0 - float(np.prod([1.0 - c for c in self._cues(tracked, t, phase)]))
        # fast attack, slow decay (~1 s half-life at 6 updates / s)
        self.score = raw if raw > self.score else 0.89 * self.score + 0.11 * raw
        return float(np.clip(self.score, 0.0, 1.0))

    def _cues(self, tracked: np.ndarray, t: float, phase: int) -> tuple[float, float, float]:
        """Danger cues from tracks in 1920-wide video pixels mapped to the reference frame."""
        if len(tracked) == 0:
            return 0.0, 0.0, 0.0
        boxes = tracked[:, :4]
        foot = apply_homography(self.H, np.c_[(boxes[:, 0] + boxes[:, 2]) / 2, boxes[:, 3]])
        size = np.maximum(boxes[:, 2] - boxes[:, 0], 1.0)
        groups = class_group(tracked[:, 5].astype(int))
        vel = np.zeros((len(tracked), 2))
        decel = np.zeros(len(tracked))
        for k, tid in enumerate(tracked[:, 6].astype(int)):
            h = self.history[tid]
            h.append((t, foot[k, 0], foot[k, 1]))
            vel[k], decel[k] = _kinematics(h)
        on_road = lookup(self.road, foot) > 0
        return (_conflict(foot, vel, size, groups, on_road),
                self._red_runner(foot, vel, size, groups, phase),
                _braking(decel, size, (groups != GROUP_PERSON) & on_road))

    def _red_runner(self, foot, vel, size, groups, phase) -> float:
        if phase != RED:
            return 0.0
        d = side_of_line(self.stop_line, foot)
        speed = np.linalg.norm(vel, axis=1) / size
        crossing = (groups == GROUP_VEHICLE) & (d < 10) & (d > -120) & (speed > 1.0) & (vel[:, 1] > 0)
        return 0.35 if crossing.any() else 0.0


def _kinematics(h: deque) -> tuple[np.ndarray, float]:
    """Velocity (px/s) over the recent history and the drop in speed (px/s^2, >0 = braking)."""
    if len(h) < 4:
        return np.zeros(2), 0.0
    a = np.asarray(h)
    t, xy = a[:, 0], a[:, 1:]
    half = len(a) // 2
    v1 = (xy[half] - xy[0]) / max(t[half] - t[0], 1e-3)
    v2 = (xy[-1] - xy[half]) / max(t[-1] - t[half], 1e-3)
    decel = (np.linalg.norm(v1) - np.linalg.norm(v2)) / max((t[-1] - t[0]) / 2, 1e-3)
    return v2, decel


def _conflict(foot, vel, size, groups, on_road, horizon: float = 2.0) -> float:
    """Worst pairwise collision course among road users on the carriageway (>= 1 moving vehicle).

    Constant-velocity extrapolation: time to closest approach ``t_ca`` and the miss
    distance ``d_ca`` in object sizes. Only near-misses in the extrapolation
    (d_ca < 0.5) with a fast closing speed and t_ca < ``horizon`` count.
    """
    n = len(foot)
    if n < 2:
        return 0.0
    rel_p = foot[None, :, :] - foot[:, None, :]
    rel_v = vel[None, :, :] - vel[:, None, :]
    radius = (size[:, None] + size[None, :]) / 2
    vv = (rel_v ** 2).sum(-1)
    closing = np.sqrt(vv) / radius  # object sizes per second
    speed = np.linalg.norm(vel, axis=1) / size
    vehicle = (groups == GROUP_VEHICLE) & (speed > 1.0)
    involved = (vehicle[:, None] | vehicle[None, :]) & on_road[:, None] & on_road[None, :]
    involved &= (groups[:, None] != GROUP_TWO_WHEELER) | (groups[None, :] != GROUP_TWO_WHEELER)
    candidates = involved & (closing > 1.5) & ~np.eye(n, dtype=bool)
    if not candidates.any():
        return 0.0
    i, j = np.nonzero(candidates)
    t_ca = -(rel_p[i, j] * rel_v[i, j]).sum(-1) / vv[i, j]
    ahead = (t_ca > 0) & (t_ca < horizon)
    if not ahead.any():
        return 0.0
    i, j, t_ca = i[ahead], j[ahead], t_ca[ahead]
    d_ca = np.linalg.norm(rel_p[i, j] + rel_v[i, j] * t_ca[:, None], axis=-1) / radius[i, j]
    r = np.exp(-t_ca) * np.clip(1.0 - d_ca / 0.5, 0, 1) * np.clip((closing[i, j] - 1.5) / 3.0, 0, 1)
    return float(r.max())


def _braking(decel: np.ndarray, size: np.ndarray, moving: np.ndarray) -> float:
    """Hard braking: speed drop of more than ~3 object sizes per second, per second.

    Capped at 0.3: drivers brake hard for every red light here, so braking only
    raises an alarm together with another cue.
    """
    if not moving.any():
        return 0.0
    return float(np.clip(((decel / size)[moving].max() - 3.0) / 6.0, 0.0, 0.3))
