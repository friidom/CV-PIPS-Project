import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LiveScene } from "../components/LiveScene";
import { PART_A, Pipeline } from "../components/Pipeline";
import { Panel, Section } from "../components/ui";
import { loadData } from "../lib/api";
import { byClassOrder, classColor, classLabel, CLASSES, IMPLEMENTED_CLASSES } from "../lib/classes";
import { group } from "../lib/format";
import { useCountUp, usePointerParallax, useReveal } from "../lib/hooks";
import type { OverlayData } from "../lib/overlay";
import type { FlowFieldData, Manifest, SampleData, SceneData } from "../lib/types";

const SAMPLE_IDS = ["C3896", "C3897", "C3902", "C3905"];

export default function Overview() {
  const navigate = useNavigate();
  const [flow, setFlow] = useState<FlowFieldData | null>(null);
  const [scene, setScene] = useState<SceneData | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [samples, setSamples] = useState<SampleData[]>([]);
  const [replay, setReplay] = useState<OverlayData | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void loadData<FlowFieldData>("eda/flow-field.json", ac.signal).then(setFlow);
    void loadData<SceneData>("eda/scene.json", ac.signal).then(setScene);
    void Promise.all(
      SAMPLE_IDS.map((id) => loadData<SampleData>(`samples/${id}.json`, ac.signal)),
    ).then((rows) => setSamples(rows.filter((r): r is SampleData => r !== null)));
    void loadData<Manifest>("manifest.json", ac.signal).then((m) => {
      setManifest(m);
      const hero = m?.summary?.hero_replay;
      if (hero) void loadData<OverlayData>(`replay/${hero}.json`, ac.signal).then(setReplay);
    });
    return () => ac.abort();
  }, []);

  // Every headline figure below is an aggregate of the four real runs.
  const totals = useMemo(() => {
    const withRuntime = samples.filter((s) => s.runtime);
    const secs = withRuntime.reduce((n, s) => n + s.runtime!.duration, 0);
    const spent = withRuntime.reduce((n, s) => n + s.runtime!.total_sec, 0);
    const budget = withRuntime.reduce((n, s) => n + s.runtime!.budget_sec, 0);
    const byClass = new Map<string, number>();
    for (const s of samples) {
      for (const [, , label] of s.events) byClass.set(label, (byClass.get(label) ?? 0) + 1);
    }
    return {
      events: samples.reduce((n, s) => n + s.events.length, 0),
      clips: samples.length,
      secs,
      realtime: secs ? spent / secs : 0,
      budgetUsed: budget ? spent / budget : 0,
      byClass: [...byClass.entries()].sort((a, b) => byClassOrder(a[0], b[0])),
    };
  }, [samples]);

  const heroId = manifest?.summary?.hero_replay ?? null;
  const heroSample = samples.find((s) => s.id === heroId) ?? null;
  const parallaxRef = usePointerParallax<HTMLDivElement>();
  const [statsRef, statsShown] = useReveal<HTMLDListElement>();

  return (
    <div>
      {/* ---------------------------------------------------------------- hero */}
      <section className="cal-bg relative overflow-hidden border-b border-line">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(1200px 520px at 68% -8%, color-mix(in srgb, var(--cyan) 11%, transparent), transparent 70%)",
          }}
        />
        <div className="relative mx-auto max-w-[1320px] px-4 py-10 sm:py-14">
          <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-10">
            <div>
              <div className="num mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-panel/80 px-3 py-1 text-[11px] uppercase tracking-wider text-muted backdrop-blur-sm">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="pulse-ring absolute inline-flex h-full w-full rounded-full bg-accent" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
                </span>
                WIUT Hackathon 2026 &middot; CV Track
              </div>

              <h1 className="text-balance text-[2.1rem] font-semibold leading-[1.06] tracking-tight sm:text-5xl">
                It watches one intersection and says exactly{" "}
                <span className="text-accent">what happened, and when</span>.
              </h1>

              <p className="mt-5 max-w-[54ch] text-pretty text-[15px] leading-relaxed text-muted">
                A detector and a tracker turn 4K CCTV into trajectories. The intersection&rsquo;s own
                geometry and its signal lamps turn those trajectories into labelled time segments. A
                second pass, which never looks forward in time, estimates how close this moment is to
                an accident.
              </p>

              <div className="mt-7 flex flex-wrap gap-2.5">
                <Link
                  to="/demo"
                  className="group rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-accentink transition-opacity hover:opacity-90"
                >
                  Run it on your own clip
                  <span className="ml-1.5 inline-block transition-transform group-hover:translate-x-0.5">
                    &rarr;
                  </span>
                </Link>
                <Link
                  to="/samples"
                  className="rounded-md border border-line bg-panel/60 px-4 py-2.5 text-sm text-muted backdrop-blur-sm transition-colors hover:text-text"
                >
                  See all four sample clips
                </Link>
              </div>

              <dl ref={statsRef} className="mt-9 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
                <HeroStat
                  run={statsShown}
                  value={totals.events}
                  label="events detected"
                  note={`across ${totals.clips} official clips`}
                />
                <HeroStat
                  run={statsShown}
                  value={totals.realtime}
                  decimals={2}
                  suffix="×"
                  label="of real time"
                  note="the budget allows 3.00×"
                />
                <HeroStat
                  run={statsShown}
                  value={flow?.total_samples ?? 0}
                  label="motion samples"
                  note="the learned flow field"
                  grouped
                />
                <HeroStat
                  run={statsShown}
                  value={IMPLEMENTED_CLASSES.length}
                  suffix={`/${CLASSES.length}`}
                  label="classes detected"
                  note="the rest are stated, not faked"
                />
              </dl>
            </div>

            <div ref={parallaxRef}>
              <LiveScene
                scene={scene}
                flow={flow}
                replay={replay}
                inliers={heroSample?.alignment?.inliers ?? null}
                onPickEvent={(_, t) => navigate(`/samples?clip=${heroId ?? "C3905"}&t=${t.toFixed(2)}`)}
              />
              <p className="mt-2.5 text-xs leading-relaxed text-faint">
                Not an animation of the idea &mdash; this is{" "}
                <span className="num text-muted">{replay?.video ?? "a sample clip"}</span> replayed from
                a cached perception pass. Every bracket is a YOLO11m detection the tracker kept, every
                number is its track id, and the drifting lines follow the mean direction of traffic
                measured in each 60&nbsp;px cell. Hover a box; click an event to open it.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-[1320px] space-y-16 px-4 py-14">
        {/* ----------------------------------------------------------- pipeline */}
        <Section
          eyebrow="How it works"
          title="One decoding pass, then reasoning on trajectories"
          lead="Everything learned in this system is object detection. Every event decision is a rule over tracked positions, the intersection's geometry and the signal phase — which is why each detection can be explained, and why a whole clip fits in a fraction of the time budget."
        >
          <Pipeline stages={PART_A} />
          <p className="mt-5 text-sm text-muted">
            <Link to="/approach" className="text-accent underline-offset-4 hover:underline">
              Read the full pipeline
            </Link>{" "}
            &mdash; including the causal Part B chain and where every threshold comes from.
          </p>
        </Section>

        {/* ------------------------------------------------------------ corpus */}
        {samples.length > 0 && (
          <Section
            eyebrow="Measured, not estimated"
            title="All four official clips, end to end"
            lead={
              <>
                Produced by <span className="num">run_submission.py</span> &mdash; the
                organizers&rsquo; own harness, unmodified &mdash; over{" "}
                <span className="num">{(totals.secs / 60).toFixed(1)} minutes</span> of 4K footage.
              </>
            }
          >
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {samples.map((s, i) => (
                <ClipCard key={s.id} sample={s} index={i} />
              ))}
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Panel className="p-4">
                <div className="num text-2xl font-semibold leading-none text-ok">
                  {(totals.budgetUsed * 100).toFixed(0)}%
                </div>
                <div className="mt-2 text-xs font-medium">of the total time budget used</div>
                <div className="mt-1 text-xs leading-snug text-faint">
                  Part A and Part B together, summed over all four clips.
                </div>
              </Panel>
              <Panel className="p-4 sm:col-span-2">
                <div className="mb-2.5 text-xs font-medium">Events by class, all clips</div>
                <ClassBars rows={totals.byClass} total={totals.events} />
              </Panel>
            </div>
          </Section>
        )}

        {/* ----------------------------------------------------------- honesty */}
        <Section
          eyebrow="Honesty"
          title="What this system does not do"
          lead="The task has 14 official classes and a published metric. Both are easy to paper over on a website, so here is the state of things in one place."
        >
          <div className="grid gap-3 md:grid-cols-3">
            <HonestCard
              title="6 classes have no detector"
              to="/classes"
              cta="Per-class status"
              body="accident, near_miss, illegal_turn, solid_line_crossing, road_obstacle and fire_smoke are never emitted. They are removed from CLASSES rather than guessed at, because a class you predict but never get right is averaged into Score A as a zero."
            />
            <HonestCard
              title="No Score A or Score B yet"
              to="/results"
              cta="What is and is not measured"
              body="The sample clips shipped unlabelled and have not been annotated, so evaluate.py has no ground truth to score against. Every accuracy figure is therefore absent from this site rather than invented."
            />
            <HonestCard
              title="The rules assume this camera"
              to="/eda"
              cta="The scene it was built on"
              body="Stop line, crossings, islands and lane directions are drawn once against a reference frame. Upload footage from somewhere else and the demo tells you the alignment failed instead of returning confident nonsense."
            />
          </div>
        </Section>
      </div>
    </div>
  );
}

