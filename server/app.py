"""FastAPI backend for the live demo.

    uvicorn server.app:app --host 127.0.0.1 --port 8000     # local development
    uvicorn server.app:app --host 0.0.0.0 --port 8000       # a server, behind a tunnel or proxy

Endpoints
    GET  /api/health              liveness for uptime checks; never loads a model
    GET  /api/capabilities        device, model names and the accepted clip length
    POST /api/jobs                multipart .mp4 -> {id}
    GET  /api/jobs/{id}           progress, or the full result once finished
    GET  /api/jobs/{id}/stream    the same payload as server-sent events
    GET  /api/jobs/{id}/media     the browser-playable copy, with range support
    DELETE /api/jobs/{id}         cancel
    POST /api/live/{session}?t=   one JPEG frame of a live feed -> tracks, risk, cues (server/live.py)
    DELETE /api/live/{session}    end a live session

It also serves web/dist when that build exists, so the site and the API can run as
one origin on a single host.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import inference, live  # noqa: E402
from server.jobs import store  # noqa: E402

# Longest accepted clip in seconds; 0 turns the check off. There is no file-size cap.
MAX_DURATION_SEC = float(os.environ.get("DEMO_MAX_DURATION_SEC", "120"))
# Uploads waiting behind the running one; each holds its file on disk until processed.
MAX_QUEUE = int(os.environ.get("DEMO_MAX_QUEUE", "3"))
LIVE_MAX_BYTES = 2 * 1024 * 1024
CHUNK = 1024 * 1024

app = FastAPI(title="WIUT CV Track — traffic event demo", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("DEMO_CORS_ORIGINS", "*").split(","),
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)
# The overlay JSON is ~4 MB per clip; Starlette skips video and text/event-stream.
app.add_middleware(GZipMiddleware, minimum_size=2048)

# Model load takes a minute on a small CPU; do it once, off the event loop, at startup.
_models: dict = {"state": "loading", "detail": None}


def _warm() -> None:
    try:
        eng = inference.engine()
        live.warm()
        _models.update(state="ready")
        print(f"[server] models ready on {eng.device} ({eng.gpu_name() or 'no CUDA device'})", flush=True)
    except Exception as exc:  # noqa: BLE001 - reported by /api/capabilities
        _models.update(state="error", detail=f"{type(exc).__name__}: {exc}")
        print(f"[server] model load failed: {_models['detail']}", file=sys.stderr, flush=True)


def _run(job) -> None:
    def on_progress(stage: str, fraction: float, message: str, frames: int | None = None,
                    detections: int | None = None) -> None:
        order = ["perception", "tracking", "rules", "risk", "encoding"]
        done = order[: order.index(stage)]
        job.update(
            stage=stage,
            progress=inference._stage_progress(done, fraction, stage),
            message=message,
            **({"frames_processed": frames} if frames is not None else {}),
            **({"detections": detections} if detections is not None else {}),
        )

    job.update(result=inference.run_job(job, on_progress))


@app.on_event("startup")
async def _startup() -> None:
    store.start(_run)
    threading.Thread(target=_warm, name="warm-models", daemon=True).start()


@app.api_route("/api/health", methods=["GET", "HEAD"])
async def health() -> dict:
    return {"ok": True, "models": _models["state"], "queue_depth": store.queue_depth(), "busy": store.busy()}


@app.get("/api/capabilities")
async def capabilities() -> dict:
    state = _models["state"]
    device, gpu = "unavailable", None
    if state == "ready":
        eng = inference.engine()
        device, gpu = eng.device, eng.gpu_name()
    return {
        "ok": state == "ready",
        "loading": state == "loading",
        "detail": _models["detail"] if state == "error" else None,
        "device": device,
        "gpu": gpu,
        "detector": "YOLO11m 1280x736 (TorchScript, COCO)",
        "risk_detector": "YOLO11s 960x544 (TorchScript, COCO)",
        "max_duration_sec": MAX_DURATION_SEC,
        "classes": inference.CLASSES,
        "queue_depth": store.queue_depth(),
        "busy": store.busy(),
        # Measured on this server, so a visitor can size a clip to the wait they will get.
        "last_run": store.last_run,
    }


def _check_duration(seconds: float) -> None:
    if MAX_DURATION_SEC > 0 and seconds > MAX_DURATION_SEC:
        raise HTTPException(
            413,
            f"Clip is {seconds:.0f} s; the demo accepts up to {MAX_DURATION_SEC:.0f} s. "
            "Trim it and try again.",
        )


@app.post("/api/jobs")
async def create_job(request: Request) -> dict:
    if store.queue_depth() >= MAX_QUEUE:
        raise HTTPException(503, f"{MAX_QUEUE} clips are already waiting. Try again in a few minutes.")

    async with request.form(max_files=1) as form:
        file = form.get("file")
        if file is None or isinstance(file, str):
            raise HTTPException(400, "Send the video as the multipart field 'file'.")
        name = (file.filename or "upload.mp4").strip()
        if not name.lower().endswith(".mp4"):
            raise HTTPException(415, "Only .mp4 files are accepted.")

        job = store.create(name)
        try:
            with job.path.open("wb") as fh:
                while chunk := await file.read(CHUNK):
                    fh.write(chunk)
        except BaseException:
            store.discard(job)
            raise

    from traffic.video import probe

    try:
        info = probe(str(job.path))
        if info.n_frames <= 0 or info.fps <= 0:
            raise HTTPException(400, "This file has no readable video stream.")
        _check_duration(info.duration)
    except HTTPException:
        store.discard(job)
        raise
    except Exception:
        store.discard(job)
        raise HTTPException(400, "This file could not be opened as a video.") from None

    store.enqueue(job)
    return {"id": job.id}


@app.get("/api/jobs/{jid}")
async def get_job(jid: str) -> JSONResponse:
    job = store.get(jid)
    if job is None:
        raise HTTPException(404, "Unknown job. It may have expired.")
    return JSONResponse(job.snapshot())


@app.delete("/api/jobs/{jid}")
async def delete_job(jid: str) -> dict:
    return {"cancelled": store.cancel(jid)}


@app.get("/api/jobs/{jid}/stream")
async def stream_job(jid: str, request: Request) -> StreamingResponse:
    job = store.get(jid)
    if job is None:
        raise HTTPException(404, "Unknown job. It may have expired.")

    async def events():
        last = -1
        while True:
            if await request.is_disconnected():
                return
            if job.version != last:
                last = job.version
                yield f"data: {json.dumps(job.snapshot())}\n\n"
                if job.stage == "done" or job.error or job.cancelled:
                    return
            await asyncio.sleep(0.25)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.get("/api/jobs/{jid}/media")
async def job_media(jid: str) -> FileResponse:
    job = store.get(jid)
    if job is None:
        raise HTTPException(404, "Unknown job. It may have expired.")
    path = job.workdir / "playback.mp4"
    if not path.exists():
        path = job.path
    if not path.exists():
        raise HTTPException(404, "No playable copy for this job.")
    # FileResponse handles Range requests, which the <video> element needs to seek.
    return FileResponse(path, media_type="video/mp4", filename=f"{job.id}.mp4")


def _live_session(session: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", session):
        raise HTTPException(400, "Bad session id.")
    return session


@app.post("/api/live/{session}")
async def live_frame(session: str, request: Request, t: float | None = None) -> dict:
    """One frame of a live feed (JPEG body, `t` = seconds into the feed) -> tracks, risk, cues.

    Uploads always come first.
    """
    _live_session(session)
    if _models["state"] != "ready":
        raise HTTPException(503, "The models are still loading; live mode starts in a moment."
                            if _models["state"] == "loading" else f"Models failed to load: {_models['detail']}")
    if store.busy():
        raise HTTPException(503, "An upload is being analysed; live mode resumes when it finishes.")
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > LIVE_MAX_BYTES:
            raise HTTPException(413, "Send one JPEG frame of at most 2 MB.")
    if not body:
        raise HTTPException(400, "Empty frame.")
    try:
        return await run_in_threadpool(live.step, session, bytes(body), t)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    except OverflowError as exc:
        raise HTTPException(503, f"{exc}; try again in a minute.") from None


@app.delete("/api/live/{session}")
async def live_close(session: str) -> dict:
    """The browser stopped its feed: drop the session's tracker now instead of at its TTL."""
    return {"closed": live.close(_live_session(session))}


DIST = ROOT / "web" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.api_route("/{path:path}", methods=["GET", "HEAD"])
    async def spa(path: str) -> FileResponse:
        """Serve built files, falling back to index.html so client-side routes work."""
        candidate = (DIST / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(DIST.resolve()):
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")
