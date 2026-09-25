import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { byClassOrder, classColor, classLabel } from "../lib/classes";
import { pad3, regionLabel, type EventFact } from "../lib/events";
import { timecode } from "../lib/format";
import {
  boxesAt,
  frameIndexAt,
  GROUP_COLORS,
  GROUP_NAMES,
  PHASE_COLORS,
  PHASE_NAMES,
  trailsAt,
  type OverlayData,
} from "../lib/overlay";
import { useGliding, usePlayback } from "../lib/playback";
import type { Alignment, EventTuple } from "../lib/types";

const RATES = [0.25, 0.5, 1, 1.5, 2, 4];
const TRAIL_FRAMES = 10;

interface Props {
  src: string;
  poster?: string | null;
  events?: EventTuple[];
  label?: string;
  /** Nominal frame rate, used by the frame-step buttons. */
  fps?: number;
  /** Real tracker output for this clip; enables the analysis overlay. */
  overlay?: OverlayData | null;
  alignment?: Alignment | null;
  /** Evidence per event, same order as `events`, for the jump notice. */
  facts?: EventFact[] | null;
}

/** Where the picture actually sits inside the element under object-contain. */
function contentRect(el: HTMLVideoElement) {
  const { clientWidth: cw, clientHeight: ch, videoWidth: vw, videoHeight: vh } = el;
  if (!vw || !vh) return { x: 0, y: 0, w: cw, h: ch };
  const scale = Math.min(cw / vw, ch / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

function cssVar(el: HTMLElement, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || "#888888";
}

/**
 * The player: raw camera with the system's reading of it drawn on top, both on
 * one clock.
 *
 * The overlay canvas reads video.currentTime inside its own animation frame
 * rather than following the React clock. The shared clock is deliberately
 * throttled for the timeline and the risk curve, and boxes drawn even one frame
 * late visibly slide off the traffic underneath them.
 */
export function VideoStage({
  src,
  poster,
  events = [],
  label,
  fps = 29.97,
  overlay,
  alignment,
  facts,
}: Props) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const { registerVideo, currentTime, duration, setDuration, playing, togglePlay, seek, selected, select, jump } =
    usePlayback();
  const gliding = useGliding();
  // The draw loop runs outside React; it reads the picked event from here.
  const pickRef = useRef<EventTuple | null>(null);
  pickRef.current = selected !== null ? (events[selected] ?? null) : null;

  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);
  const [showOverlay, setShowOverlay] = useState(true);
  const [showTrails, setShowTrails] = useState(true);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(true);
  const [full, setFull] = useState(false);
  const [scrub, setScrub] = useState<{ t: number; x: number } | null>(null);
  const [hud, setHud] = useState({ tracked: 0, drawn: 0, phase: 0 });

  useEffect(() => {
    registerVideo(ref.current);
    return () => registerVideo(null);
  }, [registerVideo, src]);

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.volume = volume;
    ref.current.muted = muted;
  }, [volume, muted]);

  useEffect(() => setFailed(false), [src]);

  useEffect(() => {
    const on = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = ref.current;
    const wrap = wrapRef.current;
    if (!canvas || !video || !wrap || !overlay || !showOverlay) return;

    const colors = {
      cyan: cssVar(wrap, "--cyan"),
      g: GROUP_COLORS.map((_, i) => cssVar(wrap, `--g${i}`)),
    };
    let raf = 0;
    let lastHud = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = video.clientWidth;
      const chh = video.clientHeight;
      if (!cw || !chh) return;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(chh * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(chh * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, chh);

      const r = contentRect(video);
      const t = video.currentTime - overlay.t0;
      if (t < 0 || t > overlay.duration) return;
      const fi = frameIndexAt(overlay, t);
      const boxes = boxesAt(overlay, fi);

      if (showTrails) {
        ctx.lineWidth = 1.4;
        for (const [, pts] of trailsAt(overlay, fi, TRAIL_FRAMES)) {
          if (pts.length < 2) continue;
          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) {
            const X = r.x + pts[i].x * r.w;
            const Y = r.y + pts[i].y * r.h;
            if (i === 0) ctx.moveTo(X, Y);
            else ctx.lineTo(X, Y);
          }
          ctx.globalAlpha = 0.35;
          ctx.strokeStyle = colors.g[pts[0].g] ?? colors.cyan;
          ctx.stroke();
        }
      }

      ctx.font = '600 10px ui-monospace, "JetBrains Mono", monospace';
      // Same-class segments never overlap (a task rule), so inside the picked
      // event's span, its label on a box means that box is its evidence.
      const pick = pickRef.current;
      const pickLabel = pick && video.currentTime >= pick[0] && video.currentTime <= pick[1] ? pick[2] : null;
      for (const b of boxes) {
        const bw = Math.max(5, b.w * r.w);
        const bh = Math.max(5, b.h * r.h);
        const x = r.x + b.x * r.w - bw / 2;
        const y = r.y + b.y * r.h - bh / 2;
        // Evidence.tids from the event rules wins over the tracker group, so a
        // red-light runner reads red here exactly as it does in the offline render.
        const col = b.ev ? classColor(b.ev) : (colors.g[b.g] ?? colors.cyan);
        const picked = pickLabel !== null && b.ev === pickLabel;
        if (picked) {
          ctx.globalAlpha = 0.16;
          ctx.fillStyle = col;
          ctx.fillRect(x, y, bw, bh);
        }
        ctx.globalAlpha = b.ev ? 1 : 0.9;
        ctx.strokeStyle = col;
        ctx.lineWidth = picked ? 3.2 : b.ev ? 2.4 : 1.2;
        const k = Math.min(bw, bh) * 0.28;
        ctx.beginPath();
        ctx.moveTo(x, y + k);
        ctx.lineTo(x, y);
        ctx.lineTo(x + k, y);
        ctx.moveTo(x + bw - k, y);
        ctx.lineTo(x + bw, y);
        ctx.lineTo(x + bw, y + k);
        ctx.moveTo(x + bw, y + bh - k);
        ctx.lineTo(x + bw, y + bh);
        ctx.lineTo(x + bw - k, y + bh);
        ctx.moveTo(x + k, y + bh);
        ctx.lineTo(x, y + bh);
        ctx.lineTo(x, y + bh - k);
        ctx.stroke();
        if (b.ev) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = col;
          ctx.fillText(`${picked ? "▸ " : ""}${String(b.id).padStart(3, "0")} ${classLabel(b.ev)}`, x, y - 4);
        } else if (bw > 30 && bh > 18) {
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = col;
          ctx.fillText(String(b.id).padStart(3, "0"), x, y - 3);
        }
      }

      if (now - lastHud > 125) {
        lastHud = now;
        setHud({ tracked: overlay.n?.[fi] ?? boxes.length, drawn: boxes.length, phase: overlay.phase[fi] ?? 0 });
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [overlay, showOverlay, showTrails]);

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const bar = barRef.current;
      if (!bar || !duration) return;
      const r = bar.getBoundingClientRect();
      seek(((clientX - r.left) / r.width) * duration);
    },
    [duration, seek],
  );

  const toggleFull = useCallback(async () => {
    const el = wrapRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {
      /* the browser refused fullscreen; the player just stays inline */
    }
  }, []);

  // Step through events by start time, the way an operator reviews a shift.
  const stepEvent = (dir: 1 | -1) => {
    const order = events.map((e, i) => ({ s: e[0], i })).sort((a, b) => a.s - b.s);
    const hit =
      dir > 0
        ? order.find((o) => o.s > currentTime + 0.05)
        : [...order].reverse().find((o) => o.s < currentTime - 0.5);
    if (hit) select(hit.i, hit.s);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 5;
    const keys: Record<string, () => void> = {
      " ": togglePlay,
      k: togglePlay,
      ArrowLeft: () => seek(Math.max(0, currentTime - step)),
      ArrowRight: () => seek(currentTime + step),
      ",": () => seek(Math.max(0, currentTime - 1 / fps)),
      ".": () => seek(currentTime + 1 / fps),
      m: () => setMuted((v) => !v),
      f: () => void toggleFull(),
      o: () => setShowOverlay((v) => !v),
      n: () => stepEvent(1),
      p: () => stepEvent(-1),
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  const active = events.filter((e) => currentTime >= e[0] && currentTime <= e[1]);
  const lanes = [...new Set(events.map((e) => e[2]))].sort(byClassOrder);
  const scrubEvents = scrub ? events.filter((e) => scrub.t >= e[0] && scrub.t <= e[1]) : [];
  const pct = duration ? (currentTime / duration) * 100 : 0;

  if (failed) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-xl border border-line bg-panel px-6 text-center text-sm text-muted">
        This video could not be loaded from <span className="num mx-1 break-all">{src}</span>
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKey}
      className="brackets overflow-hidden rounded-xl border border-line bg-black focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <div className="relative bg-black">
        <video
          ref={ref}
          src={src}
          poster={poster ?? undefined}
          preload="metadata"
          playsInline
          muted={muted}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onError={() => setFailed(true)}
          onClick={togglePlay}
          className="block max-h-[62vh] w-full cursor-pointer bg-black object-contain"
        />
        {overlay && showOverlay && (
          <canvas
            ref={canvasRef}
            className="pointer-events-none absolute inset-0 h-full w-full"
            aria-hidden="true"
          />
        )}

        {jump?.index != null && events[jump.index] && (
          <JumpNotice key={jump.id} event={events[jump.index]} fact={facts?.[jump.index]} />
        )}

        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start gap-1.5 p-2.5">
          {label && <Chip>{label}</Chip>}
          <Chip>{timecode(currentTime)}</Chip>
          <Chip>f{String(Math.round(currentTime * fps)).padStart(5, "0")}</Chip>
          {overlay && showOverlay && (
            <>
              <Chip>
                tracks <b className="mx-1 font-semibold text-white">{hud.tracked}</b>
                {hud.drawn < hud.tracked && <span className="opacity-60">({hud.drawn} shown)</span>}
              </Chip>
              <Chip>
                <span
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: PHASE_COLORS[hud.phase] }}
                />
                eb {PHASE_NAMES[hud.phase]}
              </Chip>
            </>
          )}
          {alignment && (
            <Chip>
              <span
                className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: alignment.aligned ? "var(--ok)" : "var(--bad)" }}
              />
              {alignment.inliers} inliers
            </Chip>
          )}
          <div className="ml-auto flex flex-wrap justify-end gap-1.5">
            {active.map((e, i) => (
              <span
                key={`${e[2]}-${i}`}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-semibold text-black"
                style={{ background: classColor(e[2]) }}
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span className="pulse-ring absolute inline-flex h-full w-full rounded-full bg-black/60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-black/70" />
                </span>
                {classLabel(e[2])}
              </span>
            ))}
          </div>
        </div>

        {overlay && showOverlay && (
          <div className="pointer-events-none absolute bottom-2.5 left-2.5 flex flex-wrap gap-1.5">
            {GROUP_NAMES.slice(0, 3).map((n, i) => (
              <Chip key={n}>
                <span
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-[1px]"
                  style={{ background: GROUP_COLORS[i] }}
                />
                {n}
              </Chip>
            ))}
          </div>
        )}

        {!playing && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label="Play"
            className="absolute inset-0 grid place-items-center bg-black/25"
          >
            <span className="grid h-14 w-14 place-items-center rounded-full bg-accent/95 text-accentink shadow-lg transition-transform hover:scale-105">
              <svg width="16" height="18" viewBox="0 0 11 12" fill="currentColor" aria-hidden="true">
                <path d="M0 0.8v10.4a.8.8 0 0 0 1.22.68l8.4-5.2a.8.8 0 0 0 0-1.36L1.22.12A.8.8 0 0 0 0 .8Z" />
              </svg>
            </span>
          </button>
        )}
      </div>

      <div className="border-t border-line bg-panel px-2.5 pb-2 pt-2.5">
        <div
          ref={barRef}
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          aria-valuetext={timecode(currentTime)}
          className="relative cursor-pointer select-none py-1.5"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromPointer(e.clientX);
          }}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            setScrub({ t: p * duration, x: p * r.width });
            if (e.currentTarget.hasPointerCapture(e.pointerId)) seekFromPointer(e.clientX);
          }}
          onPointerLeave={() => setScrub(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") seek(Math.max(0, currentTime - 5));
            if (e.key === "ArrowRight") seek(currentTime + 5);
          }}
        >
          {/* one thin lane per class, so overlapping events stay legible */}
          <div className="flex flex-col gap-[2px]">
            {lanes.map((cls) => (
              <div key={cls} className="relative h-[3px] w-full rounded-sm bg-panel2">
                {events.map((e, i) =>
                  e[2] !== cls ? null : (
                    <span
                      key={i}
                      className="absolute inset-y-0 rounded-sm"
                      style={{
                        left: `${(e[0] / (duration || 1)) * 100}%`,
                        width: `${Math.max(0.35, ((e[1] - e[0]) / (duration || 1)) * 100)}%`,
                        background: classColor(cls),
                        opacity:
                          selected === i || (currentTime >= e[0] && currentTime <= e[1])
                            ? 1
                            : selected === null
                              ? 0.55
                              : 0.3,
                        boxShadow: selected === i ? "0 0 0 1px var(--text)" : undefined,
                      }}
                    />
                  ),
                )}
              </div>
            ))}
          </div>

          <div className="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-panel2">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-accent"
              style={{ width: `${pct}%`, transition: gliding ? "width 380ms cubic-bezier(0.22, 0.8, 0.24, 1)" : "none" }}
            />
          </div>

          <span
            className="pointer-events-none absolute bottom-1 top-1 w-px bg-text"
            style={{ left: `${pct}%`, transition: gliding ? "left 380ms cubic-bezier(0.22, 0.8, 0.24, 1)" : "none" }}
          />

          {scrub && (
            <div
              className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded border border-line bg-ink px-2 py-1 text-[11px] shadow-lg"
              style={{ left: scrub.x }}
            >
              <span className="num">{timecode(scrub.t)}</span>
              {scrubEvents.map((e, i) => (
                <span key={i} className="ml-2 inline-flex items-center gap-1 text-muted">
                  <span className="inline-block h-[3px] w-2.5 rounded-full" style={{ background: classColor(e[2]) }} />
                  {classLabel(e[2])}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
            className="grid h-8 w-8 place-items-center rounded bg-accent text-accentink transition-opacity hover:opacity-85"
          >
            {playing ? (
              <svg width="11" height="12" viewBox="0 0 11 12" fill="currentColor" aria-hidden="true">
                <rect x="0" y="0" width="4" height="12" rx="1" />
                <rect x="7" y="0" width="4" height="12" rx="1" />
              </svg>
            ) : (
              <svg width="11" height="12" viewBox="0 0 11 12" fill="currentColor" aria-hidden="true">
                <path d="M0 0.8v10.4a.8.8 0 0 0 1.22.68l8.4-5.2a.8.8 0 0 0 0-1.36L1.22.12A.8.8 0 0 0 0 .8Z" />
              </svg>
            )}
          </button>

          <IconBtn onClick={() => seek(Math.max(0, currentTime - 1 / fps))} label="Previous frame">
            &minus;1f
          </IconBtn>
          <IconBtn onClick={() => seek(currentTime + 1 / fps)} label="Next frame">
            +1f
          </IconBtn>
          {events.length > 0 && (
            <>
              <IconBtn onClick={() => stepEvent(-1)} label="Previous event (p)">
                &lsaquo; ev
              </IconBtn>
              <IconBtn onClick={() => stepEvent(1)} label="Next event (n)">
                ev &rsaquo;
              </IconBtn>
            </>
          )}

          <span className="num ml-1 text-xs text-muted">
            {timecode(currentTime)} <span className="text-faint">/ {timecode(duration)}</span>
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {overlay && (
              <>
                <Toggle on={showOverlay} onClick={() => setShowOverlay((v) => !v)} title="Detection overlay (o)">
                  overlay
                </Toggle>
                <Toggle on={showTrails} onClick={() => setShowTrails((v) => !v)} title="Motion trails">
                  trails
                </Toggle>
              </>
            )}

            <IconBtn onClick={() => setMuted((v) => !v)} label={muted ? "Unmute" : "Mute"}>
              {muted ? "muted" : "sound"}
            </IconBtn>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => {
                setVolume(Number(e.target.value));
                setMuted(Number(e.target.value) === 0);
              }}
              aria-label="Volume"
              className="hidden w-16 sm:block"
            />

            <select
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
              aria-label="Playback speed"
              className="num h-8 rounded border border-line bg-panel2 px-1.5 text-xs text-muted"
            >
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r}&times;
                </option>
              ))}
            </select>

            <IconBtn onClick={() => void toggleFull()} label={full ? "Exit fullscreen" : "Fullscreen"}>
              {full ? "exit" : "full"}
            </IconBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A brief confirmation on the picture that the player moved to the picked event. */
