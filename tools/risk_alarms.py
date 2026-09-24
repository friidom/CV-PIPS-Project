"""Replay recorded Part B observations and list alarms (runs of score >= 0.5) with the cues behind them."""
from __future__ import annotations

import pickle

import numpy as np

import devdata  # noqa: F401  (sets up sys.path)

from evaluate import alarm_starts
from traffic.events import SceneMasks
from traffic.risk import RiskModel


def main() -> None:
    scene = devdata.scene()
    model = RiskModel(None, scene, SceneMasks.build(scene).road)
    obs = pickle.loads((devdata.CACHE / "risk_observations.pkl").read_bytes())
    for name, o in obs.items():
        model.reset({})
        model.H = o["H"]
        rows = []
        for t, phase, tracked in o["trace"]:
            cues = model._cues(tracked, t, phase)
            raw = 1.0 - float(np.prod([1.0 - c for c in cues]))
            model.score = raw if raw > model.score else 0.89 * model.score + 0.11 * raw
            rows.append((t, *cues, model.score))
        a = np.array(rows)
        s = a[:, 4]
        starts = alarm_starts([[t, v] for t, v in a[:, [0, 4]]])
        print(f"{name}: p50 {np.percentile(s, 50):.3f} p90 {np.percentile(s, 90):.3f} p99 {np.percentile(s, 99):.3f} "
              f"max {s.max():.2f}; alarms {[round(float(x), 1) for x in starts]}")
        for x in starts:
            k = np.searchsorted(a[:, 0], x)
            print(f"    {x:6.1f}s cues (conflict, red, braking) max {np.round(a[k:k + 6, 1:4].max(0), 2).tolist()}")


if __name__ == "__main__":
    main()
