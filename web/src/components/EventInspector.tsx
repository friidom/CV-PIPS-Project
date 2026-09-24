import { useMemo, useState } from "react";
import { byClassOrder, classColor, classLabel, CLASS_BY_ID } from "../lib/classes";
import { timecode } from "../lib/format";
import { usePlayback } from "../lib/playback";
import type { EventTuple } from "../lib/types";

interface Props {
  events: EventTuple[];
  visible: Set<string>;
  onToggleClass: (id: string) => void;
  onShowAll: () => void;
  selected: number | null;
  onSelect: (i: number) => void;
}

/** Filterable, searchable event list; every row seeks the shared clock. */
export function EventInspector({
  events,
  visible,
  onToggleClass,
  onShowAll,
  selected,
  onSelect,
}: Props) {
  const { seek, currentTime } = usePlayback();
  const [query, setQuery] = useState("");

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

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-panel px-4 py-6 text-sm text-muted">
        No events were detected in this clip. An empty list is a valid Part A result &mdash; the task
        states a video may contain no events at all.
      </div>
    );
  }

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

      <div className="thin-scroll mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-panel2 text-faint">
            <tr>
              <th className="px-3 py-2 font-medium">class</th>
              <th className="px-2 py-2 text-right font-medium">start</th>
              <th className="px-2 py-2 text-right font-medium">end</th>
              <th className="px-3 py-2 text-right font-medium">dur</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ e, index }) => {
              const isActive = currentTime >= e[0] && currentTime <= e[1];
              return (
                <tr
                  key={index}
                  onClick={() => {
                    seek(e[0]);
                    onSelect(index);
                  }}
                  tabIndex={0}
                  onKeyDown={(k) => {
                    if (k.key === "Enter" || k.key === " ") {
                      k.preventDefault();
                      seek(e[0]);
                      onSelect(index);
                    }
                  }}
                  className={`cursor-pointer border-t border-linesoft transition-colors ${
                    selected === index ? "bg-panel2" : isActive ? "bg-panel2/60" : "hover:bg-panel2/40"
                  }`}
                >
                  <td className="px-3 py-1.5">
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-[3px] shrink-0 rounded-sm"
                        style={{ background: classColor(e[2]) }}
                      />
                      <span className="num truncate">{e[2]}</span>
                    </span>
                  </td>
                  <td className="num px-2 py-1.5 text-right text-muted">{timecode(e[0])}</td>
                  <td className="num px-2 py-1.5 text-right text-muted">{timecode(e[1])}</td>
                  <td className="num px-3 py-1.5 text-right text-muted">{(e[1] - e[0]).toFixed(2)}s</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-faint">No events match this filter.</div>
        )}
      </div>

      <p className="mt-2 text-[11px] text-faint">
        {rows.length} of {events.length} shown &middot; click a row to jump the video
      </p>
    </div>
  );
}
