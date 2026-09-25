import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { GROUP_COLORS, GROUP_NAMES } from "../lib/overlay";
import { Callout, Panel } from "./ui";

const BASE = import.meta.env.BASE_URL;
const SEND_WIDTH = 960; // the YOLO11s graph is 960 wide; sending more is wasted bandwidth
const CLIP = "C3905";

type Source = "camera" | "clip";
/** id, group, cx, cy, w, h — fractions of the frame, as server/live.py returns them. */
type LiveBox = [number, number, number, number, number, number];

interface Stats {
  frames: number;
  inferMs: number;
  rttMs: number;
  fps: number;
  tracked: number;
  groups: number[];
  maxId: number;
}

const EMPTY: Stats = { frames: 0, inferMs: 0, rttMs: 0, fps: 0, tracked: 0, groups: [0, 0, 0], maxId: 0 };
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * Live mode: frames from a webcam, or a sample clip played in real time, go to
 * server/live.py one at a time; the tracked boxes come back and are drawn over
 * the feed. One request in flight at most, so a slow server lowers the frame
 * rate instead of building a queue.
 */
export function LiveMode() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxes = useRef<LiveBox[]>([]);
  const session = useRef(`live-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`);
  const [source, setSource] = useState<Source>("camera");
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<{ tone: "warn" | "note"; text: string } | null>(null);
  const [stats, setStats] = useState<Stats>(EMPTY);

  // Capture + send loop, alive while `running`.
  useEffect(() => {
    if (!running) return;
    const video = videoRef.current;
    if (!video) return;
    let stop = false;
    let stream: MediaStream | null = null;
    const grab = document.createElement("canvas");

    const open = async () => {
      if (source === "camera") {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("This browser only allows camera access on a secure (https) page.");
        }
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        video.srcObject = stream;
      } else {
        video.srcObject = null;
        video.src = `${BASE}media/samples/${CLIP}_720p.mp4`;
        video.loop = true;
      }
      video.muted = true;
      await video.play();
    };

    const loop = async () => {
      let last = performance.now();
      let fps = 0;
      while (!stop) {
        if (video.readyState < 2 || !video.videoWidth) {
          await sleep(80);
          continue;
        }
        grab.width = SEND_WIDTH;
        grab.height = Math.round((SEND_WIDTH * video.videoHeight) / video.videoWidth);
        grab.getContext("2d")?.drawImage(video, 0, 0, grab.width, grab.height);
        const blob = await new Promise<Blob | null>((r) => grab.toBlob(r, "image/jpeg", 0.8));
        if (!blob || stop) continue;
        const t0 = performance.now();
        let res: Response;
        try {
          res = await fetch(api(`/api/live/${session.current}`), {
            method: "POST",
            body: blob,
            headers: { "Content-Type": "image/jpeg" },
          });
        } catch {
          setNote({ tone: "warn", text: "The inference server is unreachable. Live mode needs server/app.py running." });
          setRunning(false);
          return;
        }
        if (stop) return;
        if (!res.ok) {
          const detail = await res.json().then((b: { detail?: string }) => b.detail, () => undefined);
          setNote({ tone: res.status === 503 ? "note" : "warn", text: detail ?? `The server answered ${res.status}.` });
          // Boxes from before the pause would sit on traffic that has moved on: drop them.
          boxes.current = [];
          fps = 0;
          setStats((p) => ({ ...p, fps: 0, tracked: 0, groups: [0, 0, 0] }));
          if (res.status !== 503) {
            setRunning(false);
            return;
          }
          await sleep(2000); // an upload has priority; try again shortly
          last = performance.now();
          continue;
        }
        setNote(null);
        const data = (await res.json()) as { frame: number; ms: number; boxes: LiveBox[] };
        const now = performance.now();
        fps = fps ? fps * 0.8 + (1000 / (now - last)) * 0.2 : 1000 / (now - last);
        last = now;
        boxes.current = data.boxes;
        const groups = [0, 0, 0];
        for (const b of data.boxes) if (b[1] < 3) groups[b[1]] += 1;
        setStats((p) => ({
          frames: data.frame,
          inferMs: data.ms,
          rttMs: now - t0,
          fps,
          tracked: data.boxes.length,
          groups,
          maxId: Math.max(p.maxId, ...data.boxes.map((b) => b[0])),
        }));
      }
    };

    open()
      .then(loop)
      .catch((e: Error) => {
        const text =
          e.name === "NotAllowedError"
            ? "Camera permission was refused. Allow it in the browser, or stream the sample clip instead."
            : e.name === "NotFoundError"
              ? "No camera was found. Stream the sample clip instead."
              : e.message;
        setNote({ tone: "warn", text });
        setRunning(false);
      });

    return () => {
      stop = true;
      boxes.current = [];
      video.pause();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [running, source]);

  // Draw loop: the latest boxes over the picture, wherever object-contain put it.
  useEffect(() => {
    if (!running) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const colors = GROUP_COLORS.map((_, i) => getComputedStyle(canvas).getPropertyValue(`--g${i}`).trim() || "#78dc78");
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (canvas.width !== Math.round(cw * dpr)) canvas.width = Math.round(cw * dpr);
      if (canvas.height !== Math.round(ch * dpr)) canvas.height = Math.round(ch * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx || !video.videoWidth) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      const s = Math.min(cw / video.videoWidth, ch / video.videoHeight);
      const rw = video.videoWidth * s;
      const rh = video.videoHeight * s;
      const rx = (cw - rw) / 2;
      const ry = (ch - rh) / 2;
      ctx.font = '600 10px ui-monospace, "JetBrains Mono", monospace';
      for (const [id, g, x, y, w, h] of boxes.current) {
        const bw = w * rw;
        const bh = h * rh;
        const bx = rx + x * rw - bw / 2;
        const by = ry + y * rh - bh / 2;
        ctx.strokeStyle = ctx.fillStyle = colors[g] ?? colors[1];
        ctx.lineWidth = 1.6;
        ctx.strokeRect(bx, by, bw, bh);
        if (bw > 24) ctx.fillText(String(id).padStart(3, "0"), bx, by - 3);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [running]);

  const start = (src: Source) => {
    setSource(src);
    setStats(EMPTY);
    setNote(null);
    setRunning(true);
  };

  return (
    <div className="space-y-4">
      <div className="brackets overflow-hidden rounded-xl border border-line bg-black">
        <div className="relative aspect-video bg-black">
          <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-contain" />
          <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />
          {!running && (
            <div className="absolute inset-0 grid place-items-center p-6 text-center">
              <div>
                <p className="text-sm text-white/80">Live detection and tracking on a real-time feed.</p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => start("camera")}
                    className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accentink transition-opacity hover:opacity-90"
                  >
                    Use my webcam
                  </button>
                  <button
                    type="button"
                    onClick={() => start("clip")}
                    className="rounded-md border border-white/25 px-4 py-2 text-sm text-white/85 transition-colors hover:bg-white/10"
                  >
                    Stream sample clip {CLIP}
                  </button>
                </div>
              </div>
            </div>
          )}
          {running && (
            <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-center gap-1.5 p-2.5">
              <span className="num inline-flex items-center gap-1.5 rounded bg-black/70 px-1.5 py-1 text-[10px] uppercase tracking-wider text-white/85">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="pulse-ring absolute inline-flex h-full w-full rounded-full bg-bad" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-bad" />
                </span>
                live &middot; {source === "camera" ? "webcam" : `${CLIP} played in real time`}
              </span>
              <span className="num rounded bg-black/70 px-1.5 py-1 text-[10px] uppercase tracking-wider text-white/80">
                tracked <b className="text-white">{stats.tracked}</b>
              </span>
              <span className="num rounded bg-black/70 px-1.5 py-1 text-[10px] uppercase tracking-wider text-white/80">
                {stats.fps.toFixed(1)} fps processed
              </span>
              {note?.tone === "note" && (
                <span className="num rounded bg-accent/90 px-1.5 py-1 text-[10px] uppercase tracking-wider text-accentink">
                  paused &middot; an upload has priority
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panel px-3 py-2">
          {running ? (
            <button
              type="button"
              onClick={() => setRunning(false)}
              className="rounded-md border border-line px-3 py-1.5 text-xs text-text transition-colors hover:bg-panel2"
            >
              Stop
            </button>
          ) : (
            <span className="text-xs text-muted">Stopped</span>
          )}
          <span className="num ml-auto text-[11px] text-faint">
            boxes are from the last processed frame, about {stats.rttMs ? stats.rttMs.toFixed(0) : "—"} ms behind the picture
          </span>
        </div>
      </div>

      {note && (
        <Callout tone={note.tone === "warn" ? "warn" : "note"} title={note.tone === "warn" ? "Live mode stopped" : "Paused"}>
          {note.text}
        </Callout>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <LiveStat label="Server inference" value={stats.inferMs ? `${stats.inferMs.toFixed(0)} ms` : "—"} hint="YOLO11s + tracker, per frame" />
        <LiveStat label="Round trip" value={stats.rttMs ? `${stats.rttMs.toFixed(0)} ms` : "—"} hint="encode, upload, infer, reply" />
        <LiveStat label="Frames processed" value={stats.frames || "—"} hint="this session" />
        <LiveStat label="Tracks started" value={stats.maxId || "—"} hint="confirmed ids so far" />
      </div>

      <Panel className="p-4">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
          {GROUP_NAMES.slice(0, 3).map((n, g) => (
            <span key={n} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: GROUP_COLORS[g] }} />
              {n} <b className="num text-text">{running ? stats.groups[g] : "—"}</b>
            </span>
          ))}
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-muted">
          What runs live is the causal, per-frame part of the system: the YOLO11s detector Part B uses and the same
          online tracker. The event rules and the risk score do not run on a live feed &mdash; they need this
          camera&rsquo;s calibrated scene geometry and whole-clip context (a median background for alignment, a
          signal threshold fitted per video), which a webcam cannot provide. Frames are sent at {SEND_WIDTH} px wide,
          processed and discarded; nothing is stored.
        </p>
      </Panel>
    </div>
  );
}

function LiveStat({ label, value, hint }: { label: string; value: React.ReactNode; hint: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-3">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="num mt-1 text-lg font-semibold leading-none">{value}</div>
      <div className="mt-1 text-[10px] text-faint">{hint}</div>
    </div>
  );
}
