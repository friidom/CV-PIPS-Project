"""Live mode keeps one tracker per browser session, so ids persist from frame to frame."""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
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

    replies = [live.step("pytest-live-a", f) for f in frames]
    assert [r["frame"] for r in replies] == [1, 2, 3]
    ids = [{b[0] for b in r["boxes"]} for r in replies]
    assert ids[2] and ids[1] & ids[2], "confirmed tracks keep their id on the next frame"
    assert all(0 <= b[2] <= 1 and 0 <= b[3] <= 1 for b in replies[2]["boxes"])

    assert live.step("pytest-live-b", frames[0])["frame"] == 1  # a new session starts its own tracker
    with pytest.raises(ValueError):
        live.step("pytest-live-c", b"not a jpeg")
