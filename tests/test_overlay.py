"""The live demo reuses the sample pages' build_overlay(); an upload's boxes must land in its own frame."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

from scripts.build_site_data import build_overlay  # noqa: E402
from traffic.tracks import TrackTable  # noqa: E402

FPS = 30.0


def test_overlay_for_an_upload_uses_its_frame_and_the_rules_evidence():
    # Columns: tid, frame, x1, y1, x2, y2, conf, cls. A car (tid 7) on frames 0 and 3, a person (tid 9) on 3.
    table = TrackTable(FPS, np.array([
        [7, 0, 320, 180, 640, 360, 0.9, 2],
        [7, 3, 320, 180, 640, 360, 0.9, 2],
        [9, 3, 0, 0, 128, 72, 0.8, 0],
    ], float))
    p = {"fps": FPS, "H": np.eye(3), "lamp_frames": np.zeros(0, int), "lamp_scores": np.zeros((0, 4), np.float32)}
    spans = [(0.0, 0.05, "red_light", (7,))]  # the rule fired on the car at frame 0 only
    args = ("clip.mp4", p, 0.0, 1.0, [[0.0, 0.05, "red_light"]], "video", spans)

    ov = build_overlay(*args, table=table, frame=(1280, 720))
    assert ov["times"] == [0.0, 0.1] and ov["offsets"] == [0, 1, 3] and ov["n"] == [1, 2]
    assert (ov["x"][0], ov["y"][0], ov["w"][0], ov["h"][0]) == (375, 375, 250, 250)  # thousandths of 1280x720
    assert ov["id"] == [1, 1, 2] and ov["g"] == [1, 1, 0]
    assert ov["event_labels"] == ["red_light"] and ov["e"] == [0, -1, -1]
    assert ov["phase"] == [0, 0]  # no lamp samples -> UNKNOWN, never a guessed phase

    # The sample pages' default is still their 4K frame.
    assert build_overlay(*args, table=table)["x"][0] == 125
