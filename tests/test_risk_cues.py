"""The demo's CueRecorder only records RiskModel's cues: the risk score it returns must not change."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

from server.inference import CueRecorder  # noqa: E402
from traffic.events import SceneMasks  # noqa: E402
from traffic.risk import RiskModel  # noqa: E402
from traffic.scene import Scene  # noqa: E402
from traffic.signals import GREEN  # noqa: E402


def test_cue_recorder_returns_the_same_score_and_keeps_the_cues():
    scene = Scene.load(ROOT / "configs")
    road = SceneMasks.build(scene).road
    plain, traced = RiskModel(None, scene, road), CueRecorder(None, scene, road)
    for m in (plain, traced):
        m.reset({})
        m.H = np.eye(3)  # tracks below are already in reference pixels

    # Two cars on the carriageway closing head-on at 400 px/s each (5 car-widths/s), sampled at 6 Hz,
    # stopped just before they meet.
    for k in range(7):
        t = k / 6
        a, b = 500 + 400 * t, 1400 - 400 * t
        tracked = np.array([[a - 40, 620, a + 40, 660, 0.9, 2, 1], [b - 40, 620, b + 40, 660, 0.9, 2, 2]], float)
        assert traced.observe(tracked, t, GREEN) == plain.observe(tracked, t, GREEN)

    conflict, red_runner, braking = traced.last_cues
    assert conflict > 0.5 and red_runner == 0.0 and braking == 0.0
    # Rising risk takes the new noisy-OR value outright (fast attack), so the cues account for the score.
    assert np.isclose(traced.score, 1 - (1 - conflict) * (1 - red_runner) * (1 - braking))
