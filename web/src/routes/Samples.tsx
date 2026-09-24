import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { EventInspector } from "../components/EventInspector";
import { EventTimeline } from "../components/EventTimeline";
import { RiskCurve } from "../components/RiskCurve";
import { VideoStage } from "../components/VideoStage";
import { BarList } from "../components/charts";
import { Callout, DataGap, Panel, Section, Stat } from "../components/ui";
import { loadData } from "../lib/api";
import { byClassOrder, classColor } from "../lib/classes";
import { useReveal } from "../lib/hooks";
import type { OverlayData } from "../lib/overlay";
import { PlaybackProvider, usePlayback } from "../lib/playback";
import type { Manifest, SampleData } from "../lib/types";

const BASE = import.meta.env.BASE_URL;
const SAMPLE_IDS = ["C3896", "C3897", "C3902", "C3905"];

export default function Samples() {
  const [params, setParams] = useSearchParams();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [loaded, setLoaded] = useState<Record<string, SampleData>>({});
  const [overlay, setOverlay] = useState<OverlayData | null>(null);
  const [overlayFor, setOverlayFor] = useState<string | null>(null);
  const [view, setView] = useState<"source" | "annotated">("source");
  const [selected, setSelected] = useState<number | null>(null);
  const [visible, setVisible] = useState<Set<string>>(new Set());

  const wanted = params.get("clip");
  const wantedTime = params.get("t");
  const active = wanted && SAMPLE_IDS.includes(wanted) ? wanted : (Object.keys(loaded)[0] ?? null);

  useEffect(() => {
    const ac = new AbortController();
    void loadData<Manifest>("manifest.json", ac.signal).then(async (m) => {
      setManifest(m);
      if (!m) return;
      const got: Record<string, SampleData> = {};
      for (const [id, state] of Object.entries(m.samples)) {
        if (!state.available || !state.path) continue;
        const d = await loadData<SampleData>(state.path, ac.signal);
        if (d) got[id] = d;
      }
      setLoaded(got);
    });
    return () => ac.abort();
  }, []);

  const sample = active ? loaded[active] : null;

  // The overlay is 1-2 MB per clip, so it is fetched only for the clip on screen.
  useEffect(() => {
    if (!active) return;
    const ac = new AbortController();
    setOverlay(null);
    void loadData<OverlayData>(`overlay/${active}.json`, ac.signal).then((d) => {
      setOverlay(d);
      setOverlayFor(active);
    });
    return () => ac.abort();
  }, [active]);

  useEffect(() => {
    if (!sample) return;
    setVisible(new Set(sample.events.map((e) => e[2])));
    setSelected(null);
  }, [sample]);

  const perClass = useMemo(() => {
    if (!sample) return [];
    const m = new Map<string, number>();
    for (const e of sample.events) m.set(e[2], (m.get(e[2]) ?? 0) + 1);
    return [...m.entries()]
      .sort((a, b) => byClassOrder(a[0], b[0]))
      .map(([label, value]) => ({ label, value, color: classColor(label) }));
  }, [sample]);

  const totalSeconds = useMemo(() => {
    if (!sample) return [];
    const m = new Map<string, number>();
    for (const e of sample.events) m.set(e[2], (m.get(e[2]) ?? 0) + (e[1] - e[0]));
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value: Math.round(value), color: classColor(label) }));
  }, [sample]);

  const src =
    sample && view === "annotated" && sample.media.annotated
      ? `${BASE}${sample.media.annotated}`
      : sample?.media.proxy
        ? `${BASE}${sample.media.proxy}`
        : null;

  const missing = SAMPLE_IDS.filter((id) => !manifest?.samples[id]?.available);

  return (
    <div className="mx-auto max-w-[1320px] px-4 py-10 sm:py-14">
      <Section
        eyebrow="Results on the sample videos"
        title="All four organizer clips, run through the submission"
        lead={
          <>
            Each clip was processed by <span className="num">run_submission.py</span> exactly as the
            organizers will run it. The player draws the tracker&rsquo;s own boxes and ids straight
            onto the footage from a cached perception pass, so what you see is what the rules saw.
          </>
        }
      />

      <div className="mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {SAMPLE_IDS.map((id, i) => (
          <ClipTab
            key={id}
            id={id}
            index={i}
            sample={loaded[id]}
            available={Boolean(manifest?.samples[id]?.available)}
            active={active === id}
            onPick={() => setParams({ clip: id }, { replace: true })}
          />
        ))}
      </div>

      {sample ? (
        <PlaybackProvider key={sample.id}>
          <SeekOnMount t={wantedTime} />
          <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
            <div className="min-w-0 space-y-4">
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <div className="flex overflow-hidden rounded-md border border-line">
                    {(["source", "annotated"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setView(v)}
                        disabled={v === "annotated" && !sample.media.annotated}
                        className={`px-3 py-1.5 text-xs transition-colors ${
                          view === v ? "bg-panel2 text-text" : "text-muted hover:text-text"
                        } disabled:cursor-not-allowed disabled:text-faint`}
                      >
                        {v === "source" ? "Live overlay" : "Rendered review"}
                      </button>
                    ))}
                  </div>
                  <span className="num ml-auto text-[11px] text-faint">
                    {sample.meta.width}&times;{sample.meta.height} &middot;{" "}
                    {sample.meta.fps.toFixed(2)} fps
                  </span>
                </div>
                {src ? (
                  <VideoStage
                    src={src}
                    poster={sample.media.poster ? `${BASE}${sample.media.poster}` : null}
                    events={sample.events}
                    label={sample.meta.name}
                    fps={sample.meta.fps}
                    overlay={view === "source" && overlayFor === active ? overlay : null}
                    alignment={sample.alignment}
                  />
                ) : (
                  <DataGap
                    title="No playable copy of this clip"
                    what="The 4K originals are 2+ GB and are never committed, so the site plays a generated 720p proxy instead."
                    fill="Run scripts/build_media.py --videos samples to produce it."
                  />
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-faint">
                  {view === "source" ? (
                    <>
                      Boxes, ids and trails are drawn live in the browser from{" "}
                      <span className="num">{overlay?.source ?? "the cached perception pass"}</span>{" "}
                      &mdash; {overlay ? overlay.boxes.toLocaleString() : "…"} detections across{" "}
                      {overlay ? overlay.tracks.toLocaleString() : "…"} tracks. Press{" "}
                      <span className="num">o</span> to toggle them.
                    </>
                  ) : (
                    <>
                      The offline render from <span className="num">tools/render_video.py</span>:
                      tracks, signal state, the objects that triggered each rule and a timeline burned
                      into the frame.
                    </>
                  )}
                </p>
              </div>

              <Panel className="p-4">
                <h3 className="mb-3 text-sm font-semibold">Event timeline</h3>
                <EventTimeline
                  events={sample.events}
                  duration={sample.meta.duration}
                  visible={visible}
                  selected={selected}
                  onSelect={setSelected}
                />
                <p className="mt-2 text-[11px] text-faint">
                  Click any block to jump the player to it. Different classes overlap freely; the task
                  only forbids two segments of the same class from overlapping.
                </p>
              </Panel>

              <Panel className="p-4">
                <h3 className="mb-1 text-sm font-semibold">Accident risk &mdash; Part B</h3>
                <p className="mb-3 text-xs leading-relaxed text-muted">
                  One score per frame, written by the harness. The curve keeps the peak of every{" "}
                  {sample.risk_stride}-frame bucket, so a spike can never be smoothed away.
                </p>
                <RiskCurve risk={sample.risk} duration={sample.meta.duration} />
              </Panel>
            </div>

            <aside className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Stat value={sample.events.length} label="Events" />
                <Stat value={`${sample.meta.duration.toFixed(0)}s`} label="Duration" />
              </div>

              {sample.alignment && (
                <Panel className="p-4">
                  <h3 className="mb-2 text-sm font-semibold">Scene alignment</h3>
                  <div className="flex items-baseline gap-2">
                    <span
                      className="num text-2xl font-semibold leading-none"
                      style={{ color: sample.alignment.aligned ? "var(--ok)" : "var(--bad)" }}
                    >
                      {sample.alignment.inliers}
                    </span>
                    <span className="text-xs text-muted">SIFT inliers</span>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-faint">
                    Measured by re-running <span className="num">estimate_homography()</span> on this
                    clip&rsquo;s first frame. Below {sample.alignment.min_inliers} the pipeline falls
                    back to identity and every geometric rule becomes meaningless.
                  </p>
                </Panel>
              )}

              {sample.runtime && (
                <Panel className="p-4">
                  <h3 className="mb-3 text-sm font-semibold">Runtime</h3>
                  <dl className="space-y-2 text-xs">
                    <KV k="Part A" v={`${sample.runtime.part_a_sec.toFixed(1)} s`} />
                    <KV k="Part B" v={`${sample.runtime.part_b_sec.toFixed(1)} s`} />
                    <KV k="Total" v={`${sample.runtime.total_sec.toFixed(1)} s`} />
                    <KV k="Budget" v={`${sample.runtime.budget_sec.toFixed(0)} s`} />
                    <KV
                      k="Used"
                      v={`${((sample.runtime.total_sec / sample.runtime.budget_sec) * 100).toFixed(0)}%`}
                      tone="ok"
                    />
                  </dl>
                  {sample.runtime.errors.length === 0 && (
                    <p className="mt-2 text-[11px] text-faint">No errors logged by the harness.</p>
                  )}
                </Panel>
              )}

              <Panel className="p-4">
                <h3 className="mb-3 text-sm font-semibold">Events per class</h3>
                <BarList bars={perClass} />
              </Panel>

              <Panel className="p-4">
                <h3 className="mb-1 text-sm font-semibold">Seconds flagged per class</h3>
                <p className="mb-3 text-[11px] text-faint">
                  Total covered time. Overlapping classes are counted separately.
                </p>
                <BarList bars={totalSeconds} format={(v) => `${v}s`} />
              </Panel>

              <Panel className="flex max-h-[460px] flex-col p-4">
                <h3 className="mb-3 text-sm font-semibold">All events</h3>
                <EventInspector
                  events={sample.events}
                  visible={visible}
                  onToggleClass={(id) =>
                    setVisible((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  onShowAll={() => setVisible(new Set(sample.events.map((e) => e[2])))}
                  selected={selected}
                  onSelect={setSelected}
                />
              </Panel>
            </aside>
          </div>
        </PlaybackProvider>
      ) : (
        <div className="mt-6">
          <Callout tone="note" title="No processed sample loaded">
            Nothing has been generated yet. Put the clips in <span className="num">samples/</span>, run{" "}
            <span className="num">run_submission.py</span>, then{" "}
            <span className="num">scripts/build_media.py</span> and{" "}
            <span className="num">scripts/build_site_data.py</span>.
          </Callout>
        </div>
      )}

      {missing.length > 0 && (
        <div className="mt-12">
          <Section eyebrow="Coverage" title="The rest of the sample set">
            <div className="grid gap-3 md:grid-cols-3">
              {missing.map((id) => (
                <DataGap
                  key={id}
                  title={`${id}.MP4`}
                  what={
                    manifest?.samples[id]?.reason ??
                    "This clip has not been processed in this checkout."
                  }
                  fill={
                    <>
                      Drop the file into <span className="num">samples/</span> and re-run the three
                      build commands; this card is replaced by a full result page automatically, with
                      no code change.
                    </>
                  }
                />
              ))}
            </div>
          </Section>
        </div>
      )}

      {manifest?.summary && (
        <p className="mt-10 text-sm text-muted">
          {manifest.summary.samples_processed} of {manifest.summary.samples_total} sample clips are
          present in this checkout, totalling{" "}
          <span className="num">{(manifest.summary.corpus_seconds / 60).toFixed(1)} minutes</span> of
          4K footage at 29.97&nbsp;fps.
        </p>
      )}
    </div>
  );
}

/**
 * Applies a ?t= deep link once, after the provider mounts.
 *
 * Lives inside <PlaybackProvider> because that is where the clock the timeline
 * and risk curve read actually exists.
 */
function SeekOnMount({ t }: { t: string | null }) {
  const { seek } = usePlayback();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !t) return;
    const n = Number(t);
    if (Number.isFinite(n)) {
      done.current = true;
      seek(n);
    }
  }, [t, seek]);
  return null;
}

