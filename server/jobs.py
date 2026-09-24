"""In-process job queue for the live demo.

One worker thread runs one inference at a time: the pipeline already saturates the
GPU with a batched detector and three decoder threads, so a second concurrent job
would only make both slower and risk running out of VRAM. Jobs are kept in memory
with their uploaded file in a temp directory and evicted after TTL_SEC.
"""
from __future__ import annotations

import shutil
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

TTL_SEC = 45 * 60
MAX_JOBS = 24

STAGES = ("queued", "probing", "perception", "tracking", "rules", "risk", "encoding", "done")


@dataclass
class Job:
    id: str
    filename: str
    path: Path
    workdir: Path
    created: float = field(default_factory=time.time)
    stage: str = "queued"
    progress: float = 0.0
    message: str = "Waiting for a free worker"
    frames_processed: int = 0
    detections: int = 0
    started: float | None = None
    finished: float | None = None
    result: dict | None = None
    error: str | None = None
    cancelled: bool = False
    version: int = 0

    def update(self, **kw) -> None:
        for k, v in kw.items():
            setattr(self, k, v)
        self.version += 1

    @property
    def elapsed(self) -> float:
        if self.started is None:
            return 0.0
        return (self.finished or time.time()) - self.started

    def snapshot(self) -> dict:
        base = {
            "id": self.id,
            "stage": "error" if self.error else ("cancelled" if self.cancelled else self.stage),
            "progress": round(self.progress, 4),
            "message": self.error or self.message,
            "elapsed_sec": round(self.elapsed, 2),
            "frames_processed": self.frames_processed,
            "detections": self.detections,
            "filename": self.filename,
        }
        if self.result:
            base.update(self.result)
        return base


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._lock = threading.Lock()
        self._queue: list[str] = []
        self._wake = threading.Condition(self._lock)
        self._root = Path(tempfile.mkdtemp(prefix="wiut-cv-demo-"))
        self._worker: threading.Thread | None = None
        self._run: Callable[[Job], None] | None = None

    @property
    def root(self) -> Path:
        return self._root

    def start(self, run: Callable[[Job], None]) -> None:
        self._run = run
        self._worker = threading.Thread(target=self._loop, name="inference", daemon=True)
        self._worker.start()

    def create(self, filename: str) -> Job:
        jid = uuid.uuid4().hex[:12]
        workdir = self._root / jid
        workdir.mkdir(parents=True, exist_ok=True)
        job = Job(id=jid, filename=filename, path=workdir / "input.mp4", workdir=workdir)
        with self._lock:
            self._jobs[jid] = job
            self._order.append(jid)
            self._evict_locked()
        return job

    def enqueue(self, job: Job) -> None:
        with self._wake:
            self._queue.append(job.id)
            job.update(message=f"Queued, {len(self._queue)} ahead" if len(self._queue) > 1 else "Starting")
            self._wake.notify()

    def get(self, jid: str) -> Job | None:
        with self._lock:
            return self._jobs.get(jid)

    def cancel(self, jid: str) -> bool:
        job = self.get(jid)
        if job is None or job.stage == "done":
            return False
        job.update(cancelled=True, message="Cancelled")
        return True

    def queue_depth(self) -> int:
        with self._lock:
            return len(self._queue)

    def _evict_locked(self) -> None:
        now = time.time()
        stale = [j for j in self._order if now - self._jobs[j].created > TTL_SEC]
        while len(self._order) - len(stale) > MAX_JOBS:
            stale.append(self._order[len(stale)])
        for jid in dict.fromkeys(stale):
            job = self._jobs.pop(jid, None)
            self._order.remove(jid)
            if job:
                shutil.rmtree(job.workdir, ignore_errors=True)

    def _loop(self) -> None:
        while True:
            with self._wake:
                while not self._queue:
                    self._wake.wait()
                jid = self._queue.pop(0)
            job = self.get(jid)
            if job is None or job.cancelled or self._run is None:
                continue
            job.update(started=time.time(), stage="probing", message="Reading the video")
            try:
                self._run(job)
            except Exception as exc:  # noqa: BLE001 - surfaced to the browser, never crashes the worker
                job.update(error=f"{type(exc).__name__}: {exc}", finished=time.time())
            else:
                if not job.cancelled:
                    job.update(stage="done", progress=1.0, message="Complete", finished=time.time())


store = JobStore()
