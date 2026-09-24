"""Score predictions against the team's dev labels with the official Part A metric.

    python tools/eval_dev.py ../dev_labels.json predictions_dev.json [--all]

While labelling is in progress only videos with at least one label and classes that occur
in the labels are scored (unlabelled ones would count every prediction as a false positive);
``--all`` scores everything as is.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import devdata  # noqa: F401  (puts the repo root on sys.path)
from evaluate import evaluate_part_a


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("labels")
    ap.add_argument("predictions")
    ap.add_argument("--all", action="store_true", help="score every video and class")
    args = ap.parse_args()
    gt = json.loads(Path(args.labels).read_text(encoding="utf-8"))
    pred = json.loads(Path(args.predictions).read_text(encoding="utf-8"))["videos"]
    if not args.all:
        gt = {k: v for k, v in gt.items() if v["events"]}
        classes = {e[2] for v in gt.values() for e in v["events"]}
        pred = {k: {"events": [e for e in pred.get(k, {}).get("events", []) if e[2] in classes]} for k in gt}
    rep = evaluate_part_a(gt, pred, per_video=True)
    print(f"videos: {', '.join(gt)}")
    print(f"Score A (macro F1 over {len(rep['classes'])} classes): {rep['score_a']:.3f}")
    for c in rep["classes"]:
        pc = rep["per_class"][c]
        cells = "  ".join(f"@{t}: P {pc[t]['precision']:.2f} R {pc[t]['recall']:.2f} F1 {pc[t]['f1']:.2f}" for t in ("0.3", "0.5", "0.7"))
        print(f"  {c:20s} F1 {pc['f1_mean']:.3f}   {cells}")
    for row in rep["per_video"]:
        print("  ", {k: v for k, v in row.items()})


if __name__ == "__main__":
    main()
