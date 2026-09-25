import { useMemo } from "react";
import { classColor, classLabel } from "../lib/classes";
import { pad3, riskAt, type EventFact } from "../lib/events";
import { timecode } from "../lib/format";
import { boxesAt, frameIndexAt, GROUP_COLORS, PHASE_COLORS, PHASE_NAMES, type OverlayData } from "../lib/overlay";
import { usePlayback } from "../lib/playback";
import type { EventTuple, RiskPoint } from "../lib/types";
import { THETA } from "./RiskCurve";

const SPARK_SEC = 30;

interface Props {
  /** "replay" for a recorded sample, "upload" for a file analysed by the demo. */
  mode: "replay" | "upload";
  clip: string;
  events: EventTuple[];
  risk: RiskPoint[];
  duration: number;
  overlay?: OverlayData | null;
  facts?: EventFact[] | null;
  /** How this result was produced: measured wall-clock seconds. */
  processing?: { partA: number; partB: number; total: number; by: string } | null;
}

/**
 * An operator's view of one clip at the playback position.
 *
 * Every value is read from the clip's own results at the current time — the
 * recorded risk score, the signal phase and tracked boxes of the overlay, the
 * events around the playhead. Nothing is simulated: pause the player and the
 * monitor holds still, because it is a replay of historical output, and says so.
 */
