"""One example frame per detected class, for the website's Results page.

    python scripts/build_class_examples.py

Inputs   predictions_samples.json, web/public/data/overlay/<clip>.json (the tracker boxes and
         the evidence each rule fired on, written by build_site_data.py),
         web/public/media/samples/<clip>_720p.mp4, web/public/data/dev-eval.json (optional)
Outputs  web/public/media/examples/<class>.jpg, web/public/data/examples.json

The example of a class is a segment our dev labels confirm when there is one, otherwise the
segment of median length (sub-second ones only as a last resort). Its frame is the one inside
the segment where the most boxes are that rule's evidence; boxes are drawn from the overlay the
way tools/render_video.py draws them, so the picture always matches the current rules.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from render_video import CLASS_COLOURS, GROUP_COLOURS, fmt_time  # noqa: E402

MEDIA = ROOT / "web" / "public" / "media"
DATA = ROOT / "web" / "public" / "data"
AIM_SEC = 2.0  # among equally good frames, prefer the one this far into the segment
FONT = cv2.FONT_HERSHEY_SIMPLEX


def confirmed(dev: dict | None) -> set[tuple[str, float, float, str]]:
    """(clip, start, end, label) of every prediction the dev labels match."""
    if dev is None:
        return set()
    return {(clip, p[0], p[1], p[2]) for clip, v in dev["videos"].items() for p in v["pred"] if p[3] == "tp"}


def candidates(events: list[tuple[str, float, float]], label: str, tp: set) -> list[tuple[str, float, float]]:
    """The class's segments in order of preference: labelled true positives, then median length outwards."""
    ok = sorted((ev for ev in events if (*ev, label) in tp), key=lambda ev: ev[1] - ev[2])
    rest = sorted((ev for ev in events if (*ev, label) not in tp), key=lambda ev: ev[2] - ev[1])
    long_enough = [ev for ev in rest if ev[2] - ev[1] >= 1.0]
    short = [ev for ev in rest if ev[2] - ev[1] < 1.0]
    mid = len(long_enough) // 2
    by_median = sorted(long_enough, key=lambda ev: abs(long_enough.index(ev) - mid))
    return ok + by_median + short


def best_frame(overlay: dict, label: str, start: float, end: float) -> tuple[int, int] | None:
    """(overlay frame, evidence boxes of `label` in it) with the most such boxes inside [start, end]."""
    if label not in overlay["event_labels"]:
        return None
    code = overlay["event_labels"].index(label)
    e, offsets, t0 = overlay["e"], overlay["offsets"], overlay["t0"]
    aim = start + min(AIM_SEC, (end - start) / 2)
    best = None
    for f, t in enumerate(overlay["times"]):
        t += t0
        if not start <= t <= end:
            continue
        n = sum(1 for i in range(offsets[f], offsets[f + 1]) if e[i] == code)
        key = (n, -abs(t - aim))
        if n and (best is None or key > best[0]):
            best = (key, f)
    return None if best is None else (best[1], best[0][0])


def chip(img: np.ndarray, text: str, x: int, y: int, colour: tuple[int, int, int], scale: float = 0.55) -> int:
    """A filled label with its bottom-left at (x, y); returns its width."""
    (tw, th), _ = cv2.getTextSize(text, FONT, scale, 2)
    cv2.rectangle(img, (x, y - th - 10), (x + tw + 10, y), colour, -1)
    cv2.putText(img, text, (x + 5, y - 5), FONT, scale, (0, 0, 0), 2, cv2.LINE_AA)
    return tw + 10


def draw(frame: np.ndarray, overlay: dict, f: int, label: str, clip: str, t: float) -> np.ndarray:
    h, w = frame.shape[:2]
    labels = overlay["event_labels"]
    for i in range(overlay["offsets"][f], overlay["offsets"][f + 1]):
        cx, cy, bw, bh = (overlay[k][i] / 1000 for k in ("x", "y", "w", "h"))
        p1 = (int((cx - bw / 2) * w), int((cy - bh / 2) * h))
        p2 = (int((cx + bw / 2) * w), int((cy + bh / 2) * h))
        ev = labels[overlay["e"][i]] if overlay["e"][i] >= 0 else None
        if ev is None:
            cv2.rectangle(frame, p1, p2, GROUP_COLOURS.get(overlay["g"][i], (150, 150, 150)), 1)
            continue
        cv2.rectangle(frame, p1, p2, CLASS_COLOURS[ev], 3 if ev == label else 2)
        if ev == label:
            chip(frame, ev, p1[0], p1[1], CLASS_COLOURS[ev])
    cv2.rectangle(frame, (0, 0), (w, 38), (18, 18, 18), -1)
    cv2.putText(frame, f"{clip}  {fmt_time(t)}", (12, 26), FONT, 0.7, (235, 235, 235), 2, cv2.LINE_AA)
    chip(frame, label, 250, 31, CLASS_COLOURS[label], 0.6)
    return frame


def main() -> int:
    predictions = json.loads((ROOT / "predictions_samples.json").read_text(encoding="utf-8"))["videos"]
    dev_path = DATA / "dev-eval.json"
    tp = confirmed(json.loads(dev_path.read_text(encoding="utf-8")) if dev_path.exists() else None)

    by_class: dict[str, list[tuple[str, float, float]]] = {}
    for video, entry in predictions.items():
        for s, e, label in entry["events"]:
            by_class.setdefault(label, []).append((Path(video).stem, float(s), float(e)))

    overlays: dict[str, dict] = {}
    out_dir = MEDIA / "examples"
    out_dir.mkdir(parents=True, exist_ok=True)
    examples = []
    for label in sorted(by_class):
        for clip, s, e in candidates(by_class[label], label, tp):
            path = DATA / "overlay" / f"{clip}.json"
            proxy = MEDIA / "samples" / f"{clip}_720p.mp4"
            if not path.exists() or not proxy.exists():
                continue
            overlay = overlays.setdefault(clip, json.loads(path.read_text(encoding="utf-8")))
            found = best_frame(overlay, label, s, e)
            if found is None:
                continue
            f, n = found
            t = overlay["t0"] + overlay["times"][f]
            cap = cv2.VideoCapture(str(proxy))
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
            ok, frame = cap.read()
            cap.release()
            if not ok:
                continue
            cv2.imwrite(str(out_dir / f"{label}.jpg"), draw(frame, overlay, f, label, clip, t),
                        [cv2.IMWRITE_JPEG_QUALITY, 82])
            labelled = (clip, s, e, label) in tp
            examples.append({"class": label, "clip": clip, "start": s, "end": e, "t": round(t, 3), "boxes": n,
                             "labelled": labelled, "image": f"media/examples/{label}.jpg"})
            print(f"  {label:20s} {clip} {s:7.2f}-{e:7.2f} at {t:7.2f}, {n} evidence box(es)"
                  f"{'  (matches a dev label)' if labelled else ''}")
            break
        else:
            print(f"  {label:20s} no segment with evidence boxes in the overlays")

    path = DATA / "examples.json"
    path.write_text(json.dumps({"source": "predictions_samples.json", "examples": examples}, separators=(",", ":")),
                    encoding="utf-8")
    print(f"wrote {path.relative_to(ROOT)} ({len(examples)} classes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
