import { useCallback, useMemo, useRef, useState } from "react";
import { timecode } from "../lib/format";
import { usePlayback } from "../lib/playback";
import { useElementSize, useReveal } from "../lib/hooks";
import type { EventTuple, RiskPoint } from "../lib/types";

/** evaluate.py: alarm threshold, and runs closer than this are one alarm. */
export const THETA = 0.5;
export const MERGE_GAP = 2.0;
/** evaluate.py: matching window W before an accident start. */
export const ALARM_WINDOW = 10.0;

const PAD_L = 42;
const PAD_R = 12;
const PAD_T = 10;
const PAD_B = 22;

export interface Alarm {
  start: number;
  end: number;
  peak: number;
}

/** Maximal runs of score >= THETA, merged across gaps under MERGE_GAP — evaluate.py's rule. */
export function findAlarms(risk: RiskPoint[], theta = THETA, mergeGap = MERGE_GAP): Alarm[] {
  const out: Alarm[] = [];
  let open: Alarm | null = null;
  for (const [t, s] of risk) {
    if (s >= theta) {
      if (open && t - open.end <= mergeGap) {
        open.end = t;
        open.peak = Math.max(open.peak, s);
      } else {
        if (open) out.push(open);
        open = { start: t, end: t, peak: s };
      }
    }
  }
  if (open) out.push(open);
  return out;
}

interface Props {
  risk: RiskPoint[];
  duration: number;
  /** Accident segments, when known, so the W-second matching window can be drawn. */
  accidents?: EventTuple[];
  height?: number;
  compact?: boolean;
}

/**
 * The Part B risk score over time.
 *
 * Drawn as SVG: one path plus a handful of rects, so it stays crisp, themable and
 * screen-reader describable. The playhead is a separate line that moves with the
 * shared clock rather than a redraw.
 */
