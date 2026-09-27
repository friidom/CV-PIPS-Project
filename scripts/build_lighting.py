"""Lighting of every sample clip over time, for the EDA page.

    python scripts/build_lighting.py

Inputs   web/public/media/samples/<clip>_720p.mp4 (the site's proxies of the four sample clips)
Outputs  web/public/data/eda/lighting.json

One frame per second: mean luma (BT.601 Y, 0-255), its 10th and 90th percentiles, and the share
of near-black pixels. Measured on the 8-bit proxies, so the scale is the proxy's, not the
camera's 10-bit one; the comparison between clips and over time is what matters.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "web" / "public" / "media" / "samples"
OUT = ROOT / "web" / "public" / "data" / "eda" / "lighting.json"
CLIPS = ["C3896", "C3897", "C3902", "C3905"]
DARK = 40  # luma below this counts as near-black


def measure(path: Path) -> dict:
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30000 / 1001
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    rows = []
    for second in range(int(n / fps)):
        cap.set(cv2.CAP_PROP_POS_FRAMES, round(second * fps))
        ok, frame = cap.read()
        if not ok:
            break
        y = cv2.cvtColor(cv2.resize(frame, (640, 360), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        p10, p90 = np.percentile(y, (10, 90))
        rows.append((second, float(y.mean()), float(p10), float(p90), float((y < DARK).mean())))
    cap.release()
    a = np.array(rows)
    return {
        "duration": round(n / fps, 2), "frames": n,
        "t": a[:, 0].astype(int).tolist(),
        "luma": np.round(a[:, 1], 1).tolist(), "p10": np.round(a[:, 2], 1).tolist(),
        "p90": np.round(a[:, 3], 1).tolist(), "dark": np.round(a[:, 4], 3).tolist(),
        "mean_luma": round(float(a[:, 1].mean()), 1),
        "drift": round(float(a[-10:, 1].mean() - a[:10, 1].mean()), 1),  # last 10 s against the first 10 s
    }


def main() -> int:
    clips = {}
    for clip in CLIPS:
        path = SAMPLES / f"{clip}_720p.mp4"
        if not path.exists():
            print(f"  skip {clip}: {path.relative_to(ROOT)} is missing")
            continue
        clips[clip] = measure(path)
        c = clips[clip]
        print(f"  {clip}: {c['duration']:.1f} s, mean luma {c['mean_luma']}, drift {c['drift']:+.1f}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"source": "720p proxies, 1 frame/s", "dark_below": DARK, "clips": clips},
                              separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
