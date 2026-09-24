"""Re-run the event rules on cached perception (seconds instead of a full pass) and write predictions.json.

    python tools/predict_cached.py --out predictions_dev.json [--risk-from predictions_samples.json]

Risk curves are copied from an earlier full harness run when given (Part B needs the pixels).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import devdata
from traffic.events import EventContext, SceneMasks, detect_all


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--risk-from", help="predictions.json whose risk curves are reused")
    args = ap.parse_args()
    risk = {}
    if args.risk_from and Path(args.risk_from).exists():
        risk = {k: v.get("risk", []) for k, v in json.loads(Path(args.risk_from).read_text())["videos"].items()}
    scene = devdata.scene()
    masks = SceneMasks.build(scene)
    videos = {}
    for name in devdata.VIDEOS:
        d = devdata.load(name)
        ctx = EventContext(d.duration, 30000 / 1001, d.trajectories, d.phase_t, d.phase, scene, masks)
        videos[name] = {"events": detect_all(ctx), "risk": risk.get(name, [])}
        print(f"{name}: {len(videos[name]['events'])} events")
    Path(args.out).write_text(json.dumps({"team": "wiut-cv", "videos": videos}, indent=1))
    print("wrote", args.out)


if __name__ == "__main__":
    main()
