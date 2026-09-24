import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { classColor, classLabel } from "../lib/classes";
import { timecode } from "../lib/format";
import { useElementSize, usePrefersReducedMotion } from "../lib/hooks";
import {
  boxesAt,
  frameIndexAt,
  GROUP_COLORS,
  PHASE_COLORS,
  PHASE_NAMES,
  trailsAt,
  type Box,
  type OverlayData,
} from "../lib/overlay";
import type { FlowFieldData, SceneData } from "../lib/types";

const BASE = import.meta.env.BASE_URL;
const TRAIL_FRAMES = 14;
const HUD_HZ = 8;

interface Props {
  scene: SceneData | null;
  flow: FlowFieldData | null;
  replay: OverlayData | null;
  /** Real RANSAC inlier count for the replayed clip, when it has been measured. */
  inliers?: number | null;
  onPickEvent?: (label: string, t: number) => void;
}

interface Particle {
  x: number;
  y: number;
  life: number;
  max: number;
}

/** Resolve a CSS custom property to a concrete colour that canvas can use. */
function cssVar(el: HTMLElement, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || "#888888";
}

/**
 * The hero: one canvas replaying what the system actually saw.
 *
 * Four layers over the real reference plate — scene geometry from
 * configs/scene.json, particles advected by the learned flow field, the
 * tracker's own boxes and ids from a cached perception pass, and a sampling
 * sweep. Nothing here is invented: every box was a YOLO11m detection the
 * tracker kept, and every particle follows a direction measured from the clips.
 *
 * It all runs on one requestAnimationFrame writing to a canvas; React state is
 * touched only by the HUD, and only HUD_HZ times a second.
 */
