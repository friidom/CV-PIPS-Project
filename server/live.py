"""Live mode: the causal half of the system on frames a browser streams in (a webcam, or a clip played in real time).

Each session is one RiskModel - the Part B code, unchanged - fed frame by frame the
way the organizers' harness feeds it, except that the browser has already sampled the
feed, so every frame that arrives is processed (RiskModel's own stride would drop four
of every five). Its online Tracker gives the ids; its cues and score give the warnings.

Those cues are only meaningful in this camera's calibrated scene. The first frame is
aligned to configs/reference.jpg exactly as Part B aligns a video; when that fails (a
webcam pointed at anything else) the session says so and returns boxes and ids only,
rather than a risk score read off arbitrary pixels. Part A's event rules are not run:
they need whole-clip context (per-video signal thresholds, a median background).

The detector is this module's own instance, so a live session never shares model
state with an upload being analysed; server/app.py also refuses live frames while one is.
"""
from __future__ import annotations

import math
import sys
import threading
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from traffic.detector import Detector  # noqa: E402
from traffic.events import SceneMasks  # noqa: E402
from traffic.risk import RiskModel  # noqa: E402
from traffic.scene import REF_SIZE, Scene, estimate_homography  # noqa: E402
from traffic.signals import AMBER, GREEN, RED, LampSampler  # noqa: E402
from traffic.tracker import class_group  # noqa: E402

SESSION_TTL_SEC = 60.0
MAX_SESSIONS = 16
MIN_INLIERS = 40         # the same floor server/inference.py uses to call a clip aligned
# Frames per second the browser is asked to send. RiskModel was calibrated on every 5th
# frame of a 30 fps camera (6 updates/s: its history length and decay assume that rate);
# without a scene there is no risk to keep calibrated, only boxes, so allow a smoother feed.
FPS_ALIGNED = 6.0
FPS_TRACKING = 10.0
PHASES = {RED: "red", GREEN: "green", AMBER: "amber"}

_lock = threading.Lock()
_detector: Detector | None = None
_scene: Scene | None = None
_road: np.ndarray | None = None


class _LiveRisk(RiskModel):
    """RiskModel that keeps the three cues behind its latest score (pass-through, like CueRecorder)."""

    last_cues: tuple[float, float, float] = (0.0, 0.0, 0.0)

    def _cues(self, tracked, t, phase):
        self.last_cues = super()._cues(tracked, t, phase)
        return self.last_cues


class Session:
    """One browser feed: its tracker, its alignment to the scene and its risk state."""

    def __init__(self) -> None:
        # stride 5 only sizes the model's 1.5 s track history for ~6 updates/s; step() below
        # processes every frame it is given.
        self.model = _LiveRisk(_detector, _scene, _road)
        self.restart()

    def restart(self) -> None:
        self.model.reset({"video_id": "live", "fps": FPS_ALIGNED, "width": 0, "height": 0, "n_frames": 0})
        self.aligned = False
        self.inliers = 0
        self.frames = 0
        self.last_t: float | None = None
        self.started = time.monotonic()
        self.seen = self.started

    def step(self, frame: np.ndarray, t: float) -> tuple[np.ndarray, int, int]:
        """Detect, track and (when aligned) score one frame. Returns (tracked, detections, phase)."""
        m = self.model
        if m.H is None or (m.realign and t >= m.realign[0]):
            if m.H is not None:
                m.realign.pop(0)
            H, self.inliers = estimate_homography(cv2.resize(frame, REF_SIZE, interpolation=cv2.INTER_AREA),
                                                  _scene.reference)
            self.aligned = self.inliers >= MIN_INLIERS
            m.H = H
            m.lamps = LampSampler(_scene, H, frame.shape[1] / REF_SIZE[0]) if self.aligned else None
        small = cv2.resize(frame, m.size, interpolation=cv2.INTER_LINEAR)
        dets = m.detector([small], REF_SIZE[0] / m.size[0])[0]
        tracked = m.tracker.update(dets)
        phase = 0
        if self.aligned:
            phase = m.phase.update(m.lamps(frame))
            m.observe(tracked, t, phase)
        self.frames += 1
        self.last_t = t
        return tracked, len(dets), phase


