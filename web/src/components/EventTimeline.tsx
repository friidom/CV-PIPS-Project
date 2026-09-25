import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { byClassOrder, classColor, classLabel } from "../lib/classes";
import type { EventFact } from "../lib/events";
import { timecode } from "../lib/format";
import { GLIDE, useGliding, usePlayback } from "../lib/playback";
import { useElementSize, usePrefersReducedMotion, useReveal } from "../lib/hooks";
import type { EventTuple } from "../lib/types";
import { EventTip, niceTicks, Tip } from "./viz";

const LANE_H = 26;
const LANE_GAP = 4;
const AXIS_H = 22;
const MIN_BLOCK_PX = 3;
/** Label column. A fixed 128px would eat a third of a phone screen. */
const gutterFor = (w: number) => (w < 520 ? 88 : 128);

interface Props {
  events: EventTuple[];
  duration: number;
  /** Class ids currently shown; undefined = all. */
  visible?: Set<string>;
  /** Evidence per event, same order as `events`, for the hover card. */
  facts?: EventFact[] | null;
  height?: number;
}

interface Lane {
  id: string;
  items: { index: number; start: number; end: number }[];
}

/**
 * Event segments as one lane per class, drawn on canvas.
 *
 * Canvas rather than SVG: a long clip carries hundreds of blocks. The canvas
 * repaints only when the lanes, zoom, hover or selection change; the playhead is
 * a DOM line on top, so playback never repaints the blocks and a jump can glide.
 */
