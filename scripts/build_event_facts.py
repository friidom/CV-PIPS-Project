"""Per-event facts for the dashboard: which tracks fired each event, and where it began.

    python scripts/build_event_facts.py

Reads only what the site already serves (samples/*.json, overlay/*.json, the 720p
proxies) plus configs/. For every Part A event it records

  tracks  - the rule's own evidence tracks (Evidence.tids, as carried by the overlay),
            numbered exactly as the player draws them;
  region  - the scene region (configs/scene.json crossing or zone, the most specific one)
            under most evidence boxes during the event's first second (the vehicle's, when
            the evidence includes one), judged by the rules' own
            ground-footprint test (failure_to_yield's >= 15% bottom-strip overlap). Lane
            lines exist only on the east-bound approach, so this is a region, never a lane;
  foot    - the median of those foot points, in reference-plate pixels;
  phase   - the east-bound signal phase at the event's start.

Foot points reach the reference plate through a homography re-estimated here with
the pipeline's own estimate_homography() on a median of proxy frames, the same
recipe as src/traffic/pipeline.py. Writes web/public/data/events.json.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from traffic.events.pedestrians import _strip_overlap  # noqa: E402  (the rules' footprint test)
from traffic.pipeline import ALIGN_FRAMES  # noqa: E402
from traffic.scene import REF_SIZE, Scene, apply_homography, estimate_homography  # noqa: E402

DATA = ROOT / "web" / "public" / "data"
MEDIA = ROOT / "web" / "public" / "media" / "samples"
CLIPS = ["C3896", "C3897", "C3902", "C3905"]
PHASES = ["UNKNOWN", "RED", "GREEN", "AMBER"]
OPENING_SEC = 1.0
MIN_OVERLAP = 0.15  # failure_to_yield's min_overlap
OTHER = "other"


def proxy_homography(path: Path, reference: np.ndarray) -> tuple[np.ndarray, int] | None:
    """Median of ALIGN_FRAMES frames spread through the clip -> reference, as Pipeline.perceive() does."""
    cap = cv2.VideoCapture(str(path))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frames = []
    for idx in np.linspace(0, max(n - 1, 0), ALIGN_FRAMES).astype(int):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
        ok, frame = cap.read()
        if ok:
            frames.append(frame)
    cap.release()
    if not frames:
        return None
    return estimate_homography(np.median(np.stack(frames), axis=0).astype(np.uint8), reference)


def region_integrals(scene: Scene) -> dict[str, np.ndarray]:
    """Integral images of each region, most specific first: the crossings, then the zones from the
    smallest (wb_near before the wb carriageway that contains it)."""
    zones = sorted(scene.zones.items(), key=lambda kv: cv2.contourArea(kv[1].astype(np.float32)))
    polys = {**scene.crosswalks, **dict(zones)}
    return {k: cv2.integral(scene.mask([p])) for k, p in polys.items()}


def regions_of(boxes: np.ndarray, integrals: dict[str, np.ndarray]) -> np.ndarray:
    """Region of each reference-frame box: the first one covering >= MIN_OVERLAP of its footprint, else the most covered."""
    names = list(integrals)
    cover = np.stack([_strip_overlap(integrals[k], boxes) for k in names], axis=1)
    hit = cover >= MIN_OVERLAP
    idx = np.where(hit.any(1), hit.argmax(1), np.where(cover.max(1) > 0, cover.argmax(1), len(names)))
    return np.asarray(names + [OTHER], object)[idx]


def event_facts(overlay: dict, events: list, H: np.ndarray, integrals: dict[str, np.ndarray]) -> list[dict]:
    times = np.asarray(overlay["times"]) + overlay["t0"]
    offsets = np.asarray(overlay["offsets"])
    ev_col, ids, group = np.asarray(overlay["e"]), np.asarray(overlay["id"]), np.asarray(overlay["g"])
    x_col, y_col, w_col, h_col = (np.asarray(overlay[k]) / 1000.0 for k in ("x", "y", "w", "h"))
    labels = overlay["event_labels"]
    out = []
    for s, e, label in events:
        li = labels.index(label) if label in labels else -2
        f0, f1 = np.searchsorted(times, s - 0.05), np.searchsorted(times, e + 0.05, side="right")
        span = np.arange(offsets[f0], offsets[f1])
        rows = span[ev_col[span] == li]
        phase = PHASES[overlay["phase"][min(f0, len(times) - 1)]]
        if not len(rows):
            out.append({"tracks": [], "region": None, "share": 0.0, "foot": None, "evidence": 0, "phase": phase})
            continue
        frame_of = np.searchsorted(offsets, rows, side="right") - 1
        opening = rows[times[frame_of] <= s + OPENING_SEC]
        pick = opening if len(opening) else rows
        # A vehicle is the subject of every rule but jaywalking; the pedestrians in a
        # failure_to_yield only qualify it, so they do not get a vote on where it happened.
        if (group[pick] == 1).any():
            pick = pick[group[pick] == 1]
        # Box corners in the 1920-wide video frame -> reference plate, as build_trajectories() maps them.
        x1, x2 = (x_col[pick] - w_col[pick] / 2) * REF_SIZE[0], (x_col[pick] + w_col[pick] / 2) * REF_SIZE[0]
        y1, y2 = (y_col[pick] - h_col[pick] / 2) * REF_SIZE[1], (y_col[pick] + h_col[pick] / 2) * REF_SIZE[1]
        corners = apply_homography(H, np.stack([np.c_[x1, y1], np.c_[x2, y1], np.c_[x2, y2], np.c_[x1, y2]], 1)
                                   .reshape(-1, 2)).reshape(-1, 4, 2)
        boxes = np.c_[corners[..., 0].min(1), corners[..., 1].min(1), corners[..., 0].max(1), corners[..., 1].max(1)]
        foot = apply_homography(H, np.c_[(x1 + x2) / 2, y2])
        region, count = Counter(regions_of(boxes, integrals).tolist()).most_common(1)[0]
        out.append({
            "tracks": sorted({int(v) for v in ids[rows]}),
            "region": region,
            "share": round(count / len(pick), 2),
            "foot": [round(float(v), 1) for v in np.median(foot, axis=0)],
            "evidence": int(len(rows)),
            "phase": phase,
        })
    return out


def main() -> int:
    scene = Scene.load(ROOT / "configs")
    integrals = region_integrals(scene)
    clips = {}
    for clip in CLIPS:
        sample, overlay = DATA / "samples" / f"{clip}.json", DATA / "overlay" / f"{clip}.json"
        proxy = MEDIA / f"{clip}_720p.mp4"
        if not (sample.exists() and overlay.exists() and proxy.exists()) or scene.reference is None:
            print(f"  {clip}: skipped, an input is missing")
            continue
        aligned = proxy_homography(proxy, scene.reference)
        if aligned is None or aligned[1] < 40:
            print(f"  {clip}: skipped, the proxy does not align to the reference plate")
            continue
        H, inliers = aligned
        facts = event_facts(json.loads(overlay.read_text()), json.loads(sample.read_text())["events"], H, integrals)
        clips[clip] = {"inliers": int(inliers), "events": facts}
        print(f"  {clip}: {len(facts)} events, {inliers} inliers, regions "
              f"{dict(Counter(f['region'] for f in facts))}")
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "regions": list(integrals) + [OTHER],
        "opening_sec": OPENING_SEC,
        "clips": clips,
    }
    (DATA / "events.json").write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {(DATA / 'events.json').relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