export function LiveScene({ scene, flow, replay, inliers, onPickEvent }: Props) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const plateRef = useRef<HTMLImageElement | null>(null);
  const reduced = usePrefersReducedMotion();

  const [hud, setHud] = useState({ t: 0, frame: 0, tracked: 0, drawn: 0, ids: 0, phase: 0 });
  const [active, setActive] = useState<{ label: string; t: number }[]>([]);
  const [hover, setHover] = useState<Box | null>(null);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const pickedRef = useRef<Box | null>(null);
  const particles = useRef<Particle[]>([]);

  useEffect(() => {
    const img = new Image();
    img.src = `${BASE}media/reference.jpg`;
    img.onload = () => {
      plateRef.current = img;
    };
  }, []);

  // Polygons, flattened once into the 0..1 space the canvas draws in.
  const geometry = useMemo(() => {
    if (!scene) return null;
    const [w, h] = scene.size;
    const norm = (p: [number, number][]) => p.map(([x, y]) => [x / w, y / h] as [number, number]);
    return {
      stop: scene.stop_lines.map((s) => norm(s.points)),
      cross: scene.crosswalks.map((s) => norm(s.points)),
      islands: scene.islands.map((s) => norm(s.points)),
      zones: scene.zones.map((s) => norm(s.points)),
    };
  }, [scene]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || size.width < 2) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(size.width);
    const H = Math.round(size.width * (9 / 16));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const colors = {
      cyan: cssVar(wrap, "--cyan"),
      accent: cssVar(wrap, "--accent"),
      plate: cssVar(wrap, "--plate"),
      g: GROUP_COLORS.map((_, i) => cssVar(wrap, `--g${i}`)),
    };

    const gw = flow ? flow.dx[0]?.length ?? 0 : 0;
    const gh = flow ? flow.dx.length : 0;
    const wantParticles = reduced ? 0 : W < 640 ? 90 : 220;
    if (particles.current.length !== wantParticles) {
      particles.current = Array.from({ length: wantParticles }, () => ({
        x: Math.random(),
        y: Math.random(),
        life: Math.random() * 90,
        max: 60 + Math.random() * 90,
      }));
    }

    const sampleFlow = (x: number, y: number) => {
      if (!flow || !gw || !gh) return null;
      const gx = Math.min(gw - 1, Math.max(0, Math.floor(x * gw)));
      const gy = Math.min(gh - 1, Math.max(0, Math.floor(y * gh)));
      const c = flow.consistency[gy][gx];
      if (c < 0.35 || flow.count[gy][gx] < 12) return null;
      return { dx: flow.dx[gy][gx], dy: flow.dy[gy][gx], c };
    };

    const respawn = (p: Particle) => {
      // Seed only where the field has evidence, so the motion on screen is the
      // motion the sample clips actually contained.
      for (let i = 0; i < 12; i++) {
        const x = Math.random();
        const y = Math.random();
        if (sampleFlow(x, y)) {
          p.x = x;
          p.y = y;
          p.life = 0;
          p.max = 60 + Math.random() * 110;
          return;
        }
      }
      p.x = Math.random();
      p.y = Math.random();
      p.life = 0;
    };

    let raf = 0;
    let start = 0;
    let lastHud = 0;

    const draw = (now: number) => {
      if (!start) start = now;
      const elapsed = (now - start) / 1000;
      const px = Number(wrap.style.getPropertyValue("--px") || 0);
      const py = Number(wrap.style.getPropertyValue("--py") || 0);
      const par = (depth: number) => ({ x: -px * depth, y: -py * depth });

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = colors.plate;
      ctx.fillRect(0, 0, W, H);

      // --- layer 0: the real reference plate, pushed back -------------------
      const plate = plateRef.current;
      if (plate) {
        const o = par(6);
        ctx.save();
        ctx.globalAlpha = 0.34;
        ctx.filter = "grayscale(1) contrast(1.15)";
        ctx.drawImage(plate, o.x - 10, o.y - 10, W + 20, H + 20);
        ctx.restore();
      }

      // --- layer 1: scene geometry, drawing itself in on first pass ---------
      if (geometry) {
        const o = par(11);
        const reveal = reduced ? 1 : Math.min(1, elapsed / 2.2);
        ctx.save();
        ctx.translate(o.x, o.y);
        const poly = (pts: [number, number][], stroke: string, close: boolean, alpha: number) => {
          if (pts.length < 2) return;
          const n = Math.max(2, Math.ceil(pts.length * reveal));
          ctx.beginPath();
          for (let i = 0; i < n; i++) {
            const [x, y] = pts[i];
            if (i === 0) ctx.moveTo(x * W, y * H);
            else ctx.lineTo(x * W, y * H);
          }
          if (close && reveal >= 1) ctx.closePath();
          ctx.globalAlpha = alpha * reveal;
          ctx.strokeStyle = stroke;
          ctx.stroke();
        };
        ctx.lineWidth = 1;
        for (const z of geometry.zones) poly(z, colors.cyan, true, 0.16);
        for (const i of geometry.islands) poly(i, colors.cyan, true, 0.3);
        for (const c of geometry.cross) poly(c, colors.cyan, true, 0.45);
        ctx.lineWidth = 2;
        for (const s of geometry.stop) poly(s, colors.accent, false, 0.8);
        ctx.restore();
      }

      // --- layer 2: particles advected by the learned flow field ------------
      if (wantParticles) {
        const o = par(16);
        ctx.save();
        ctx.translate(o.x, o.y);
        ctx.lineCap = "round";
        ctx.strokeStyle = colors.cyan;
        ctx.lineWidth = 1.4;
        for (const p of particles.current) {
          const f = sampleFlow(p.x, p.y);
          if (!f || p.life > p.max || p.x < -0.02 || p.x > 1.02 || p.y < -0.02 || p.y > 1.02) {
            respawn(p);
            continue;
          }
          const nx = p.x + f.dx * 0.0016;
          const ny = p.y + f.dy * 0.0016;
          // Fade in and out so particles never pop at either end of their life.
          const age = p.life / p.max;
          ctx.globalAlpha = Math.min(age * 6, 1) * Math.min((1 - age) * 4, 1) * (0.22 + f.c * 0.5);
          ctx.beginPath();
          ctx.moveTo(p.x * W, p.y * H);
          ctx.lineTo(nx * W, ny * H);
          ctx.stroke();
          p.x = nx;
          p.y = ny;
          p.life += 1;
        }
        ctx.restore();
      }

      // --- layer 3: the tracker's own boxes ---------------------------------
      let tracked = 0;
      let drawn = 0;
      let liveTracks = 0;
      let phase = 0;
      let tRep = 0;
      if (replay && replay.times.length) {
        const o = par(22);
        tRep = reduced ? replay.duration / 2 : elapsed % replay.duration;
        const fi = frameIndexAt(replay, tRep);
        phase = replay.phase[fi] ?? 0;
        const boxes = boxesAt(replay, fi);
        tracked = replay.n?.[fi] ?? boxes.length;
        drawn = boxes.length;
        const trails = trailsAt(replay, fi, TRAIL_FRAMES);
        liveTracks = trails.size;

        ctx.save();
        ctx.translate(o.x, o.y);

        ctx.lineWidth = 1.5;
        for (const [, pts] of trails) {
          if (pts.length < 2) continue;
          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) {
            const b = pts[i];
            if (i === 0) ctx.moveTo(b.x * W, b.y * H);
            else ctx.lineTo(b.x * W, b.y * H);
          }
          ctx.globalAlpha = 0.28;
          ctx.strokeStyle = colors.g[pts[0].g] ?? colors.cyan;
          ctx.stroke();
        }

        const hoverPt = hoverRef.current;
        let picked: Box | null = null;
        for (const b of boxes) {
          const bw = Math.max(6, b.w * W);
          const bh = Math.max(6, b.h * H);
          const x = b.x * W - bw / 2;
          const y = b.y * H - bh / 2;
          if (
            hoverPt &&
            hoverPt.x >= x - 4 &&
            hoverPt.x <= x + bw + 4 &&
            hoverPt.y >= y - 4 &&
            hoverPt.y <= y + bh + 4
          ) {
            picked = b;
          }
          const on = picked === b;
          // Same precedence as the offline renderer: an event's own evidence
          // tracks take the class colour, everything else the tracker group.
          const col = b.ev ? classColor(b.ev) : (colors.g[b.g] ?? colors.cyan);
          ctx.globalAlpha = on || b.ev ? 1 : 0.8;
          ctx.strokeStyle = col;
          ctx.lineWidth = b.ev ? 2.2 : on ? 1.8 : 1.1;
          // Corner brackets rather than a closed rectangle: the detection-HUD
          // motif, and it keeps the plate readable where boxes overlap.
          const k = Math.min(bw, bh) * 0.3;
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

          if (bw > 34 && (on || bh > 26)) {
            ctx.globalAlpha = on ? 1 : 0.7;
            ctx.fillStyle = col;
            ctx.font = '600 9px ui-monospace, "JetBrains Mono", monospace';
            ctx.fillText(String(b.id).padStart(3, "0"), x, y - 3);
          }
        }
        ctx.restore();
        if (picked?.id !== pickedRef.current?.id) {
          pickedRef.current = picked;
          setHover(picked);
        }
      }

      // --- layer 4: the sampling sweep --------------------------------------
      if (!reduced) {
        const sx = ((elapsed * 0.17) % 1) * W;
        const grad = ctx.createLinearGradient(sx - 90, 0, sx + 8, 0);
        grad.addColorStop(0, "rgba(53,214,240,0)");
        grad.addColorStop(1, "rgba(53,214,240,0.16)");
        ctx.globalAlpha = 1;
        ctx.fillStyle = grad;
        ctx.fillRect(sx - 90, 0, 98, H);
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = colors.cyan;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, H);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // The HUD is React state, so it updates a few times a second, not 60.
      if (now - lastHud > 1000 / HUD_HZ) {
        lastHud = now;
        setHud({
          t: replay ? replay.t0 + tRep : 0,
          frame: replay ? Math.round((replay.t0 + tRep) * 29.97) : 0,
          tracked,
          drawn,
          ids: liveTracks,
          phase,
        });
        if (replay) {
          setActive(
            replay.events
              .filter(([s, e]) => tRep >= s && tRep <= e)
              .map(([s, , label]) => ({ label, t: replay.t0 + s })),
          );
        }
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size.width, flow, geometry, replay, reduced, wrapRef]);

  return (
    <div
      ref={wrapRef}
      className="relative overflow-hidden rounded-xl border border-line bg-[var(--plate)]"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        hoverRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      }}
      onPointerLeave={() => {
        hoverRef.current = null;
      }}
    >
      <canvas ref={canvasRef} className="block w-full" aria-hidden="true" />

      {!replay && !flow && !scene && (
        <div className="absolute inset-0 grid place-items-center text-xs text-faint">
          loading scene&hellip;
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5 sm:p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip>
            <span className="anim-blink mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--bad)]" />
            replay
          </Chip>
          {replay && <Chip>{replay.video}</Chip>}
          <Chip>{timecode(hud.t)}</Chip>
          <Chip>f{String(hud.frame).padStart(5, "0")}</Chip>
        </div>
        <Chip>
          <span
            className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: PHASE_COLORS[hud.phase] }}
          />
          eb {PHASE_NAMES[hud.phase]}
        </Chip>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-2 p-2.5 sm:p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip>
            tracks <b className="mx-1 font-semibold text-text">{hud.tracked}</b>
            {hud.drawn < hud.tracked && <span className="opacity-60">({hud.drawn} shown)</span>}
          </Chip>
          <Chip>
            ids <b className="ml-1 font-semibold text-text">{hud.ids}</b>
          </Chip>
          {typeof inliers === "number" && (
            <Chip>
              <span
                className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: inliers >= 40 ? "var(--ok)" : "var(--bad)" }}
              />
              aligned &middot; {inliers} inliers
            </Chip>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {active.map((e) => (
            <button
              key={`${e.label}-${e.t}`}
              type="button"
              onClick={() => onPickEvent?.(e.label, e.t)}
              className="pointer-events-auto flex items-center gap-2 rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider backdrop-blur-sm transition-transform hover:scale-[1.03]"
              style={{
                borderColor: classColor(e.label),
                color: classColor(e.label),
                background: "color-mix(in srgb, var(--ink) 72%, transparent)",
              }}
            >
              <span className="relative flex h-1.5 w-1.5">
                <span
                  className="pulse-ring absolute inline-flex h-full w-full rounded-full"
                  style={{ background: classColor(e.label) }}
                />
                <span
                  className="relative inline-flex h-1.5 w-1.5 rounded-full"
                  style={{ background: classColor(e.label) }}
                />
              </span>
              {classLabel(e.label)}
              <span className="num opacity-70">t+{e.t.toFixed(2)}s</span>
            </button>
          ))}
        </div>
      </div>

      {hover && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2">
          <span className="num rounded border border-cyan/60 bg-ink/85 px-2 py-1 text-[10px] uppercase tracking-wider text-cyan">
            track {String(hover.id).padStart(3, "0")}
          </span>
        </div>
      )}
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="num inline-flex items-center rounded border border-line/80 bg-ink/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted backdrop-blur-sm">
      {children}
    </span>
  );
}