function JumpNotice({ event, fact }: { event: EventTuple; fact?: EventFact }) {
  const [s, e, label] = event;
  return (
    <div
      role="status"
      className="anim-toast pointer-events-none absolute left-1/2 top-12 z-10 flex max-w-[92%] -translate-x-1/2 items-center gap-2 rounded-md border border-white/15 bg-black/80 px-3 py-1.5 text-[11px] text-white/85 backdrop-blur-sm"
    >
      <span className="num text-[10px] uppercase tracking-wider text-white/55">jumped to</span>
      <span className="inline-block h-[3px] w-3 shrink-0 rounded-full" style={{ background: classColor(label) }} />
      <span className="truncate font-semibold text-white">{classLabel(label)}</span>
      <span className="num shrink-0">
        {timecode(s)} &rarr; {timecode(e)}
      </span>
      {fact && fact.tracks.length > 0 && (
        <span className="num hidden truncate text-white/60 sm:inline">
          tracks {fact.tracks.slice(0, 3).map(pad3).join(" ")}
          {fact.region ? ` · ${regionLabel(fact.region)}` : ""}
        </span>
      )}
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="num inline-flex items-center rounded bg-black/70 px-1.5 py-1 text-[10px] uppercase tracking-wider text-white/80 backdrop-blur-sm">
      {children}
    </span>
  );
}

function IconBtn({
  children,
  onClick,
  label,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="num h-8 rounded border border-line px-2 text-[11px] text-muted transition-colors hover:text-text"
    >
      {children}
    </button>
  );
}

function Toggle({
  on,
  onClick,
  children,
  title,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className="num h-8 rounded border px-2 text-[11px] uppercase tracking-wider transition-colors"
      style={{
        borderColor: on ? "color-mix(in srgb, var(--cyan) 55%, transparent)" : "var(--line)",
        color: on ? "var(--cyan)" : "var(--faint)",
      }}
    >
      {children}
    </button>
  );
}
