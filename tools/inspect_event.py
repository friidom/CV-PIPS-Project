"""Render a 2x2 contact sheet of an event for quick visual review (reference-frame coordinates).

    python tools/inspect_event.py C3896.MP4 78.9 86.9 out.jpg [--proxies D:/hackaton/proxies]
"""
from __future__ import annotations

import argparse

import cv2
import numpy as np

import devdata
from traffic.signals import AMBER, GREEN, RED

PHASE_NAME = {RED: ("RED", (0, 0, 255)), AMBER: ("AMBER", (0, 200, 255)), GREEN: ("GREEN", (0, 220, 0))}
GROUP_COLOUR = {0: (0, 200, 255), 1: (80, 255, 80), 2: (255, 160, 0), 3: (255, 0, 255)}


def render(video: str, start: float, end: float, proxies: str, focus: list[int] | None = None) -> np.ndarray:
    d = devdata.load(video)
    sc = devdata.scene()
    H = np.load(devdata.CACHE / f"{video}.align.npy")
    cap = cv2.VideoCapture(f"{proxies}/{video.split('.')[0]}_1080p.mp4")
    times = [max(0.0, start - 0.5), start, (start + end) / 2, end]
    tiles = []
    for t in times:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(t * 29.97)))
        ok, frame = cap.read()
        if not ok:
            frame = np.zeros((1080, 1920, 3), np.uint8)
        img = cv2.warpPerspective(frame, H, (1920, 1080))
        for poly in sc.crosswalks.values():
            cv2.polylines(img, [poly.astype(np.int32)], True, (255, 255, 0), 1)
        a, b = sc.stop_lines["eb"].astype(int)
        cv2.line(img, tuple(a), tuple(b), (0, 0, 255), 2)
        for tr in d.trajectories:
            if not (tr.t[0] - 0.05 <= t <= tr.t[-1] + 0.05):
                continue
            i = int(np.argmin(np.abs(tr.t - t)))
            if abs(tr.t[i] - t) > 0.25:
                continue
            x1, y1, x2, y2 = tr.box[i].astype(int)
            col = GROUP_COLOUR.get(tr.group, (255, 255, 255))
            thick = 4 if focus and tr.tid in focus else 2
            cv2.rectangle(img, (x1, y1), (x2, y2), col, thick)
            cv2.putText(img, str(tr.tid), (x1, y1 - 4), 0, 0.6, col, 2)
            past = (tr.t >= t - 3) & (tr.t <= t)
            cv2.polylines(img, [tr.foot[past].astype(np.int32)], False, col, 2)
        name, col = PHASE_NAME.get(int(d.phase[np.clip(np.searchsorted(d.phase_t, t) - 1, 0, len(d.phase) - 1)]), ("?", (200, 200, 200)))
        cv2.rectangle(img, (0, 0), (560, 50), (0, 0, 0), -1)
        cv2.putText(img, f"{video} t={t:.1f}s  EB {name}", (10, 36), 0, 1.0, col, 2)
        tiles.append(cv2.resize(img, (960, 540), interpolation=cv2.INTER_AREA))
    return np.vstack([np.hstack(tiles[:2]), np.hstack(tiles[2:])])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("start", type=float)
    ap.add_argument("end", type=float)
    ap.add_argument("out")
    ap.add_argument("--proxies", default="D:/hackaton/proxies")
    ap.add_argument("--focus", type=int, nargs="*")
    args = ap.parse_args()
    cv2.imwrite(args.out, render(args.video, args.start, args.end, args.proxies, args.focus), [cv2.IMWRITE_JPEG_QUALITY, 85])


if __name__ == "__main__":
    main()
