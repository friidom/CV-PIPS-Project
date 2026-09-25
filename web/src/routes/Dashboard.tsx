import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { findAlarms, THETA } from "../components/RiskCurve";
import { DataGap, Panel, Section } from "../components/ui";
import { EventTip, LineKey, niceTicks, Tip } from "../components/viz";
import { loadData } from "../lib/api";
import { byClassOrder, classColor, classLabel, IMPLEMENTED_CLASSES } from "../lib/classes";
import { peakRisk, REGION_LABEL, regionLabel, type EventFact, type EventFacts } from "../lib/events";
import { clamp, timecode } from "../lib/format";
import { useElementSize } from "../lib/hooks";
import { PHASE_COLORS, PHASE_NAMES } from "../lib/overlay";
import type { SampleData, SceneData } from "../lib/types";

const CLIPS = ["C3896", "C3897", "C3902", "C3905"];
const BIN = 10; // seconds per column of the time histogram
const BASE = import.meta.env.BASE_URL;
const EASE = "cubic-bezier(0.3, 0.8, 0.3, 1)";

interface Row {
  key: string;
  clip: string;
  index: number;
  start: number;
  end: number;
  dur: number;
  label: string;
  /** Highest recorded Part B score while the event lasts. */
  peak: number;
  fact: EventFact | null;
}

type Dim = "clip" | "class" | "range" | "region";

interface Filters {
  clips: Set<string>;
  /** null = every class. */
  classes: Set<string> | null;
  /** Clip-relative window on event start, seconds. */
  range: [number, number] | null;
  region: string | null;
}

const ALL: Filters = { clips: new Set(CLIPS), classes: null, range: null, region: null };

/** Crossfilter: a chart is drawn against every filter except its own, so its own choices stay visible. */
function passes(r: Row, f: Filters, skip?: Dim): boolean {
  return (
    (skip === "clip" || f.clips.has(r.clip)) &&
    (skip === "class" || !f.classes || f.classes.has(r.label)) &&
    (skip === "range" || !f.range || (r.start >= f.range[0] && r.start < f.range[1])) &&
    (skip === "region" || !f.region || (r.fact?.region ?? null) === f.region)
  );
}

function toggle<T>(set: Set<T>, v: T): Set<T> {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
}

