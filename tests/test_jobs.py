"""The demo's job store never deletes a clip that is still queued or running."""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def test_eviction_keeps_unfinished_jobs_and_discard_removes_files(monkeypatch):
    from server import jobs

    monkeypatch.setattr(jobs, "MAX_JOBS", 2)
    store = jobs.JobStore()
    running = store.create("a.mp4")  # e.g. a slow CPU job older than the TTL
    running.created -= jobs.TTL_SEC * 2
    done = [store.create(f"{i}.mp4") for i in range(3)]
    for j in done:
        j.finished = time.time()
    store.create("new.mp4")  # triggers eviction

    assert store.get(running.id) is running and running.workdir.exists()
    assert store.get(done[0].id) is None and not done[0].workdir.exists()  # oldest finished goes first

    rejected = store.create("bad.mp4")
    rejected.path.write_bytes(b"x")
    store.discard(rejected)
    assert store.get(rejected.id) is None and not rejected.workdir.exists()
