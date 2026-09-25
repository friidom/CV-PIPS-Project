"""The dashboard places an event where the rule's vehicle stood, using the rules' own footprint test."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

from scripts.build_event_facts import event_facts, region_integrals  # noqa: E402
from traffic.scene import Scene  # noqa: E402


def box(x: float, y: float, w: float, h: float) -> list[int]:
    """Reference pixels -> the overlay's thousandths of the frame (identity homography below)."""
    return [round(x / 1920 * 1000), round(y / 1080 * 1000), round(w / 1920 * 1000), round(h / 1080 * 1000)]


def test_failure_to_yield_is_placed_on_the_crossing_its_vehicle_occupies():
    # One frame at t = 10 s: car 3 standing on crossing cw2, pedestrian 4 far away on the
    # other side of the frame. Both are the rule's evidence; only the car decides the region.
    car, ped = box(680, 970, 80, 60), box(900, 100, 20, 60)
    overlay = {
        "t0": 0.0, "times": [10.0], "offsets": [0, 2], "phase": [1], "event_labels": ["failure_to_yield"],
        "id": [3, 4], "g": [1, 0], "e": [0, 0],
        **{k: [car[i], ped[i]] for i, k in enumerate("xywh")},
    }
    (fact,) = event_facts(overlay, [[9.9, 10.5, "failure_to_yield"]], np.eye(3),
                          region_integrals(Scene.load(ROOT / "configs")))
    assert (fact["region"], fact["share"], fact["tracks"], fact["evidence"], fact["phase"]) == ("cw2", 1.0, [3, 4], 2, "RED")
    assert np.allclose(fact["foot"], [680, 1000], atol=2)

    # An event of a class the overlay carries no evidence for is reported as unplaced, never guessed.
    (gap,) = event_facts(overlay, [[9.9, 10.5, "congestion"]], np.eye(3), region_integrals(Scene.load(ROOT / "configs")))
    assert gap["region"] is None and gap["tracks"] == []
