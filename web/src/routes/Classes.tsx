import { useMemo, useState } from "react";
import { Callout, Panel, Section, Stat, Tag } from "../components/ui";
import { CLASSES } from "../lib/classes";

type Filter = "all" | "detected" | "not";

export default function Classes() {
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const shown = useMemo(
    () =>
      CLASSES.filter((c) =>
        filter === "all" ? true : filter === "detected" ? c.rule !== null : c.rule === null,
      ),
    [filter],
  );

  const detected = CLASSES.filter((c) => c.rule !== null).length;

  return (
    <div className="mx-auto max-w-[1320px] px-4 py-10 sm:py-14">
      <Section
        eyebrow="Event classes"
        title="The 14 official ids, and which ones we emit"
        lead={
          <>
            Definitions and start/end conventions below are transcribed from the task&rsquo;s Event
            classes table, unchanged. What we added is the last line of each card: how &mdash; or
            whether &mdash; this repository decides it.
          </>
        }
      />

      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        <Stat value={`${detected} / 14`} label="Classes detected" tone="accent" />
        <Stat value={14 - detected} label="Not detected" hint="removed from CLASSES, never guessed" />
        <Stat value="0.3 / 0.5 / 0.7" label="Temporal IoU thresholds" hint="F1 is averaged over all three" />
      </div>

      <div className="mt-6 flex flex-wrap gap-1.5">
        {(
          [
            ["all", `All 14`],
            ["detected", `Detected (${detected})`],
            ["not", `Not detected (${14 - detected})`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setFilter(k)}
            aria-pressed={filter === k}
            className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
              filter === k ? "border-line bg-panel2 text-text" : "border-linesoft text-faint hover:text-muted"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <ul className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((c) => {
          const open = openId === c.id;
          const on = c.rule !== null;
          return (
            <Panel
              as="li"
              key={c.id}
              className={`overflow-hidden p-0 transition-opacity ${on ? "" : "opacity-75"}`}
            >
              <button
                type="button"
                onClick={() => setOpenId(open ? null : c.id)}
                aria-expanded={open}
                className="w-full p-4 text-left"
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className="mt-1 inline-block h-3 w-[3px] shrink-0 rounded-sm"
                    style={{ background: c.color, opacity: on ? 1 : 0.4 }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="num text-[13px] font-medium">{c.id}</div>
                    <div className="mt-0.5 text-xs text-muted">{c.label}</div>
                  </div>
                  <Tag tone={on ? "ok" : "off"}>{on ? "detected" : "not detected"}</Tag>
                </div>

                <p className="mt-3 text-[13px] leading-relaxed text-text">{c.definition}</p>

                <dl className="mt-3 space-y-1 text-[11px]">
                  <div className="flex gap-2">
                    <dt className="w-9 shrink-0 text-faint">start</dt>
                    <dd className="text-muted">{c.start}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-9 shrink-0 text-faint">end</dt>
                    <dd className="text-muted">{c.end}</dd>
                  </div>
                </dl>

                <div className="mt-3 border-t border-linesoft pt-3">
                  <div className="num text-[10px] uppercase tracking-[0.14em] text-accent">
                    {on ? "How we decide it" : "Why not"}
                  </div>
                  <p className={`mt-1 text-[12px] leading-relaxed text-muted ${open ? "" : "line-clamp-2"}`}>
                    {c.how}
                  </p>
                  {c.rule && open && <p className="num mt-2 text-[11px] text-faint">{c.rule}</p>}
                </div>
              </button>
            </Panel>
          );
        })}
      </ul>

      <div className="mt-10 grid gap-4 md:grid-cols-2">
        <Callout tone="note" title={`Why we removed ${CLASSES.length - detected} ids instead of guessing`}>
          Score A averages F1 over the classes present in the test set <em>plus</em> any class we
          predict. A class we emit but never get right is a zero folded into that average, and a class
          we stay silent on costs nothing beyond the ground-truth classes we miss. The task permits
          removing ids and forbids adding them, so <span className="num">CLASSES</span> in{" "}
          <span className="num">solution.py</span> lists exactly the {detected} we implement.
        </Callout>
        <Callout tone="note" title="Overlap rules">
          Two segments of the same class must never overlap &mdash; the harness silently drops the
          later one &mdash; so every rule ends with a union pass. Different classes may overlap freely,
          which is why the timeline gives each class its own lane: a jaywalking pedestrian and the
          failure_to_yield they cause are two separate, simultaneous events.
        </Callout>
      </div>
    </div>
  );
}