export default function Dashboard() {
  const [samples, setSamples] = useState<SampleData[] | null>(null);
  const [facts, setFacts] = useState<EventFacts | null>(null);
  const [scene, setScene] = useState<SceneData | null>(null);
  const [f, setF] = useState<Filters>(ALL);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void Promise.all(CLIPS.map((id) => loadData<SampleData>(`samples/${id}.json`, ac.signal))).then((rows) =>
      setSamples(rows.filter((r): r is SampleData => r !== null)),
    );
    void loadData<EventFacts>("events.json", ac.signal).then(setFacts);
    void loadData<SceneData>("eda/scene.json", ac.signal).then(setScene);
    return () => ac.abort();
  }, []);

  const rows = useMemo<Row[]>(() => {
    if (!samples) return [];
    return samples.flatMap((s) =>
      s.events.map(([start, end, label], index) => ({
        key: `${s.id}:${index}`,
        clip: s.id,
        index,
        start,
        end,
        dur: end - start,
        label,
        peak: peakRisk(s.risk, start, end),
        fact: facts?.clips[s.id]?.events[index] ?? null,
      })),
    );
  }, [samples, facts]);

  const byId = useMemo(() => new Map((samples ?? []).map((s) => [s.id, s])), [samples]);
  const shown = useMemo(() => rows.filter((r) => passes(r, f)), [rows, f]);
  const pick = rows.find((r) => r.key === picked) ?? null;

  // Footage in scope: the selected clips, cut to the time window when one is set.
  const footage = useMemo(() => {
    let secs = 0;
    for (const id of f.clips) {
      const d = byId.get(id)?.meta.duration ?? 0;
      secs += f.range ? Math.max(0, Math.min(d, f.range[1]) - f.range[0]) : d;
    }
    return secs;
  }, [f.clips, f.range, byId]);

  const alarms = useMemo(() => {
    let n = 0;
    let peak = 0;
    for (const id of f.clips) {
      const s = byId.get(id);
      if (!s) continue;
      const inRange = (t: number) => !f.range || (t >= f.range[0] && t < f.range[1]);
      n += findAlarms(s.risk).filter((a) => inRange(a.start)).length;
      for (const [t, v] of s.risk) if (inRange(t)) peak = Math.max(peak, v);
    }
    return { n, peak };
  }, [f.clips, f.range, byId]);

  if (samples && samples.length === 0) {
    return (
      <div className="mx-auto max-w-[1320px] px-4 py-14">
        <DataGap
          title="No processed samples"
          what="The dashboard aggregates the sample results in web/public/data/samples, and none are present in this checkout."
          fill="Run run_submission.py over the sample clips, then scripts/build_site_data.py."
        />
      </div>
    );
  }

  const filtered = f.clips.size < CLIPS.length || f.classes !== null || f.range !== null || f.region !== null;
  const totalMin = (samples ?? []).reduce((n, s) => n + s.meta.duration, 0) / 60;
  const maxT = Math.max(1, ...[...f.clips].map((id) => byId.get(id)?.meta.duration ?? 0));
  const classCounts = count(rows.filter((r) => passes(r, f, "class")), (r) => r.label);
  const regionCounts = count(rows.filter((r) => passes(r, f, "region")), (r) => r.fact?.region ?? "unplaced");
  const medianDur = median(shown.map((r) => r.dur));

  return (
    <div className="mx-auto max-w-[1320px] px-4 py-10 sm:py-14">
      <Section
        eyebrow="Traffic operations dashboard"
        title="Every event from the four recorded clips, as an operator would slice it"
        lead={
          <>
            All numbers are the submission&rsquo;s own output on the organizers&rsquo; sample clips
            &mdash; {rows.length} Part A events over {totalMin.toFixed(1)} minutes of footage. Every chart
            filters every other: click a class, a region or a clip, or drag across the timeline.
          </>
        }
      />

      {/* One filter row above everything it scopes. Sticky on wide screens, so the pick and the filters stay in view. */}
      <div className="sticky top-14 z-30 -mx-4 mt-7 border-y border-line bg-ink/90 px-4 py-2.5 backdrop-blur-md max-lg:static">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="num inline-flex items-center gap-1.5 rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-faint" />
            historical &middot; recorded clips
          </span>
          <FilterGroup label="Clips">
            {CLIPS.map((id) => (
              <Chip
                key={id}
                on={f.clips.has(id)}
                disabled={!byId.has(id)}
                onClick={() => setF((p) => ({ ...p, clips: p.clips.has(id) && p.clips.size === 1 ? new Set(CLIPS) : toggle(p.clips, id) }))}
              >
                {id}
              </Chip>
            ))}
          </FilterGroup>
          <FilterGroup label="Window">
            <span className="num text-xs text-text">
              {f.range ? `${timecode(f.range[0])} – ${timecode(f.range[1])}` : "whole clip"}
            </span>
          </FilterGroup>
          <FilterGroup label="Class">
            <span className="text-xs text-text">{f.classes ? [...f.classes].map(classLabel).join(", ") : "all"}</span>
          </FilterGroup>
          <FilterGroup label="Region">
            <span className="num text-xs text-text">{f.region ? regionLabel(f.region) : "all"}</span>
          </FilterGroup>
          {filtered && (
            <button
              type="button"
              onClick={() => setF(ALL)}
              className="rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:text-text"
            >
              Reset filters
            </button>
          )}
        </div>
        {pick && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-linesoft pt-2 text-xs">
            <span className="num text-[10px] uppercase tracking-wider text-faint">selected</span>
            <span className="inline-flex items-center gap-1.5">
              <LineKey color={classColor(pick.label)} />
              <span className="font-medium">{classLabel(pick.label)}</span>
            </span>
            <span className="num text-muted">
              {pick.clip} &middot; {timecode(pick.start)} &rarr; {timecode(pick.end)} &middot; {pick.dur.toFixed(2)} s
            </span>
            {pick.fact && <span className="num text-muted">{regionLabel(pick.fact.region)} &middot; EB {pick.fact.phase.toLowerCase()}</span>}
            <span className="num text-muted">peak risk {pick.peak.toFixed(3)}</span>
            <Link
              to={`/samples?clip=${pick.clip}&ev=${pick.index}`}
              className="ml-auto rounded-md bg-accent px-2.5 py-1 font-semibold text-accentink transition-opacity hover:opacity-90"
            >
              Open in player &rarr;
            </Link>
            <button type="button" onClick={() => setPicked(null)} className="text-muted hover:text-text" aria-label="Clear selection">
              &times;
            </button>
          </div>
        )}
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" style={{ opacity: samples ? 1 : 0.4 }}>
        <Kpi label="Events" value={shown.length} hint={`of ${rows.length} in all clips`} />
        <Kpi
          label="Rate, normalised"
          value={footage > 0 ? `${((shown.length / footage) * 3600).toFixed(0)}/h` : "—"}
          hint={`from ${(footage / 60).toFixed(1)} min of footage, not an hourly count`}
        />
        <Kpi label="Classes" value={new Set(shown.map((r) => r.label)).size} hint={`of ${IMPLEMENTED_CLASSES.length} the rules can emit`} />
        <Kpi label="Median duration" value={shown.length ? `${medianDur.toFixed(1)} s` : "—"} hint="per event" />
        <Kpi label="Peak risk" value={alarms.peak.toFixed(3)} hint={`selected clips and window · θ = ${THETA.toFixed(2)}`} />
        <Kpi label="Alarms" value={alarms.n} hint="score ≥ θ, runs < 2 s apart merged; clips and window only" />
      </dl>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card
          title="Events over clip time"
          note={`Event starts per ${BIN} s of clip time, summed over the selected clips. Drag across to set a window; click to clear it. The clips are ${(Math.min(...[...f.clips].map((id) => byId.get(id)?.meta.duration ?? Infinity)) / 60).toFixed(1)}–${(maxT / 60).toFixed(1)} min long, so later bins are covered by fewer of them.`}
        >
          <TimeHistogram
            rows={rows.filter((r) => passes(r, f, "range"))}
            maxT={maxT}
            range={f.range}
            onRange={(range) => setF((p) => ({ ...p, range }))}
            cover={(t) => [...f.clips].filter((id) => (byId.get(id)?.meta.duration ?? 0) > t).length}
          />
        </Card>
        <Card
          title="Events by class"
          note="Click a class to filter; click again to add or remove it. Right column: events per hour, normalised from the footage in scope — not an hourly count."
        >
          <ClassBars
            counts={classCounts}
            classes={f.classes}
            footage={footage}
            onToggle={(id) =>
              setF((p) => {
                const next = toggle(p.classes ?? new Set<string>(), id);
                return { ...p, classes: next.size ? next : null };
              })
            }
          />
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card
          title="Where events begin"
          note="The scene region under the event's evidence during its first second, on the reference plate: a crossing, else the smallest zone of configs/scene.json that holds it. Lane lines exist only on the east-bound approach, so this is a region, never a lane. Dots are events; click one to select it."
        >
          {scene && facts ? (
            <RegionMap
              scene={scene}
              rows={rows.filter((r) => passes(r, f, "region"))}
              counts={regionCounts}
              region={f.region}
              picked={picked}
              onRegion={(id) => setF((p) => ({ ...p, region: p.region === id ? null : id }))}
              onPick={setPicked}
            />
          ) : (
            <DataGap
              title="No region attribution"
              what="web/public/data/events.json is missing, so events cannot be placed in the scene."
              fill="Run python scripts/build_event_facts.py."
            />
          )}
        </Card>
        <Card title="Events by region" note="Share of the event's opening evidence that agrees on the region is in each dot's tooltip.">
          <RegionBars counts={regionCounts} region={f.region} onRegion={(id) => setF((p) => ({ ...p, region: p.region === id ? null : id }))} />
          <h4 className="mt-6 text-xs font-semibold">East-bound signal when each event began</h4>
          <p className="mt-0.5 text-[11px] text-faint">Read from the lamp pixels at the event&rsquo;s first frame; follows every filter.</p>
          <PhaseBars rows={shown} />
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="How long events last" note="One dot per event, log scale. Sub-second segments are unlikely to survive matching at tIoU 0.7.">
          <Strip rows={shown} value={(r) => r.dur} log domain={[0.2, 400]} ticks={[0.3, 1, 3, 10, 30, 100, 300]} format={(v) => `${v} s`} picked={picked} onPick={setPicked} />
        </Card>
        <Card
          title="Accident risk while each event lasts"
          note="The highest Part B score recorded during the event. Part B never sees Part A's events, so this is co-occurrence on one clock, not severity."
        >
          <Strip
            rows={shown}
            value={(r) => r.peak}
            domain={[0, 0.65]}
            ticks={[0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]}
            format={(v) => v.toFixed(1)}
            threshold={THETA}
            picked={picked}
            onPick={setPicked}
          />
        </Card>
      </div>

      <details className="group mt-4 rounded-xl border border-line bg-panel">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold marker:hidden">
          <span className="mr-2 inline-block text-faint transition-transform group-open:rotate-90">&rsaquo;</span>
          The {shown.length} events in this selection, as a table
        </summary>
        <div className="thin-scroll max-h-[420px] overflow-auto border-t border-line">
          <table className="w-full min-w-[720px] border-collapse text-left text-xs">
            <thead className="sticky top-0 bg-panel2 text-faint">
              <tr>
                {["clip", "class", "start", "duration", "began in", "EB signal", "peak risk", ""].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...shown]
                .sort((a, b) => a.clip.localeCompare(b.clip) || a.start - b.start)
                .map((r) => (
                  <tr key={r.key} className={`border-t border-linesoft ${picked === r.key ? "bg-panel2" : ""}`}>
                    <td className="num px-3 py-1.5 text-muted">{r.clip}</td>
                    <td className="px-3 py-1.5">
                      <span className="inline-flex items-center gap-1.5">
                        <LineKey color={classColor(r.label)} />
                        {classLabel(r.label)}
                      </span>
                    </td>
                    <td className="num px-3 py-1.5 text-muted">{timecode(r.start)}</td>
                    <td className="num px-3 py-1.5 text-muted">{r.dur.toFixed(2)} s</td>
                    <td className="px-3 py-1.5 text-muted">{regionLabel(r.fact?.region)}</td>
                    <td className="num px-3 py-1.5 text-muted">{r.fact?.phase.toLowerCase() ?? "—"}</td>
                    <td className="num px-3 py-1.5 text-muted">{r.peak.toFixed(3)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <Link to={`/samples?clip=${r.clip}&ev=${r.index}`} className="text-accent underline-offset-4 hover:underline">
                        open
                      </Link>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>

      <Card
        className="mt-4"
        title="Clip comparison and processing"
        note="Event counts follow the class, window and region filters; peak risk and alarms follow the window (risk has no class or region). Click a row to include or exclude that clip. Runtimes are the organizers' harness on one RTX 5080 against the 4K originals; the budget is 3× the clip."
      >
        <ClipTable
          samples={samples ?? []}
          rows={rows.filter((r) => passes(r, f, "clip"))}
          range={f.range}
          clips={f.clips}
          onToggle={(id) => setF((p) => ({ ...p, clips: p.clips.has(id) && p.clips.size === 1 ? new Set(CLIPS) : toggle(p.clips, id) }))}
        />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function count<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return m;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function Card({ title, note, children, className = "" }: { title: string; note?: string; children: ReactNode; className?: string }) {
  return (
    <Panel className={`min-w-0 p-4 ${className}`}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {note && <p className="mt-1 text-[11px] leading-relaxed text-faint">{note}</p>}
      <div className="mt-3">{children}</div>
    </Panel>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-faint">{label}</span>
      {children}
    </div>
  );
}

function Chip({ on, disabled, onClick, children }: { on: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={`num rounded border px-2 py-0.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "border-accent bg-panel2 text-text" : "border-line text-faint hover:text-muted"
      }`}
    >
      {children}
    </button>
  );
}

function Kpi({ label, value, hint }: { label: string; value: ReactNode; hint: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-3.5">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold leading-none tracking-tight">{value}</dd>
      <dd className="mt-1.5 text-[10px] leading-snug text-faint">{hint}</dd>
    </div>
  );
}

/** Event starts per BIN seconds of clip time; drag to set the window every other chart uses. */
function TimeHistogram({
  rows,
  maxT,
  range,
  onRange,
  cover,
}: {
  rows: Row[];
  maxT: number;
  range: [number, number] | null;
  onRange: (r: [number, number] | null) => void;
  cover: (t: number) => number;
}) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; y: number; bin: number } | null>(null);
  const drag = useRef<number | null>(null);
  const W = size.width || 700;
  const H = 168;
  const PL = 30;
  const PR = 8;
  const PT = 10;
  const PB = 22;
  const plotW = Math.max(W - PL - PR, 10);
  const plotH = H - PT - PB;
  const nBins = Math.max(1, Math.ceil(maxT / BIN));
  const span = nBins * BIN;

  const bins = useMemo(() => {
    const out = Array.from({ length: nBins }, () => ({ n: 0, byClass: new Map<string, number>() }));
    for (const r of rows) {
      const b = out[Math.min(nBins - 1, Math.floor(r.start / BIN))];
      if (!b) continue;
      b.n += 1;
      b.byClass.set(r.label, (b.byClass.get(r.label) ?? 0) + 1);
    }
    return out;
  }, [rows, nBins]);

  const yMax = Math.max(1, ...bins.map((b) => b.n));
  const yTicks = niceTicks(0, yMax, 3).filter((v) => Number.isInteger(v));
  const xOf = (t: number) => PL + (t / span) * plotW;
  const tOf = (x: number) => clamp((x - PL) / plotW, 0, 1) * span;
  const bw = plotW / nBins;
  const base = PT + plotH;

  const setFrom = (a: number, b: number) =>
    onRange([Math.floor(Math.min(a, b) / BIN) * BIN, Math.min(span, Math.ceil(Math.max(a, b) / BIN) * BIN)]);

  return (
    <div ref={ref} className="relative w-full select-none">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full cursor-crosshair touch-none"
        role="img"
        aria-label={`Histogram of event start times in ${BIN}-second bins`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = tOf(e.clientX - e.currentTarget.getBoundingClientRect().left);
        }}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - r.left;
          const t = tOf(x);
          if (drag.current !== null && Math.abs(t - drag.current) >= BIN / 2) setFrom(drag.current, t);
          setHover(x >= PL && x <= W - PR ? { x, y: e.clientY - r.top, bin: Math.min(nBins - 1, Math.floor(t / BIN)) } : null);
        }}
        onPointerUp={(e) => {
          const t = tOf(e.clientX - e.currentTarget.getBoundingClientRect().left);
          if (drag.current !== null && Math.abs(t - drag.current) < BIN / 2) onRange(null);
          drag.current = null;
        }}
        onPointerLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={PL} x2={W - PR} y1={base - (v / yMax) * plotH} y2={base - (v / yMax) * plotH} stroke="var(--line)" opacity={v ? 0.5 : 1} />
            <text x={PL - 6} y={base - (v / yMax) * plotH + 3.5} textAnchor="end" fontSize={10} className="num" fill="var(--faint)">
              {v}
            </text>
          </g>
        ))}
        {range && (
          <rect x={xOf(range[0])} y={PT - 4} width={Math.max(xOf(range[1]) - xOf(range[0]), 1)} height={plotH + 4} fill="var(--cyan)" opacity={0.08} />
        )}
        {bins.map((b, i) => {
          const t = i * BIN;
          const inRange = !range || (t >= range[0] && t < range[1]);
          const x = PL + i * bw + 1;
          return (
            <rect
              key={i}
              x={x}
              y={PT}
              width={Math.max(bw - 2, 1)}
              height={plotH}
              fill="var(--cyan)"
              opacity={hover?.bin === i ? 1 : inRange ? 0.78 : 0.25}
              style={{
                transform: `scaleY(${b.n / yMax})`,
                transformOrigin: `${x}px ${base}px`,
                transition: `transform 420ms ${EASE}, opacity 200ms`,
              }}
            />
          );
        })}
        {niceTicks(0, span, Math.max(2, Math.floor(plotW / 90))).map((t) => (
          <text
            key={t}
            x={xOf(t)}
            y={H - 6}
            textAnchor={t === 0 ? "start" : t >= span - 1e-6 ? "end" : "middle"}
            fontSize={10}
            className="num"
            fill="var(--faint)"
          >
            {timecode(t)}
          </text>
        ))}
      </svg>
      {hover && bins[hover.bin] && (
        <Tip x={hover.x} y={hover.y} width={W}>
          <div className="num text-[13px] font-semibold text-text">
            {bins[hover.bin].n} <span className="text-xs font-normal text-muted">event starts</span>
          </div>
          <div className="num mt-0.5 text-[11px] text-muted">
            {timecode(hover.bin * BIN)} &ndash; {timecode((hover.bin + 1) * BIN)} &middot; {cover(hover.bin * BIN)} clip
            {cover(hover.bin * BIN) === 1 ? "" : "s"} reach this far
          </div>
          {bins[hover.bin].n > 0 && (
            <ul className="mt-1.5 space-y-0.5 border-t border-linesoft pt-1.5 text-[11px] text-muted">
              {[...bins[hover.bin].byClass.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([id, n]) => (
                  <li key={id} className="flex items-center gap-1.5">
                    <LineKey color={classColor(id)} />
                    {classLabel(id)}
                    <span className="num ml-auto text-text">{n}</span>
                  </li>
                ))}
            </ul>
          )}
        </Tip>
      )}
    </div>
  );
}

