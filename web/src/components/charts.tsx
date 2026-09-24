import { useState } from "react";
import { useElementSize, useReveal } from "../lib/hooks";

const PAD_L = 40;
const PAD_R = 10;
const PAD_T = 8;
const PAD_B = 22;

const EASE = "cubic-bezier(0.3, 0.8, 0.3, 1)";

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

/** Stacked area over a shared time axis: object counts, density over time. */
export function StackedArea({
  t,
  series,
  height = 170,
  unit = "",
}: {
  t: number[];
  series: Series[];
  height?: number;
  unit?: string;
}) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const [revealRef, shown] = useReveal<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const w = size.width || 640;
  const h = height;
  const plotW = Math.max(w - PAD_L - PAD_R, 10);
  const plotH = Math.max(h - PAD_T - PAD_B, 10);

  const n = t.length;
  const totals = new Array(n).fill(0);
  for (const s of series) for (let i = 0; i < n; i++) totals[i] += s.values[i] ?? 0;
  const yMax = Math.max(1, ...totals);
  const tMax = t[n - 1] ?? 1;

  const xOf = (i: number) => PAD_L + ((t[i] ?? 0) / Math.max(tMax, 1e-6)) * plotW;
  const yOf = (v: number) => PAD_T + (1 - v / yMax) * plotH;

  const bands: { s: Series; d: string }[] = [];
  const running = new Array(n).fill(0);
  for (const s of series) {
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = 0; i < n; i++) {
      const lo = running[i];
      const hi = lo + (s.values[i] ?? 0);
      top.push(`${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(hi).toFixed(1)}`);
      bottom.push(`L${xOf(n - 1 - i).toFixed(1)},${yOf(running[n - 1 - i]).toFixed(1)}`);
      running[i] = hi;
    }
    bands.push({ s, d: `${top.join(" ")} ${bottom.join(" ")} Z` });
  }

  const idxAt = (px: number) => {
    const frac = (px - PAD_L) / Math.max(plotW, 1);
    return Math.max(0, Math.min(Math.round(frac * (n - 1)), n - 1));
  };

  return (
    <div ref={revealRef} className="w-full">
      <div ref={wrapRef} className="w-full">
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          className="block w-full"
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHover(idxAt(e.clientX - r.left));
          }}
          onMouseLeave={() => setHover(null)}
          role="img"
          aria-label={`Stacked area chart of ${series.map((s) => s.label).join(", ")} over time`}
        >
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line
                x1={PAD_L}
                x2={w - PAD_R}
                y1={yOf(yMax * f)}
                y2={yOf(yMax * f)}
                stroke="var(--line)"
                opacity={0.5}
              />
              <text
                x={PAD_L - 6}
                y={yOf(yMax * f) + 3.5}
                textAnchor="end"
                className="num"
                fontSize={10}
                fill="var(--faint)"
              >
                {(yMax * f).toFixed(yMax < 5 ? 1 : 0)}
              </text>
            </g>
          ))}
          {/* The bands wipe in left to right, which reads as time passing. */}
          <g
            style={{
              transform: shown ? "scaleX(1)" : "scaleX(0)",
              transformOrigin: `${PAD_L}px 0px`,
              transition: `transform 1000ms ${EASE}`,
            }}
          >
            {bands.map(({ s, d }) => (
              <path
                key={s.key}
                d={d}
                fill={s.color}
                fillOpacity={0.62}
                stroke={s.color}
                strokeWidth={0.8}
              />
            ))}
          </g>
          {hover !== null && (
            <line
              x1={xOf(hover)}
              x2={xOf(hover)}
              y1={PAD_T}
              y2={PAD_T + plotH}
              stroke="var(--text)"
              strokeWidth={1}
              opacity={0.6}
            />
          )}
          <text x={PAD_L} y={h - 6} className="num" fontSize={10} fill="var(--faint)">
            0s
          </text>
          <text
            x={w - PAD_R}
            y={h - 6}
            textAnchor="end"
            className="num"
            fontSize={10}
            fill="var(--faint)"
          >
            {tMax.toFixed(0)}s
          </text>
        </svg>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-muted">
            <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: s.color }} />
            {s.label}
            {hover !== null && (
              <span className="num text-text">
                {(s.values[hover] ?? 0).toFixed(1)}
                {unit}
              </span>
            )}
          </span>
        ))}
        {hover !== null && (
          <span className="num ml-auto text-faint">t = {(t[hover] ?? 0).toFixed(0)}s</span>
        )}
      </div>
    </div>
  );
}

export interface Bar {
  label: string;
  value: number;
  color?: string;
  note?: string;
}

