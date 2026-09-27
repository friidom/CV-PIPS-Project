"""Score the submission's sample output against the team's dev labels, for the website.

    python scripts/build_dev_eval.py

Inputs   labels/dev_labels.json   ground truth in evaluate.py's format (the clips labelled so far)
         labels/review.json       labels disputed on review: still scored, also reported without
         predictions_samples.json the committed harness output
         web/public/data/ablation.json   ablation runs, scored on the same labels
Outputs  web/public/data/dev-eval.json and the "metrics" entry of web/public/data/manifest.json

Every score comes from evaluate.py's own functions. This script only adds what the metric
does not report: which event matched which, what the unmatched ones overlap instead, and
how each ablation run scores against the same labels.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from evaluate import TIOU_THRESHOLDS, evaluate, evaluate_part_a, match_segments, tiou  # noqa: E402

LABELS = ROOT / "labels" / "dev_labels.json"
REVIEW = ROOT / "labels" / "review.json"
PREDICTIONS = ROOT / "predictions_samples.json"
OUT = ROOT / "web" / "public" / "data"

STATUS_TIOU = 0.5    # the middle threshold decides TP / FP / FN on the timeline
OVERLAP_TIOU = 0.1   # confusion: the least overlap that counts as "emitted over this label"
H = 5.0              # evaluate.py's anticipation horizon, for the risk read-out before each accident


def match_pairs(gt: list[tuple[float, float]], pred: list[tuple[float, float]], thr: float) -> list[tuple[int, int]]:
    """evaluate.match_segments, returning the matched (gt, pred) index pairs instead of counts."""
    pairs = sorted(((tiou(g, p), i, j) for i, g in enumerate(gt) for j, p in enumerate(pred) if tiou(g, p) >= thr),
                   reverse=True)
    used_g, used_p, out = set(), set(), []
    for _, i, j in pairs:
        if i in used_g or j in used_p:
            continue
        used_g.add(i)
        used_p.add(j)
        out.append((i, j))
    assert len(out) == match_segments(gt, pred, thr)[0]
    return out


def timeline(gt_events: list, pred_events: list) -> tuple[list, list]:
    """Every event as [start, end, label, status at STATUS_TIOU, best same-class tIoU]."""
    gt_rows = [[float(s), float(e), lab, "fn", 0.0] for s, e, lab in gt_events]
    pred_rows = [[float(s), float(e), lab, "fp", 0.0] for s, e, lab in pred_events]
    for label in {r[2] for r in gt_rows} | {r[2] for r in pred_rows}:
        gi = [k for k, r in enumerate(gt_rows) if r[2] == label]
        pi = [k for k, r in enumerate(pred_rows) if r[2] == label]
        g = [(gt_rows[k][0], gt_rows[k][1]) for k in gi]
        p = [(pred_rows[k][0], pred_rows[k][1]) for k in pi]
        for a, b in match_pairs(g, p, STATUS_TIOU):
            gt_rows[gi[a]][3] = pred_rows[pi[b]][3] = "tp"
        for a, k in enumerate(gi):
            gt_rows[k][4] = round(max((tiou(g[a], q) for q in p), default=0.0), 3)
        for b, k in enumerate(pi):
            pred_rows[k][4] = round(max((tiou(p[b], q) for q in g), default=0.0), 3)
    return sorted(gt_rows), sorted(pred_rows)


def confusion(gt_events: list, pred_events: list) -> list[list]:
    """[label, emitted, count] cells: what we emitted over each labelled event, and bare predictions.

    ``emitted`` is the label's own class when a prediction of that class overlaps it by at least
    OVERLAP_TIOU, else the class of the prediction overlapping it most, else "(missed)". A
    prediction that overlaps no label at all counts under the row "(no label)".
    """
    cells: dict[tuple[str, str], int] = {}
    for s, e, lab in gt_events:
        same = max((tiou((s, e), (ps, pe)) for ps, pe, plab in pred_events if plab == lab), default=0.0)
        other = max(((tiou((s, e), (ps, pe)), plab) for ps, pe, plab in pred_events if plab != lab),
                    default=(0.0, ""))
        col = lab if same >= OVERLAP_TIOU else other[1] if other[0] >= OVERLAP_TIOU else "(missed)"
        cells[(lab, col)] = cells.get((lab, col), 0) + 1
    for ps, pe, plab in pred_events:
        if max((tiou((ps, pe), (s, e)) for s, e, _ in gt_events), default=0.0) < OVERLAP_TIOU:
            cells[("(no label)", plab)] = cells.get(("(no label)", plab), 0) + 1
    return [[row, col, n] for (row, col), n in sorted(cells.items())]


def per_class(rep_a: dict, gt: dict, pred: dict) -> list[dict]:
    def count(videos: dict, label: str) -> int:
        return sum(1 for v in videos.values() for *_, lab in v.get("events", []) if lab == label)

    rows = []
    for c in rep_a["classes"]:
        pc = rep_a["per_class"][c]
        at = pc[str(STATUS_TIOU)]
        rows.append({
            "id": c, "gt": count(gt, c), "pred": count(pred, c),
            "f1": [round(pc[str(t)]["f1"], 4) for t in TIOU_THRESHOLDS],
            "mean": round(pc["f1_mean"], 4), "tp": at["tp"], "fp": at["fp"], "fn": at["fn"],
        })
    return rows


def ablation_scores(labels: dict) -> dict | None:
    """Score A of every ablation run on the labelled window it covers (both sides cut at its end)."""
    path = OUT / "ablation.json"
    if not path.exists():
        return None
    abl = json.loads(path.read_text(encoding="utf-8"))
    video, window = f"{abl['input']['clip']}.MP4", float(abl["input"]["seconds"])
    if video not in labels:
        return None
    gt = {video: {"events": [[s, min(e, window), lab] for s, e, lab in labels[video]["events"] if s < window]}}
    runs = abl["runs"] + [{"id": "submission", "events": abl["submission"]["events"]}]
    rows = []
    for run in runs:
        rep = evaluate_part_a(gt, {video: {"events": run["events"]}})
        rows.append({"id": run["id"], "score_a": round(rep["score_a"], 4),
                     "f1_05": round(rep["micro"][str(STATUS_TIOU)]["f1"], 4)})
    return {"video": video, "seconds": window, "gt_events": len(gt[video]["events"]), "runs": rows}


def build() -> dict | None:
    """The dev-set report, or None while no labels exist."""
    if not LABELS.exists() or not PREDICTIONS.exists():
        return None
    labels = json.loads(LABELS.read_text(encoding="utf-8"))
    review = json.loads(REVIEW.read_text(encoding="utf-8")) if REVIEW.exists() else []
    submission = json.loads(PREDICTIONS.read_text(encoding="utf-8"))
    pred = {"team": submission.get("team"), "videos": {v: submission["videos"].get(v, {"events": [], "risk": []})
                                                       for v in labels}}
    rep = evaluate(labels, pred)
    a, b = rep["part_a"], rep["part_b"]

    disputed = {(r["video"], r["start"], r["end"], r["label"]) for r in review}
    undisputed = {v: {**g, "events": [ev for ev in g["events"] if (v, ev[0], ev[1], ev[2]) not in disputed]}
                  for v, g in labels.items()}

    videos = {}
    for v, g in labels.items():
        p_events = pred["videos"][v]["events"]
        gt_rows, pred_rows = timeline(g["events"], p_events)
        risk = pred["videos"][v].get("risk", [])
        accidents = [
            {"start": s, "end": e,
             "peak_before": round(max((r for t, r in risk if s - H <= t < s), default=0.0), 4)}
            for s, e, lab in g["events"] if lab == "accident"
        ]
        videos[Path(v).stem] = {"file": v, "duration": g["duration"], "gt": gt_rows, "pred": pred_rows,
                                "confusion": confusion(g["events"], p_events), "accidents": accidents}

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "labels": str(LABELS.relative_to(ROOT)),
        "predictions": str(PREDICTIONS.relative_to(ROOT)),
        "status_tiou": STATUS_TIOU,
        "overlap_tiou": OVERLAP_TIOU,
        "n_gt": sum(len(g["events"]) for g in labels.values()),
        "n_pred": sum(len(pred["videos"][v]["events"]) for v in labels),
        "model_score": round(rep["model_score"], 4),
        "score_a": round(a["score_a"], 4),
        "micro": {t: round(m["f1"], 4) for t, m in a["micro"].items()},
        "class_agnostic": {t: round(m["f1"], 4) for t, m in a["class_agnostic"].items()},
        "classes": per_class(a, labels, pred["videos"]),
        "part_b": None if b is None else {k: (round(val, 4) if isinstance(val, float) else val)
                                          for k, val in b.items() if k != "per_video"},
        "disputed": review,
        "score_a_undisputed": round(evaluate_part_a(undisputed, pred["videos"])["score_a"], 4) if review else None,
        "videos": videos,
        "ablation": ablation_scores(labels),
    }


def metrics_entry(report: dict | None) -> dict:
    """The manifest's "metrics" state for this report."""
    if report is None:
        return {
            "available": False,
            "reason": ("No dev labels in labels/dev_labels.json, so Score A, Score B, per-class F1, AP and "
                       "mTTA cannot be computed: evaluate.py needs a ground truth to score against."),
        }
    clips = ", ".join(report["videos"])
    return {"available": True, "reason": f"labels/dev_labels.json ({report['n_gt']} events on {clips})",
            "path": "dev-eval.json"}


def main() -> int:
    report = build()
    if report is not None:
        path = OUT / "dev-eval.json"
        path.write_text(json.dumps(report, separators=(",", ":")), encoding="utf-8")
        print(f"wrote {path.relative_to(ROOT)}: Score A {report['score_a']:.4f} over {report['n_gt']} labels, "
              f"model score {report['model_score']:.4f}")
    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["metrics"] = metrics_entry(report)
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    print(f"updated {manifest_path.relative_to(ROOT)} (metrics available: {manifest['metrics']['available']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