export function TrafficMonitor({ mode, clip, events, risk, duration, overlay, facts, processing }: Props) {
  const { currentTime: t, playing, selected, select } = usePlayback();

  const byStart = useMemo(() => events.map((e, i) => ({ e, i })).sort((a, b) => a.e[0] - b.e[0]), [events]);
  const rate = duration > 0 ? (events.length / duration) * 3600 : 0;

  const score = riskAt(risk, t);
  const alarm = score >= THETA;
  const fi = overlay ? frameIndexAt(overlay, t - overlay.t0) : -1;
  const inWindow = overlay ? t >= overlay.t0 && t <= overlay.t0 + overlay.duration : false;
  const phase = overlay && inWindow ? (overlay.phase[fi] ?? 0) : null;
  const groups = [0, 0, 0];
  if (overlay && inWindow) for (const b of boxesAt(overlay, fi)) if (b.g < 3) groups[b.g] += 1;

  const active = byStart.filter(({ e }) => t >= e[0] && t <= e[1]);
  const recent = byStart.filter(({ e }) => e[1] < t).sort((a, b) => b.e[1] - a.e[1]).slice(0, 3);
  const started = byStart.filter(({ e }) => e[0] <= t);
  const tally = new Map<string, number>();
  for (const { e } of started) tally.set(e[2], (tally.get(e[2]) ?? 0) + 1);
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  // The last SPARK_SEC seconds of the recorded score, drawn up to the playhead only.
  const spark = useMemo(() => {
    const from = Math.max(0, t - SPARK_SEC);
    const pts = risk.filter(([rt]) => rt >= from && rt <= t);
    if (pts.length < 2) return "";
    return pts
      .map(([rt, s], i) => `${i ? "L" : "M"}${(((rt - from) / SPARK_SEC) * 100).toFixed(2)},${(34 - Math.min(s, 1) * 32).toFixed(1)}`)
      .join(" ");
  }, [risk, t]);

  return (
    <section className="brackets rounded-xl border border-line bg-panel p-4" aria-label="Traffic monitor">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          {playing && <span className="pulse-ring absolute inline-flex h-full w-full rounded-full bg-cyan" />}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${playing ? "bg-cyan" : "bg-faint"}`} />
        </span>
        <h3 className="num text-[11px] font-semibold uppercase tracking-[0.14em]">Traffic monitor</h3>
        <span className="num ml-auto rounded border border-line px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted">
          {mode === "replay" ? "replay · recorded clip" : "analysed upload"}
        </span>
      </div>

      <div className="mt-3 flex items-baseline justify-between gap-2">
        <span className="num truncate text-xs text-muted">{clip}</span>
        <span className="num text-lg font-semibold tabular-nums">
          {timecode(t)}
          <span className="text-xs font-normal text-faint"> / {timecode(duration)}</span>
        </span>
      </div>

      {/* Risk status: the recorded Part B score at this moment, against the official θ. */}
      <div className="mt-3 rounded-lg border border-line bg-panel2 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted">Accident risk, now</span>
          <span
            className={`num inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
              alarm ? "bg-bad/15 text-bad" : "bg-ok/10 text-ok"
            }`}
          >
            {alarm ? "▲ alarm" : "● below"}
            {!alarm && <span className="normal-case">&theta;</span>}
          </span>
        </div>
        <div className="mt-1 flex items-end gap-3">
          <span className="text-2xl font-semibold leading-none">{score.toFixed(3)}</span>
          <svg viewBox="0 0 100 36" preserveAspectRatio="none" className="h-9 min-w-0 flex-1" aria-hidden="true">
            <line x1="0" x2="100" y1={34 - THETA * 32} y2={34 - THETA * 32} stroke="var(--bad)" strokeWidth="0.6" strokeDasharray="2 2" opacity="0.7" />
            <path d={spark} fill="none" stroke="var(--bad)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
        <div className="num mt-1 text-[10px] text-faint">last {SPARK_SEC} s · dashed line = &theta; {THETA.toFixed(2)}</div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <Tile label="EB signal">
          {phase === null ? (
            <span className="text-faint">not read</span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: PHASE_COLORS[phase] }} />
              {PHASE_NAMES[phase]}
            </span>
          )}
        </Tile>
        <Tile label="Tracked in frame">
          {overlay && inWindow ? (
            <span className="inline-flex items-baseline gap-2">
              {overlay.n[fi] ?? 0}
              <span className="num inline-flex gap-1.5 text-[10px] font-normal text-muted">
                {["ped", "veh", "2w"].map((n, g) => (
                  <span key={n} className="inline-flex items-center gap-0.5">
                    <span className="inline-block h-1.5 w-1.5 rounded-[1px]" style={{ background: GROUP_COLORS[g] }} />
                    {groups[g]}
                  </span>
                ))}
              </span>
            </span>
          ) : (
            <span className="text-faint">no overlay</span>
          )}
        </Tile>
        <Tile label="Events so far">
          {started.length}
          <span className="text-[10px] font-normal text-faint"> of {events.length}</span>
        </Tile>
        <Tile label="Rate, normalised per h">
          {/* Scaling seconds of video to an hour turns one event into a headline; below a minute, say so instead. */}
          {duration >= 60 ? (
            <>
              {rate.toFixed(0)}
              <span className="text-[10px] font-normal text-faint"> /h over {(duration / 60).toFixed(1)} min</span>
            </>
          ) : (
            <span className="text-[11px] font-normal text-faint">clip under 1 min, too short</span>
          )}
        </Tile>
      </dl>

      <div className="mt-3">
        <div className="text-[11px] text-muted">Active now ({active.length})</div>
        {active.length === 0 ? (
          <p className="mt-1 text-[11px] text-faint">No event spans this moment.</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {active.slice(0, 4).map(({ e, i }) => (
              <EventRow key={i} e={e} picked={selected === i} onPick={() => select(i, e[0])}>
                <span className="relative block h-1 w-full overflow-hidden rounded-full bg-ink2">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{ width: `${((t - e[0]) / Math.max(e[1] - e[0], 1e-6)) * 100}%`, background: classColor(e[2]) }}
                  />
                </span>
                <span className="num text-[10px] text-faint">
                  {(t - e[0]).toFixed(1)} of {(e[1] - e[0]).toFixed(1)} s
                  {facts?.[i]?.tracks.length ? ` · tracks ${facts[i].tracks.slice(0, 3).map(pad3).join(" ")}` : ""}
                </span>
              </EventRow>
            ))}
            {active.length > 4 && <li className="text-[10px] text-faint">+{active.length - 4} more on the timeline</li>}
          </ul>
        )}
      </div>

      <div className="mt-3">
        <div className="text-[11px] text-muted">Recently ended</div>
        {recent.length === 0 ? (
          <p className="mt-1 text-[11px] text-faint">Nothing has ended yet.</p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {recent.map(({ e, i }) => (
              <EventRow key={i} e={e} picked={selected === i} onPick={() => select(i, e[0])}>
                <span className="num text-[10px] text-faint">ended {(t - e[1]).toFixed(0)} s ago</span>
              </EventRow>
            ))}
          </ul>
        )}
      </div>

      {top.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] text-muted">Most frequent so far</div>
          <ul className="mt-1.5 space-y-1">
            {top.map(([id, n]) => (
              <li key={id} className="flex items-center gap-2 text-[11px]">
                <span className="w-[108px] shrink-0 truncate text-muted">{classLabel(id)}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink2">
                  <span className="block h-full rounded-full" style={{ width: `${(n / top[0][1]) * 100}%`, background: classColor(id) }} />
                </span>
                <span className="num w-5 text-right text-text">{n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {processing && (
        <p className="num mt-3 border-t border-linesoft pt-2.5 text-[10px] leading-relaxed text-faint">
          processed by {processing.by}: Part A {processing.partA.toFixed(1)} s + Part B {processing.partB.toFixed(1)} s ={" "}
          {processing.total.toFixed(1)} s for {duration.toFixed(0)} s of video ({(processing.total / Math.max(duration, 1e-6)).toFixed(2)}&times; real
          time)
        </p>
      )}
    </section>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel2 px-2.5 py-2">
      <dt className="text-[10px] text-faint">{label}</dt>
      <dd className="num mt-0.5 text-sm font-semibold text-text">{children}</dd>
    </div>
  );
}

function EventRow({
  e,
  picked,
  onPick,
  children,
}: {
  e: EventTuple;
  picked: boolean;
  onPick: () => void;
  children: React.ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className={`block w-full rounded-md border px-2 py-1.5 text-left transition-colors ${
          picked ? "border-line bg-panel2" : "border-transparent hover:bg-panel2/60"
        }`}
      >
        <span className="flex items-center gap-1.5 text-[11px]">
          <span className="inline-block h-[3px] w-3 shrink-0 rounded-full" style={{ background: classColor(e[2]) }} />
          <span className="truncate text-text">{classLabel(e[2])}</span>
          <span className="num ml-auto shrink-0 text-[10px] text-faint">{timecode(e[0])}</span>
        </span>
        <span className="mt-1 block space-y-0.5">{children}</span>
      </button>
    </li>
  );
}