export function RiskCurve({ risk, duration, accidents = [], height = 132, compact = false }: Props) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const [drawRef, drawn] = useReveal<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { currentTime, seek } = usePlayback();
  const [hoverT, setHoverT] = useState<number | null>(null);

  const w = size.width || 720;
  const h = height;
  const plotW = Math.max(w - PAD_L - PAD_R, 10);
  const plotH = Math.max(h - PAD_T - PAD_B, 10);

  const xOf = useCallback(
    (t: number) => PAD_L + (t / Math.max(duration, 1e-6)) * plotW,
    [duration, plotW],
  );
  const yOf = useCallback(
    (s: number) => PAD_T + (1 - Math.min(Math.max(s, 0), 1)) * plotH,
    [plotH],
  );

  const alarms = useMemo(() => findAlarms(risk), [risk]);
  const peak = useMemo(() => risk.reduce((m, p) => Math.max(m, p[1]), 0), [risk]);

  const path = useMemo(() => {
    if (risk.length === 0) return "";
    // One point per horizontal pixel at most: a 3825-sample curve on a 700 px axis
    // is otherwise 3800 invisible segments in the DOM.
    const stride = Math.max(1, Math.floor(risk.length / Math.max(plotW, 1)));
    const parts: string[] = [];
    for (let i = 0; i < risk.length; i += stride) {
      const [t, s] = risk[i];
      parts.push(`${i === 0 ? "M" : "L"}${xOf(t).toFixed(1)},${yOf(s).toFixed(1)}`);
    }
    const last = risk[risk.length - 1];
    parts.push(`L${xOf(last[0]).toFixed(1)},${yOf(last[1]).toFixed(1)}`);
    return parts.join(" ");
  }, [risk, plotW, xOf, yOf]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < PAD_L) return setHoverT(null);
    setHoverT(Math.max(0, Math.min(((x - PAD_L) / plotW) * duration, duration)));
  };

  const scoreAt = (t: number): number => {
    if (risk.length === 0) return 0;
    let lo = 0;
    let hi = risk.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (risk[mid][0] < t) lo = mid + 1;
      else hi = mid;
    }
    return risk[lo][1];
  };

  if (risk.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-panel px-4 py-6 text-sm text-muted">
        No risk curve for this clip. Part B writes one <span className="num">[t_sec, score]</span> pair per
        frame; an empty array means the estimator did not run.
      </div>
    );
  }

  return (
    <div className="w-full">
      {!compact && (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
          <span className="text-muted">
            peak <span className="num text-text">{peak.toFixed(3)}</span>
          </span>
          <span className="text-muted">
            threshold &theta; <span className="num text-text">{THETA.toFixed(2)}</span>
          </span>
          <span className="text-muted">
            alarms <span className="num text-text">{alarms.length}</span>
          </span>
          <span className="num ml-auto text-faint">{risk.length} samples</span>
        </div>
      )}

      <div ref={drawRef} className="w-full">
      <div ref={wrapRef} className="w-full">
        <svg
          ref={svgRef}
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          onMouseMove={onMove}
          onMouseLeave={() => setHoverT(null)}
          onClick={() => hoverT !== null && seek(hoverT)}
          className="block w-full cursor-pointer touch-none"
          role="img"
          aria-label={`Accident risk over time. Peak score ${peak.toFixed(3)}, ${alarms.length} alarms above the ${THETA} threshold.`}
        >
          <defs>
            <linearGradient id="riskfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--bad)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--bad)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {[0, 0.25, 0.5, 0.75, 1].map((s) => (
            <g key={s}>
              <line
                x1={PAD_L}
                x2={w - PAD_R}
                y1={yOf(s)}
                y2={yOf(s)}
                stroke="var(--line)"
                strokeWidth={1}
                strokeDasharray={s === THETA ? "4 3" : undefined}
                opacity={s === THETA ? 1 : 0.45}
              />
              <text
                x={PAD_L - 7}
                y={yOf(s) + 3.5}
                textAnchor="end"
                className="num"
                fontSize={10}
                fill={s === THETA ? "var(--bad)" : "var(--faint)"}
              >
                {s.toFixed(2)}
              </text>
            </g>
          ))}

          {accidents.map(([s, e], i) => (
            <g key={`acc-${i}`}>
              <rect
                x={xOf(Math.max(0, s - ALARM_WINDOW))}
                y={PAD_T}
                width={Math.max(xOf(s) - xOf(Math.max(0, s - ALARM_WINDOW)), 1)}
                height={plotH}
                fill="var(--accent)"
                opacity={0.1}
              />
              <rect
                x={xOf(s)}
                y={PAD_T}
                width={Math.max(xOf(e) - xOf(s), 1.5)}
                height={plotH}
                fill="var(--bad)"
                opacity={0.22}
              />
            </g>
          ))}

          {alarms.map((a, i) => (
            <rect
              key={`al-${i}`}
              x={xOf(a.start)}
              y={PAD_T}
              width={Math.max(xOf(a.end) - xOf(a.start), 2)}
              height={plotH}
              fill="var(--bad)"
              opacity={0.16}
            />
          ))}

          <path
            d={`${path} L${xOf(duration)},${yOf(0)} L${xOf(0)},${yOf(0)} Z`}
            fill="url(#riskfill)"
            style={{ opacity: drawn ? 1 : 0, transition: "opacity 900ms 500ms" }}
          />
          {/* pathLength normalises the curve to 1 so the stroke can be drawn on in
              pure CSS, without measuring the path in a layout pass. */}
          <path
            d={path}
            fill="none"
            stroke="var(--bad)"
            strokeWidth={1.4}
            strokeLinejoin="round"
            pathLength={1}
            strokeDasharray={1}
            style={{
              strokeDashoffset: drawn ? 0 : 1,
              transition: "stroke-dashoffset 1400ms cubic-bezier(0.3, 0.8, 0.3, 1)",
            }}
          />

          <line x1={PAD_L} x2={w - PAD_R} y1={yOf(0)} y2={yOf(0)} stroke="var(--line)" />

          <line
            x1={xOf(currentTime)}
            x2={xOf(currentTime)}
            y1={PAD_T}
            y2={PAD_T + plotH}
            stroke="var(--text)"
            strokeWidth={1}
          />

          {hoverT !== null && (
            <>
              <line
                x1={xOf(hoverT)}
                x2={xOf(hoverT)}
                y1={PAD_T}
                y2={PAD_T + plotH}
                stroke="var(--muted)"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <circle cx={xOf(hoverT)} cy={yOf(scoreAt(hoverT))} r={3} fill="var(--bad)" />
            </>
          )}

          <text x={PAD_L} y={h - 6} className="num" fontSize={10} fill="var(--faint)">
            {timecode(0)}
          </text>
          <text x={w - PAD_R} y={h - 6} textAnchor="end" className="num" fontSize={10} fill="var(--faint)">
            {timecode(duration)}
          </text>
          {hoverT !== null && (
            <text
              x={Math.min(Math.max(xOf(hoverT), PAD_L + 44), w - PAD_R - 44)}
              y={h - 6}
              textAnchor="middle"
              className="num"
              fontSize={10}
              fill="var(--text)"
            >
              {timecode(hoverT)} &middot; {scoreAt(hoverT).toFixed(3)}
            </text>
          )}
        </svg>
      </div>
      </div>

      {!compact && alarms.length === 0 && (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          The score never reaches &theta; = {THETA}, so this clip raises no alarm. The cues in{" "}
          <span className="num">src/traffic/risk.py</span> are calibrated so ordinary traffic stays well
          below the threshold; a peak of <span className="num">{peak.toFixed(3)}</span> is the expected
          reading for a clip with no collision in it.
        </p>
      )}
    </div>
  );
}
