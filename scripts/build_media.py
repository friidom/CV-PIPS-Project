"""Generate the web-playable media for the sample clips.

    python scripts/build_media.py --videos samples

For each clip found it writes, into web/public/media/samples/:
  <stem>_720p.mp4        H.264 proxy the site plays (the 4K originals are 2+ GB)
  <stem>_poster.jpg      first-frame poster so the player does not start black
  <stem>_annotated.mp4   tools/render_video.py output, re-encoded for the web

The annotated render needs cache/<name>.perception.npz (tools/cache_perception.py)
and predictions_samples.json. Missing inputs are skipped and reported, never faked.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "public" / "media" / "samples"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

PROXY_WIDTH = 1280


def run(args: list[str]) -> None:
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-8:])
        raise RuntimeError(f"ffmpeg failed ({proc.returncode}):\n{tail}")


def make_proxy(src: Path, dst: Path) -> None:
    run([
        FFMPEG, "-y", "-loglevel", "error", "-i", str(src),
        "-vf", f"scale={PROXY_WIDTH}:-2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
        "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart",
        str(dst),
    ])


def make_poster(src: Path, dst: Path) -> None:
    run([
        FFMPEG, "-y", "-loglevel", "error", "-i", str(src),
        "-frames:v", "1", "-q:v", "4", str(dst),
    ])


def make_annotated(name: str, proxy: Path, dst: Path) -> None:
    raw = OUT / f"{Path(name).stem}_annotated_raw.mp4"
    env_path = f"{ROOT / 'src'}{';' if sys.platform == 'win32' else ':'}{ROOT / 'tools'}"
    subprocess.run(
        [sys.executable, str(ROOT / "tools" / "render_video.py"), name,
         "--proxy", str(proxy), "--pred", str(ROOT / "predictions_samples.json"),
         "--out", str(raw), "--width", str(PROXY_WIDTH)],
        cwd=ROOT, check=True,
        env={**__import__("os").environ, "PYTHONPATH": env_path, "PYTHONIOENCODING": "utf-8"},
    )
    run([
        FFMPEG, "-y", "-loglevel", "error", "-i", str(raw),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "27",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dst),
    ])
    raw.unlink(missing_ok=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", default="samples", help="folder with the sample .mp4 files")
    ap.add_argument("--force", action="store_true", help="rebuild files that already exist")
    ap.add_argument("--skip-annotated", action="store_true")
    args = ap.parse_args()

    src_dir = ROOT / args.videos if not Path(args.videos).is_absolute() else Path(args.videos)
    if not src_dir.exists():
        print(f"no such folder: {src_dir}")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)

    videos = sorted(p for p in src_dir.iterdir() if p.suffix.lower() == ".mp4")
    if not videos:
        print(f"no .mp4 files in {src_dir}")
        return 0

    for src in videos:
        stem = src.stem
        proxy = OUT / f"{stem}_720p.mp4"
        poster = OUT / f"{stem}_poster.jpg"
        annotated = OUT / f"{stem}_annotated.mp4"

        if args.force or not proxy.exists():
            print(f"[{src.name}] proxy -> {proxy.name}", flush=True)
            make_proxy(src, proxy)
        if args.force or not poster.exists():
            print(f"[{src.name}] poster -> {poster.name}", flush=True)
            make_poster(proxy, poster)
        if args.skip_annotated:
            continue
        if not (ROOT / "cache" / f"{src.name}.perception.npz").exists():
            print(f"[{src.name}] skipping annotated render: no cached perception")
            continue
        if args.force or not annotated.exists():
            print(f"[{src.name}] annotated -> {annotated.name}", flush=True)
            make_annotated(src.name, proxy, annotated)

    for p in sorted(OUT.iterdir()):
        print(f"  {p.name}  {p.stat().st_size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
