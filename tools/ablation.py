"""Pipeline / efficiency ablation of Part A on one clip: detector, frame sampling, tracking.

    python tools/ablation.py --video web/public/media/samples/C3905_720p.mp4 --seconds 60

Every configuration runs the real code end to end (decode -> detector -> tracker ->
alignment + signal phase -> the event rules) and every number written is measured on
this machine. There are no labels, so nothing here is accuracy: a run reports what
it *outputs* and how many of the baseline run's events it reproduces (the official
greedy temporal-IoU matcher from evaluate.py at tIoU >= 0.5), which is agreement
between configurations, not correctness.

Writes web/public/data/ablation.json for the website.
"""
from __future__ import annotations

import argparse
import json
import platform
import subprocess
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch

import devdata
from evaluate import match_segments, segs
from solution import CLASSES
from traffic.detector import Detector
from traffic.events import EventContext, SceneMasks, detect_all
from traffic.perception import DETECT_SIZE, Detections
from traffic.pipeline import ALIGN_FRAMES
from traffic.scene import estimate_homography
from traffic.signals import LampCrops, eb_phase
from traffic.tracks import TrackTable, build_tracks
from traffic.trajectories import build_trajectories
from traffic.video import iter_frames, probe

DETECTORS = {
    "A": ("YOLO11m 1280x736", "yolo11m_1280x736_b16.torchscript"),
    "B": ("YOLO11s 960x544", "yolo11s_960x544_b1.torchscript"),
}
STEPS = (3, 6, 15)  # every 3rd frame is what the submission samples (~10 fps); then 5 fps and 2 fps
BASELINE = "A3"
MATCH_IOU = 0.5
OUT = devdata.ROOT / "web" / "public" / "data" / "ablation.json"


