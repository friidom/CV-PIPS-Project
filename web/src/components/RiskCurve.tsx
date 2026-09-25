import { useCallback, useMemo, useState } from "react";
import { byClassOrder, classColor, classLabel } from "../lib/classes";
import { peakRisk, riskAt, type EventFact } from "../lib/events";
import { timecode } from "../lib/format";
import { GLIDE, useGliding, usePlayback } from "../lib/playback";
import { useElementSize, useReveal } from "../lib/hooks";
import type { EventTuple, RiskCues, RiskPoint } from "../lib/types";
import { EventTip, LineKey, niceTicks, Tip } from "./viz";

/** src/traffic/risk.py's three cues, in the order CueRecorder writes them. */
const CUES = [
  { label: "conflict (time to closest approach)", color: "var(--cue1)" },
  { label: "red-light runner", color: "var(--cue2)" },
  { label: "hard braking", color: "var(--cue3)" },
];

/** evaluate.py: alarm threshold, and runs closer than this are one alarm. */
export const THETA = 0.5;
export const MERGE_GAP = 2.0;
/** evaluate.py: matching window W before an accident start. */
export const ALARM_WINDOW = 10.0;

const PAD_L = 42;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 22;
const MARK_H = 16;

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
  /** Part A events, drawn as markers under the curve; picking one selects it everywhere. */
  events?: EventTuple[];
  /** Class ids whose markers are shown; undefined = all. Indices stay those of `events`. */
  visible?: Set<string>;
  facts?: EventFact[] | null;
  /** The cues behind the score, when the run recorded them (uploads do; the harness does not). */
  cues?: RiskCues;
  height?: number;
  compact?: boolean;
}

type Hover = { x: number; y: number; t: number; event: number | null };

/**
 * The Part B risk score over time.
 *
 * Drawn as SVG: one path plus a handful of rects, so it stays crisp, themable and
 * screen-reader describable. The curve is drawn exactly as recorded, point to
 * point; nothing is smoothed. Part A events sit in a strip underneath, on the
 * same clock, so a spike can be read against what the rules saw at that moment.
 */
