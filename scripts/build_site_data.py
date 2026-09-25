"""Turn the repository's real artifacts into the JSON the website reads.

    python scripts/build_site_data.py

Reads only files that exist; every output records what it came from and every
missing input is reported in manifest.json instead of being filled in. Nothing
here computes a metric the repository cannot back up.

Inputs   configs/scene.json, configs/flow_field.npz, configs/reference.jpg,
         predictions_samples.json, cache/<video>.perception.npz
Outputs  web/public/data/**.json, web/public/media/reference.jpg
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from traffic.scene import REF_SIZE  # noqa: E402
from traffic.signals import AMBER, GREEN, RED, UNKNOWN, eb_phase  # noqa: E402
from traffic.tracker import GROUP_PERSON, GROUP_TWO_WHEELER, GROUP_VEHICLE, class_group  # noqa: E402

OUT = ROOT / "web" / "public" / "data"
MEDIA = ROOT / "web" / "public" / "media"
CACHE = ROOT / "cache"

# Sample clips the organizers provided, with the durations recorded in tools/devdata.py.
SAMPLES = {
    "C3896.MP4": 10200 / 29.97,
    "C3897.MP4": 9525 / 29.97,
    "C3902.MP4": 9525 / 29.97,
    "C3905.MP4": 3825 / 29.97,
}
FPS = 30000 / 1001
RISK_TARGET_POINTS = 1400


def write(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"  wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1024:.1f} kB)")


def git_commit() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
    except Exception:
        return "unknown"


def build_scene() -> dict:
    cfg = json.loads((ROOT / "configs" / "scene.json").read_text(encoding="utf-8"))
    polys = lambda d: [{"name": k, "points": v} for k, v in d.items()]  # noqa: E731
    return {
        "size": cfg["size"],
        "reference": "media/reference.jpg",
        "stop_lines": polys(cfg["stop_lines"]),
        "crosswalks": polys(cfg["crosswalks"]),
        "islands": polys(cfg["islands"]),
        "sidewalks": polys(cfg["sidewalks"]),
        "zones": polys(cfg["zones"]),
        "lane_lines": [
            {"name": f"{approach}{i + 1}", "points": seg}
            for approach, segs in cfg.get("lane_lines", {}).items()
            for i, seg in enumerate(segs)
        ],
        "signals": [
            {
                "name": head,
                "lamps": [
                    {"name": k, "x": v[0], "y": v[1], "r": spec.get("radius", 5)}
                    for k, v in spec.items()
                    if isinstance(v, list)
                ],
            }
            for head, spec in cfg["signals"].items()
        ],
    }


def build_flow_field() -> dict:
    z = np.load(ROOT / "configs" / "flow_field.npz")
    cell = int(z["cell"])
    n = z["n"].astype(np.int64)
    mean = np.stack([z["sx"], z["sy"]], -1) / np.maximum(n, 1)[..., None]
    consistency = np.linalg.norm(mean, axis=-1)
    unit = mean / np.maximum(consistency, 1e-6)[..., None]
    # Thresholds the wrong-way rule uses (src/traffic/events/maneuvers.py).
    min_count, min_consistency = 40, 0.85
    one_way = int(((consistency >= min_consistency) & (n >= min_count)).sum())
    r3 = lambda a: np.round(a, 3).tolist()  # noqa: E731
    return {
        "cell": cell,
        "width": REF_SIZE[0],
        "height": REF_SIZE[1],
        "dx": r3(unit[..., 0]),
        "dy": r3(unit[..., 1]),
        "consistency": r3(consistency),
        "count": n.tolist(),
        "total_samples": int(n.sum()),
        "cells_with_data": int((n > 0).sum()),
        "cells_one_way": one_way,
        "min_count": min_count,
        "min_consistency": min_consistency,
    }


def decimate_risk(risk: list[list[float]]) -> tuple[list[list[float]], int]:
    """Thin a per-frame curve for the browser, keeping the max of each bucket.

    Taking the maximum rather than a sample means an alarm spike can never be
    decimated away, so the drawn curve still crosses the threshold where the
    real one does.
    """
    if len(risk) <= RISK_TARGET_POINTS:
        return [[round(t, 3), round(s, 4)] for t, s in risk], 1
    stride = int(np.ceil(len(risk) / RISK_TARGET_POINTS))
    out = []
    for i in range(0, len(risk), stride):
        chunk = risk[i : i + stride]
        best = max(chunk, key=lambda p: p[1])
        out.append([round(chunk[0][0], 3), round(best[1], 4)])
    return out, stride


def load_perception(name: str):
    path = CACHE / f"{name}.perception.npz"
    if not path.exists():
        return None
    z = np.load(path)
    return {
        "fps": float(z["fps"]),
        "frames": z["frames"],
        "frame_of": z["frame_of"],
        "boxes": z["boxes"],
        "lamp_frames": z["lamp_frames"],
        "lamp_scores": z["lamp_scores"],
        "H": z["H"],
    }


def build_density(name: str, p: dict, duration: float) -> dict:
    """Per-second counts of detected road users by group, plus concurrent tracks."""
    from traffic.perception import Detections
    from traffic.tracks import build_tracks

    frames, boxes, frame_of = p["frames"], p["boxes"], p["frame_of"]
    t_of_box = frames[frame_of] / p["fps"]
    groups = class_group(boxes[:, 5].astype(int))
    n_bins = int(np.ceil(duration)) + 1
    bins = np.arange(n_bins, dtype=float)
    # Detections are sampled ~every 3rd frame, so a per-second sum over-counts by
    # the number of sampled frames in that second; divide by it to get a mean count.
    per_sec_frames = np.bincount(np.clip(frames / p["fps"], 0, n_bins - 1).astype(int), minlength=n_bins)
    per_sec_frames = np.maximum(per_sec_frames, 1)

    def series(mask: np.ndarray) -> list[float]:
        idx = np.clip(t_of_box[mask], 0, n_bins - 1).astype(int)
        return np.round(np.bincount(idx, minlength=n_bins) / per_sec_frames, 2).tolist()

    dets = Detections(p["fps"], frames, frame_of, boxes)
    table = build_tracks(dets)
    track_counts = np.zeros(n_bins)
    if len(table.rows):
        for tid, rows in table.split().items():  # noqa: B007
            t = rows[:, 1] / p["fps"]
            lo, hi = int(np.clip(t[0], 0, n_bins - 1)), int(np.clip(t[-1], 0, n_bins - 1))
            track_counts[lo : hi + 1] += 1
    return {
        "video": name,
        "t": bins.tolist(),
        "person": series(groups == GROUP_PERSON),
        "vehicle": series(groups == GROUP_VEHICLE),
        "two_wheeler": series(groups == GROUP_TWO_WHEELER),
        "tracks": track_counts.tolist(),
        "total_boxes": int(len(boxes)),
        "sampled_frames": int(len(frames)),
        "total_tracks": int(len(table.track_ids())),
    }


def build_phase(name: str, p: dict) -> dict:
    """The east-bound signal phase over time, and the runs it decomposes into."""
    from traffic.intervals import runs

    phase = eb_phase(p["lamp_scores"])
    t = (p["lamp_frames"] / p["fps"]).astype(float)
    if len(t) == 0:
        return {"video": name, "t": [], "phase": [], "cycles": []}
    cycles = [
        {"start": round(float(t[s]), 2), "end": round(float(t[e - 1]), 2), "phase": int(v)}
        for s, e, v in runs(phase)
    ]
    counts = {
        "red": sum(c["end"] - c["start"] for c in cycles if c["phase"] == RED),
        "green": sum(c["end"] - c["start"] for c in cycles if c["phase"] == GREEN),
        "amber": sum(c["end"] - c["start"] for c in cycles if c["phase"] == AMBER),
        "unknown": sum(c["end"] - c["start"] for c in cycles if c["phase"] == UNKNOWN),
    }
    # Red onset to red onset = one full signal cycle.
    red_starts = [c["start"] for c in cycles if c["phase"] == RED]
    periods = [round(b - a, 1) for a, b in zip(red_starts, red_starts[1:])]
    return {
        "video": name,
        "t": np.round(t, 2).tolist(),
        "phase": phase.astype(int).tolist(),
        "cycles": cycles,
        "seconds_by_phase": {k: round(v, 1) for k, v in counts.items()},
        "cycle_periods": periods,
    }


REPLAY_SECONDS = 26.0


def evidence_spans(p: dict, duration: float) -> list[tuple[float, float, str, tuple[int, ...]]]:
    """(start, end, label, track ids) for everything the event rules fired on.

    This is the same `detect_all(ctx, evidence=...)` call tools/render_video.py
    makes, so the website can colour exactly the objects the offline renderer
    colours. It re-runs the rules over the cached perception; it does not
    re-detect and does not change what the rules decide.
    """
    from traffic.events import EventContext, SceneMasks, detect_all
    from traffic.perception import Detections
    from traffic.scene import Scene
    from traffic.tracks import build_tracks
    from traffic.trajectories import build_trajectories

    fps = p["fps"]
    table = build_tracks(Detections(fps, p["frames"], p["frame_of"], p["boxes"]))
    scene = Scene.load(ROOT / "configs")
    ctx = EventContext(
        duration,
        fps,
        build_trajectories(table, 3840, p["H"]),
        p["lamp_frames"] / fps,
        eb_phase(p["lamp_scores"]),
        scene,
        SceneMasks.build(scene),
    )
    found: dict[str, list] = {}
    detect_all(ctx, evidence=found)
    return [
        (float(e.start), float(e.end), label, tuple(int(t) for t in e.tids))
        for label, items in found.items()
        for e in items
    ]


def build_overlay(name: str, p: dict, t0: float, span: float, events: list, space: str,
                  spans: list | None = None, table=None,
                  frame: tuple[float, float] = (3840.0, 2160.0)) -> dict | None:
    """Real tracked objects over a time window, as compact per-frame arrays.

    Every box here is a YOLO11m detection the tracker kept, carrying the id the
    tracker gave it — the website draws these rather than inventing particles.
    No box is dropped: an earlier display cap made the drawn set churn between
    frames, because it re-picked the most confident N independently each frame.

    `space` picks the coordinate frame: "ref" maps video pixels -> REF_SIZE ->
    reference plate with the clip's own homography, so boxes land on
    configs/reference.jpg exactly where the geometric rules see them; "video"
    keeps normalised source-frame coordinates, which is what an overlay drawn on
    top of the clip's own proxy needs.

    `spans` carries evidence_spans(); each box gets the index of the event it is
    evidence for, or -1. First label wins, matching render_video.py's setdefault.

    `table` reuses tracks the caller already built (the live demo) instead of
    re-running the tracker; `frame` is the pixel frame the boxes are in — the
    sample clips are 4K, an upload is whatever it was recorded at.
    """
    from traffic.perception import Detections
    from traffic.scene import apply_homography
    from traffic.tracks import build_tracks

    if table is None:
        table = build_tracks(Detections(p["fps"], p["frames"], p["frame_of"], p["boxes"]))
    if not len(table.rows):
        return None
    rows, fps = table.rows, p["fps"]
    t_all = rows[:, 1] / fps
    win = rows[(t_all >= t0) & (t_all < t0 + span)]
    if not len(win):
        return None

    sx, sy = REF_SIZE[0] / frame[0], REF_SIZE[1] / frame[1]
    cx = (win[:, 2] + win[:, 4]) * 0.5
    cy = (win[:, 3] + win[:, 5]) * 0.5
    w, h = win[:, 4] - win[:, 2], win[:, 5] - win[:, 3]
    if space == "ref":
        ctr = apply_homography(p["H"], np.stack([cx * sx, cy * sy], 1))
        cx, cy, w, h = ctr[:, 0], ctr[:, 1], w * sx, h * sy
        fw, fh = float(REF_SIZE[0]), float(REF_SIZE[1])
    else:
        fw, fh = frame

    q = lambda a, s: np.clip(np.round(a / s * 1000.0), -200, 1200).astype(int)  # noqa: E731
    qx, qy, qw, qh = q(cx, fw), q(cy, fh), q(w, fw), q(h, fh)
    groups = class_group(win[:, 7].astype(int))
    # Track ids are renumbered from 1 within the window: the raw ids index a
    # several-hundred-track table and would read as noise on screen.
    ids = win[:, 0].astype(np.int64)
    remap = {int(v): i + 1 for i, v in enumerate(np.unique(ids))}

    spans = spans or []
    labels: list[str] = []
    for _, _, label, _ in spans:
        if label not in labels:
            labels.append(label)

    frame_col = win[:, 1].astype(np.int64)
    times, offsets, counts = [], [0], []
    out = {"id": [], "g": [], "e": [], "x": [], "y": [], "w": [], "h": []}
    for f in np.unique(frame_col):
        idx = np.flatnonzero(frame_col == f)
        counts.append(int(len(idx)))
        t_abs = float(f / fps)
        # Which raw track ids are evidence for an event at this instant.
        flagged: dict[int, int] = {}
        for s, e, label, tids in spans:
            if s <= t_abs <= e:
                for tid in tids:
                    flagged.setdefault(tid, labels.index(label))
        times.append(round(t_abs - t0, 3))
        for i in idx:
            raw = int(ids[i])
            out["id"].append(remap[raw])
            out["g"].append(int(groups[i]))
            out["e"].append(flagged.get(raw, -1))
            out["x"].append(int(qx[i]))
            out["y"].append(int(qy[i]))
            out["w"].append(int(qw[i]))
            out["h"].append(int(qh[i]))
        offsets.append(len(out["id"]))

    phase = eb_phase(p["lamp_scores"])
    pt = p["lamp_frames"] / fps
    phase_at = [
        int(phase[min(int(np.searchsorted(pt, t0 + t)), len(phase) - 1)]) if len(phase) else 0
        for t in times
    ]
    return {
        "video": Path(name).stem,
        "space": space,
        "t0": round(t0, 2),
        "duration": round(span, 2),
        "ref": list(REF_SIZE),
        "times": times,
        "offsets": offsets,
        "phase": phase_at,
        "n": counts,
        "event_labels": labels,
        **out,
        "tracks": len(remap),
        "boxes": len(out["id"]),
        "events": [
            [round(max(float(s) - t0, 0.0), 2), round(min(float(e) - t0, span), 2), lab]
            for s, e, lab in events
            if float(e) > t0 and float(s) < t0 + span
        ],
        "source": f"cache/{name}.perception.npz",
    }


def pick_replay_window(p: dict, duration: float, events: list) -> float:
    """Start time of the busiest window that also contains something the system flagged."""
    from traffic.perception import Detections
    from traffic.tracks import build_tracks

    table = build_tracks(Detections(p["fps"], p["frames"], p["frame_of"], p["boxes"]))
    if not len(table.rows):
        return 0.0
    rows = table.rows
    t_all = rows[:, 1] / p["fps"]
    starts = np.arange(0.0, max(duration - REPLAY_SECONDS, 0.0) + 1e-6, 2.0)
    if not len(starts):
        return 0.0
    event_starts = [float(e[0]) for e in events]

    def score(t0: float) -> tuple[int, int]:
        m = (t_all >= t0) & (t_all < t0 + REPLAY_SECONDS)
        has_event = any(t0 <= s < t0 + REPLAY_SECONDS for s in event_starts)
        return (int(has_event), int(len(np.unique(rows[m, 0]))))

    return float(max(starts, key=score))


def build_detector_stats(p: dict) -> dict:
    """Confidence and box-size distribution of the raw detections."""
    boxes = p["boxes"]
    if len(boxes) == 0:
        return {}
    conf = boxes[:, 4]
    widths = boxes[:, 2] - boxes[:, 0]
    cls = boxes[:, 5].astype(int)
    names = {0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
    hist, edges = np.histogram(conf, bins=20, range=(0.0, 1.0))
    wh, wedges = np.histogram(widths, bins=24, range=(0.0, float(np.percentile(widths, 99))))
    return {
        "total": int(len(boxes)),
        "by_class": {names.get(int(c), str(int(c))): int((cls == c).sum()) for c in np.unique(cls)},
        "confidence": {"counts": hist.tolist(), "edges": np.round(edges, 3).tolist()},
        "box_width_px": {"counts": wh.tolist(), "edges": np.round(wedges, 1).tolist()},
        "conf_threshold": 0.15,
        "median_width_px": round(float(np.median(widths)), 1),
    }


def measure_alignment(name: str) -> dict | None:
    """Re-run the real homography estimate on the clip's first frame.

    The perception cache stores the resulting matrix but not the RANSAC inlier
    count, and that count is what tells a reader whether the geometric rules
    meant anything on this clip — so it is measured here rather than asserted.
    Costs one frame decode per sample.
    """
    import cv2

    from traffic.scene import estimate_homography

    proxy = MEDIA / "samples" / f"{Path(name).stem}_720p.mp4"
    ref = ROOT / "configs" / "reference.jpg"
    if not proxy.exists() or not ref.exists():
        return None
    cap = cv2.VideoCapture(str(proxy))
    ok, frame = cap.read()
    cap.release()
    if not ok:
        return None
    reference = cv2.imread(str(ref))
    if reference is None:
        return None
    try:
        _, inliers = estimate_homography(frame, reference)
    except Exception:
        return None
    # The 40-inlier floor is the same one src/traffic/pipeline.py falls back at.
    return {"inliers": int(inliers), "aligned": bool(inliers >= 40), "min_inliers": 40}


def media_for(name: str) -> dict:
    """Which generated media files exist for a sample, as site-relative paths."""
    stem = Path(name).stem
    out = {}
    for key, filename in (("proxy", f"{stem}_720p.mp4"), ("annotated", f"{stem}_annotated.mp4"),
                          ("poster", f"{stem}_poster.jpg")):
        path = MEDIA / "samples" / filename
        out[key] = f"media/samples/{filename}" if path.exists() else None
    return out


def main() -> int:
    print("building site data")
    OUT.mkdir(parents=True, exist_ok=True)
    MEDIA.mkdir(parents=True, exist_ok=True)

    manifest: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source_commit": git_commit(),
        "samples": {},
        "eda": {},
        "metrics": {
            "available": False,
            "reason": (
                "No dev labels exist in this repository, so Score A, Score B, per-class F1, AP and "
                "mTTA cannot be computed. evaluate.py needs a ground_truth.json; the sample clips "
                "shipped unlabelled and have not been annotated yet."
            ),
        },
    }

    ref = ROOT / "configs" / "reference.jpg"
    if ref.exists():
        shutil.copyfile(ref, MEDIA / "reference.jpg")
        print(f"  wrote {(MEDIA / 'reference.jpg').relative_to(ROOT)}")

    write(OUT / "eda" / "scene.json", build_scene())
    manifest["eda"]["scene"] = {"available": True, "reason": "configs/scene.json", "path": "eda/scene.json"}

    if (ROOT / "configs" / "flow_field.npz").exists():
        write(OUT / "eda" / "flow-field.json", build_flow_field())
        manifest["eda"]["flow_field"] = {
            "available": True,
            "reason": "configs/flow_field.npz",
            "path": "eda/flow-field.json",
        }
    else:
        manifest["eda"]["flow_field"] = {"available": False, "reason": "configs/flow_field.npz is missing"}

    pred_path = ROOT / "predictions_samples.json"
    predictions = {}
    log = {}
    if pred_path.exists() and pred_path.stat().st_size > 0:
        blob = json.loads(pred_path.read_text(encoding="utf-8"))
        predictions = blob.get("videos", {})
        log = blob.get("log", {})

    replays: dict[str, int] = {}
    for name, duration in SAMPLES.items():
        stem = Path(name).stem
        entry = predictions.get(name)
        perception = load_perception(name)
        if entry is None and perception is None:
            manifest["samples"][stem] = {
                "available": False,
                "reason": (
                    f"{name} was not processed: the clip is not in samples/ and there is no cached "
                    f"perception for it. Drop the file in and re-run run_submission.py."
                ),
            }
            continue

        risk, stride = decimate_risk(entry.get("risk", []) if entry else [])
        events = entry.get("events", []) if entry else []
        runtime = log.get(name)
        payload = {
            "id": stem,
            "meta": {
                "name": name,
                "duration": round(runtime["duration"] if runtime else duration, 2),
                "fps": FPS,
                "width": 3840,
                "height": 2160,
                "n_frames": int(round(duration * FPS)),
            },
            "events": events,
            "risk": risk,
            "risk_stride": stride,
            "runtime": runtime,
            "alignment": measure_alignment(name),
            "media": media_for(name),
            "produced_by": "run_submission.py --videos samples --out predictions_samples.json --team wiut-cv",
        }
        write(OUT / "samples" / f"{stem}.json", payload)
        manifest["samples"][stem] = {
            "available": True,
            "reason": "predictions_samples.json",
            "path": f"samples/{stem}.json",
        }

        if perception is not None:
            write(OUT / "eda" / f"density-{stem}.json", build_density(name, perception, duration))
            write(OUT / "eda" / f"phase-{stem}.json", build_phase(name, perception))
            write(OUT / "eda" / f"detector-{stem}.json", build_detector_stats(perception))
            manifest["eda"][f"density_{stem}"] = {
                "available": True,
                "reason": f"cache/{name}.perception.npz",
                "path": f"eda/density-{stem}.json",
            }
            spans = evidence_spans(perception, duration)
            t0 = pick_replay_window(perception, duration, events)
            replay = build_overlay(name, perception, t0, REPLAY_SECONDS, events, "ref", spans)
            if replay is not None:
                write(OUT / "replay" / f"{stem}.json", replay)
                replays[stem] = replay["tracks"]
                manifest["eda"][f"replay_{stem}"] = {
                    "available": True,
                    "reason": f"cache/{name}.perception.npz",
                    "path": f"replay/{stem}.json",
                }
            overlay = build_overlay(name, perception, 0.0, duration + 1.0, events, "video", spans)
            if overlay is not None:
                write(OUT / "overlay" / f"{stem}.json", overlay)
                manifest["eda"][f"overlay_{stem}"] = {
                    "available": True,
                    "reason": f"cache/{name}.perception.npz",
                    "path": f"overlay/{stem}.json",
                }

    processed = [k for k, v in manifest["samples"].items() if v["available"]]
    manifest["summary"] = {
        "samples_total": len(SAMPLES),
        "samples_processed": len(processed),
        "processed_ids": processed,
        "corpus_seconds": round(sum(SAMPLES.values()), 1),
        # The hero replays whichever clip gave the tracker the most to hold on to.
        "hero_replay": max(replays, key=replays.get) if replays else None,
    }
    write(OUT / "manifest.json", manifest)
    print(f"done: {len(processed)}/{len(SAMPLES)} samples have real results")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
