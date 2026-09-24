"""Per-video perception pass: parallel sampled decoding + batched detection, with an on-disk cache."""
from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator

import numpy as np

from .detector import Detector
from .video import VideoInfo, iter_frames

DETECT_SIZE = (1920, 1080)  # decode target; the detector resizes it again on the GPU


@dataclass
class Detections:
    """All detections of one video, flattened.

    frames: (F,) sampled frame indices, increasing.
    frame_of: (N,) row -> position in ``frames``; boxes: (N, 6) x1 y1 x2 y2 conf cls (video pixels).
    """
    fps: float
    frames: np.ndarray
    frame_of: np.ndarray
    boxes: np.ndarray

    def per_frame(self) -> Iterator[tuple[int, np.ndarray]]:
        bounds = np.searchsorted(self.frame_of, np.arange(len(self.frames) + 1))
        for k, idx in enumerate(self.frames):
            yield int(idx), self.boxes[bounds[k]:bounds[k + 1]]

    def save(self, path: Path) -> None:
        np.savez_compressed(path, fps=self.fps, frames=self.frames, frame_of=self.frame_of, boxes=self.boxes)

    @classmethod
    def load(cls, path: Path) -> "Detections":
        z = np.load(path)
        return cls(float(z["fps"]), z["frames"], z["frame_of"], z["boxes"])

    @classmethod
    def from_frames(cls, fps: float, results: dict[int, np.ndarray]) -> "Detections":
        frames = np.array(sorted(results), np.int32)
        per = [results[int(i)] for i in frames]
        return cls(
            fps=fps, frames=frames,
            frame_of=np.repeat(np.arange(len(frames), dtype=np.int32), [len(d) for d in per]),
            boxes=np.concatenate(per) if per else np.zeros((0, 6), np.float32),
        )


def parallel_frames(info: VideoInfo, size: tuple[int, int], workers: int,
                    deadline: float | None = None) -> Iterator[tuple[int, np.ndarray]]:
    """Decode ``workers`` contiguous parts of the video concurrently (PyAV releases the GIL).

    Frames arrive out of order. Decoding stops early once ``deadline`` (perf_counter) passes.
    """
    q: queue.Queue = queue.Queue(maxsize=64)
    done = object()
    errors: list[BaseException] = []
    cuts = np.linspace(0, info.n_frames, workers + 1).round().astype(int)
    cuts[-1] = max(cuts[-1], info.n_frames + 1000)  # headroom if the header under-reports frames

    def work(first: int, stop: int) -> None:
        try:
            for item in iter_frames(info.path, size, first=first, stop=stop):
                q.put(item)
                if deadline is not None and time.perf_counter() > deadline:
                    break
        except BaseException as exc:  # re-raised in the consumer thread
            errors.append(exc)
        finally:
            q.put(done)

    threads = [threading.Thread(target=work, args=(int(a), int(b)), daemon=True) for a, b in zip(cuts[:-1], cuts[1:])]
    for th in threads:
        th.start()
    finished = 0
    while finished < len(threads):
        item = q.get()
        if item is done:
            finished += 1
        else:
            yield item
    if errors:
        raise errors[0]


def detect_video(info: VideoInfo, detector: Detector, workers: int = 3, batch: int = 16,
                 on_frame: Callable[[int, np.ndarray], None] | None = None,
                 deadline: float | None = None) -> Detections:
    """Detect road users on every reference frame (~10 fps) of a video.

    ``on_frame(index, bgr)`` sees each decoded frame (e.g. to sample signal-light pixels).
    """
    scale = info.width / DETECT_SIZE[0]
    results: dict[int, np.ndarray] = {}
    buf_idx, buf_img = [], []

    def flush() -> None:
        for idx, det in zip(buf_idx, detector(buf_img, scale)):
            results[idx] = det
        buf_idx.clear()
        buf_img.clear()

    for idx, img in parallel_frames(info, DETECT_SIZE, workers, deadline):
        if on_frame:
            on_frame(idx, img)
        buf_idx.append(idx)
        buf_img.append(img)
        if len(buf_img) == batch:
            flush()
    if buf_img:
        flush()
    return Detections.from_frames(info.fps, results)
