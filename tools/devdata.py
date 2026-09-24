"""Development helper: assemble cached per-video data (detections, alignment, signal phase).

Used by the exploration / tuning scripts in tools/; the submission pipeline computes the
same things in one decoding pass (src/traffic/pipeline.py).
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))  # evaluate.py (official metric) lives at the repo root

from traffic.pipeline import Perception  # noqa: E402
from traffic.scene import Scene  # noqa: E402
from traffic.signals import eb_phase  # noqa: E402
from traffic.trajectories import Trajectory, build_trajectories  # noqa: E402
from traffic.tracks import build_tracks  # noqa: E402
from traffic.video import VideoInfo  # noqa: E402

CACHE = ROOT / "cache"
VIDEOS = ["C3896.MP4", "C3897.MP4", "C3902.MP4", "C3905.MP4"]
DURATION = {"C3896.MP4": 10200 / 29.97, "C3897.MP4": 9525 / 29.97, "C3902.MP4": 9525 / 29.97, "C3905.MP4": 3825 / 29.97}


@dataclass
class DevVideo:
    name: str
    duration: float
    trajectories: list[Trajectory]
    phase_t: np.ndarray
    phase: np.ndarray


def load(name: str) -> DevVideo:
    """Cached perception of a sample video (tools/cache_perception.py) -> trajectories + signal phase."""
    info = VideoInfo(name, 30000 / 1001, round(DURATION[name] * 30000 / 1001), 3840, 2160)
    p = Perception.load(CACHE / f"{name}.perception.npz", info)
    trajs = build_trajectories(build_tracks(p.detections), info.width, p.video_to_ref)
    return DevVideo(name, DURATION[name], trajs, p.lamp_frames / info.fps, eb_phase(p.lamp_scores))


def scene() -> Scene:
    return Scene.load(ROOT / "configs")
