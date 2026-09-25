import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { byClassOrder, classColor, classLabel, CLASS_BY_ID } from "../lib/classes";
import { pad3, peakRisk, regionLabel, type EventFact } from "../lib/events";
import { timecode } from "../lib/format";
import { usePlayback } from "../lib/playback";
import type { EventTuple, RiskPoint } from "../lib/types";

interface Props {
  events: EventTuple[];
  visible: Set<string>;
  onToggleClass: (id: string) => void;
  onShowAll: () => void;
  /** Evidence per event, same order as `events`, shown under the picked row. */
  facts?: EventFact[] | null;
  risk?: RiskPoint[];
}

/** Filterable, searchable event list; every row selects its event and seeks the shared clock. */
export function EventInspector({ events, visible, onToggleClass, onShowAll, facts, risk }: Props) {
  const { currentTime, selected, select } = usePlayback();
  const [query, setQuery] = useState("");
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  const boxRef = useRef<HTMLDivElement | null>(null);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) m.set(e[2], (m.get(e[2]) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => byClassOrder(a[0], b[0]));
  }, [events]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events
      .map((e, index) => ({ e, index }))
      .filter(({ e }) => visible.has(e[2]))
      .filter(({ e }) =>
        q === "" ? true : e[2].includes(q) || classLabel(e[2]).toLowerCase().includes(q),
      )
      .sort((a, b) => a.e[0] - b.e[0]);
  }, [events, visible, query]);

  // A pick made anywhere else on the page brings its row into view. Only on a
  // pick (following playback would fight the reader's own scrolling), and only
  // inside the list: scrollIntoView would also drag the page to it.
  useEffect(() => {
    const row = selected === null ? undefined : rowRefs.current.get(selected);
    const box = boxRef.current;
    if (!row || !box) return;
    const r = row.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top + 32 || r.bottom > b.bottom) {
      box.scrollTo({ top: box.scrollTop + (r.top - b.top) - b.height / 3, behavior: "smooth" });
    }
  }, [selected]);

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-panel px-4 py-6 text-sm text-muted">
        No events were detected in this clip. An empty list is a valid Part A result &mdash; the task
        states a video may contain no events at all.
      </div>
    );
  }

  const pick = (index: number) => select(index, events[index][0]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap gap-1.5">
        {counts.map(([id, n]) => {
          const on = visible.has(id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => onToggleClass(id)}
              aria-pressed={on}
              title={CLASS_BY_ID[id]?.definition}
              className={`num inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                on ? "border-line bg-panel2 text-text" : "border-linesoft text-faint"
              }`}
            >
              <span
                className="inline-block h-2 w-2 rounded-full transition-opacity"
                style={{ background: classColor(id), opacity: on ? 1 : 0.3 }}
              />
              {id}
              <span className={on ? "text-muted" : "text-faint"}>{n}</span>
            </button>
          );
        })}
        {visible.size < counts.length && (
          <button
            type="button"
            onClick={onShowAll}
            className="rounded-full border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:text-text"
          >
            show all
          </button>
        )}
      </div>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by class…"
        aria-label="Filter events by class"
        className="mt-3 w-full rounded-md border border-line bg-panel2 px-3 py-2 text-sm outline-none placeholder:text-faint"
      />

      <div ref={boxRef} className="thin-scroll mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-panel2 text-faint">
            <tr>
              <th className="px-3 py-2 font-medium">class</th>
              <th className="px-2 py-2 text-right font-medium">start</th>
              <th className="px-3 py-2 text-right font-medium">dur</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ e, index }) => {
              const isActive = currentTime >= e[0] && currentTime <= e[1];
              const isPicked = selected === index;
              const fact = facts?.[index];
              return (
                <Fragment key={index}>
                  <tr
                    ref={(el) => {
                      if (el) rowRefs.current.set(index, el);
                      else rowRefs.current.delete(index);
                    }}
                    onClick={() => pick(index)}
                    tabIndex={0}
                    aria-selected={isPicked}
                    onKeyDown={(k) => {
                      if (k.key === "Enter" || k.key === " ") {
                        k.preventDefault();
                        pick(index);
                      }
                    }}
                    className={`cursor-pointer border-t border-linesoft transition-colors ${
                      isPicked ? "bg-panel2" : isActive ? "bg-panel2/60" : "hover:bg-panel2/40"
                    }`}
                  >
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-[3px] shrink-0 rounded-sm"
                          style={{ background: classColor(e[2]) }}
                        />
                        <span className="num truncate">{e[2]}</span>
                        {isActive && (
                          <span className="relative flex h-1.5 w-1.5 shrink-0" title="spans the current moment">
                            <span className="pulse-ring absolute inline-flex h-full w-full rounded-full bg-cyan" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-cyan" />
                            <span className="sr-only">now</span>
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="num px-2 py-1.5 text-right text-muted">{timecode(e[0])}</td>
                    <td className="num px-3 py-1.5 text-right text-muted">{(e[1] - e[0]).toFixed(2)}s</td>
                  </tr>
                  {isPicked && fact && (
                    <tr className="bg-panel2">
                      <td colSpan={3} className="px-3 pb-2 pt-0">
                        <dl className="num grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-l-2 pl-2.5 text-[11px]" style={{ borderColor: classColor(e[2]) }}>
                          <dt className="text-faint">ends</dt>
                          <dd className="text-text">{timecode(e[1])}</dd>
                          <dt className="text-faint">tracks</dt>
                          <dd className="truncate text-text">{fact.tracks.length ? fact.tracks.map(pad3).join(" ") : "none recorded"}</dd>
                          {fact.region && (
                            <>
                              <dt className="text-faint">began in</dt>
                              <dd className="text-text">{regionLabel(fact.region)}</dd>
                            </>
                          )}
                          <dt className="text-faint">EB signal</dt>
                          <dd className="text-text">{fact.phase.toLowerCase()} at start</dd>
                          {risk && risk.length > 0 && (
                            <>
                              <dt className="text-faint">peak risk</dt>
                              <dd className="text-text">{peakRisk(risk, e[0], e[1]).toFixed(3)} during it</dd>
                            </>
                          )}
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-faint">No events match this filter.</div>
        )}
      </div>

      <p className="mt-2 text-[11px] text-faint">
        {rows.length} of {events.length} shown &middot; click a row to jump the video &middot; <span className="num">n</span>/<span className="num">p</span> in the player step through them
      </p>
    </div>
  );
}
