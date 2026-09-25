"""Live mode keeps one tracker per browser session, so ids persist from frame to frame,
and runs Part B's risk model only on a feed that aligns to this camera's scene."""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

PROXY = ROOT / "web" / "public" / "media" / "samples" / "C3905_720p.mp4"


@pytest.mark.skipif(not PROXY.exists(), reason="needs the C3905 web proxy")
def test_tracks_persist_within_a_session_and_bad_frames_are_refused():
    from server import live

    cap = cv2.VideoCapture(str(PROXY))
    frames = [cv2.imencode(".jpg", cap.read()[1])[1].tobytes() for _ in range(3)]
    cap.release()

    replies = [live.step("pytest-live-a", f, i / 6) for i, f in enumerate(frames)]
    assert [r["frame"] for r in replies] == [1, 2, 3]
    ids = [{b[0] for b in r["boxes"]} for r in replies]
    assert ids[2] and ids[1] & ids[2], "confirmed tracks keep their id on the next frame"
    assert all(0 <= b[2] <= 1 and 0 <= b[3] <= 1 for b in replies[2]["boxes"])

    # The sample clip is this camera: it aligns, and Part B's score and cues come back.
    assert replies[0]["aligned"] and replies[0]["inliers"] >= live.MIN_INLIERS
    assert 0.0 <= replies[2]["risk"] <= 1.0 and set(replies[2]["cues"]) == {"conflict", "red_runner", "braking"}

    # A timestamp that runs backwards (the clip looped) starts the session over.
    again = live.step("pytest-live-a", frames[0], 0.0)
    assert again["reset"] and again["frame"] == 1

    assert live.step("pytest-live-b", frames[0])["frame"] == 1  # a new session starts its own tracker
    assert live.close("pytest-live-b") and not live.close("pytest-live-b")
    with pytest.raises(ValueError):
        live.step("pytest-live-c", b"not a jpeg")
    with pytest.raises(ValueError):
        live.step("pytest-live-c", frames[0], float("nan"))


def test_a_feed_from_elsewhere_is_tracked_but_never_scored():
    from server import live

    noise = np.random.default_rng(0).integers(0, 255, (480, 640, 3), dtype=np.uint8)  # a 4:3 "webcam"
    reply = live.step("pytest-live-d", cv2.imencode(".jpg", noise)[1].tobytes(), 0.0)
    assert not reply["aligned"]
    assert reply["risk"] is None and reply["cues"] is None and reply["phase"] is None
    assert reply["target_fps"] == live.FPS_TRACKING
    live.close("pytest-live-d")
