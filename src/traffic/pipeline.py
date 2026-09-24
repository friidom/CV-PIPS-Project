"""Part A end to end: one decoding pass -> alignment, tracks, signal phase -> rule-based events."""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .detector import Detector
from .events import EventContext, SceneMasks, detect_all
from .perception import Detections, detect_video
from .scene import Scene, estimate_homography
from .signals import LampCrops, eb_phase
from .tracks import build_tracks
from .trajectories import build_trajectories
from .video import VideoInfo, probe

TIME_FACTOR = 3.0          # organizers' budget: Part A + Part B <= 3 x video duration
ALIGN_FRAMES = 12          # frames whose median gives the background for alignment


@dataclass
class Perception:
    """Everything extracted from the pixels of one video (cacheable)."""
    info: VideoInfo
    detections: Detections
    lamp_frames: np.ndarray    # (F,) frame indices of lamp samples, increasing
    lamp_scores: np.ndarray    # (F, n_lamps)
    video_to_ref: np.ndarray   # 3x3 homography, 1920-wide video frame -> reference frame

    def save(self, path: Path) -> None:
        np.savez_compressed(path, fps=self.detections.fps, frames=self.detections.frames,
                            frame_of=self.detections.frame_of, boxes=self.detections.boxes,
                            lamp_frames=self.lamp_frames, lamp_scores=self.lamp_scores, H=self.video_to_ref)

    @classmethod
    def load(cls, path: Path, info: VideoInfo) -> "Perception":
        z = np.load(path)
        dets = Detections(float(z["fps"]), z["frames"], z["frame_of"], z["boxes"])
        return cls(info, dets, z["lamp_frames"], z["lamp_scores"], z["H"])


def harness_decode_seconds(info: VideoInfo, probe_frames: int = 45) -> float:
    """Predict how long the organizers' harness needs to read every frame (Part B loop) on this machine."""
    cap = cv2.VideoCapture(info.path)
    for _ in range(5):  # warm-up: codec init, first keyframe
        cap.read()
    t0 = time.perf_counter()
    n = 0
    while n < probe_frames and cap.read()[0]:
        n += 1
    cap.release()
    fps = n / max(time.perf_counter() - t0, 1e-6)
    return info.n_frames / max(fps, 1e-6)


class Pipeline:
    def __init__(self, root: Path, weights: str = "yolo11m_1280x736_b16.torchscript", device: str | None = None,
                 workers: int = 3):
        self.scene = Scene.load(root / "configs")
        self.masks = SceneMasks.build(self.scene)
        self.detector = Detector(str(root / "weights" / weights), device=device)
        self.workers = workers

    def perceive(self, info: VideoInfo, deadline: float | None = None) -> Perception:
        """Single decoding pass: detections, signal-head crops and background frames for alignment."""
        lamps: list[LampCrops] = []
        background = []
        spread = max(1, info.n_frames // 3 // ALIGN_FRAMES)

        def on_frame(idx: int, img: np.ndarray) -> None:
            if not lamps:  # rough head positions from the first frame; exact lamp positions come later
                lamps.append(LampCrops(self.scene, estimate_homography(img, self.scene.reference)[0]))
            lamps[0].add(idx, img)
            if (idx // 3) % spread == 0 and len(background) < ALIGN_FRAMES:
                background.append(img)

        dets = detect_video(info, self.detector, workers=self.workers, on_frame=on_frame, deadline=deadline)
        H = np.eye(3)
        if background:
            H, _ = estimate_homography(np.median(np.stack(background), axis=0).astype(np.uint8), self.scene.reference)
        if lamps:
            lamp_frames, lamp_scores = lamps[0].scores(self.scene, H)
        else:
            lamp_frames, lamp_scores = np.zeros(0, int), np.zeros((0, 4), np.float32)
        return Perception(info, dets, lamp_frames, lamp_scores, H)

    def context(self, p: Perception) -> EventContext:
        trajectories = build_trajectories(build_tracks(p.detections), p.info.width, p.video_to_ref)
        return EventContext(
            duration=p.info.duration, fps=p.info.fps, trajectories=trajectories,
            phase_t=p.lamp_frames / p.info.fps, phase=eb_phase(p.lamp_scores),
            scene=self.scene, masks=self.masks,
        )

    def detect_events(self, video_path: str, classes: list[str] | None = None,
                      cache_dir: Path | None = None) -> list[list]:
        t0 = time.perf_counter()
        info = probe(video_path)
        cache = cache_dir / f"{Path(video_path).name}.perception.npz" if cache_dir else None
        if cache is not None and cache.exists():
            perception = Perception.load(cache, info)
        else:
            # leave the harness enough time to stream every frame through Part B afterwards
            part_b = harness_decode_seconds(info) * 1.25
            deadline = t0 + TIME_FACTOR * info.duration - part_b - 0.05 * info.duration - 15.0
            perception = self.perceive(info, deadline=deadline)
            if cache is not None:
                cache.parent.mkdir(parents=True, exist_ok=True)
                perception.save(cache)
        return detect_all(self.context(perception), classes)