def perceive(info, detector: Detector, step: int, n_frames: int, scene) -> tuple:
    """Pipeline.perceive() at a chosen sampling step: every `step`-th frame, exactly."""
    lamps, background, results = None, [], {}
    spread = max(1, n_frames // step // ALIGN_FRAMES)
    scale = info.width / DETECT_SIZE[0]
    buf_idx, buf_img = [], []

    def flush() -> None:
        for idx, det in zip(buf_idx, detector(buf_img, scale)):
            results[idx] = det
        buf_idx.clear()
        buf_img.clear()

    # reference_only=False: the proxy's GOP is not the camera's, so sample by index instead.
    for k, (idx, img) in enumerate(iter_frames(info.path, DETECT_SIZE, stop=n_frames, min_step=step,
                                               reference_only=False)):
        if lamps is None:
            lamps = LampCrops(scene, estimate_homography(img, scene.reference)[0])
        lamps.add(idx, img)
        if k % spread == 0 and len(background) < ALIGN_FRAMES:
            background.append(img)
        buf_idx.append(idx)
        buf_img.append(img)
        if len(buf_img) == 16:
            flush()
    if buf_img:
        flush()
    H, inliers = estimate_homography(np.median(np.stack(background), axis=0).astype(np.uint8), scene.reference)
    lamp_frames, lamp_scores = lamps.scores(scene, H)
    return Detections.from_frames(info.fps, results), H, inliers, lamp_frames, lamp_scores


def untracked(dets: Detections) -> TrackTable:
    """Tracking OFF: every detection is its own one-observation track, i.e. no identity over time."""
    rows = np.column_stack([np.arange(1, len(dets.boxes) + 1), dets.frames[dets.frame_of], dets.boxes[:, :6]])
    return TrackTable(dets.fps, rows.reshape(-1, 8).astype(np.float64))


def evaluate_run(run_id: str, dets: Detections, track: bool, ctx_args: tuple, perception_sec: float) -> dict:
    duration, fps, H, width, lamp_frames, lamp_scores, scene, masks = ctx_args
    t0 = time.perf_counter()
    table = build_tracks(dets) if track else untracked(dets)
    trajectories = build_trajectories(table, width, H)
    t1 = time.perf_counter()
    ctx = EventContext(duration, fps, trajectories, lamp_frames / fps, eb_phase(lamp_scores), scene, masks)
    events = detect_all(ctx, CLASSES)
    t2 = time.perf_counter()
    return {
        "id": run_id,
        "frames": int(len(dets.frames)),
        "detections": int(len(dets.boxes)),
        "tracks": int(len(table.track_ids())),
        "trajectories": len(trajectories),
        "events": events,
        "by_class": dict(Counter(e[2] for e in events)),
        "seconds": {
            "perception": round(perception_sec, 2),
            "tracking": round(t1 - t0, 3),
            "rules": round(t2 - t1, 3),
            "total": round(perception_sec + t2 - t0, 2),
        },
    }


def shared(reference: list, events: list) -> int:
    """Reference events reproduced by `events`: same class, greedy one-to-one at tIoU >= MATCH_IOU."""
    return sum(match_segments(segs(reference, c), segs(events, c), MATCH_IOU)[0] for c in CLASSES)


def cpu_name() -> str:
    try:
        return subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True,
                              check=True).stdout.strip()
    except Exception:
        return platform.processor() or platform.machine()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--seconds", type=float, default=0.0, help="analyse only the first N seconds (0 = whole clip)")
    ap.add_argument("--device", default=None, help="torch device; default cuda if available, else cpu")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()

    info = probe(args.video)
    n_frames = info.n_frames if args.seconds <= 0 else min(info.n_frames, round(args.seconds * info.fps))
    duration = n_frames / info.fps
    scene = devdata.scene()
    masks = SceneMasks.build(scene)
    runs, perceptions = [], {}

    for key, (name, weights) in DETECTORS.items():
        detector = Detector(devdata.ROOT / "weights" / weights, device=args.device)  # load + warm-up not timed
        for step in STEPS:
            t0 = time.perf_counter()
            dets, H, inliers, lamp_frames, lamp_scores = perceive(info, detector, step, n_frames, scene)
            perception_sec = time.perf_counter() - t0
            ctx_args = (duration, info.fps, H, info.width, lamp_frames, lamp_scores, scene, masks)
            run = evaluate_run(f"{key}{step}", dets, True, ctx_args, perception_sec)
            run.update(detector=name, step=step, fps=round(info.fps / step, 2), tracking=True, inliers=int(inliers))
            runs.append(run)
            perceptions[run["id"]] = (dets, ctx_args, perception_sec)
            print(f"{run['id']}: {run['frames']} frames, {run['detections']} boxes, {run['tracks']} tracks, "
                  f"{len(run['events'])} events, {run['seconds']['total']} s", flush=True)

    # Tracking OFF reuses the baseline's detections: the detector stage is identical and shared.
    dets, ctx_args, perception_sec = perceptions[BASELINE]
    base = next(r for r in runs if r["id"] == BASELINE)
    run = evaluate_run(f"{BASELINE}-notrack", dets, False, ctx_args, perception_sec)
    run.update(detector=base["detector"], step=base["step"], fps=base["fps"], tracking=False,
               inliers=base["inliers"], perception_shared_with=BASELINE)
    runs.append(run)
    print(f"{run['id']}: {run['trajectories']} trajectories, {len(run['events'])} events", flush=True)

    stem = Path(args.video).stem.split("_")[0]
    official = []
    sample = devdata.ROOT / "web" / "public" / "data" / "samples" / f"{stem}.json"
    if sample.exists():
        official = [[s, min(e, round(duration, 2)), lab] for s, e, lab in json.loads(sample.read_text())["events"]
                    if s < duration]
    for r in runs:
        r["shared_with_baseline"] = shared(base["events"], r["events"])
        r["shared_with_submission"] = shared(official, r["events"]) if official else None

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "command": f"python tools/ablation.py --video {args.video} --seconds {args.seconds:g}",
        "machine": {"cpu": cpu_name(), "device": str(torch.device(args.device or ("cuda:0" if torch.cuda.is_available() else "cpu"))),
                    "torch": torch.__version__, "threads": torch.get_num_threads()},
        "input": {"video": Path(args.video).name, "clip": stem, "seconds": round(duration, 2), "fps": round(info.fps, 3),
                  "width": info.width, "height": info.height},
        "baseline": BASELINE,
        "match_iou": MATCH_IOU,
        "submission": {"events": official, "by_class": dict(Counter(e[2] for e in official))} if official else None,
        "runs": runs,
    }
    Path(args.out).write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print("wrote", args.out)


if __name__ == "__main__":
    main()
