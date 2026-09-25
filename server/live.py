"""Live mode: detection + tracking on frames a browser streams in (a webcam, or a clip played in real time).

Only the parts of the pipeline that are causal and per-frame apply to a live feed:
the YOLO11s detector Part B uses and the same online Tracker. The event rules are
not run - they need whole-clip context (per-video signal thresholds, a median
background for alignment) and this camera's scene geometry - and neither is the
risk score, whose cues are expressed in the reference frame of this camera.

The detector here is its own instance, so a live session never shares model state
with an upload being analysed; server/app.py also refuses live frames while one is.
"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from traffic.detector import Detector  # noqa: E402
from traffic.tracker import Tracker, class_group  # noqa: E402

SESSION_TTL_SEC = 60.0
MAX_SESSIONS = 16

_lock = threading.Lock()
_detector: Detector | None = None
_sessions: dict[str, tuple[Tracker, float, int]] = {}  # id -> (tracker, last seen, frames)


def step(session: str, jpeg: bytes) -> dict:
    """Detect and track one frame for `session`. Boxes come back in fractions of the frame."""
    frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("not a decodable image")
    h, w = frame.shape[:2]
    if w * 9 < h * 16:  # taller than 16:9: pad the right edge, the export is a 16:9 graph
        frame = cv2.copyMakeBorder(frame, 0, 0, 0, int(np.ceil(h * 16 / 9)) - w, cv2.BORDER_CONSTANT, value=(114,) * 3)

    global _detector
    with _lock:  # one frame at a time: the detector and the trackers are not shared across threads
        if _detector is None:
            _detector = Detector(str(ROOT / "weights" / "yolo11s_960x544_b1.torchscript"))
        now = time.monotonic()
        for sid in [s for s, (_, seen, _) in _sessions.items() if now - seen > SESSION_TTL_SEC]:
            del _sessions[sid]
        if session not in _sessions and len(_sessions) >= MAX_SESSIONS:
            raise OverflowError("too many live sessions")
        tracker, _, n = _sessions.get(session) or (Tracker(), now, 0)
        t0 = time.perf_counter()
        dets = _detector([frame], 1.0)[0]
        tracked = tracker.update(dets)
        ms = (time.perf_counter() - t0) * 1000.0
        _sessions[session] = (tracker, now, n + 1)

    groups = class_group(tracked[:, 5].astype(int)) if len(tracked) else []
    return {
        "frame": n + 1,
        "ms": round(ms, 1),
        "detections": int(len(dets)),
        # id, group (0 person, 1 vehicle, 2 two-wheeler, 3 animal), cx, cy, w, h
        "boxes": [
            [int(r[6]), int(g), round(float((r[0] + r[2]) / 2 / w), 4), round(float((r[1] + r[3]) / 2 / h), 4),
             round(float((r[2] - r[0]) / w), 4), round(float((r[3] - r[1]) / h), 4)]
            for r, g in zip(tracked, groups)
        ],
    }