export function EventTimeline({ events, duration, visible, facts, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const { currentTime, seek, selected, select, jump } = usePlayback();
  const gliding = useGliding();
  const [hover, setHover] = useState<{ x: number; y: number; index: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(0);
  const [growRef, growShown] = useReveal<HTMLDivElement>();
  const [grow, setGrow] = useState(0);
  const reduced = usePrefersReducedMotion();

  // One-shot: blocks grow out of their start time when the timeline first
  // appears. Bounded by design — it stops at 1 and never schedules again.
  useEffect(() => {
    if (!growShown || grow >= 1) return;
    if (reduced) {
      setGrow(1);
      return;
    }
    let raf = 0;
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now;
      const p = Math.min(1, (now - start) / 900);
      setGrow(p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [growShown, reduced]);

  const lanes = useMemo<Lane[]>(() => {
    const byClass = new Map<string, Lane["items"]>();
    events.forEach((e, index) => {
      const id = e[2];
      if (visible && !visible.has(id)) return;
      const arr = byClass.get(id) ?? [];
      arr.push({ index, start: e[0], end: e[1] });
      byClass.set(id, arr);
    });
    return [...byClass.entries()]
      .sort((a, b) => byClassOrder(a[0], b[0]))
      .map(([id, items]) => ({ id, items: items.sort((a, b) => a.start - b.start) }));
  }, [events, visible]);

  const plotH = lanes.length * (LANE_H + LANE_GAP) + AXIS_H + 8;
  const h = height ?? Math.max(plotH, LANE_H + AXIS_H + 12);
  const w = size.width || 800;
  const GUTTER = gutterFor(w);
  const plotW = Math.max(w - GUTTER - 12, 40);

  const span = duration / zoom;
  const maxPan = Math.max(0, duration - span);
  const t0 = Math.min(Math.max(pan, 0), maxPan);
  const t1 = t0 + span;

  const xOf = useCallback(
    (t: number) => GUTTER + ((t - t0) / Math.max(t1 - t0, 1e-6)) * plotW,
    [t0, t1, plotW, GUTTER],
  );
  const tOf = useCallback(
    (x: number) => t0 + ((x - GUTTER) / Math.max(plotW, 1)) * (t1 - t0),
    [t0, t1, plotW, GUTTER],
  );

  // Picking an event that is off screen in a zoomed view brings it into view.
  useEffect(() => {
    if (jump?.index == null || zoom <= 1) return;
    const e = events[jump.index];
    if (e && (e[0] < t0 || e[0] > t1)) setPan(Math.max(0, e[0] - span / 4));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  const hoverIndex = hover?.index ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !w) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(document.documentElement);
    const line = css.getPropertyValue("--line").trim() || "#222a35";
    const muted = css.getPropertyValue("--muted").trim() || "#8d98a7";
    const text = css.getPropertyValue("--text").trim() || "#e8ecf2";
    const panel = css.getPropertyValue("--panel-2").trim() || "#161c25";

    const ticks = niceTicks(t0, t1, Math.max(3, Math.floor(plotW / 110)));
    ctx.font = "11px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    for (const tk of ticks) {
      const x = xOf(tk);
      if (x < GUTTER - 1) continue;
      ctx.strokeStyle = line;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, h - AXIS_H);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = muted;
      ctx.textAlign = "center";
      ctx.fillText(timecode(tk), x, h - AXIS_H / 2);
    }

    lanes.forEach((lane, i) => {
      const y = i * (LANE_H + LANE_GAP);
      ctx.fillStyle = panel;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(GUTTER, y, plotW, LANE_H);
      ctx.globalAlpha = 1;

      ctx.fillStyle = text;
      ctx.textAlign = "right";
      ctx.font = `${GUTTER < 100 ? 10 : 11}px ui-sans-serif, system-ui, sans-serif`;
      const name = lane.id;
      ctx.fillText(name.length > 18 ? `${name.slice(0, 17)}…` : name, GUTTER - 10, y + LANE_H / 2);
      ctx.fillStyle = classColor(lane.id);
      ctx.fillRect(GUTTER - 6, y + 6, 3, LANE_H - 12);

      const p = Math.min(1, Math.max(0, (grow - i * 0.05) / 0.55));
      const ease = 1 - Math.pow(1 - p, 3);
      if (ease <= 0) return;

      for (const item of lane.items) {
        if (item.end < t0 || item.start > t1) continue;
        const x1 = Math.max(xOf(item.start), GUTTER);
        const x2 = Math.min(xOf(item.end), GUTTER + plotW);
        const bw = Math.max(x2 - x1, MIN_BLOCK_PX) * ease;
        const isSel = selected === item.index;
        const isHover = hoverIndex === item.index;
        ctx.fillStyle = classColor(lane.id);
        // With a selection, everything else steps back so the pick reads first.
        ctx.globalAlpha = isSel || isHover ? 1 : selected === null ? 0.82 : 0.45;
        roundRect(ctx, x1, y + 4, bw, LANE_H - 8, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (isSel || isHover) {
          ctx.strokeStyle = text;
          ctx.lineWidth = isSel ? 1.5 : 1;
          roundRect(ctx, x1 - 1.5, y + 2.5, bw + 3, LANE_H - 5, 4);
          ctx.stroke();
        }
      }
    });
  }, [lanes, w, h, plotW, GUTTER, t0, t1, xOf, selected, hoverIndex, grow]);

  const hitTest = useCallback(
    (x: number, y: number) => {
      const lane = lanes[Math.floor(y / (LANE_H + LANE_GAP))];
      if (!lane || x < GUTTER) return null;
      const t = tOf(x);
      const pad = ((t1 - t0) / Math.max(plotW, 1)) * 4; // slack so 0.4 s blocks stay clickable
      return lane.items.find((it) => t >= it.start - pad && t <= it.end + pad) ?? null;
    },
    [lanes, tOf, t0, t1, plotW, GUTTER],
  );

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = hitTest(x, y);
    setHover(hit ? { x, y, index: hit.index } : null);
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = hitTest(x, y);
    if (hit) select(hit.index, hit.start);
    else if (x >= GUTTER) seek(Math.max(0, Math.min(tOf(x), duration)));
  };

  const hovered = hover ? events[hover.index] : null;
  const segmentCount = lanes.reduce((n, l) => n + l.items.length, 0);
  const playX = xOf(currentTime);
  const showPlayhead = currentTime >= t0 && currentTime <= t1;

  // Where the picked block sits, for the one-shot pulse that answers a jump.
  const pulse = useMemo(() => {
    if (jump?.index == null) return null;
    const e = events[jump.index];
    const lane = e ? lanes.findIndex((l) => l.id === e[2]) : -1;
    if (!e || lane < 0 || e[1] < t0 || e[0] > t1) return null;
    const x1 = Math.max(xOf(e[0]), GUTTER);
    return { x: x1, y: lane * (LANE_H + LANE_GAP) + 4, w: Math.max(Math.min(xOf(e[1]), GUTTER + plotW) - x1, MIN_BLOCK_PX) };
  }, [jump, events, lanes, t0, t1, xOf, GUTTER, plotW]);

  return (
    <div ref={growRef} className="w-full">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">
          {lanes.length} {lanes.length === 1 ? "class" : "classes"} &middot; {segmentCount} segments
        </span>
        <div className="ml-auto flex items-center gap-1">
          <ZoomButton label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z / 2))}>
            &minus;
          </ZoomButton>
          <span className="num w-10 text-center text-xs text-muted">{zoom.toFixed(0)}&times;</span>
          <ZoomButton
            label="Zoom in"
            disabled={zoom >= 32}
            onClick={() =>
              setZoom((z) => {
                const next = Math.min(32, z * 2);
                setPan(Math.max(0, currentTime - duration / next / 2));
                return next;
              })
            }
          >
            +
          </ZoomButton>
          {zoom > 1 && (
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setPan(0);
              }}
              className="ml-1 rounded border border-line px-2 py-1 text-xs text-muted transition-colors hover:text-text"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      <div ref={wrapRef} className="relative w-full select-none">
        <canvas
          ref={canvasRef}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onClick={onClick}
          className="block w-full cursor-pointer"
          role="img"
          aria-label={`Event timeline: ${segmentCount} segments across ${lanes.length} classes`}
        />
        {showPlayhead && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 w-px bg-text"
            style={{
              height: Math.max(h - AXIS_H, 0),
              transform: `translateX(${playX}px)`,
              transition: gliding ? GLIDE : "none",
            }}
          >
            <span className="absolute -left-1 -top-px h-0 w-0 border-x-4 border-t-[6px] border-x-transparent border-t-text" />
          </div>
        )}
        {pulse && (
          <span
            key={jump?.id}
            aria-hidden="true"
            className="anim-pick pointer-events-none absolute rounded"
            style={{ left: pulse.x, top: pulse.y, width: pulse.w, height: LANE_H - 8 }}
          />
        )}
        {hover && hovered && (
          <Tip x={hover.x} y={hover.y} width={w}>
            <EventTip event={hovered} fact={facts?.[hover.index]} prefix={`#${hover.index + 1}`} />
            <div className="mt-1.5 text-[10px] text-faint">click to jump the video here</div>
          </Tip>
        )}
      </div>

      {zoom > 1 && (
        <input
          type="range"
          min={0}
          max={maxPan}
          step={Math.max(maxPan / 500, 0.01)}
          value={t0}
          onChange={(e) => setPan(Number(e.target.value))}
          aria-label="Pan the timeline"
          className="mt-2 w-full"
        />
      )}
      <span className="sr-only" aria-live="polite">
        {selected !== null && events[selected] ? `Selected ${classLabel(events[selected][2])} at ${timecode(events[selected][0])}` : ""}
      </span>
    </div>
  );
}

function ZoomButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="num h-7 w-7 rounded border border-line text-sm text-muted transition-colors hover:text-text disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
