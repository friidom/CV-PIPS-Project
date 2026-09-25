import { useEffect, useRef, useState } from "react";
import { api, getCapabilities } from "../lib/api";
import { GROUP_COLORS, GROUP_NAMES } from "../lib/overlay";
import { Callout, Panel } from "./ui";

const BASE = import.meta.env.BASE_URL;
const CLIP = "C3905";
// The YOLO11s graph is 960 wide, so a webcam frame is sent at that. The sample clip goes at its
// native 1280 so the signal-lamp reader, which samples a few pixels per lamp, keeps them all.
const SEND_WIDTH = { camera: 960, clip: 1280 } as const;
const THETA = 0.5; // the metric's alarm threshold
const TRAIL_POINTS = 24;
const HISTORY_SEC = 60;
const MAX_EVENTS = 40;
const MAX_NET_RETRIES = 3;
const PHASE_HOLD_SEC = 1.0;

type Source = "camera" | "clip";
/** id, group, cx, cy, w, h — fractions of the frame, as server/live.py returns them. */
type LiveBox = [number, number, number, number, number, number];
type Cues = { conflict: number; red_runner: number; braking: number };

interface LiveReply {
  frame: number;
  t: number;
  reset: boolean;
  ms: number;
  device: string;
  detections: number;
  aligned: boolean;
  inliers: number;
  target_fps: number;
  risk: number | null;
  cues: Cues | null;
  phase: string | null;
  boxes: LiveBox[];
}

interface Stats {
  frames: number;
  inferMs: number;
  rttMs: number;
  fps: number;
  tracked: number;
  groups: number[];
  maxId: number;
  device: string | null;
  aligned: boolean | null;
  inliers: number;
  risk: number | null;
  cues: Cues | null;
  phase: string | null;
}

interface LiveEvent {
  key: number;
  t: number;
  kind: "alarm" | "cue" | "signal" | "info";
  text: string;
}

