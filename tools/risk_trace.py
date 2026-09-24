"""Calibrate the Part B risk cues on the sample videos.

Records what the causal model observes (tracks + signal phase per processed frame)
once, then replays the observations through the scoring code, so cue parameters
can be tuned in seconds:

    python tools/risk_trace.py --record      # ~5 min, 1080p proxies decode fast
    python tools/risk_trace.py               # replay and print score statistics
"""
from __future__ import annotations

import argparse
import pickle
import time

import cv2
import numpy as np

import devdata
from traffic.detector import Detector
from traffic.events import SceneMasks
from traffic.risk import RiskModel

OBS = devdata.CACHE / "risk_observations.pkl"


def record(proxies: str) -> None:
    scene = devdata.scene()
    model = RiskModel(Detector(devdata.ROOT / "weights" / "yolo11s_960x544_b1.torchscript"), scene,
                      SceneMasks.build(scene).road)
    obs = {}
    for name in devdata.VIDEOS:
        cap = cv2.VideoCapture(f"{proxies}/{name.split('.')[0]}_1080p.mp4")
        fps = cap.get(cv2.CAP_PROP_FPS)
        model.reset({"video_id": name, "fps": fps})
        model.trace = []
        t0, idx = time.perf_counter(), 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            model.step(frame, idx / fps)
            idx += 1
        obs[name] = {"H": model.H, "trace": model.trace}
        print(f"{name}: {idx} frames in {time.perf_counter() - t0:.0f}s")
    OBS.write_bytes(pickle.dumps(obs))


def replay() -> dict[str, np.ndarray]:
    scene = devdata.scene()
    obs = pickle.loads(OBS.read_bytes())
    model = RiskModel(None, scene, SceneMasks.build(scene).road)
    curves = {}
    for name, o in obs.items():
        model.reset({"video_id": name})
        model.H = o["H"]
        curves[name] = np.array([(t, model.observe(tracked, t, phase)) for t, phase, tracked in o["trace"]])
        s = curves[name][:, 1]
        print(f"{name}: score p50/p90/p99/max {np.round(np.percentile(s, [50, 90, 99, 100]), 3)}; "
              f"updates >= 0.5: {(s >= 0.5).sum()}")
    return curves


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--record", action="store_true")
    ap.add_argument("--proxies", default="D:/hackaton/proxies")
    args = ap.parse_args()
    if args.record:
        record(args.proxies)
    replay()