export function RiskCurve({
  risk,
  duration,
  accidents = [],
  events = [],
  visible,
  facts,
  cues,
  height = 132,
  compact = false,
}: Props) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const [drawRef, drawn] = useReveal<HTMLDivElement>();
  const { currentTime, seek, selected, select } = usePlayback();
  const gliding = useGliding();
  const [hover, setHover] = useState<Hover | null>(null);
  const [showCues, setShowCues] = useState(false);
  // One [t, value] series per cue, so a lookup at the pointer is the same binary search as the score's.
  const cueSeries = useMemo(
    () => (cues?.length ? CUES.map((_, k) => cues.map((r) => [r[0], r[k + 1]] as RiskPoint)) : []),
    [cues],
  );

  const strip = events.length > 0;
  const w = size.width || 720;
  const h = height + (strip ? MARK_H : 0);
  const plotW = Math.max(w - PAD_L - PAD_R, 10);
  const plotH = Math.max(height - PAD_T - PAD_B, 10);
  const stripY = PAD_T + plotH + 4;

  const xOf = useCallback((t: number) => PAD_L + (t / Math.max(duration, 1e-6)) * plotW, [duration, plotW]);
  const yOf = useCallback((s: number) => PAD_T + (1 - Math.min(Math.max(s, 0), 1)) * plotH, [plotH]);

  const alarms = useMemo(() => findAlarms(risk), [risk]);
  const peak = useMemo(() => risk.reduce((m, p) => Math.max(m, p[1]), 0), [risk]);
  const ticks = useMemo(() => niceTicks(0, duration, Math.max(2, Math.floor(plotW / 120))), [duration, plotW]);

  const path = useMemo(() => {
    if (risk.length === 0) return "";
    // One point per horizontal pixel at most: a 3825-sample curve on a 700 px axis
    // is otherwise 3800 invisible segments in the DOM. Every bucket keeps its max,
    // so thinning never hides a peak.
    const stride = Math.max(1, Math.floor(risk.length / Math.max(plotW, 1)));
    const parts: string[] = [];
    for (let i = 0; i < risk.length; i += stride) {
      let s = risk[i][1];
      for (let k = i + 1; k < Math.min(i + stride, risk.length); k++) s = Math.max(s, risk[k][1]);
      parts.push(`${i === 0 ? "M" : "L"}${xOf(risk[i][0]).toFixed(1)},${yOf(s).toFixed(1)}`);
    }
    const last = risk[risk.length - 1];
    parts.push(`L${xOf(last[0]).toFixed(1)},${yOf(last[1]).toFixed(1)}`);
    return parts.join(" ");
  }, [risk, plotW, xOf, yOf]);

  // Events on the strip, stacked into rows so overlapping markers stay pickable.
  const markers = useMemo(() => {
    const order = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => !visible || visible.has(e[2]))
      .sort((a, b) => a.e[0] - b.e[0] || byClassOrder(a.e[2], b.e[2]));
    return order.map(({ e, i }) => ({ i, x: xOf(e[0]), x2: Math.max(xOf(e[1]), xOf(e[0]) + 3), color: classColor(e[2]) }));
  }, [events, visible, xOf]);

  const eventAt = (x: number, y: number): number | null => {
    if (!strip || y < stripY - 3 || y > stripY + MARK_H) return null;
    let best: number | null = null;
    let bestD = 7;
    for (const m of markers) {
      const d = x < m.x ? m.x - x : x > m.x2 ? x - m.x2 : 0;
      if (d < bestD) {
        bestD = d;
        best = m.i;
      }
    }
    return best;
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < PAD_L || x > w - PAD_R) return setHover(null);
    setHover({ x, y, t: Math.max(0, Math.min(((x - PAD_L) / plotW) * duration, duration)), event: eventAt(x, y) });
  };

  const onClick = () => {
    if (!hover) return;
    if (hover.event !== null) select(hover.event, events[hover.event][0]);
    else seek(hover.t);
  };

  if (risk.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-panel px-4 py-6 text-sm text-muted">
        No risk curve for this clip. Part B writes one <span className="num">[t_sec, score]</span> pair per
        frame; an empty array means the estimator did not run.
      </div>
    );
  }

  const sel = selected !== null ? events[selected] : undefined;
  const hoverScore = hover ? riskAt(risk, hover.t) : 0;
  const hoverAlarm = hover ? alarms.find((a) => hover.t >= a.start && hover.t <= a.end) : undefined;
  const activeAtHover = hover
    ? events.filter((e) => (!visible || visible.has(e[2])) && hover.t >= e[0] && hover.t <= e[1])
    : [];

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
          <span className="text-muted">
            now <span className="num text-text">{riskAt(risk, currentTime).toFixed(3)}</span>
          </span>
          {cueSeries.length > 0 && (
            <button
              type="button"
              aria-pressed={showCues}
              onClick={() => setShowCues((v) => !v)}
              className={`num rounded border px-2 py-0.5 text-[11px] transition-colors ${
                showCues ? "border-line bg-panel2 text-text" : "border-line text-muted hover:text-text"
              }`}
            >
              {showCues ? "hide" : "show"} the three cues
            </button>
          )}
          <span className="num ml-auto text-faint">{risk.length} samples</span>
        </div>
      )}
      {showCues && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            <LineKey color="var(--bad)" /> risk score (noisy-OR of the cues, fast attack, slow decay)
          </span>
          {CUES.map((c) => (
            <span key={c.label} className="inline-flex items-center gap-1.5">
              <LineKey color={c.color} /> {c.label}
            </span>
          ))}
        </div>
      )}

      <div ref={drawRef} className="w-full">
        <div ref={wrapRef} className="relative w-full">
          <svg
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            onClick={onClick}
            className="block w-full cursor-pointer touch-none select-none"
            role="img"
            aria-label={`Accident risk over time. Peak score ${peak.toFixed(3)}, ${alarms.length} alarms above the ${THETA} threshold.`}
          >
            <defs>
              <linearGradient id="riskfill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--bad)" stopOpacity="0.22" />
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
                  stroke={s === THETA ? "var(--bad)" : "var(--line)"}
                  strokeWidth={1}
                  strokeDasharray={s === THETA ? "4 3" : undefined}
                  opacity={s === THETA ? 0.75 : 0.45}
                />
                <text
                  x={PAD_L - 7}
                  y={yOf(s) + 3.5}
                  textAnchor="end"
                  className="num"
                  fontSize={10}
                  fill={s === THETA ? "var(--text)" : "var(--faint)"}
                >
                  {s.toFixed(2)}
                </text>
              </g>
            ))}
            <text x={w - PAD_R - 2} y={yOf(THETA) - 4} textAnchor="end" fontSize={9} className="num" fill="var(--muted)">
              &theta; alarm threshold
            </text>

            {ticks.map((tk) => (
              <line key={tk} x1={xOf(tk)} x2={xOf(tk)} y1={PAD_T} y2={PAD_T + plotH} stroke="var(--line)" opacity={0.3} />
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
                <rect x={xOf(s)} y={PAD_T} width={Math.max(xOf(e) - xOf(s), 1.5)} height={plotH} fill="var(--bad)" opacity={0.22} />
              </g>
            ))}

            {sel && (
              <rect
                x={xOf(sel[0])}
                y={PAD_T}
                width={Math.max(xOf(sel[1]) - xOf(sel[0]), 2)}
                height={plotH + (strip ? MARK_H + 4 : 0)}
                fill="var(--text)"
                opacity={0.07}
              />
            )}

            {alarms.map((a, i) => {
              const x = xOf(a.start);
              const aw = Math.max(xOf(a.end) - x, 2);
              return (
                <g key={`al-${i}`}>
                  <rect x={x} y={PAD_T} width={aw} height={plotH} fill="var(--bad)" opacity={0.16} />
                  <rect x={x} y={PAD_T - 5} width={aw} height={3} rx={1} fill="var(--bad)" />
                </g>
              );
            })}

            {showCues &&
              cueSeries.map((series, k) => (
                <path
                  key={CUES[k].label}
                  d={series.map(([t, v], i) => `${i ? "L" : "M"}${xOf(t).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ")}
                  fill="none"
                  stroke={CUES[k].color}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  opacity={0.95}
                />
              ))}

            <path
              d={`${path} L${xOf(risk[risk.length - 1][0])},${yOf(0)} L${xOf(risk[0][0])},${yOf(0)} Z`}
              fill="url(#riskfill)"
              style={{ opacity: drawn ? 1 : 0, transition: "opacity 900ms 500ms" }}
            />
            {/* pathLength normalises the curve to 1 so the stroke can be drawn on in
                pure CSS, without measuring the path in a layout pass. */}
            <path
              d={path}
              fill="none"
              stroke="var(--bad)"
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              pathLength={1}
              strokeDasharray={1}
              style={{
                strokeDashoffset: drawn ? 0 : 1,
                transition: "stroke-dashoffset 1400ms cubic-bezier(0.3, 0.8, 0.3, 1)",
              }}
            />

            <line x1={PAD_L} x2={w - PAD_R} y1={yOf(0)} y2={yOf(0)} stroke="var(--line)" />

            {strip && (
              <g>
                <rect x={PAD_L} y={stripY} width={plotW} height={MARK_H - 6} rx={2} fill="var(--panel-2)" opacity={0.7} />
                {markers.map((m) => {
                  const on = selected === m.i || hover?.event === m.i;
                  return (
                    <rect
                      key={m.i}
                      x={m.x}
                      y={stripY + (on ? 0 : 2)}
                      width={Math.max(m.x2 - m.x, 3)}
                      height={on ? MARK_H - 6 : MARK_H - 10}
                      rx={1.5}
                      fill={m.color}
                      opacity={on ? 1 : selected === null ? 0.75 : 0.35}
                    />
                  );
                })}
              </g>
            )}

            {/* Playhead: a transform, so a jump glides while playback stays on the frame. */}
            <g style={{ transform: `translateX(${xOf(currentTime)}px)`, transition: gliding ? GLIDE : "none" }}>
              <line x1={0} x2={0} y1={PAD_T} y2={PAD_T + plotH + (strip ? MARK_H : 0)} stroke="var(--text)" strokeWidth={1} />
              <circle cx={0} cy={yOf(riskAt(risk, currentTime))} r={3.5} fill="var(--bad)" stroke="var(--panel)" strokeWidth={2} />
            </g>

            {hover && (
              <>
                <line x1={hover.x} x2={hover.x} y1={PAD_T} y2={PAD_T + plotH} stroke="var(--muted)" strokeWidth={1} opacity={0.7} />
                {hover.event === null && (
                  <circle cx={hover.x} cy={yOf(hoverScore)} r={4} fill="var(--bad)" stroke="var(--panel)" strokeWidth={2} />
                )}
              </>
            )}

            {ticks.map((tk) => (
              <text
                key={tk}
                x={xOf(tk)}
                y={h - 6}
                textAnchor={tk === 0 ? "start" : xOf(tk) > w - PAD_R - 24 ? "end" : "middle"}
                className="num"
                fontSize={10}
                fill="var(--faint)"
              >
                {timecode(tk)}
              </text>
            ))}
          </svg>

          {hover && (
            <Tip x={hover.x} y={hover.y} width={w}>
              {hover.event !== null ? (
                <>
                  <EventTip
                    event={events[hover.event]}
                    fact={facts?.[hover.event]}
                    peak={peakRisk(risk, events[hover.event][0], events[hover.event][1])}
                  />
                  <div className="mt-1.5 text-[10px] text-faint">click to jump the video here</div>
                </>
              ) : (
                <>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="num text-[13px] font-semibold text-text">{hoverScore.toFixed(3)}</span>
                    <span className="num text-muted">{timecode(hover.t)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-muted">
                    <LineKey color="var(--bad)" />
                    risk score
                    <span className={`num ml-auto text-[10px] tracking-wider ${hoverScore >= THETA ? "text-bad" : "text-faint"}`}>
                      {hoverScore >= THETA ? "▲ ALARM" : "BELOW θ"}
                    </span>
                  </div>
                  {hoverAlarm && (
                    <div className="num mt-1 text-[11px] text-muted">
                      alarm run {timecode(hoverAlarm.start)}&ndash;{timecode(hoverAlarm.end)}, peak {hoverAlarm.peak.toFixed(3)}
                    </div>
                  )}
                  {showCues && (
                    <ul className="mt-1.5 space-y-0.5 border-t border-linesoft pt-1.5 text-[11px] text-muted">
                      {cueSeries.map((series, k) => (
                        <li key={CUES[k].label} className="flex items-center gap-1.5">
                          <LineKey color={CUES[k].color} />
                          <span className="truncate">{CUES[k].label}</span>
                          <span className="num ml-auto text-text">{riskAt(series, hover.t).toFixed(3)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {activeAtHover.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5 border-t border-linesoft pt-1.5 text-[11px] text-muted">
                      {activeAtHover.slice(0, 4).map((e, i) => (
                        <li key={i} className="flex items-center gap-1.5">
                          <LineKey color={classColor(e[2])} />
                          {classLabel(e[2])}
                        </li>
                      ))}
                      {activeAtHover.length > 4 && <li className="text-faint">+{activeAtHover.length - 4} more</li>}
                    </ul>
                  )}
                  <div className="mt-1.5 text-[10px] text-faint">click to seek</div>
                </>
              )}
            </Tip>
          )}
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