function HeroStat({
  value,
  label,
  note,
  run,
  decimals = 0,
  suffix = "",
  grouped = false,
}: {
  value: number;
  label: string;
  note: string;
  run: boolean;
  decimals?: number;
  suffix?: string;
  grouped?: boolean;
}) {
  const n = useCountUp(value, run);
  return (
    <div>
      <dt className="num text-2xl font-semibold leading-none tracking-tight sm:text-[1.7rem]">
        {value ? `${grouped ? group(n) : n.toFixed(decimals)}${suffix}` : "—"}
      </dt>
      <dd className="mt-1.5 text-xs font-medium text-text">{label}</dd>
      <dd className="text-[11px] leading-snug text-faint">{note}</dd>
    </div>
  );
}

/** One clip, with its real events laid out across a miniature of its duration. */
function ClipCard({ sample, index }: { sample: SampleData; index: number }) {
  const [ref, shown] = useReveal<HTMLAnchorElement>();
  const d = sample.meta.duration || 1;
  const rt = sample.runtime;
  const lanes = [...new Set(sample.events.map((e) => e[2]))].sort(byClassOrder);
  return (
    <Link
      ref={ref}
      to={`/samples?clip=${sample.id}`}
      className={`reveal ${shown ? "is-in" : ""} brackets block rounded-lg border border-line bg-panel p-4 transition-colors hover:border-[color-mix(in_srgb,var(--cyan)_45%,transparent)]`}
      style={{ transitionDelay: `${index * 70}ms` }}
    >
      <div className="flex items-baseline justify-between">
        <span className="num text-sm font-semibold">{sample.id}</span>
        <span className="num text-[11px] text-faint">
          {(sample.meta.duration / 60).toFixed(1)} min
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-[2px]">
        {lanes.map((cls, li) => (
          <div key={cls} className="relative h-[3px] w-full rounded-sm bg-ink2">
            {sample.events
              .filter((e) => e[2] === cls)
              .map(([s, e], i) => (
                <span
                  key={i}
                  className="absolute inset-y-0 rounded-sm"
                  style={{
                    left: `${(s / d) * 100}%`,
                    width: `${Math.max(0.5, ((e - s) / d) * 100)}%`,
                    background: classColor(cls),
                    opacity: shown ? 0.95 : 0,
                    transition: `opacity 480ms ${index * 70 + li * 55}ms`,
                  }}
                />
              ))}
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between text-[11px]">
        <span className="text-muted">
          <b className="num text-sm font-semibold text-text">{sample.events.length}</b> events
        </span>
        {rt && (
          <span className="num text-faint">{(rt.total_sec / rt.duration).toFixed(2)}× real time</span>
        )}
      </div>
      {sample.alignment && (
        <div className="num mt-1.5 flex items-center gap-1.5 text-[10px] text-faint">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: sample.alignment.aligned ? "var(--ok)" : "var(--bad)" }}
          />
          {sample.alignment.inliers} SIFT inliers
        </div>
      )}
    </Link>
  );
}

function ClassBars({ rows, total }: { rows: [string, number][]; total: number }) {
  const [ref, shown] = useReveal<HTMLDivElement>();
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <div ref={ref} className="flex flex-col gap-1.5">
      {rows.map(([id, n], i) => (
        <div key={id} className="flex items-center gap-2.5">
          <span className="w-[104px] shrink-0 truncate text-[11px] text-muted">{classLabel(id)}</span>
          <span className="h-2.5 flex-1 overflow-hidden rounded-sm bg-ink2">
            <span
              className="block h-full rounded-sm"
              style={{
                width: shown ? `${(n / max) * 100}%` : 0,
                background: classColor(id),
                transition: `width 800ms cubic-bezier(0.3,0.8,0.3,1) ${i * 60}ms`,
              }}
            />
          </span>
          <span className="num w-8 shrink-0 text-right text-[11px] text-text">{n}</span>
        </div>
      ))}
      <div className="num mt-1 text-[10px] text-faint">{total} segments in total</div>
    </div>
  );
}

function HonestCard({
  title,
  body,
  to,
  cta,
}: {
  title: string;
  body: string;
  to: string;
  cta: string;
}) {
  return (
    <Panel className="p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
      <Link to={to} className="mt-3 inline-block text-xs text-accent underline-offset-4 hover:underline">
        {cta} &rarr;
      </Link>
    </Panel>
  );
}
