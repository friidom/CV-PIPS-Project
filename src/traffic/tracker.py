"""Multi-object tracking: ByteTrack-style two-stage IoU association on top of a
constant-velocity Kalman filter over (cx, cy, w, h). Vectorised with numpy.

Detections are matched only within a class group (people, motor vehicles,
two-wheelers, animals), so a pedestrian box never takes over a car track;
car/bus/truck flips inside the vehicle group are tolerated and resolved by
majority vote per track.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import linear_sum_assignment

from .detector import ANIMALS, BICYCLE, MOTORCYCLE, PERSON

GROUP_PERSON, GROUP_VEHICLE, GROUP_TWO_WHEELER, GROUP_ANIMAL = 0, 1, 2, 3


def class_group(coco_cls: np.ndarray) -> np.ndarray:
    groups = np.full(coco_cls.shape, GROUP_VEHICLE, np.int8)
    groups[coco_cls == PERSON] = GROUP_PERSON
    groups[(coco_cls == BICYCLE) | (coco_cls == MOTORCYCLE)] = GROUP_TWO_WHEELER
    groups[np.isin(coco_cls, ANIMALS)] = GROUP_ANIMAL
    return groups


def iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """IoU between xyxy boxes a (N, 4) and b (M, 4)."""
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)), np.float32)
    lt = np.maximum(a[:, None, :2], b[None, :, :2])
    rb = np.minimum(a[:, None, 2:], b[None, :, 2:])
    inter = np.prod(np.clip(rb - lt, 0, None), axis=2)
    area_a = np.prod(a[:, 2:] - a[:, :2], axis=1)
    area_b = np.prod(b[:, 2:] - b[:, :2], axis=1)
    return inter / (area_a[:, None] + area_b[None, :] - inter + 1e-9)


class KalmanXYWH:
    """Batched constant-velocity Kalman filter; state = cx, cy, w, h and their velocities."""
    POS, VEL = 1 / 20, 1 / 160  # noise scale relative to box size (ByteTrack / BoT-SORT values)

    def __init__(self):
        self.F = np.eye(8)
        self.F[:4, 4:] = np.eye(4)
        self.H = np.eye(4, 8)

    @staticmethod
    def _wh(x: np.ndarray) -> np.ndarray:
        wh = np.maximum(x[..., 2:4], 1.0)
        return np.concatenate([wh, wh], axis=-1)  # (…, 4): w h w h

    def initiate(self, z: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        mean = np.concatenate([z, np.zeros_like(z)], axis=1)
        wh = self._wh(z)
        std = np.concatenate([2 * self.POS * wh, 10 * self.VEL * wh], axis=1)
        return mean, np.einsum("ni,ij->nij", std ** 2, np.eye(8))

    def predict(self, mean: np.ndarray, cov: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        wh = self._wh(mean)
        q = np.concatenate([self.POS * wh, self.VEL * wh], axis=1) ** 2
        mean = mean @ self.F.T
        cov = self.F @ cov @ self.F.T + np.einsum("ni,ij->nij", q, np.eye(8))
        return mean, cov

    def update(self, mean, cov, z):
        r = (self.POS * self._wh(mean)) ** 2
        s = self.H @ cov @ self.H.T + np.einsum("ni,ij->nij", r, np.eye(4))
        k = cov @ self.H.T @ np.linalg.inv(s)
        innovation = z - mean @ self.H.T
        mean = mean + np.einsum("nij,nj->ni", k, innovation)
        cov = cov - k @ s @ np.transpose(k, (0, 2, 1))
        return mean, cov


def xyxy_to_cxcywh(b: np.ndarray) -> np.ndarray:
    return np.stack([(b[:, 0] + b[:, 2]) / 2, (b[:, 1] + b[:, 3]) / 2, b[:, 2] - b[:, 0], b[:, 3] - b[:, 1]], axis=1)


def cxcywh_to_xyxy(s: np.ndarray) -> np.ndarray:
    return np.stack([s[:, 0] - s[:, 2] / 2, s[:, 1] - s[:, 3] / 2, s[:, 0] + s[:, 2] / 2, s[:, 1] + s[:, 3] / 2], axis=1)


@dataclass
class TrackerConfig:
    high_conf: float = 0.4       # first-stage detections
    low_conf: float = 0.15       # second-stage (recovers occluded / blurred objects)
    new_track_conf: float = 0.5
    match_iou: float = 0.2       # first stage
    low_match_iou: float = 0.4   # second stage
    confirm_hits: int = 2
    max_lost: int = 40           # sampled frames a lost track is kept (~4 s at 10 fps)


@dataclass
class _Tracks:
    ids: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int64))
    mean: np.ndarray = field(default_factory=lambda: np.zeros((0, 8)))
    cov: np.ndarray = field(default_factory=lambda: np.zeros((0, 8, 8)))
    group: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int8))
    hits: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int32))
    lost: np.ndarray = field(default_factory=lambda: np.zeros(0, np.int32))

    def select(self, keep: np.ndarray) -> "_Tracks":
        return _Tracks(self.ids[keep], self.mean[keep], self.cov[keep], self.group[keep], self.hits[keep], self.lost[keep])

    @staticmethod
    def concat(a: "_Tracks", b: "_Tracks") -> "_Tracks":
        return _Tracks(*(np.concatenate([x, y]) for x, y in zip(
            (a.ids, a.mean, a.cov, a.group, a.hits, a.lost), (b.ids, b.mean, b.cov, b.group, b.hits, b.lost))))


class Tracker:
    """Online tracker. ``update(dets)`` takes (N, 6) x1 y1 x2 y2 conf cls and returns
    (M, 7) rows for confirmed tracks seen in this frame: x1 y1 x2 y2 conf cls track_id.
    """

    def __init__(self, config: TrackerConfig | None = None):
        self.cfg = config or TrackerConfig()
        self.kf = KalmanXYWH()
        self.tracks = _Tracks()
        self.next_id = 1

    def _match(self, track_idx: np.ndarray, det_idx: np.ndarray, boxes: np.ndarray,
               det_groups: np.ndarray, min_iou: float) -> list[tuple[int, int]]:
        if len(track_idx) == 0 or len(det_idx) == 0:
            return []
        pred = cxcywh_to_xyxy(self.tracks.mean[track_idx, :4])
        iou = iou_matrix(pred, boxes[det_idx, :4])
        iou[self.tracks.group[track_idx][:, None] != det_groups[det_idx][None, :]] = 0.0
        rows, cols = linear_sum_assignment(-iou)
        return [(track_idx[r], det_idx[c]) for r, c in zip(rows, cols) if iou[r, c] >= min_iou]

    def update(self, dets: np.ndarray) -> np.ndarray:
        cfg, t = self.cfg, self.tracks
        if len(t.ids):
            t.mean, t.cov = self.kf.predict(t.mean, t.cov)
            # a lost track keeps moving only briefly; freeze velocity after 1 s to avoid drifting boxes
            t.mean[t.lost > 10, 4:] = 0.0
        groups = class_group(dets[:, 5].astype(np.int32)) if len(dets) else np.zeros(0, np.int8)
        conf = dets[:, 4] if len(dets) else np.zeros(0)
        high = np.flatnonzero(conf >= cfg.high_conf)
        low = np.flatnonzero((conf >= cfg.low_conf) & (conf < cfg.high_conf))

        all_tracks = np.arange(len(t.ids))
        pairs = self._match(all_tracks, high, dets, groups, cfg.match_iou)
        matched_t = {p[0] for p in pairs}
        remaining = np.array([i for i in all_tracks if i not in matched_t and t.hits[i] >= cfg.confirm_hits], np.int64)
        pairs += self._match(remaining, low, dets, groups, cfg.low_match_iou)

        det_for_track = np.full(len(t.ids), -1, np.int64)
        for ti, di in pairs:
            det_for_track[ti] = di
        upd = np.flatnonzero(det_for_track >= 0)
        if len(upd):
            z = xyxy_to_cxcywh(dets[det_for_track[upd], :4])
            t.mean[upd], t.cov[upd] = self.kf.update(t.mean[upd], t.cov[upd], z)
            t.hits[upd] += 1
            t.lost[upd] = 0
        missed = det_for_track < 0
        t.lost[missed] += 1
        # tentative tracks die on their first miss; confirmed ones after max_lost frames
        keep = ~(missed & ((t.hits < cfg.confirm_hits) | (t.lost > cfg.max_lost)))
        det_for_track = det_for_track[keep]
        self.tracks = t = t.select(keep)

        used = set(det_for_track[det_for_track >= 0].tolist())
        new = np.array([d for d in high if d not in used and conf[d] >= cfg.new_track_conf], np.int64)
        if len(new):
            mean, cov = self.kf.initiate(xyxy_to_cxcywh(dets[new, :4]))
            fresh = _Tracks(np.arange(self.next_id, self.next_id + len(new)), mean, cov, groups[new],
                            np.ones(len(new), np.int32), np.zeros(len(new), np.int32))
            self.next_id += len(new)
            self.tracks = _Tracks.concat(t, fresh)
            det_for_track = np.concatenate([det_for_track, new])

        t = self.tracks
        out = [np.concatenate([dets[d, :6], [t.ids[i]]]) for i, d in enumerate(det_for_track)
               if d >= 0 and t.hits[i] >= cfg.confirm_hits]
        return np.asarray(out, np.float64).reshape(-1, 7)