function ClipTab({
  id,
  index,
  sample,
  available,
  active,
  onPick,
}: {
  id: string;
  index: number;
  sample?: SampleData;
  available: boolean;
  active: boolean;
  onPick: () => void;
}) {
  const [ref, shown] = useReveal<HTMLButtonElement>();
  const d = sample?.meta.duration || 1;
  const lanes = sample ? [...new Set(sample.events.map((e) => e[2]))].sort(byClassOrder) : [];
  return (
    <button
      ref={ref}
      type="button"
      disabled={!available}
      onClick={onPick}
      aria-pressed={active}
      className={`reveal ${shown ? "is-in" : ""} rounded-lg border p-3.5 text-left transition-colors ${
        active
          ? "border-accent bg-panel2"
          : available
            ? "border-line bg-panel hover:border-[color-mix(in_srgb,var(--cyan)_45%,transparent)]"
            : "cursor-not-allowed border-dashed border-line bg-panel"
      }`}
      style={{ transitionDelay: `${index * 60}ms` }}
    >
      <div className="flex items-baseline justify-between">
        <span className="num text-sm font-semibold">{id}</span>
        {available && sample ? (
          <span className="num text-[11px] text-faint">
            {(sample.meta.duration / 60).toFixed(1)} min
          </span>
        ) : (
          <span className="num text-[10px] uppercase tracking-wider text-faint">pending</span>
        )}
      </div>
      {sample && (
        <>
          <div className="mt-2.5 flex flex-col gap-[2px]">
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
                        transition: `opacity 460ms ${index * 60 + li * 50}ms`,
                      }}
                    />
                  ))}
              </div>
            ))}
          </div>
          <div className="mt-2.5 flex items-center justify-between text-[11px] text-muted">
            <span>
              <b className="num text-text">{sample.events.length}</b> events
            </span>
            {sample.runtime && (
              <span className="num text-faint">
                {(sample.runtime.total_sec / sample.runtime.duration).toFixed(2)}×
              </span>
            )}
          </div>
        </>
      )}
    </button>
  );
}

function KV({ k, v, tone }: { k: string; v: string; tone?: "ok" }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-faint">{k}</dt>
      <dd className={`num ${tone === "ok" ? "text-ok" : "text-text"}`}>{v}</dd>
    </div>
  );
}
