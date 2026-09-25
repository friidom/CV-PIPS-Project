import type { ReactNode } from "react";
import { classColor, classLabel } from "../lib/classes";
import { pad3, regionLabel, type EventFact } from "../lib/events";
import { timecode } from "../lib/format";
import type { EventTuple } from "../lib/types";

/** Ticks on a 1/2/5 x 10^n ladder so labels stay round at every zoom level. */
export function niceTicks(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / Math.max(count, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const first = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let t = first; t <= hi + 1e-9; t += step) out.push(Number(t.toFixed(6)));
  return out;
}

/**
 * The one tooltip shell every chart uses: anchored at (x, y) inside a relative
 * parent `width` px wide, kept on screen, and above the pointer unless there is
 * no room.
 */
export function Tip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const w = 236;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-30 rounded-md border border-line bg-ink/95 px-2.5 py-2 text-xs shadow-xl backdrop-blur-sm"
      style={{
        width: w,
        left: Math.min(Math.max(x - w / 2, 0), Math.max(width - w, 0)),
        top: y,
        transform: y > 96 ? "translateY(calc(-100% - 12px))" : "translateY(16px)",
      }}
    >
      {children}
    </div>
  );
}

/** A short stroke of the series colour: tooltip rows key identity with a line, not a box. */
export function LineKey({ color }: { color: string }) {
  return <span className="inline-block h-[3px] w-3 shrink-0 rounded-full" style={{ background: color }} />;
}

/** Everything the data says about one event, in the same words in every view. */
export function EventTip({
  event,
  fact,
  peak,
  prefix,
}: {
  event: EventTuple;
  fact?: EventFact | null;
  peak?: number | null;
  prefix?: string;
}) {
  const [s, e, label] = event;
  return (
    <>
      <div className="flex items-center gap-1.5 text-muted">
        <LineKey color={classColor(label)} />
        <span className="truncate">{classLabel(label)}</span>
        {prefix && <span className="num ml-auto shrink-0 text-faint">{prefix}</span>}
      </div>
      <div className="num mt-1 text-[13px] font-semibold text-text">
        {timecode(s)} &rarr; {timecode(e)}
        <span className="ml-1.5 font-normal text-muted">{(e - s).toFixed(2)} s</span>
      </div>
      {fact && (
        <dl className="num mt-1.5 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-[11px]">
          <dt className="text-faint">tracks</dt>
          <dd className="truncate text-text">
            {fact.tracks.length ? fact.tracks.slice(0, 6).map(pad3).join(" ") : "none recorded"}
            {fact.tracks.length > 6 && <span className="text-faint"> +{fact.tracks.length - 6}</span>}
          </dd>
          {fact.region !== undefined && fact.region !== null && (
            <>
              <dt className="text-faint">began in</dt>
              <dd className="truncate text-text">{regionLabel(fact.region)}</dd>
            </>
          )}
          <dt className="text-faint">EB signal</dt>
          <dd className="text-text">{fact.phase.toLowerCase()} at start</dd>
          {peak != null && (
            <>
              <dt className="text-faint">peak risk</dt>
              <dd className="text-text">{peak.toFixed(3)}</dd>
            </>
          )}
        </dl>
      )}
    </>
  );
}
