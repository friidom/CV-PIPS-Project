import { Link } from "react-router-dom";
import { byClassOrder, classColor } from "../lib/classes";
import { timecode } from "../lib/format";
import type { DevClass, DevEvent, DevVideo } from "../lib/types";
import { niceTicks } from "./viz";

const STATUS_COLOUR = { tp: "var(--ok)", fp: "var(--bad)", fn: "var(--accent)" } as const;
const STATUS_WORD = { tp: "matched", fp: "no label under it", fn: "missed" } as const;
const LABEL_W = "7.5rem";

const f1Tone = (v: number) => (v >= 0.67 ? "text-ok" : v === 0 ? "text-faint" : "text-text");

/** evaluate.py's per-class report as a table: F1 at each tIoU and the TP/FP/FN behind the middle one. */
export function DevClassTable({ classes }: { classes: DevClass[] }) {
  const rows = [...classes].sort((a, b) => byClassOrder(a.id, b.id));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] text-left text-xs">
        <thead>
          <tr className="border-b border-line text-faint">
            <th className="py-2 pr-3 font-medium">class</th>
            <th className="py-2 pr-3 text-right font-medium">labelled</th>
            <th className="py-2 pr-3 text-right font-medium">emitted</th>
            <th className="py-2 pr-3 text-right font-medium">F1 @0.3</th>
            <th className="py-2 pr-3 text-right font-medium">F1 @0.5</th>
            <th className="py-2 pr-3 text-right font-medium">F1 @0.7</th>
            <th className="py-2 pr-3 text-right font-medium">mean</th>
            <th className="py-2 text-right font-medium">TP / FP / FN @0.5</th>
          </tr>
        </thead>
        <tbody className="num">
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-linesoft">
              <td className="py-1.5 pr-3">
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: classColor(r.id) }} />
                  {r.id}
                </span>
              </td>
              <td className="py-1.5 pr-3 text-right">{r.gt}</td>
              <td className="py-1.5 pr-3 text-right">{r.pred}</td>
              {r.f1.map((v, i) => (
                <td key={i} className={`py-1.5 pr-3 text-right ${f1Tone(v)}`}>
                  {v.toFixed(2)}
                </td>
              ))}
              <td className={`py-1.5 pr-3 text-right font-semibold ${f1Tone(r.mean)}`}>{r.mean.toFixed(3)}</td>
              <td className="py-1.5 text-right text-muted">
                {r.tp} / {r.fp} / {r.fn}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Labels against predictions, one pair of lanes per class, coloured by the match at tIoU 0.5.
 * Every block links to that moment in the sample player.
 */
export function DevTimeline({ clip, video }: { clip: string; video: DevVideo }) {
  const ids = [...new Set([...video.gt, ...video.pred].map((e) => e[2]))].sort(byClassOrder);
  const ticks = niceTicks(0, video.duration, 6).filter((t) => t < video.duration);
  const pct = (t: number) => `${(Math.min(t, video.duration) / video.duration) * 100}%`;

  const lane = (events: DevEvent[], who: "label" | "ours") => (
    <div className="relative h-3.5 rounded-sm bg-panel2">
      {events.map((e, i) => (
        <Link
          key={i}
          to={`/samples?clip=${clip}&t=${e[0].toFixed(2)}`}
          title={`${who === "label" ? "label" : "ours"} · ${e[2]} · ${timecode(e[0])}–${timecode(e[1])} · ${
            STATUS_WORD[e[3]]
          }${e[4] > 0 ? ` · best tIoU ${e[4].toFixed(2)}` : ""}`}
          aria-label={`${who} ${e[2]} at ${timecode(e[0])}, ${STATUS_WORD[e[3]]}`}
          className="absolute top-0 h-full rounded-sm opacity-90 transition-opacity hover:opacity-100"
          style={{
            left: pct(e[0]),
            width: `max(3px, ${(Math.max(e[1] - e[0], 0) / video.duration) * 100}%)`,
            background: STATUS_COLOUR[e[3]],
          }}
        />
      ))}
    </div>
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        {(["tp", "fn", "fp"] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: STATUS_COLOUR[s] }} />
            {s === "tp" ? "matched at tIoU ≥ 0.5" : s === "fn" ? "label we missed (FN)" : "prediction with no match (FP)"}
          </span>
        ))}
      </div>
      <div className="space-y-2.5">
        {ids.map((id) => (
          <div key={id} className="grid items-center gap-x-3" style={{ gridTemplateColumns: `${LABEL_W} 1fr` }}>
            <div className="num truncate text-[11px] text-text" title={id}>
              <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: classColor(id) }} />
              {id}
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="num w-9 shrink-0 text-[9px] uppercase tracking-wider text-faint">label</span>
                <div className="min-w-0 flex-1">{lane(video.gt.filter((e) => e[2] === id), "label")}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className="num w-9 shrink-0 text-[9px] uppercase tracking-wider text-faint">ours</span>
                <div className="min-w-0 flex-1">{lane(video.pred.filter((e) => e[2] === id), "ours")}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 grid gap-x-3" style={{ gridTemplateColumns: `${LABEL_W} 1fr` }}>
        <span />
        <div className="flex items-center gap-2">
          <span className="w-9 shrink-0" />
          <div className="num relative h-4 min-w-0 flex-1 text-[10px] text-faint">
            {ticks.map((t) => (
              <span key={t} className="absolute -translate-x-1/2" style={{ left: pct(t) }}>
                {timecode(t).slice(0, 5)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * What we emitted over each labelled event: its own class if we emitted that at all, otherwise
 * the class overlapping it most, otherwise nothing. The last row holds predictions with no label
 * under them.
 */
export function ConfusionTable({ cells }: { cells: DevVideo["confusion"] }) {
  const rows = [...new Set(cells.map((c) => c[0]))].sort(byClassOrder);
  const cols = [...new Set(cells.map((c) => c[1]))].sort(byClassOrder);
  const count = (r: string, c: string) => cells.find((x) => x[0] === r && x[1] === c)?.[2] ?? 0;
  const tone = (r: string, c: string) =>
    r === c ? "bg-[color-mix(in_srgb,var(--ok)_22%,transparent)] text-text" : "bg-[color-mix(in_srgb,var(--bad)_16%,transparent)] text-text";
  return (
    <div className="overflow-x-auto">
      <table className="num text-center text-[11px]">
        <thead>
          <tr>
            <th className="p-1.5 text-left text-[10px] font-medium uppercase tracking-wider text-faint">
              label &darr; &nbsp; emitted &rarr;
            </th>
            {cols.map((c) => (
              <th key={c} className="p-1.5 align-bottom font-medium text-muted">
                <span className="inline-block max-w-[5.5rem] break-words leading-tight">{c}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <th className="whitespace-nowrap p-1.5 text-left font-medium text-muted">{r}</th>
              {cols.map((c) => {
                const n = count(r, c);
                return (
                  <td key={c} className={`h-8 min-w-[2.5rem] border border-linesoft p-1.5 ${n ? tone(r, c) : "text-faint"}`}>
                    {n || "·"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
