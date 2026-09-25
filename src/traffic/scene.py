"""Scene layout of the camera and per-video alignment to the reference view.

All geometry lives in the coordinates of ``configs/reference.jpg`` (1920x1080).
The camera is fixed but its framing differs slightly between recordings, so
every video gets a homography video->reference estimated from SIFT matches.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

REF_SIZE = (1920, 1080)


def _sift_features(gray: np.ndarray):
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return cv2.SIFT_create(nfeatures=6000).detectAndCompute(clahe.apply(gray), None)


def estimate_homography(frame: np.ndarray, reference: np.ndarray) -> tuple[np.ndarray, int]:
    """Homography mapping ``frame`` pixels (resized to REF_SIZE) onto the reference.

    Returns (H, inliers); falls back to identity when matching is unreliable.
    """
    a = cv2.cvtColor(cv2.resize(frame, REF_SIZE, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    b = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY)
    ka, da = _sift_features(a)
    kb, db = _sift_features(b)
    if da is None or db is None or len(ka) < 50 or len(kb) < 50:
        return np.eye(3), 0
    matches = cv2.BFMatcher(cv2.NORM_L2).knnMatch(da, db, k=2)
    good = [m for m, n in (p for p in matches if len(p) == 2) if m.distance < 0.75 * n.distance]
    if len(good) < 30:
        return np.eye(3), 0
    src = np.float32([ka[m.queryIdx].pt for m in good])
    dst = np.float32([kb[m.trainIdx].pt for m in good])
    H, mask = cv2.findHomography(src, dst, cv2.USAC_MAGSAC, 3.0)
    inliers = int(mask.sum()) if mask is not None else 0
    if H is None or inliers < 40:
        return np.eye(3), inliers
    return H, inliers


def apply_homography(H: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Map (N, 2) points with a 3x3 homography."""
    if len(pts) == 0:
        return pts.reshape(0, 2)
    p = np.c_[pts, np.ones(len(pts))] @ H.T
    return p[:, :2] / p[:, 2:3]


@dataclass
class FlowField:
    """Normal direction of vehicle traffic per grid cell, learned from the sample videos."""
    cell: int
    direction: np.ndarray    # (gh, gw, 2) mean unit direction
    consistency: np.ndarray  # (gh, gw) length of the mean unit vector: 1 = strictly one-way
    count: np.ndarray        # (gh, gw) moving-vehicle samples behind the estimate

    @classmethod
    def load(cls, path: Path) -> "FlowField":
        z = np.load(path)
        n = np.maximum(z["n"], 1)[..., None]
        mean = np.stack([z["sx"], z["sy"]], -1) / n
        length = np.linalg.norm(mean, axis=-1)
        return cls(int(z["cell"]), mean / np.maximum(length, 1e-6)[..., None], length, z["n"])

    def at(self, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """(direction (n, 2), consistency (n,), count (n,)) at reference-frame points."""
        gh, gw = self.count.shape
        cx = np.clip((pts[:, 0] // self.cell).astype(int), 0, gw - 1)
        cy = np.clip((pts[:, 1] // self.cell).astype(int), 0, gh - 1)
        return self.direction[cy, cx], self.consistency[cy, cx], self.count[cy, cx]


@dataclass
class Scene:
    """Named polygons / lines of the intersection, rasterised for O(1) point lookup."""
    stop_lines: dict[str, np.ndarray]
    crosswalks: dict[str, np.ndarray]
    islands: dict[str, np.ndarray]
    sidewalks: dict[str, np.ndarray]
    zones: dict[str, np.ndarray]
    signals: dict[str, dict]
    lane_lines: dict[str, np.ndarray] = field(default_factory=dict)  # (n, 2, 2): solid part of each lane line, upstream end -> stop line
    lane_rules: dict[str, dict[int, list[str]]] = field(default_factory=dict)  # lane (1 = kerb) -> allowed exits
    exits: dict[str, np.ndarray] = field(default_factory=dict)       # exit regions of the junction legs
    reference: np.ndarray | None = None
    flow: FlowField | None = None

    @classmethod
    def load(cls, config_dir: Path) -> "Scene":
        cfg = json.loads((config_dir / "scene.json").read_text())
        arr = lambda d: {k: np.asarray(v, np.float32) for k, v in d.items()}  # noqa: E731
        ref_path = config_dir / "reference.jpg"
        flow_path = config_dir / "flow_field.npz"
        return cls(
            stop_lines=arr(cfg["stop_lines"]),
            crosswalks=arr(cfg["crosswalks"]),
            islands=arr(cfg["islands"]),
            sidewalks=arr(cfg["sidewalks"]),
            zones=arr(cfg["zones"]),
            signals=cfg["signals"],
            lane_lines=arr(cfg.get("lane_lines", {})),
            lane_rules={k: {int(lane): exits for lane, exits in v.items()} for k, v in cfg.get("lane_rules", {}).items()},
            exits=arr(cfg.get("exits", {})),
            reference=cv2.imread(str(ref_path)) if ref_path.exists() else None,
            flow=FlowField.load(flow_path) if flow_path.exists() else None,
        )

    def mask(self, polygons: list[np.ndarray], dilate: int = 0) -> np.ndarray:
        m = np.zeros(REF_SIZE[::-1], np.uint8)
        cv2.fillPoly(m, [p.astype(np.int32) for p in polygons], 1)
        if dilate:
            m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dilate + 1, 2 * dilate + 1)))
        return m


def lookup(mask: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Values of a reference-frame raster at (N, 2) points; outside the frame -> 0."""
    x = np.round(pts[:, 0]).astype(np.int64)
    y = np.round(pts[:, 1]).astype(np.int64)
    ok = (x >= 0) & (y >= 0) & (x < mask.shape[1]) & (y < mask.shape[0])
    out = np.zeros(len(pts), mask.dtype)
    out[ok] = mask[y[ok], x[ok]]
    return out


def side_of_line(line: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Signed distance of points to the directed line a->b (positive = left of a->b in image coords)."""
    a, b = line[0], line[1]
    d = (b - a) / np.linalg.norm(b - a)
    rel = pts - a
    return rel[:, 0] * d[1] - rel[:, 1] * d[0]
