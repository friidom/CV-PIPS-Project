"""Render an annotated review video: tracks, signal state, detected events (with the objects
that triggered them) and a timeline with the Part B risk curve.

    python tools/render_video.py C3896.MP4 --proxy D:/hackaton/proxies/C3896_1080p.mp4 \
        --pred predictions_samples.json --out renders/C3896_annotated.mp4

Draws on a proxy of the sample video (the 4K original works too, just slower). By default the
tracks, the evidence and the events come from re-running the tracker and the rules over the
perception cache. Without the cache, --overlay web/public/data/overlay/C3896.json draws the same
tracks and evidence from the website's overlay, with the events from --pred.
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
from traffic.scene import REF_SIZE, apply_homography, estimate_homography
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
    m, tenths = divmod(round(t * 10), 600)  # round first: 119.97 s is 02:00.0, not 01:60.0
    return f"{m:02d}:{tenths / 10:04.1f}"


def scene_lines(scene, H: np.ndarray, width: int, height: int) -> tuple[np.ndarray, list[np.ndarray]]:
    """The east-bound stop line and the crossings in output pixels; H maps the REF_SIZE frame onto the reference."""
    to_out = np.diag([width / REF_SIZE[0], height / REF_SIZE[1], 1.0]) @ np.linalg.inv(H)
    return (apply_homography(to_out, scene.stop_lines["eb"]).astype(np.int32),
            [apply_homography(to_out, poly).astype(np.int32) for poly in scene.crosswalks.values()])


class Renderer:
    """Draws one annotated frame. Subclasses say where the boxes, their events and the signal phase come from."""

    def __init__(self, name: str, width: int, height: int, duration: float, events: list,
                 lines: tuple[np.ndarray, list[np.ndarray]], risk: list | None):
        self.name, self.w, self.h = name, width, height
        self.duration, self.events = duration, events
        self.stop_line, self.crossings = lines
        self.risk = np.asarray(risk, np.float32) if risk else None
        self.tx = lambda t: int(12 + (self.w - 24) * t / self.duration)  # timeline x of a time
        self.timeline = self._timeline()

    def boxes(self, t: float) -> list[tuple[tuple[int, int], tuple[int, int], int, list[str]]]:
        """(top-left, bottom-right, tracker group, events it is evidence for) of every box on screen at t."""
        raise NotImplementedError

    def phase_at(self, t: float) -> int:
        raise NotImplementedError

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
        active = [e for e in self.events if e[0] <= t <= e[1]]
        phase = self.phase_at(t)
        # scene
        for poly in self.crossings:
            cv2.polylines(frame, [poly], True, (200, 200, 60), 1, cv2.LINE_AA)
        cv2.line(frame, tuple(self.stop_line[0]), tuple(self.stop_line[1]), PHASES.get(phase, ("", (150, 150, 150)))[1], 3, cv2.LINE_AA)
        # tracks
        for p1, p2, group, labels in self.boxes(t):
            if labels:
                cv2.rectangle(frame, p1, p2, CLASS_COLOURS[labels[0]], 4)
                y = p1[1]
                for label in labels:                # chips stacked above the box
                    col = CLASS_COLOURS[label]
                    (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
                    cv2.rectangle(frame, (p1[0], y - th - 10), (p1[0] + tw + 8, y), col, -1)
                    cv2.putText(frame, label, (p1[0] + 4, y - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2, cv2.LINE_AA)
                    y -= th + 12
            else:
                cv2.rectangle(frame, p1, p2, GROUP_COLOURS.get(group, (150, 150, 150)), 1)
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


class CacheRenderer(Renderer):
    """Tracks, evidence and events from re-running the tracker and the rules over the perception cache."""

    def __init__(self, name: str, width: int, height: int, fps: float, risk: list | None):
        info = VideoInfo(name, fps, round(devdata.DURATION[name] * fps), 3840, 2160)
        p = Perception.load(devdata.CACHE / f"{name}.perception.npz", info)
        scene = devdata.scene()
        table = build_tracks(p.detections)
        self.ctx = EventContext(info.duration, fps, build_trajectories(table, info.width, p.video_to_ref),
                                p.lamp_frames / fps, eb_phase(p.lamp_scores), scene, SceneMasks.build(scene))
        self.evidence: dict = {}
        events = detect_all(self.ctx, evidence=self.evidence)
        # tracks per sampled frame, in video pixels; box_scale takes them to output pixels
        self.fps = fps
        self.frames = np.unique(table.frame)
        rows = table.rows
        order = np.searchsorted(self.frames, rows[:, 1].astype(int))
        self.by_frame = [rows[order == k] for k in range(len(self.frames))]
        self.box_scale = width / info.width
        super().__init__(name, width, height, info.duration, events, scene_lines(scene, p.video_to_ref, width, height), risk)

    def phase_at(self, t: float) -> int:
        return int(self.ctx.phase_at(t))

    def boxes(self, t: float) -> list[tuple[tuple[int, int], tuple[int, int], int, list[str]]]:
        k = np.searchsorted(self.frames, int(round(t * self.fps)), side="right") - 1
        if k < 0:
            return []
        highlight: dict[int, list[str]] = {}   # one vehicle may commit several events at once
        for label, items in self.evidence.items():
            for ev in items:
                if ev.start <= t <= ev.end:
                    for tid in ev.tids:
                        labels = highlight.setdefault(tid, [])
                        if label not in labels:
                            labels.append(label)
        s = self.box_scale
        return [((int(x1 * s), int(y1 * s)), (int(x2 * s), int(y2 * s)),
                 int(class_group(np.array([int(cls)]))[0]), highlight.get(int(tid), []))
                for tid, _, x1, y1, x2, y2, conf, cls in self.by_frame[k]]


class OverlayRenderer(Renderer):
    """The same tracks and evidence from the website's overlay (scripts/build_site_data.py), for a
    machine without the perception cache. The overlay keeps one event per box, the first, so a box
    that is evidence for two events at once gets one chip instead of two."""

    def __init__(self, name: str, width: int, height: int, duration: float, overlay: dict, events: list,
                 H: np.ndarray, risk: list | None):
        self.times = overlay["t0"] + np.asarray(overlay["times"], float)
        self.phases = np.asarray(overlay["phase"], int)
        labels = overlay["event_labels"]
        x, y, w, h = (np.asarray(overlay[k], float) / 1000 for k in ("x", "y", "w", "h"))
        x1, x2 = ((x - w / 2) * width).astype(int), ((x + w / 2) * width).astype(int)
        y1, y2 = ((y - h / 2) * height).astype(int), ((y + h / 2) * height).astype(int)
        g, e, off = overlay["g"], overlay["e"], overlay["offsets"]
        self.by_frame = [[((x1[i], y1[i]), (x2[i], y2[i]), g[i], [labels[e[i]]] if e[i] >= 0 else [])
                          for i in range(off[f], off[f + 1])] for f in range(len(self.times))]
        super().__init__(name, width, height, duration, events, scene_lines(devdata.scene(), H, width, height), risk)

    def _frame(self, t: float) -> int:
        return int(np.searchsorted(self.times, t, side="right")) - 1

    def phase_at(self, t: float) -> int:
        return int(self.phases[max(self._frame(t), 0)]) if len(self.phases) else 0

    def boxes(self, t: float) -> list[tuple[tuple[int, int], tuple[int, int], int, list[str]]]:
        f = self._frame(t)
        return self.by_frame[f] if f >= 0 else []


def align(path: str, samples: int = 12) -> np.ndarray:
    """Homography of a clip onto the reference plate, from the median of frames spread over it."""
    cap = cv2.VideoCapture(path)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frames = []
    for i in np.linspace(0, max(n - 1, 0), samples).astype(int):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(i))
        ok, frame = cap.read()
        if ok:
            frames.append(cv2.resize(frame, REF_SIZE, interpolation=cv2.INTER_AREA))
    cap.release()
    H, inliers = estimate_homography(np.median(np.stack(frames), axis=0).astype(np.uint8), devdata.scene().reference)
    print(f"aligned {Path(path).name}: {inliers} SIFT inliers")
    return H


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", help="sample name, e.g. C3896.MP4")
    ap.add_argument("--proxy", required=True, help="video file to draw on (1080p proxy or the original)")
    ap.add_argument("--pred", help="predictions.json with the events and the Part B risk curve")
    ap.add_argument("--overlay", help="draw from this overlay JSON (web/public/data/overlay/<clip>.json) "
                                      "instead of the perception cache; needs --pred for the events")
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--seconds", type=float, help="render only the first N seconds (preview)")
    args = ap.parse_args()

    entry = {}
    if args.pred and Path(args.pred).exists():
        entry = json.loads(Path(args.pred).read_text())["videos"].get(args.video, {})
    cap = cv2.VideoCapture(args.proxy)
    fps = cap.get(cv2.CAP_PROP_FPS)
    w, h = args.width, args.width * 9 // 16
    if args.overlay:
        if "events" not in entry:
            ap.error(f"--overlay needs --pred with an entry for {args.video}")
        duration = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) / fps
        overlay = json.loads(Path(args.overlay).read_text())
        r: Renderer = OverlayRenderer(args.video, w, h, duration, overlay, entry["events"], align(args.proxy),
                                      entry.get("risk"))
    else:
        r = CacheRenderer(args.video, w, h, fps, entry.get("risk"))
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