function ClassBars({
  counts,
  classes,
  footage,
  onToggle,
}: {
  counts: Map<string, number>;
  classes: Set<string> | null;
  footage: number;
  onToggle: (id: string) => void;
}) {
  const ids = [...counts.keys()].sort(byClassOrder);
  const max = Math.max(1, ...counts.values());
  if (!ids.length) return <p className="text-xs text-faint">No events in this selection.</p>;
  return (
    <ul className="space-y-1">
      {ids.map((id) => {
        const n = counts.get(id) ?? 0;
        const on = !classes || classes.has(id);
        return (
          <li key={id}>
            <button
              type="button"
              onClick={() => onToggle(id)}
              aria-pressed={classes?.has(id) ?? false}
              className="block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-panel2"
            >
              <span className="flex items-baseline gap-1.5 text-xs">
                <LineKey color={classColor(id)} />
                <span className={`truncate ${on ? "text-text" : "text-faint"}`}>{classLabel(id)}</span>
                <span className="num ml-auto shrink-0 text-text">{n}</span>
                <span className="num w-12 shrink-0 text-right text-[10px] text-faint">
                  {footage > 0 ? `${((n / footage) * 3600).toFixed(0)}/h` : ""}
                </span>
              </span>
              <span className="mt-1 block h-2 overflow-hidden rounded-sm bg-ink2">
                <span
                  className="block h-full rounded-r-[4px]"
                  style={{
                    width: `${(n / max) * 100}%`,
                    background: classColor(id),
                    opacity: on ? 1 : 0.25,
                    transition: `width 420ms ${EASE}, opacity 200ms`,
                  }}
                />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function RegionBars({
  counts,
  region,
  onRegion,
}: {
  counts: Map<string, number>;
  region: string | null;
  onRegion: (id: string) => void;
}) {
  const ids = [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  const max = Math.max(1, ...counts.values());
  if (!ids.length) return <p className="text-xs text-faint">No events in this selection.</p>;
  return (
    <ul className="space-y-1">
      {ids.map((id) => {
        const n = counts.get(id) ?? 0;
        const on = !region || region === id;
        return (
          <li key={id}>
            <button
              type="button"
              onClick={() => id !== "unplaced" && onRegion(id)}
              disabled={id === "unplaced"}
              aria-pressed={region === id}
              className="grid w-full grid-cols-[132px_1fr_auto] items-center gap-2.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-panel2 disabled:cursor-default"
            >
              <span className={`truncate text-xs ${on ? "text-text" : "text-faint"}`}>{REGION_LABEL[id] ?? "not placed"}</span>
              <span className="h-2.5 overflow-hidden rounded-sm bg-ink2">
                <span
                  className="block h-full rounded-r-[4px] bg-cyan"
                  style={{ width: `${(n / max) * 100}%`, opacity: on ? 0.85 : 0.25, transition: `width 420ms ${EASE}, opacity 200ms` }}
                />
              </span>
              <span className="num w-8 text-right text-xs text-text">{n}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Signal phase at each event's start: signal state, so the lamp colours carry it, always with the word. */
function PhaseBars({ rows }: { rows: Row[] }) {
  const counts = count(rows, (r) => r.fact?.phase ?? "UNKNOWN");
  const total = Math.max(1, rows.length);
  return (
    <ul className="mt-2.5 space-y-1.5">
      {PHASE_NAMES.slice(1)
        .concat(PHASE_NAMES[0])
        .map((name) => {
          const n = counts.get(name) ?? 0;
          return (
            <li key={name} className="grid grid-cols-[72px_1fr_auto] items-center gap-2.5 text-xs">
              <span className="inline-flex items-center gap-1.5 text-muted">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: PHASE_COLORS[PHASE_NAMES.indexOf(name)] }} />
                {name.toLowerCase()}
              </span>
              <span className="h-2 overflow-hidden rounded-sm bg-ink2">
                <span
                  className="block h-full rounded-r-[4px]"
                  style={{
                    width: `${(n / total) * 100}%`,
                    background: PHASE_COLORS[PHASE_NAMES.indexOf(name)],
                    transition: `width 420ms ${EASE}`,
                  }}
                />
              </span>
              <span className="num w-16 text-right text-text">
                {n} <span className="text-[10px] text-faint">{Math.round((n / total) * 100)}%</span>
              </span>
            </li>
          );
        })}
    </ul>
  );
}

/** The reference plate with crossings and direction zones shaded by event count, and one dot per event. */
function RegionMap({
  scene,
  rows,
  counts,
  region,
  picked,
  onRegion,
  onPick,
}: {
  scene: SceneData;
  rows: Row[];
  counts: Map<string, number>;
  region: string | null;
  picked: string | null;
  onRegion: (id: string) => void;
  onPick: (key: string) => void;
}) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; y: number; row?: Row; region?: string } | null>(null);
  const [w, h] = scene.size;
  const max = Math.max(1, ...[...counts.entries()].filter(([k]) => k !== "other").map(([, v]) => v));
  // Zones first, crossings on top: a crossing inside a zone must stay clickable.
  const polys = [...scene.zones, ...scene.crosswalks];
  const toPx = (e: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 };
  };

  return (
    <div ref={ref} className="relative w-full">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="block w-full overflow-hidden rounded-lg border border-line bg-black"
        role="img"
        aria-label="Reference plate with scene regions shaded by event count"
        onPointerLeave={() => setHover(null)}
      >
        <image href={`${BASE}${scene.reference}`} x="0" y="0" width={w} height={h} opacity={0.55} />
        {polys.map((p) => {
          const n = counts.get(p.name) ?? 0;
          const on = region === p.name;
          return (
            <polygon
              key={p.name}
              points={p.points.map((q) => q.join(",")).join(" ")}
              fill="var(--cyan)"
              fillOpacity={0.05 + (n / max) * 0.4}
              stroke={on ? "var(--text)" : "var(--cyan)"}
              strokeWidth={on ? 5 : 2}
              strokeOpacity={on ? 1 : 0.6}
              className="cursor-pointer transition-[fill-opacity] duration-300"
              onPointerMove={(e) => setHover({ ...toPx(e), region: p.name })}
              onClick={() => onRegion(p.name)}
            />
          );
        })}
        {rows.map((r) =>
          r.fact?.foot ? (
            <g
              key={r.key}
              className="cursor-pointer"
              style={{ transform: `translate(${r.fact.foot[0]}px, ${r.fact.foot[1]}px)` }}
              onPointerMove={(e) => {
                e.stopPropagation();
                setHover({ ...toPx(e), row: r });
              }}
              onClick={() => onPick(r.key)}
            >
              <circle r={26} fill="transparent" />
              <circle
                r={picked === r.key ? 15 : 9}
                fill={picked === r.key ? "var(--accent)" : "var(--text)"}
                stroke="var(--ink)"
                strokeWidth={4}
                opacity={picked && picked !== r.key ? 0.6 : 0.95}
              />
            </g>
          ) : null,
        )}
      </svg>
      {hover && (
        <Tip x={hover.x} y={hover.y} width={size.width || 600}>
          {hover.row ? (
            <>
              <EventTip event={[hover.row.start, hover.row.end, hover.row.label]} fact={hover.row.fact} peak={hover.row.peak} prefix={hover.row.clip} />
              {hover.row.fact?.share !== undefined && (
                <div className="num mt-1 text-[10px] text-faint">{Math.round(hover.row.fact.share * 100)}% of the opening evidence agrees on the region</div>
              )}
            </>
          ) : (
            <>
              <div className="num text-[13px] font-semibold text-text">
                {counts.get(hover.region ?? "") ?? 0} <span className="text-xs font-normal text-muted">events began here</span>
              </div>
              <div className="mt-0.5 text-[11px] text-muted">{regionLabel(hover.region)}</div>
              <div className="mt-1 text-[10px] text-faint">click to filter by this region</div>
            </>
          )}
        </Tip>
      )}
    </div>
  );
}

/** One row per class, one dot per event: identity by position, so colour is only a second cue. */
function Strip({
  rows,
  value,
  log = false,
  domain,
  ticks,
  format,
  threshold,
  picked,
  onPick,
}: {
  rows: Row[];
  value: (r: Row) => number;
  log?: boolean;
  domain: [number, number];
  ticks: number[];
  format: (v: number) => string;
  threshold?: number;
  picked: string | null;
  onPick: (key: string) => void;
}) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; y: number; row: Row } | null>(null);
  const classes = [...new Set(rows.map((r) => r.label))].sort(byClassOrder);
  const W = size.width || 520;
  const LABEL = W < 440 ? 84 : 170;
  const ROW = 24;
  const H = classes.length * ROW + 24;
  const plotW = Math.max(W - LABEL - 12, 10);
  const f = (v: number) => (log ? Math.log10(Math.max(v, domain[0])) : v);
  const xOf = (v: number) => LABEL + ((f(clamp(v, domain[0], domain[1])) - f(domain[0])) / (f(domain[1]) - f(domain[0]))) * plotW;
  // Stable jitter from the key, so a dot does not hop when filters change.
  const jitter = (key: string) => {
    let hsh = 0;
    for (let i = 0; i < key.length; i++) hsh = (hsh * 31 + key.charCodeAt(i)) | 0;
    return ((Math.abs(hsh) % 1000) / 1000 - 0.5) * (ROW - 10);
  };

  if (!rows.length) return <p className="text-xs text-faint">No events in this selection.</p>;

  return (
    <div ref={ref} className="relative w-full">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Strip plot, one dot per event, one row per class">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={xOf(t)} x2={xOf(t)} y1={0} y2={H - 20} stroke="var(--line)" opacity={0.45} />
            <text x={xOf(t)} y={H - 6} textAnchor="middle" fontSize={10} className="num" fill="var(--faint)">
              {format(t)}
            </text>
          </g>
        ))}
        {threshold !== undefined && (
          <g>
            <line x1={xOf(threshold)} x2={xOf(threshold)} y1={0} y2={H - 20} stroke="var(--bad)" strokeDasharray="4 3" />
            <text x={xOf(threshold) + 4} y={10} fontSize={9} className="num" fill="var(--muted)">
              &theta;
            </text>
          </g>
        )}
        {classes.map((c, i) => {
          // ~5.6 px a character at 11 px: cut the label to its column rather than let it run off the left edge.
          const fit = Math.floor((LABEL - 12) / 5.6);
          const name = classLabel(c);
          return (
            <g key={c}>
              <rect x={LABEL} y={i * ROW + 2} width={plotW} height={ROW - 4} rx={3} fill="var(--panel-2)" opacity={0.45} />
              <text x={LABEL - 8} y={i * ROW + ROW / 2 + 3.5} textAnchor="end" fontSize={11} fill="var(--text)">
                <title>{name}</title>
                {name.length > fit ? `${name.slice(0, fit - 1)}…` : name}
              </text>
            </g>
          );
        })}
        {rows.map((r) => {
          const on = picked === r.key;
          return (
            <g
              key={r.key}
              className="cursor-pointer"
              style={{
                transform: `translate(${xOf(value(r))}px, ${classes.indexOf(r.label) * ROW + ROW / 2 + jitter(r.key)}px)`,
                transition: `transform 420ms ${EASE}`,
              }}
              onPointerMove={(e) => {
                const b = ref.current?.getBoundingClientRect();
                if (b) setHover({ x: e.clientX - b.left, y: e.clientY - b.top, row: r });
              }}
              onPointerLeave={() => setHover(null)}
              onClick={() => onPick(r.key)}
            >
              <circle r={12} fill="transparent" />
              <circle r={on ? 6.5 : 4.5} fill={classColor(r.label)} stroke={on ? "var(--text)" : "var(--panel)"} strokeWidth={2} />
            </g>
          );
        })}
      </svg>
      {hover && (
        <Tip x={hover.x} y={hover.y} width={W}>
          <EventTip event={[hover.row.start, hover.row.end, hover.row.label]} fact={hover.row.fact} peak={hover.row.peak} prefix={hover.row.clip} />
          <div className="mt-1.5 text-[10px] text-faint">click to select; open it in the player from the bar above</div>
        </Tip>
      )}
    </div>
  );
}

function ClipTable({
  samples,
  rows,
  range,
  clips,
  onToggle,
}: {
  samples: SampleData[];
  rows: Row[];
  range: [number, number] | null;
  clips: Set<string>;
  onToggle: (id: string) => void;
}) {
  const inRange = (t: number) => !range || (t >= range[0] && t < range[1]);
  const maxRtf = 3;
  return (
    <div className="thin-scroll relative overflow-x-auto">
      <table className="w-full min-w-[860px] border-collapse text-left text-xs">
        <thead className="text-faint">
          <tr className="border-b border-line">
            <th className="py-2 pr-3 font-medium">clip</th>
            <th className="px-2 py-2 text-right font-medium">duration</th>
            <th className="px-2 py-2 text-right font-medium">events</th>
            <th className="px-2 py-2 text-right font-medium">per h (norm.)</th>
            <th className="px-2 py-2 font-medium">classes</th>
            <th className="px-2 py-2 text-right font-medium">peak risk</th>
            <th className="px-2 py-2 text-right font-medium">alarms</th>
            <th className="px-2 py-2 text-right font-medium">Part A</th>
            <th className="px-2 py-2 text-right font-medium">Part B</th>
            <th className="py-2 pl-2 font-medium">total vs 3&times; budget</th>
          </tr>
        </thead>
        <tbody>
          {samples.map((s) => {
            const mine = rows.filter((r) => r.clip === s.id);
            const on = clips.has(s.id);
            const rt = s.runtime;
            const rtf = rt ? rt.total_sec / rt.duration : null;
            const peak = s.risk.reduce((m, p) => (inRange(p[0]) ? Math.max(m, p[1]) : m), 0);
            // Seconds of this clip inside the window: the denominator of the normalised rate.
            const scope = range ? Math.max(0, Math.min(s.meta.duration, range[1]) - range[0]) : s.meta.duration;
            const classes = [...new Set(mine.map((r) => r.label))].sort(byClassOrder);
            return (
              <tr
                key={s.id}
                onClick={() => onToggle(s.id)}
                aria-selected={on}
                className={`cursor-pointer border-b border-linesoft transition-colors hover:bg-panel2/60 ${on ? "" : "opacity-45"}`}
              >
                <td className="py-2 pr-3">
                  <span className="num inline-flex items-center gap-2 font-semibold">
                    <span className={`inline-block h-2.5 w-2.5 rounded-sm border ${on ? "border-accent bg-accent" : "border-line"}`} />
                    {s.id}
                  </span>
                </td>
                <td className="num px-2 py-2 text-right text-muted">{(s.meta.duration / 60).toFixed(1)} min</td>
                <td className="num px-2 py-2 text-right text-text">{mine.length}</td>
                <td className="num px-2 py-2 text-right text-muted">
                  {scope > 0 ? ((mine.length / scope) * 3600).toFixed(0) : "—"}
                </td>
                <td className="px-2 py-2">
                  <span className="flex flex-wrap gap-1">
                    {classes.map((c) => (
                      <span key={c} className="inline-flex items-center gap-1 text-[10px] text-muted" title={classLabel(c)}>
                        <LineKey color={classColor(c)} />
                        <span className="sr-only">{classLabel(c)}</span>
                        {mine.filter((r) => r.label === c).length}
                      </span>
                    ))}
                  </span>
                </td>
                <td className={`num px-2 py-2 text-right ${peak >= THETA ? "text-text" : "text-muted"}`}>
                  {peak.toFixed(3)}
                  {peak >= THETA && <span className="ml-1 text-[10px] text-bad">&#9650;</span>}
                </td>
                <td className="num px-2 py-2 text-right text-muted">{findAlarms(s.risk).filter((a) => inRange(a.start)).length}</td>
                <td className="num px-2 py-2 text-right text-muted">{rt ? `${rt.part_a_sec.toFixed(1)} s` : "—"}</td>
                <td className="num px-2 py-2 text-right text-muted">{rt ? `${rt.part_b_sec.toFixed(1)} s` : "—"}</td>
                <td className="py-2 pl-2">
                  {rt && rtf !== null ? (
                    <span className="flex items-center gap-2">
                      <span className="relative h-2 w-40 overflow-hidden rounded-sm bg-ink2" title={`${rt.total_sec.toFixed(1)} s of a ${rt.budget_sec.toFixed(0)} s budget`}>
                        <span className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${(rt.part_a_sec / rt.duration / maxRtf) * 100}%` }} />
                        <span
                          className="absolute inset-y-0 bg-cyan"
                          style={{ left: `${(rt.part_a_sec / rt.duration / maxRtf) * 100}%`, width: `${(rt.part_b_sec / rt.duration / maxRtf) * 100}%` }}
                        />
                      </span>
                      <span className="num text-text">{rtf.toFixed(2)}&times;</span>
                    </span>
                  ) : (
                    <span className="text-faint">no runtime log</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-3 rounded-sm bg-accent" /> Part A (events)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-3 rounded-sm bg-cyan" /> Part B (risk, every frame)
        </span>
        <span className="text-faint">bar length = seconds per second of video; full bar = the 3.00&times; budget</span>
      </div>
    </div>
  );
}
