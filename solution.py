"""
solution.py — the entry point the organizers' harness imports.

    detect_events(video_path)  -> [[start_sec, end_sec, label], ...]    # Part A
    RiskEstimator().reset(meta); .step(frame, t_sec) -> float           # Part B

Both delegate to the implementation in ``src/traffic``:

  Part A  src/traffic/pipeline.py   one sampled decoding pass -> detections,
                                    signal-lamp crops and background frames ->
                                    tracks, scene alignment, phase -> rule-based events
  Part B  src/traffic/risk.py       the same detector at a lower resolution, run
                                    online over the frames the harness streams in

Part B never sees Part A's output and never opens the video itself, so the risk
score stays causal.
"""
from __future__ import annotations

import os
import random
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

SEED = 1234
random.seed(SEED)
np.random.seed(SEED)
os.environ.setdefault("PYTHONHASHSEED", str(SEED))

# Official class ids we actually predict. The task allows removing ids and never
# adding them; a predicted class that never occurs in the test set scores 0 AND is
# added to the averaged class set, so shipping ids without a detector only lowers
# Score A. Not predicted here: accident, near_miss, illegal_turn,
# solid_line_crossing, road_obstacle, fire_smoke.
CLASSES: list[str] = [
    "red_light",           # crossing the stop line on red
    "wrong_way",           # driving against the traffic direction / in the oncoming lane
    "illegal_u_turn",      # U-turn where prohibited
    "stopped_vehicle",     # stationary on the carriageway >= 10 s, not queued at a signal
    "jaywalking",          # pedestrian on the carriageway outside a crossing
    "failure_to_yield",    # driving through a crossing while a pedestrian is on it
    "stop_line",           # stopped past the stop line on red
    "congestion",          # standstill / crawling traffic across all lanes of a direction
]

# Anticipation horizon used by the metric (seconds).
RISK_HORIZON_SEC = 5.0

DETECTOR_WEIGHTS = "yolo11m_1280x736_b16.torchscript"      # Part A: batched, full pass
RISK_WEIGHTS = "yolo11s_960x544_b1.torchscript"            # Part B: per-frame, must stay light

_pipeline = None


def _seed_torch() -> None:
    import torch

    torch.manual_seed(SEED)
    torch.cuda.manual_seed_all(SEED)
    torch.use_deterministic_algorithms(False)  # cuDNN conv autotune stays on; NMS is order-stable
    torch.backends.cudnn.benchmark = True


def _get_pipeline():
    """Build the Part A pipeline once; the detector warm-up costs a few seconds."""
    global _pipeline
    if _pipeline is None:
        _seed_torch()
        from traffic.pipeline import Pipeline

        _pipeline = Pipeline(ROOT, weights=DETECTOR_WEIGHTS)
    return _pipeline


def detect_events(video_path: str) -> list[list]:
    """Part A — traffic event detection.

    Returns ``[[start_sec, end_sec, label], ...]`` with ``label in CLASSES`` and
    ``0 <= start_sec < end_sec <= duration``. Returns ``[]`` on any failure: the
    harness would score a raised exception the same way, but an empty list keeps
    its log readable.
    """
    try:
        return _get_pipeline().detect_events(video_path, classes=CLASSES)
    except Exception as exc:  # noqa: BLE001 - one bad video must not end the run
        print(f"[solution] detect_events failed on {video_path}: {exc!r}", file=sys.stderr)
        return []


class RiskEstimator:
    """Part B — causal accident anticipation.

    ``reset`` is called once per video, then ``step`` for every frame in order.
    The work happens in :class:`traffic.risk.RiskModel`, which processes every
    5th frame and repeats the last score in between to stay inside the budget.
    """

    def __init__(self) -> None:
        self._model = None
        self._failed = False
        self.last_score = 0.0

    def _build(self):
        if self._model is None and not self._failed:
            try:
                _seed_torch()
                from traffic.detector import Detector
                from traffic.events import SceneMasks
                from traffic.risk import RiskModel
                from traffic.scene import Scene

                scene = Scene.load(ROOT / "configs")
                detector = Detector(str(ROOT / "weights" / RISK_WEIGHTS))
                self._model = RiskModel(detector, scene, SceneMasks.build(scene).road)
            except Exception as exc:  # noqa: BLE001
                print(f"[solution] RiskEstimator unavailable: {exc!r}", file=sys.stderr)
                self._failed = True
        return self._model

    def reset(self, meta: dict) -> None:
        self.meta = meta
        self.last_score = 0.0
        model = self._build()
        if model is not None:
            model.reset(meta)

    def step(self, frame: np.ndarray, t_sec: float) -> float:
        model = self._model
        if model is None:
            return 0.0
        try:
            self.last_score = float(model.step(frame, t_sec))
        except Exception as exc:  # noqa: BLE001 - keep streaming; a stale score beats a crash
            print(f"[solution] risk step failed at t={t_sec:.2f}: {exc!r}", file=sys.stderr)
        return self.last_score
