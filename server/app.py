"""FastAPI backend for the live demo.

    uvicorn server.app:app --host 127.0.0.1 --port 8000

Endpoints
    GET  /api/capabilities        device, model names and the accepted upload limits
    POST /api/jobs                multipart .mp4 -> {id}
    GET  /api/jobs/{id}           progress, or the full result once finished
    GET  /api/jobs/{id}/stream    the same payload as server-sent events
    GET  /api/jobs/{id}/media     the browser-playable copy, with range support
    DELETE /api/jobs/{id}         cancel

It also serves web/dist when that build exists, so the site and the API can run as
one origin on a single host.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import inference  # noqa: E402
from server.jobs import store  # noqa: E402

MAX_UPLOAD_BYTES = int(os.environ.get("DEMO_MAX_UPLOAD_MB", "200")) * 1024 * 1024
MAX_DURATION_SEC = float(os.environ.get("DEMO_MAX_DURATION_SEC", "120"))
CHUNK = 1024 * 1024

app = FastAPI(title="WIUT CV Track — traffic event demo", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("DEMO_CORS_ORIGINS", "*").split(","),
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)


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


@app.get("/api/capabilities")
async def capabilities() -> dict:
    try:
        eng = inference.engine()
        device, gpu = eng.device, eng.gpu_name()
        ok = True
        detail = None
    except Exception as exc:  # noqa: BLE001 - the UI shows this instead of a dead upload box
        device, gpu, ok, detail = "unavailable", None, False, f"{type(exc).__name__}: {exc}"
    return {
        "ok": ok,
        "detail": detail,
        "device": device,
        "gpu": gpu,
        "detector": "YOLO11m 1280x736 (TorchScript, COCO)",
        "risk_detector": "YOLO11s 960x544 (TorchScript, COCO)",
        "max_upload_bytes": MAX_UPLOAD_BYTES,
        "max_duration_sec": MAX_DURATION_SEC,
        "classes": inference.CLASSES,
        "queue_depth": store.queue_depth(),
    }


@app.post("/api/jobs")
async def create_job(file: UploadFile) -> dict:
    name = (file.filename or "upload.mp4").strip()
    if not name.lower().endswith(".mp4"):
        raise HTTPException(415, "Only .mp4 files are accepted.")

    job = store.create(name)
    size = 0
    try:
        with job.path.open("wb") as fh:
            while chunk := await file.read(CHUNK):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
                fh.write(chunk)
    except HTTPException:
        job.path.unlink(missing_ok=True)
        raise

    from traffic.video import probe

    try:
        info = probe(str(job.path))
    except Exception:
        raise HTTPException(400, "This file could not be opened as a video.") from None
    if info.n_frames <= 0 or info.fps <= 0:
        raise HTTPException(400, "This file has no readable video stream.")
    if info.duration > MAX_DURATION_SEC:
        raise HTTPException(
            413,
            f"Clip is {info.duration:.0f} s; the demo accepts up to {MAX_DURATION_SEC:.0f} s. "
            "Trim it and try again.",
        )

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


DIST = ROOT / "web" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    async def spa(path: str) -> FileResponse:
        """Serve built files, falling back to index.html so client-side routes work."""
        candidate = (DIST / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(DIST.resolve()):
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")