_sessions: dict[str, Session] = {}


def _load() -> None:
    global _detector, _scene, _road
    if _detector is None:
        _scene = Scene.load(ROOT / "configs")
        _road = SceneMasks.build(_scene).road
        _detector = Detector(str(ROOT / "weights" / "yolo11s_960x544_b1.torchscript"))


def warm() -> str:
    """Load the live detector ahead of the first frame. Returns its device."""
    with _lock:
        _load()
        return str(_detector.device)


def close(session: str) -> bool:
    """Forget a session and its tracker (the browser stopped the feed)."""
    with _lock:
        return _sessions.pop(session, None) is not None


def step(session: str, jpeg: bytes, t: float | None = None) -> dict:
    """Process one frame of `session`, taken `t` seconds into its feed.

    Boxes come back as fractions of the frame the browser sent. A timestamp that runs
    backwards (a looping clip, a seek) starts the session over, ids included.
    """
    frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("not a decodable image")
    if t is not None and not (math.isfinite(t) and 0.0 <= t < 1e6):
        raise ValueError("t must be a non-negative number of seconds")
    h, w = frame.shape[:2]
    if w * 9 < h * 16:  # taller than 16:9 (most webcams are 4:3): pad the right edge, the model expects 16:9
        frame = cv2.copyMakeBorder(frame, 0, 0, 0, int(np.ceil(h * 16 / 9)) - w, cv2.BORDER_CONSTANT, value=(114,) * 3)
    fx = frame.shape[1] / REF_SIZE[0] / w  # 1920-wide model pixels -> fraction of the sent width
    fy = frame.shape[0] / REF_SIZE[1] / h

    with _lock:  # one frame at a time: the detector and the trackers are not shared across threads
        _load()
        now = time.monotonic()
        for sid in [s for s, v in _sessions.items() if now - v.seen > SESSION_TTL_SEC]:
            del _sessions[sid]
        sess = _sessions.get(session)
        if sess is None:
            if len(_sessions) >= MAX_SESSIONS:
                raise OverflowError("too many live sessions")
            sess = _sessions[session] = Session()
        if t is None:
            t = now - sess.started
        reset = sess.last_t is not None and t < sess.last_t - 0.25
        if reset:
            sess.restart()
        sess.seen = now
        t0 = time.perf_counter()
        tracked, n_dets, phase = sess.step(frame, t)
        ms = (time.perf_counter() - t0) * 1000.0
        aligned = sess.aligned
        cues = sess.model.last_cues if aligned else None
        risk = sess.model.score if aligned else None
        reply = {
            "frame": sess.frames,
            "t": round(t, 3),
            "reset": reset,
            "ms": round(ms, 1),
            "device": str(_detector.device),
            "detections": int(n_dets),
            "aligned": aligned,
            "inliers": int(sess.inliers),
            "target_fps": FPS_ALIGNED if aligned else FPS_TRACKING,
        }

    groups = class_group(tracked[:, 5].astype(int)) if len(tracked) else []
    reply.update(
        # Part B's score and the cues behind it; None when the feed is not this camera's scene.
        risk=None if risk is None else round(float(risk), 4),
        cues=None if cues is None else dict(zip(("conflict", "red_runner", "braking"), (round(float(c), 4) for c in cues))),
        phase=PHASES.get(phase, "unknown") if aligned else None,
        # id, group (0 person, 1 vehicle, 2 two-wheeler, 3 animal), cx, cy, w, h
        boxes=[
            [int(r[6]), int(g), round(float((r[0] + r[2]) / 2 * fx), 4), round(float((r[1] + r[3]) / 2 * fy), 4),
             round(float((r[2] - r[0]) * fx), 4), round(float((r[3] - r[1]) * fy), 4)]
            for r, g in zip(tracked, groups)
        ],
    )
    return reply