const EMPTY: Stats = {
  frames: 0, inferMs: 0, rttMs: 0, fps: 0, tracked: 0, groups: [0, 0, 0], maxId: 0,
  device: null, aligned: null, inliers: 0, risk: null, cues: null, phase: null,
};
const CUE_TEXT: Record<keyof Cues, string> = {
  conflict: "Collision course: two road users converging (time-to-closest-approach cue)",
  red_runner: "Vehicle crossing the stop line on red",
  braking: "Hard braking",
};
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const newSession = () => `live-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;

/**
 * Live mode: frames from a webcam, or a sample clip played in real time, go to
 * server/live.py one at a time, at the rate the server asks for. Each session is
 * Part B's RiskModel run online: tracked boxes and ids always, and — when the feed
 * aligns to this camera's scene — the risk score, its three cues and the signal phase.
 * One request in flight at most, so a slow link lowers the frame rate instead of
 * building a queue.
 */
export function LiveMode() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxes = useRef<LiveBox[]>([]);
  const trails = useRef(new Map<number, { g: number; pts: [number, number][]; seen: number }>());
  const [source, setSource] = useState<Source>("camera");
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<{ tone: "warn" | "note"; text: string } | null>(null);
  const [stats, setStats] = useState<Stats>(EMPTY);
  const [history, setHistory] = useState<[number, number][]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [gpu, setGpu] = useState<string | null>(null);

  // Capture + send loop, alive while `running`.
  useEffect(() => {
    if (!running) return;
    const video = videoRef.current;
    if (!video) return;
    const session = newSession();
    const tracks = trails.current;
    const close = () => {
      void fetch(api(`/api/live/${session}`), { method: "DELETE", keepalive: true }).catch(() => undefined);
    };
    let stop = false;
    let stream: MediaStream | null = null;
    let t0 = performance.now();
    let eventKey = 0;
    const grab = document.createElement("canvas");

    const log = (t: number, kind: LiveEvent["kind"], text: string) =>
      setEvents((prev) => [{ key: eventKey++, t, kind, text }, ...prev].slice(0, MAX_EVENTS));

    const open = async () => {
      if (source === "camera") {
        if (!window.isSecureContext) {
          throw new Error(
            "Webcam access needs a secure page. Open this site through its https:// address (http://localhost also works during development), or stream the sample clip instead.",
          );
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("This browser does not support camera capture. Stream the sample clip instead.");
        }
        const cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        stream = cam;
        if (stop) {
          cam.getTracks().forEach((tr) => tr.stop()); // stopped while the permission prompt was open
          return;
        }
        video.srcObject = cam;
      } else {
        video.srcObject = null;
        video.src = `${BASE}media/samples/${CLIP}_720p.mp4`;
        video.loop = true;
      }
      video.muted = true;
      await video.play();
      t0 = performance.now();
    };

    const loop = async () => {
      let lastReply = 0;
      let lastSent = 0;
      let fps = 0;
      let failures = 0;
      let targetFps = 6;
      let sent = 0;
      let prev: { risk: number; cues: Cues | null; phase: string | null } = { risk: 0, cues: null, phase: null };
      let phaseCand = { phase: "", since: 0 };
      while (!stop) {
        if (video.readyState < 2 || !video.videoWidth) {
          await sleep(80);
          continue;
        }
        const wait = lastSent + 1000 / targetFps - performance.now();
        if (wait > 0) await sleep(wait);
        if (stop) return;
        lastSent = performance.now();
        const t = source === "clip" ? video.currentTime : (performance.now() - t0) / 1000;
        const width = Math.min(SEND_WIDTH[source], video.videoWidth);
        grab.width = width;
        grab.height = Math.round((width * video.videoHeight) / video.videoWidth);
        grab.getContext("2d")?.drawImage(video, 0, 0, grab.width, grab.height);
        const blob = await new Promise<Blob | null>((r) => grab.toBlob(r, "image/jpeg", 0.8));
        if (!blob || stop) continue;

        const tSend = performance.now();
        let res: Response;
        try {
          res = await fetch(api(`/api/live/${session}?t=${t.toFixed(3)}`), {
            method: "POST",
            body: blob,
            headers: { "Content-Type": "image/jpeg" },
          });
        } catch {
          if (stop) return;
          failures += 1;
          boxes.current = [];
          if (failures > MAX_NET_RETRIES) {
            setNote({ tone: "warn", text: "Lost the connection to the inference server. Check that it is running and reachable, then start again." });
            setRunning(false);
            return;
          }
          setNote({ tone: "note", text: `Connection to the inference server dropped; retrying (${failures}/${MAX_NET_RETRIES})…` });
          await sleep(1000 * failures);
          continue;
        }
        if (stop) return;
        failures = 0;
        if (!res.ok) {
          const detail = await res.json().then((b: { detail?: string }) => b.detail, () => undefined);
          setNote({ tone: res.status === 503 ? "note" : "warn", text: detail ?? `The server answered ${res.status}.` });
          // Boxes from before the pause would sit on traffic that has moved on: drop them.
          boxes.current = [];
          tracks.clear();
          fps = 0;
          setStats((p) => ({ ...p, fps: 0, tracked: 0, groups: [0, 0, 0] }));
          if (res.status !== 503) {
            setRunning(false);
            return;
          }
          await sleep(2000); // busy (an upload has priority) or still loading: try again shortly
          lastReply = 0;
          continue;
        }
        const data = (await res.json()) as LiveReply;
        if (stop) return;
        setNote(null);
        const now = performance.now();
        if (lastReply) fps = fps ? fps * 0.8 + (1000 / (now - lastReply)) * 0.2 : 1000 / (now - lastReply);
        lastReply = now;
        targetFps = data.target_fps || targetFps;
        sent += 1;

        if (data.reset || data.frame === 1) {
          tracks.clear();
          setHistory([]);
          prev = { risk: 0, cues: null, phase: null };
          phaseCand = { phase: "", since: 0 };
          if (data.reset) log(data.t, "info", "Sample clip looped: tracker and risk state restarted");
          else if (data.aligned) log(data.t, "info", `Feed aligned to this camera's scene (${data.inliers} SIFT inliers): risk model active`);
          else log(data.t, "info", "Feed does not match this camera's scene: detection and tracking only");
        }

        boxes.current = data.boxes;
        const groups = [0, 0, 0];
        for (const b of data.boxes) {
          if (b[1] < 3) groups[b[1]] += 1;
          const tr = tracks.get(b[0]) ?? { g: b[1], pts: [], seen: 0 };
          tr.pts.push([b[2], b[3] + b[5] / 2]); // the foot point, as the pipeline tracks it
          if (tr.pts.length > TRAIL_POINTS) tr.pts.shift();
          tr.seen = sent;
          tracks.set(b[0], tr);
        }
        for (const [id, tr] of tracks) if (sent - tr.seen > 8) tracks.delete(id);

        if (data.risk !== null) {
          const risk = data.risk;
          setHistory((h) => [...h.filter(([ht]) => ht > data.t - HISTORY_SEC && ht <= data.t), [data.t, risk]]);
          if (risk >= THETA && prev.risk < THETA) {
            log(data.t, "alarm", `Risk alarm: score ${risk.toFixed(2)} crossed θ = ${THETA}`);
          }
          if (data.cues) {
            for (const k of Object.keys(CUE_TEXT) as (keyof Cues)[]) {
              if (data.cues[k] > 0 && !(prev.cues && prev.cues[k] > 0)) log(data.t, "cue", `${CUE_TEXT[k]} (${data.cues[k].toFixed(2)})`);
            }
          }
          // A phase enters the log once it has held for PHASE_HOLD_SEC: single-frame lamp misreads stay out.
          let phase = prev.phase;
          if (data.phase && data.phase !== "unknown") {
            if (data.phase !== phaseCand.phase) phaseCand = { phase: data.phase, since: data.t };
            if (data.phase !== phase && data.t - phaseCand.since >= PHASE_HOLD_SEC) {
              if (phase) log(phaseCand.since, "signal", `East-bound signal turned ${data.phase}`);
              phase = data.phase;
            }
          }
          prev = { risk, cues: data.cues, phase };
        }

        const ids = data.boxes.map((b) => b[0]);
        setStats((p) => ({
          frames: sent,
          inferMs: data.ms,
          rttMs: now - tSend,
          fps,
          tracked: data.boxes.length,
          groups,
          maxId: data.reset ? Math.max(0, ...ids) : Math.max(p.maxId, ...ids),
          device: data.device,
          aligned: data.aligned,
          inliers: data.inliers,
          risk: data.risk,
          cues: data.cues,
          phase: data.phase,
        }));
      }
    };

    const failed = (e: Error) => {
      if (stop) return;
      const camera = source === "camera";
      const text =
        camera && (e.name === "NotAllowedError" || e.name === "SecurityError")
          ? "Camera permission was refused. Allow camera access for this site in the browser, or stream the sample clip instead."
          : camera && (e.name === "NotFoundError" || e.name === "OverconstrainedError")
            ? "No camera was found. Stream the sample clip instead."
            : camera && e.name === "NotReadableError"
              ? "The camera is in use by another application, or the system blocked it. Close that application and try again."
              : !camera && (e.name === "NotSupportedError" || e.name === "NotAllowedError")
                ? "The sample clip could not be played in this browser."
                : e.message;
      setNote({ tone: "warn", text });
      setRunning(false);
    };

    const onPageHide = () => close();
    window.addEventListener("pagehide", onPageHide);
    open()
      .then(() => (stop ? undefined : loop()))
      .catch(failed);

    return () => {
      stop = true;
      window.removeEventListener("pagehide", onPageHide);
      close();
      boxes.current = [];
      tracks.clear();
      stream?.getTracks().forEach((tr) => tr.stop());
      video.pause();
      video.srcObject = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [running, source]);

  // Draw loop: trails and the latest boxes over the picture, wherever object-contain put it.
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
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      if (!video.videoWidth) return;
      const s = Math.min(cw / video.videoWidth, ch / video.videoHeight);
      const rw = video.videoWidth * s;
      const rh = video.videoHeight * s;
      const rx = (cw - rw) / 2;
      const ry = (ch - rh) / 2;
      ctx.lineWidth = 1.4;
      ctx.globalAlpha = 0.55;
      for (const { g, pts } of trails.current.values()) {
        if (pts.length < 2) continue;
        ctx.strokeStyle = colors[g] ?? colors[1];
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(rx + x * rw, ry + y * rh) : ctx.moveTo(rx + x * rw, ry + y * rh)));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.6;
      ctx.font = '600 10px ui-monospace, "JetBrains Mono", monospace';
      for (const [id, g, x, y, w, h] of boxes.current) {
        const bw = w * rw;
        const bh = h * rh;
        const bx = rx + x * rw - bw / 2;
        const by = ry + y * rh - bh / 2;
        ctx.strokeStyle = ctx.fillStyle = colors[g] ?? colors[1];
        ctx.strokeRect(bx, by, bw, bh);
        if (bw > 18) ctx.fillText(String(id).padStart(3, "0"), bx, by - 3);
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
    setHistory([]);
    setEvents([]);
    setNote(null);
    setRunning(true);
    getCapabilities()
      .then((c) => setGpu(c.gpu))
      .catch(() => setGpu(null));
  };

  const onGpu = stats.device?.startsWith("cuda");
  const deviceLabel = stats.device ? (onGpu ? `GPU${gpu ? ` · ${gpu}` : ""}` : "CPU") : null;
  const hot = stats.risk !== null && stats.risk >= THETA;

  return (
    <div className="space-y-4">
      <div className="brackets overflow-hidden rounded-xl border border-line bg-black">
        <div className="relative aspect-video bg-black">
          <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-contain" />
          <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />
          {!running && (
            <div className="absolute inset-0 grid place-items-center p-6 text-center">
              <div>
                <p className="num text-[10px] uppercase tracking-[0.2em] text-white/60">Live inference &middot; extra credit</p>
                <p className="mt-2 text-sm text-white/80">Detection, tracking and the causal risk model on a real-time feed.</p>
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
                    Run sample stream {CLIP}
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
                live inference &middot; {source === "camera" ? "webcam" : `${CLIP} streamed in real time`}
              </span>
              {deviceLabel && <Chip>{deviceLabel}</Chip>}
              <Chip>
                {stats.fps.toFixed(1)} fps &middot; {stats.rttMs ? `${stats.rttMs.toFixed(0)} ms` : "—"}
              </Chip>
              <Chip>
                tracked <b className="text-white">{stats.tracked}</b>
              </Chip>
              {stats.risk !== null && (
                <span
                  className={`num rounded px-1.5 py-1 text-[10px] uppercase tracking-wider ${hot ? "bg-bad text-white" : "bg-black/70 text-white/80"}`}
                >
                  risk <b className={hot ? "" : "text-white"}>{stats.risk.toFixed(2)}</b>
                  {hot && " · alarm"}
                </span>
              )}
              {stats.phase && stats.phase !== "unknown" && <Chip>signal {stats.phase}</Chip>}
              {note?.tone === "note" && (
                <span className="num rounded bg-accent/90 px-1.5 py-1 text-[10px] uppercase tracking-wider text-accentink">paused</span>
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <LiveStat label="Server inference" value={stats.inferMs ? `${stats.inferMs.toFixed(0)} ms` : "—"} hint={`YOLO11s + tracker + risk, on ${stats.device ?? "—"}`} />
        <LiveStat label="Round trip" value={stats.rttMs ? `${stats.rttMs.toFixed(0)} ms` : "—"} hint="encode, upload, infer, reply" />
        <LiveStat label="Processed" value={stats.fps ? `${stats.fps.toFixed(1)} fps` : "—"} hint="paced to what the server asks for" />
        <LiveStat label="Frames processed" value={stats.frames || "—"} hint="this session" />
        <LiveStat label="Tracks started" value={stats.maxId || "—"} hint="confirmed ids so far" />
        <LiveStat
          label="Scene"
          value={stats.aligned === null ? "—" : stats.aligned ? "aligned" : "not this camera"}
          hint={stats.aligned === null ? "matched on the first frame" : `${stats.inliers} SIFT inliers (≥ 40 needed)`}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel className="p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted">Accident risk, live</div>
          {stats.aligned === false ? (
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              Not computed: this feed does not align to the camera&rsquo;s reference view, and every risk cue is
              measured against that scene (road mask, stop line, signal lamps). Run the sample stream to see it.
            </p>
          ) : (
            <>
              <RiskSpark history={history} />
              <div className="mt-3 space-y-1.5">
                {(Object.keys(CUE_TEXT) as (keyof Cues)[]).map((k) => (
                  <CueBar key={k} label={k === "red_runner" ? "red runner" : k} value={stats.cues?.[k] ?? null} />
                ))}
              </div>
            </>
          )}
        </Panel>
        <Panel className="p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted">Live detections &amp; events</div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {GROUP_NAMES.slice(0, 3).map((n, g) => (
              <span key={n} className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: GROUP_COLORS[g] }} />
                {n} <b className="num text-text">{running ? stats.groups[g] : "—"}</b>
              </span>
            ))}
          </div>
          <ol className="mt-3 max-h-48 space-y-1 overflow-y-auto text-[12px]" aria-live="polite">
            {events.length === 0 && <li className="text-faint">Nothing yet.</li>}
            {events.map((e) => (
              <li key={e.key} className="flex gap-2">
                <span className="num w-12 shrink-0 text-faint">{e.t.toFixed(1)} s</span>
                <span className={e.kind === "alarm" ? "font-semibold text-bad" : e.kind === "cue" ? "text-accent" : "text-muted"}>{e.text}</span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>

      <Panel className="p-4">
        <p className="text-[12px] leading-relaxed text-muted">
          What runs live is the causal, per-frame half of the system: each browser session gets its own instance of
          Part B&rsquo;s risk model &mdash; the YOLO11s detector, the online tracker, and the conflict, red-runner and
          braking cues &mdash; fed only the frames seen so far. The first frame is aligned to this camera&rsquo;s
          reference view; if it does not match (a webcam pointed anywhere else), only detection and tracking run,
          because every cue is measured against the calibrated scene. Part A&rsquo;s event rules do not run live: they
          need the whole clip (a median background, per-video signal thresholds). Frames are sampled at the rate the
          server asks for (6 per second when the risk model runs, its calibrated rate), processed and discarded;
          nothing is stored.
        </p>
      </Panel>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="num rounded bg-black/70 px-1.5 py-1 text-[10px] uppercase tracking-wider text-white/80">{children}</span>;
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

function CueBar({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-20 shrink-0 text-muted">{label}</span>
      <span className="relative h-1.5 flex-1 overflow-hidden rounded bg-panel2">
        <span className="absolute inset-y-0 left-0 rounded bg-accent" style={{ width: `${Math.min(1, value ?? 0) * 100}%` }} />
      </span>
      <span className="num w-9 text-right text-text">{value === null ? "—" : value.toFixed(2)}</span>
    </div>
  );
}

/** The last minute of the live score, with the metric's θ = 0.5 alarm line. */
function RiskSpark({ history }: { history: [number, number][] }) {
  const W = 300;
  const H = 64;
  if (history.length < 2) {
    return <div className="mt-2 grid h-16 place-items-center text-[11px] text-faint">waiting for the score…</div>;
  }
  const t1 = history[history.length - 1][0];
  const t0 = Math.min(history[0][0], t1 - 10);
  const x = (t: number) => ((t - t0) / Math.max(t1 - t0, 1e-3)) * W;
  const y = (v: number) => H - v * H;
  const line = history.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-16 w-full" preserveAspectRatio="none" role="img" aria-label="Live risk score">
      <line x1={0} x2={W} y1={y(THETA)} y2={y(THETA)} stroke="var(--bad)" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <path d={`${line}L${x(t1).toFixed(1)},${H}L${x(history[0][0]).toFixed(1)},${H}Z`} fill="color-mix(in srgb, var(--accent) 18%, transparent)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
