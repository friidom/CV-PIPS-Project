"""Runs the real pipeline for one uploaded clip.

Part A and Part B both come from src/traffic, the same code the submission runs.
Part B is driven here exactly as the organizers' harness drives it: reset once,
then step over frames in order, never touching the file itself.
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

from traffic.detector import Detector  # noqa: E402
from traffic.events import SceneMasks, detect_all  # noqa: E402
from traffic.pipeline import Perception  # noqa: E402
from traffic.risk import RiskModel  # noqa: E402
from traffic.scene import REF_SIZE, Scene, estimate_homography  # noqa: E402
from traffic.signals import LampCrops, eb_phase  # noqa: E402
from traffic.tracks import build_tracks  # noqa: E402
from traffic.trajectories import build_trajectories  # noqa: E402
from traffic.video import VideoInfo, probe  # noqa: E402
from traffic.perception import DETECT_SIZE, Detections, parallel_frames  # noqa: E402
from traffic.events.context import EventContext  # noqa: E402

from solution import CLASSES  # noqa: E402

PROXY_WIDTH = 1280
RISK_STRIDE = 5          # traffic.risk processes every 5th frame; match it for the preview curve
ALIGN_FRAMES = 12
DETECT_BATCH = 16

# Rough share of the wall clock each stage takes, for a progress bar that does not stall.
WEIGHTS = {"perception": 0.52, "tracking": 0.06, "rules": 0.04, "risk": 0.30, "encoding": 0.08}


class Engine:
    """Loads both detectors once and reuses them for every job."""

    def __init__(self) -> None:
        self.scene = Scene.load(ROOT / "configs")
        self.masks = SceneMasks.build(self.scene)
        self.detector = Detector(str(ROOT / "weights" / "yolo11m_1280x736_b16.torchscript"))
        self.risk_detector = Detector(str(ROOT / "weights" / "yolo11s_960x544_b1.torchscript"))
        self.device = str(self.detector.device)

    def gpu_name(self) -> str | None:
        try:
            import torch

            return torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
        except Exception:
            return None


_engine: Engine | None = None


def engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = Engine()
    return _engine


def _stage_progress(done_stages: list[str], fraction: float, stage: str) -> float:
    base = sum(WEIGHTS[s] for s in done_stages)
    return min(base + WEIGHTS[stage] * max(0.0, min(fraction, 1.0)), 0.999)


def run_job(job, on_progress) -> dict:
    """Full Part A + Part B for one uploaded clip. Returns the payload the UI renders."""
    eng = engine()
    t_start = time.perf_counter()
    info = probe(str(job.path))
    if info.n_frames <= 0 or info.fps <= 0:
        raise ValueError("this file has no readable video stream")

    done: list[str] = []
    on_progress("perception", 0.0, f"Decoding {info.width}x{info.height} at {info.fps:.2f} fps")

    # --- Part A: one sampled decoding pass -------------------------------------
    lamps: list[LampCrops] = []
    background: list[np.ndarray] = []
    spread = max(1, info.n_frames // 3 // ALIGN_FRAMES)
    results: dict[int, np.ndarray] = {}
    buf_idx: list[int] = []
    buf_img: list[np.ndarray] = []
    n_boxes = 0
    expected = max(info.n_frames / 3, 1)

    def flush() -> None:
        nonlocal n_boxes
        if not buf_img:
            return
        for idx, det in zip(buf_idx, eng.detector(buf_img, info.width / DETECT_SIZE[0])):
            results[idx] = det
            n_boxes += len(det)
        buf_idx.clear()
        buf_img.clear()

    for idx, img in parallel_frames(info, DETECT_SIZE, workers=3):
        if job.cancelled:
            raise RuntimeError("cancelled")
        if not lamps:
            lamps.append(LampCrops(eng.scene, estimate_homography(img, eng.scene.reference)[0]))
        lamps[0].add(idx, img)
        if (idx // 3) % spread == 0 and len(background) < ALIGN_FRAMES:
            background.append(img)
        buf_idx.append(idx)
        buf_img.append(img)
        if len(buf_img) == DETECT_BATCH:
            flush()
            on_progress(
                "perception",
                len(results) / expected,
                f"Detected {n_boxes:,} objects in {len(results):,} frames",
                frames=len(results),
                detections=n_boxes,
            )
    flush()
    done.append("perception")

    H = np.eye(3)
    inliers = 0
    if background:
        median = np.median(np.stack(background), axis=0).astype(np.uint8)
        H, inliers = estimate_homography(median, eng.scene.reference)
    if lamps:
        lamp_frames, lamp_scores = lamps[0].scores(eng.scene, H)
    else:
        lamp_frames, lamp_scores = np.zeros(0, int), np.zeros((0, 4), np.float32)

    on_progress("tracking", 0.2, f"Associating {n_boxes:,} detections into tracks")
    dets = Detections.from_frames(info.fps, results)
    perception = Perception(info, dets, lamp_frames, lamp_scores, H)
    table = build_tracks(perception.detections)
    trajectories = build_trajectories(table, info.width, H)
    done.append("tracking")

    on_progress("rules", 0.4, f"Applying event rules to {len(trajectories)} trajectories")
    ctx = EventContext(
        duration=info.duration,
        fps=info.fps,
        trajectories=trajectories,
        phase_t=lamp_frames / info.fps,
        phase=eb_phase(lamp_scores),
        scene=eng.scene,
        masks=eng.masks,
    )
    events = detect_all(ctx, CLASSES)
    part_a_sec = time.perf_counter() - t_start
    done.append("rules")

    # --- Part B: causal, frame by frame ----------------------------------------
    t_b = time.perf_counter()
    risk_model = RiskModel(eng.risk_detector, eng.scene, eng.masks.road)
    risk_model.reset(
        {
            "video_id": job.filename,
            "fps": info.fps,
            "width": info.width,
            "height": info.height,
            "n_frames": info.n_frames,
        }
    )
    risk: list[list[float]] = []
    cap = cv2.VideoCapture(str(job.path))
    i = 0
    while True:
        if job.cancelled:
            cap.release()
            raise RuntimeError("cancelled")
        ok, frame = cap.read()
        if not ok:
            break
        t_sec = i / info.fps
        score = float(risk_model.step(frame, t_sec))
        if i % RISK_STRIDE == 0:
            risk.append([round(t_sec, 3), round(score, 4)])
        i += 1
        if i % 150 == 0:
            on_progress("risk", i / max(info.n_frames, 1), f"Risk estimated for {i:,} frames")
    cap.release()
    part_b_sec = time.perf_counter() - t_b
    done.append("risk")

    on_progress("encoding", 0.3, "Preparing the playback copy")
    playback = _playback_copy(job, info)

    return {
        "meta": {
            "name": job.filename,
            "duration": round(info.duration, 2),
            "fps": round(info.fps, 3),
            "width": info.width,
            "height": info.height,
            "n_frames": info.n_frames,
        },
        "events": events,
        "risk": risk,
        "alignment": {"inliers": int(inliers), "aligned": bool(inliers >= 40)},
        "timings": {
            "part_a_sec": round(part_a_sec, 2),
            "part_b_sec": round(part_b_sec, 2),
            "total_sec": round(time.perf_counter() - t_start, 2),
            "budget_sec": round(3.0 * info.duration, 1),
        },
        "stats": {
            "sampled_frames": int(len(dets.frames)),
            "detections": int(n_boxes),
            "tracks": int(len(table.track_ids())),
            "trajectories": len(trajectories),
        },
        "media": {"playback": f"/api/jobs/{job.id}/media"},
        "device": eng.device,
    }


def _playback_copy(job, info: VideoInfo) -> Path:
    """A browser-safe H.264 copy. 4K/10-bit sources do not play in most browsers."""
    out = job.workdir / "playback.mp4"
    scale = f"scale={PROXY_WIDTH}:-2" if info.width > PROXY_WIDTH else "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    subprocess.run(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(job.path),
         "-vf", scale, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
         "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", str(out)],
        capture_output=True, text=True, check=False,
    )
    return out if out.exists() else job.path
