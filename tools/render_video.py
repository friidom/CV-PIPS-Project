"""Render an annotated review video: tracks, signal state, detected events (with the objects
that triggered them) and a timeline with the Part B risk curve.

    python tools/render_video.py C3896.MP4 --proxy D:/hackaton/proxies/C3896_1080p.mp4 \
        --pred predictions_samples.json --out renders/C3896_annotated.mp4

Draws on a 1080p proxy of the sample video (the 4K original works too, just slower).
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np

import devdata
from traffic.events import EventContext, SceneMasks, detect_all
from traffic.pipeline import Perception
from traffic.scene import REF_SIZE, apply_homography
from traffic.signals import AMBER, GREEN, RED, eb_phase
from traffic.tracker import class_group
from traffic.tracks import build_tracks
from traffic.trajectories import build_trajectories
from traffic.video import VideoInfo

CLASS_COLOURS = {  # BGR, same hues as the labeler
    "accident": (79, 77, 255), "near_miss": (110, 156, 255), "red_light": (45, 34, 245), "wrong_way": (150, 47, 235),
    "illegal_u_turn": (222, 84, 146), "stopped_vehicle": (20, 219, 250), "jaywalking": (201, 207, 54),
    "failure_to_yield": (255, 169, 64), "illegal_turn": (247, 126, 89), "solid_line_crossing": (61, 209, 115),
    "stop_line": (61, 197, 255), "congestion": (6, 136, 212), "road_obstacle": (140, 140, 140), "fire_smoke": (69, 122, 255),
}
GROUP_COLOURS = {0: (0, 190, 255), 1: (120, 220, 120), 2: (255, 170, 60), 3: (230, 120, 230)}
PHASES = {RED: ("RED", (40, 40, 240)), AMBER: ("AMBER", (0, 190, 255)), GREEN: ("GREEN", (60, 200, 60))}
FOOT_H = 150


def fmt_time(t: float) -> str:
    return f"{int(t // 60):02d}:{t % 60:04.1f}"


class Renderer:
    def __init__(self, name: str, width: int, height: int, fps: float, risk: list | None):
        self.name, self.w, self.h, self.fps = name, width, height, fps
        info = VideoInfo(name, fps, round(devdata.DURATION[name] * fps), 3840, 2160)
        p = Perception.load(devdata.CACHE / f"{name}.perception.npz", info)
        scene = devdata.scene()
        table = build_tracks(p.detections)
        ctx = EventContext(info.duration, fps, build_trajectories(table, info.width, p.video_to_ref),
                           p.lamp_frames / fps, eb_phase(p.lamp_scores), scene, SceneMasks.build(scene))
        self.evidence: dict = {}
        self.events = detect_all(ctx, evidence=self.evidence)
        self.ctx, self.duration = ctx, info.duration
        # tracks per sampled frame, in output pixels
        scale = width / info.width
        self.frames = np.unique(table.frame)
        rows = table.rows
        order = np.searchsorted(self.frames, rows[:, 1].astype(int))
        self.by_frame = [rows[order == k] for k in range(len(self.frames))]
        self.box_scale = scale
        to_out = np.diag([width / REF_SIZE[0], height / REF_SIZE[1], 1.0]) @ np.linalg.inv(p.video_to_ref)
        self.stop_line = apply_homography(to_out, scene.stop_lines["eb"]).astype(np.int32)
        self.crossings = [apply_homography(to_out, poly).astype(np.int32) for poly in scene.crosswalks.values()]
        self.risk = np.asarray(risk, np.float32) if risk else None
        self.tx = lambda t: int(12 + (self.w - 24) * t / self.duration)  # timeline x of a time
        self.timeline = self._timeline()

    def _timeline(self) -> np.ndarray:
        """Static footer: one lane per predicted class + the risk curve."""
        img = np.full((FOOT_H, self.w, 3), 18, np.uint8)
        labels = sorted({e[2] for e in self.events}, key=list(CLASS_COLOURS).index)
        lane_h = max(8, min(18, (FOOT_H - 55) // max(1, len(labels))))
        x = self.tx
        for i, lab in enumerate(labels):
            y = 8 + i * lane_h
            cv2.putText(img, lab, (x(0) + 2, y + lane_h - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (150, 150, 150), 1, cv2.LINE_AA)
            for s, e, l2 in self.events:
                if l2 == lab:
                    cv2.rectangle(img, (x(s), y + 2), (max(x(e), x(s) + 2), y + lane_h - 2), CLASS_COLOURS[lab], -1)
        base = FOOT_H - 8
        cv2.line(img, (x(0), base), (x(self.duration), base), (70, 70, 70), 1)
        cv2.line(img, (x(0), base - 40), (x(self.duration), base - 40), (50, 50, 90), 1)  # alarm threshold 0.5
        if self.risk is not None and len(self.risk):
            pts = np.stack([[x(t) for t in self.risk[:, 0]], base - 80 * self.risk[:, 1]], 1).astype(np.int32)
            cv2.polylines(img, [pts], False, (80, 80, 255), 1, cv2.LINE_AA)
        cv2.putText(img, "risk", (x(0) + 2, base - 44), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (120, 120, 200), 1, cv2.LINE_AA)
        return img

    def draw(self, frame: np.ndarray, t: float) -> np.ndarray:
        k = np.searchsorted(self.frames, int(round(t * self.fps)), side="right") - 1
        active = [e for e in self.events if e[0] <= t <= e[1]]
        highlight: dict[int, str] = {}
        for label, items in self.evidence.items():
            for ev in items:
                if ev.start <= t <= ev.end:
                    for tid in ev.tids:
                        highlight.setdefault(tid, label)
        phase = int(self.ctx.phase_at(t))
        # scene
        for poly in self.crossings:
            cv2.polylines(frame, [poly], True, (200, 200, 60), 1, cv2.LINE_AA)
        cv2.line(frame, tuple(self.stop_line[0]), tuple(self.stop_line[1]), PHASES.get(phase, ("", (150, 150, 150)))[1], 3, cv2.LINE_AA)
        # tracks
        if k >= 0:
            for tid, _, x1, y1, x2, y2, conf, cls in self.by_frame[k]:
                p1 = (int(x1 * self.box_scale), int(y1 * self.box_scale))
                p2 = (int(x2 * self.box_scale), int(y2 * self.box_scale))
                label = highlight.get(int(tid))
                if label:
                    col = CLASS_COLOURS[label]
                    cv2.rectangle(frame, p1, p2, col, 4)
                    (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
                    cv2.rectangle(frame, (p1[0], p1[1] - th - 10), (p1[0] + tw + 8, p1[1]), col, -1)
                    cv2.putText(frame, label, (p1[0] + 4, p1[1] - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2, cv2.LINE_AA)
                else:
                    cv2.rectangle(frame, p1, p2, GROUP_COLOURS[int(class_group(np.array([int(cls)]))[0])], 1)
        # header
        cv2.rectangle(frame, (0, 0), (self.w, 44), (18, 18, 18), -1)
        cv2.putText(frame, f"{self.name}  {fmt_time(t)}", (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (235, 235, 235), 2, cv2.LINE_AA)
        name, col = PHASES.get(phase, ("?", (150, 150, 150)))
        cv2.putText(frame, "EB signal", (300, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (170, 170, 170), 1, cv2.LINE_AA)
        cv2.circle(frame, (405, 23), 10, col, -1)
        cv2.putText(frame, name, (422, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2, cv2.LINE_AA)
        x = 540
        for label in dict.fromkeys(e[2] for e in active):
            (tw, _), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
            cv2.rectangle(frame, (x, 8), (x + tw + 16, 38), CLASS_COLOURS[label], -1)
            cv2.putText(frame, label, (x + 8, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2, cv2.LINE_AA)
            x += tw + 26
        if self.risk is not None and len(self.risk):
            r = float(self.risk[min(np.searchsorted(self.risk[:, 0], t), len(self.risk) - 1), 1])
            cv2.putText(frame, f"risk {r:.2f}", (self.w - 160, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                        (80, 80, 255) if r >= 0.5 else (200, 200, 200), 2, cv2.LINE_AA)
        # footer
        foot = self.timeline.copy()
        cv2.line(foot, (self.tx(t), 0), (self.tx(t), FOOT_H), (255, 255, 255), 1)
        return np.vstack([frame, foot])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", help="sample name, e.g. C3896.MP4")
    ap.add_argument("--proxy", required=True, help="video file to draw on (1080p proxy or the original)")
    ap.add_argument("--pred", help="predictions.json with the Part B risk curve (optional)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--seconds", type=float, help="render only the first N seconds (preview)")
    args = ap.parse_args()

    risk = None
    if args.pred and Path(args.pred).exists():
        risk = json.loads(Path(args.pred).read_text())["videos"].get(args.video, {}).get("risk")
    cap = cv2.VideoCapture(args.proxy)
    fps = cap.get(cv2.CAP_PROP_FPS)
    w, h = args.width, args.width * 9 // 16
    r = Renderer(args.video, w, h, fps, risk)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    ff = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo",
                           "-pix_fmt", "bgr24", "-s", f"{w}x{h + FOOT_H}", "-r", f"{fps}", "-i", "-",
                           "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
                           "-movflags", "+faststart", args.out], stdin=subprocess.PIPE)
    idx = 0
    last = int(args.seconds * fps) if args.seconds else None
    while last is None or idx < last:
        ok, frame = cap.read()
        if not ok:
            break
        if frame.shape[1] != w:
            frame = cv2.resize(frame, (w, h), interpolation=cv2.INTER_AREA)
        ff.stdin.write(r.draw(frame, idx / fps).tobytes())
        idx += 1
    ff.stdin.close()
    ff.wait()
    print(f"wrote {args.out} ({idx} frames, {len(r.events)} events)")


if __name__ == "__main__":
    main()