/** Horizontal bars: class counts, dataset breakdowns. Sorted by the caller. */
export function BarList({
  bars,
  unit = "",
  max,
  format,
}: {
  bars: Bar[];
  unit?: string;
  max?: number;
  format?: (v: number) => string;
}) {
  const [ref, shown] = useReveal<HTMLUListElement>();
  const top = max ?? Math.max(1, ...bars.map((b) => b.value));
  const fmt = format ?? ((v: number) => `${v.toLocaleString()}${unit}`);
  return (
    <ul ref={ref} className="space-y-2">
      {bars.map((b, i) => (
        <li key={b.label}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="num truncate text-text">{b.label}</span>
            <span className="num shrink-0 text-muted">{fmt(b.value)}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel2">
            <div
              className="h-full rounded-full"
              style={{
                width: shown ? `${(b.value / top) * 100}%` : 0,
                background: b.color ?? "var(--accent)",
                transition: `width 700ms ${EASE} ${i * 45}ms`,
              }}
            />
          </div>
          {b.note && <p className="mt-1 text-[11px] leading-snug text-faint">{b.note}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Histogram from evenly spaced bin edges. */
export function Histogram({
  counts,
  edges,
  height = 120,
  color = "var(--accent)",
  xLabel,
}: {
  counts: number[];
  edges: number[];
  height?: number;
  color?: string;
  xLabel?: string;
}) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const [revealRef, shown] = useReveal<HTMLDivElement>();
  const w = size.width || 480;
  const h = height;
  const plotW = Math.max(w - PAD_L - PAD_R, 10);
  const plotH = Math.max(h - PAD_T - PAD_B, 10);
  const maxC = Math.max(1, ...counts);
  const bw = plotW / Math.max(counts.length, 1);
  const baseline = PAD_T + plotH;

  return (
    <div ref={revealRef} className="w-full">
      <div ref={wrapRef} className="w-full">
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          className="block w-full"
          role="img"
          aria-label={xLabel ?? "Histogram"}
        >
          <line x1={PAD_L} x2={w - PAD_R} y1={baseline} y2={baseline} stroke="var(--line)" />
          <text
            x={PAD_L - 6}
            y={PAD_T + 8}
            textAnchor="end"
            className="num"
            fontSize={10}
            fill="var(--faint)"
          >
            {maxC.toLocaleString()}
          </text>
          {counts.map((c, i) => {
            const bh = (c / maxC) * plotH;
            const x = PAD_L + i * bw + 0.5;
            return (
              <rect
                key={i}
                x={x}
                y={baseline - bh}
                width={Math.max(bw - 1, 1)}
                height={bh}
                fill={color}
                fillOpacity={0.72}
                style={{
                  transform: shown ? "scaleY(1)" : "scaleY(0)",
                  transformOrigin: `${x}px ${baseline}px`,
                  transition: `transform 620ms ${EASE} ${i * 18}ms`,
                }}
              >
                <title>{`${edges[i]?.toFixed(2)} – ${edges[i + 1]?.toFixed(2)}: ${c.toLocaleString()}`}</title>
              </rect>
            );
          })}
          <text x={PAD_L} y={h - 6} className="num" fontSize={10} fill="var(--faint)">
            {edges[0]?.toFixed(2)}
          </text>
          <text
            x={w - PAD_R}
            y={h - 6}
            textAnchor="end"
            className="num"
            fontSize={10}
            fill="var(--faint)"
          >
            {edges[edges.length - 1]?.toFixed(2)}
          </text>
          {xLabel && (
            <text
              x={(PAD_L + w - PAD_R) / 2}
              y={h - 6}
              textAnchor="middle"
              fontSize={10}
              fill="var(--faint)"
            >
              {xLabel}
            </text>
          )}
        </svg>
      </div>
    </div>
  );
}

const PHASE_COLOR: Record<number, string> = {
  0: "var(--line)",
  1: "#f5222d",
  2: "#3ecf8e",
  3: "#fadb14",
};
const PHASE_NAME: Record<number, string> = { 0: "unknown", 1: "red", 2: "green", 3: "amber" };

/** The signal phase as a ribbon of coloured runs. */
export function PhaseRibbon({
  cycles,
  duration,
  height = 26,
}: {
  cycles: { start: number; end: number; phase: number }[];
  duration: number;
  height?: number;
}) {
  const [ref, shown] = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className="w-full">
      <svg
        viewBox={`0 0 1000 ${height}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height }}
        role="img"
        aria-label="East-bound signal phase over time"
      >
        {/* Wipes left to right at the same rate as the other time charts. */}
        <g
          style={{
            transform: shown ? "scaleX(1)" : "scaleX(0)",
            transformOrigin: "0px 0px",
            transition: `transform 1100ms ${EASE}`,
          }}
        >
          {cycles.map((c, i) => (
            <rect
              key={i}
              x={(c.start / Math.max(duration, 1e-6)) * 1000}
              y={0}
              width={Math.max(((c.end - c.start) / Math.max(duration, 1e-6)) * 1000, 0.8)}
              height={height}
              fill={PHASE_COLOR[c.phase]}
              opacity={c.phase === 0 ? 0.4 : 0.85}
            >
              <title>{`${PHASE_NAME[c.phase]} ${c.start.toFixed(1)}s – ${c.end.toFixed(1)}s`}</title>
            </rect>
          ))}
        </g>
      </svg>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        {[1, 3, 2, 0].map((p) => (
          <span key={p} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ background: PHASE_COLOR[p] }}
            />
            {PHASE_NAME[p]}
          </span>
        ))}
      </div>
    </div>
  );
}
