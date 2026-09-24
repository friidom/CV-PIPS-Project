"""Run the submission's perception pass over sample videos once and cache it for rule development.

    python tools/cache_perception.py --videos D:/hackaton/wiut_cv_solution/samples
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import devdata
from traffic.pipeline import Pipeline
from traffic.video import probe


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", required=True, help="folder with .mp4 files or a single file")
    ap.add_argument("--force", action="store_true", help="recompute existing caches")
    args = ap.parse_args()
    src = Path(args.videos)
    videos = [src] if src.is_file() else sorted(p for p in src.iterdir() if p.suffix.lower() == ".mp4")
    pipeline = Pipeline(devdata.ROOT)
    for path in videos:
        target = devdata.CACHE / f"{path.name}.perception.npz"
        if target.exists() and not args.force:
            print(f"[{path.name}] cached")
            continue
        info = probe(str(path))
        t0 = time.perf_counter()
        perception = pipeline.perceive(info)
        perception.save(target)
        dt = time.perf_counter() - t0
        print(f"[{path.name}] {len(perception.detections.frames)} frames, {len(perception.detections.boxes)} boxes "
              f"in {dt:.0f}s = {dt / info.duration:.2f}x duration", flush=True)


if __name__ == "__main__":
    main()
