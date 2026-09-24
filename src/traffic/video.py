"""Video access: metadata and sampled decoding of long 4K clips.

The camera writes H.264 High 4:2:2 10-bit at 29.97 fps with a 15-frame GOP
(I B B P B B P ...). Only I/P frames are reference frames, so asking the
decoder to skip non-reference frames yields every 3rd frame (~10 fps) at
roughly half the CPU cost of a full decode. Corrupt packets (the sample
files contain zero-filled holes) are skipped instead of ending the read.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

import av
import cv2
import numpy as np


@dataclass(frozen=True)
class VideoInfo:
    path: str
    fps: float
    n_frames: int
    width: int
    height: int

    @property
    def duration(self) -> float:
        return self.n_frames / self.fps if self.fps else 0.0


def probe(path: str) -> VideoInfo:
    """Read metadata the same way the organizers' harness does (OpenCV)."""
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {path}")
    info = VideoInfo(
        path=path,
        fps=cap.get(cv2.CAP_PROP_FPS) or 25.0,
        n_frames=int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
        width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
    )
    cap.release()
    return info


def iter_frames(path: str, size: tuple[int, int], first: int = 0, stop: int | None = None,
                min_step: int = 3, reference_only: bool = True) -> Iterator[tuple[int, np.ndarray]]:
    """Yield ``(frame_index, bgr)`` resized to ``size`` = (width, height) for indices in [first, stop).

    Args:
        min_step: minimum index distance between yielded frames; guards the
            processing rate if a video has no B-frames to skip.
        reference_only: decode I/P frames only (skip_frame=NONREF). With the
            camera's GOP this is every 3rd frame; set False to decode all.
    """
    width, height = size
    with av.open(path) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        if reference_only:
            stream.codec_context.skip_frame = "NONREF"
        fps = float(stream.average_rate or 25)
        time_base = float(stream.time_base)
        start = stream.start_time or 0
        if first > 0:  # lands on the keyframe before `first`; earlier frames are dropped below
            container.seek(int(start + first / fps / time_base), stream=stream, backward=True)
        last = -min_step
        for packet in container.demux(stream):
            try:
                frames = packet.decode()
            except av.error.InvalidDataError:
                continue  # zero-filled / corrupt packet: the decoder resyncs at the next keyframe
            for frame in frames:
                if frame.pts is None:
                    continue
                idx = int(round((frame.pts - start) * time_base * fps))
                if stop is not None and idx >= stop:
                    return
                if idx < first or idx - last < min_step:
                    continue
                last = idx
                yield idx, frame.to_ndarray(format="bgr24", width=width, height=height)


def read_frame(path: str, index: int) -> np.ndarray | None:
    """Random access to one full-resolution frame (used for scene alignment and tools)."""
    cap = cv2.VideoCapture(path)
    cap.set(cv2.CAP_PROP_POS_FRAMES, index)
    ok, frame = cap.read()
    cap.release()
    return frame if ok else None
