import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { findAlarms, THETA } from "../components/RiskCurve";
import { Callout, DataGap, Panel, Section, Tag } from "../components/ui";
import { EventTip, LineKey, Tip } from "../components/viz";
import { loadData } from "../lib/api";
import { byClassOrder, classColor, classLabel, CLASSES, IMPLEMENTED_CLASSES } from "../lib/classes";
import type { EventFacts } from "../lib/events";
import { timecode } from "../lib/format";
import { useElementSize } from "../lib/hooks";
import type { AblationData, AblationRun, SampleData } from "../lib/types";

const CLIPS = ["C3896", "C3897", "C3902", "C3905"];
const SHORT_SEC = 1.0;

export default function Extra() {
  const [samples, setSamples] = useState<SampleData[]>([]);
  const [facts, setFacts] = useState<EventFacts | null>(null);
  const [ablation, setAblation] = useState<AblationData | null | undefined>(undefined);

  useEffect(() => {
    const ac = new AbortController();
    void Promise.all(CLIPS.map((id) => loadData<SampleData>(`samples/${id}.json`, ac.signal))).then((rows) =>
      setSamples(rows.filter((r): r is SampleData => r !== null)),
    );
    void loadData<EventFacts>("events.json", ac.signal).then(setFacts);
    void loadData<AblationData>("ablation.json", ac.signal).then(setAblation);
    return () => ac.abort();
  }, []);

  const all = useMemo(() => samples.flatMap((s) => s.events.map((e) => ({ clip: s.id, e }))), [samples]);
  const footage = samples.reduce((n, s) => n + s.meta.duration, 0);
  const regions = new Set(Object.values(facts?.clips ?? {}).flatMap((c) => c.events.map((f) => f.region).filter(Boolean)));
  const short = all.filter(({ e }) => e[1] - e[0] < SHORT_SEC).length;
  const spanningEvents = all.filter(({ clip, e }) => e[1] - e[0] > 0.9 * (samples.find((s) => s.id === clip)?.meta.duration ?? Infinity));
  const spanning = spanningEvents.length;
  const spanningClasses = [...new Set(spanningEvents.map(({ e }) => e[2]))].join(", ");

  return (
    <div className="mx-auto max-w-[1320px] space-y-16 px-4 py-10 sm:py-14">
      <Section
        eyebrow="Extra credit"
        title="What we built beyond the required pages"
        lead={
          <>
            The task lists ideas that earn extra credit. Each card below says what exists, shows it
            working on the real results, and states what is missing. Two of them cannot be done
            honestly without labels, and say so rather than show a number.
          </>
        }
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Card
            n="01"
            title="Interactive analysis"
            status={<Tag tone="ok">live on every result</Tag>}
            to="/samples"
            cta="Open the sample player"
            limits="Selection is shared inside one player page; the dashboard hands a pick to the player through a link rather than a shared session."
          >
            <p>
              The player, event timeline, risk curve, event list and traffic monitor run on one clock.
              Clicking an event anywhere jumps the video to it and highlights it in every view, down to
              its evidence boxes on the picture; <span className="num">n</span>/<span className="num">p</span> step
              through events. The same wiring powers the live demo&rsquo;s results.
            </p>
            <MiniClips samples={samples} facts={facts} />
          </Card>

          <Card
            n="02"
            title="Operator dashboard"
            status={<Tag tone="ok">live</Tag>}
            to="/dashboard"
            cta="Open the dashboard"
            limits={
              <>
                Per <em>region</em>, not per lane: the scene has crossings and direction zones but no lane
                polygons. Rates are normalised from {(footage / 60).toFixed(1)} minutes of recorded clips.
              </>
            }
          >
            <p>
              Events per class, per region, per clip and over clip time, with every chart filtering the
              others, plus event duration, risk during events, and processing time against the budget.
            </p>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
              <Mini label="events" value={all.length || "—"} />
              <Mini label="per h, normalised" value={footage ? ((all.length / footage) * 3600).toFixed(0) : "—"} />
              <Mini label="scene regions" value={regions.size || "—"} />
            </dl>
          </Card>

          <Card
            n="03"
            title="Pipeline ablations"
            status={ablation ? <Tag tone="ok">measured</Tag> : <Tag tone="off">not run here</Tag>}
            to="#ablations"
            cta="See the numbers"
            limits="Efficiency and agreement only: without labels no configuration can be called more accurate. Runs on a 60 s window of a 720p proxy, on a laptop CPU."
          >
            <p>
              Detector A vs B, three frame-sampling rates, and tracking on vs off &mdash; each run end to
              end through the real rules, with runtime, detections, tracks and events recorded.
            </p>
            {ablation && <RuntimeBars runs={ablation.runs} compact />}
          </Card>

          <Card
            n="04"
            title="Error analysis"
            status={<Tag tone="off">requires dev labels</Tag>}
            to="#error-analysis"
            cta="What it needs"
            limits="No confusion matrix, precision or recall is shown anywhere on this site, because none can be computed."
          >
            <p>
              The sample clips are unlabelled and we have not annotated them, so there is nothing to
              confuse a prediction with. What can be read off the output without labels is below.
            </p>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
              <Mini label={`events < ${SHORT_SEC} s`} value={short} />
              <Mini label="span > 90% of clip" value={spanning} />
              <Mini label="classes never emitted" value={CLASSES.length - IMPLEMENTED_CLASSES.length} />
            </dl>
          </Card>

          <Card
            n="05"
            title="Live stream / webcam"
            status={<Tag tone="ok">detection + tracking</Tag>}
            to="/demo#live"
            cta="Open live mode"
            limits="Event rules and the risk score are not run live: they need this camera's calibrated geometry and a whole-clip signal reading."
          >
            <p>
              The demo page streams webcam frames, or a sample clip played in real time, to the same
              YOLO11s detector and tracker the risk model uses, and draws the tracked boxes back on the
              feed with measured latency.
            </p>
          </Card>

          <Card
            n="06"
            title="Traffic-centre view"
            status={<Tag tone="ok">live on every result</Tag>}
            to="/samples"
            cta="Watch it with a clip"
            limits="On the samples it is a replay of recorded output and labelled as one; it never invents values between recorded samples."
          >
            <p>
              A monitor beside the player: risk against &theta;, signal phase, objects in frame, active and
              recent events and the processing cost &mdash; all read at the playhead from the clip&rsquo;s own
              results.
            </p>
            <RiskStrips samples={samples} />
          </Card>
        </div>
      </Section>

      <Section
        id="ablations"
        eyebrow="03 — Pipeline / efficiency ablation"
        title="What each design choice costs, and what it changes"
        lead={
          <>
            Every configuration below runs the real Part A code end to end: decode, detector, tracker,
            alignment, signal phase and the eight rules. Only the configuration changes. With no labels,
            the honest comparison is cost and agreement: how much each run spends, what it emits, and how
            many of the baseline&rsquo;s events it reproduces.
          </>
        }
      >
        {ablation === undefined ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : ablation === null ? (
          <DataGap
            title="No ablation results in this checkout"
            what="web/public/data/ablation.json has not been generated."
            fill={
              <>
                Run <span className="num">python tools/ablation.py --video web/public/media/samples/C3905_720p.mp4 --seconds 60</span>.
              </>
            }
          />
        ) : (
          <Ablation data={ablation} />
        )}
      </Section>

      <Section
        id="error-analysis"
        eyebrow="04 — Error analysis"
        title="Error analysis requires development labels"
        lead="A confusion matrix compares predictions with ground truth. We have predictions; the ground truth for the sample clips does not exist yet. Rather than approximate one, this section says what is needed and shows only what the output reveals by itself."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel className="p-5">
            <h3 className="text-sm font-semibold">What would make it possible</h3>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-[13px] leading-relaxed text-muted">
              <li>
                <b className="text-text">Labels.</b> Annotate the four sample clips with{" "}
                <span className="num">tools/labeler/index.html</span>, following the task&rsquo;s start/end
                conventions, and export <span className="num">dev_labels.json</span> in{" "}
                <span className="num">evaluate.py</span>&rsquo;s ground-truth format.
              </li>
              <li>
                <b className="text-text">Scores.</b> <span className="num">python tools/eval_dev.py dev_labels.json predictions_samples.json</span>{" "}
                gives per-class precision, recall and F1 at tIoU 0.3 / 0.5 / 0.7 with the official matcher.
              </li>
              <li>
                <b className="text-text">Confusion.</b> Matching every unmatched prediction against
                ground truth of <em>other</em> classes by temporal IoU would show, for example, whether a
                stop-line violation is being read as a red-light run.
              </li>
              <li>
                <b className="text-text">Examples.</b> Each false positive and false negative links to its
                moment in the player, which already accepts <span className="num">?clip=&amp;t=</span>.
              </li>
            </ol>
          </Panel>
          <Panel className="p-5">
            <h3 className="text-sm font-semibold">What the output shows without labels</h3>
            <p className="mt-1 text-[11px] text-faint">Counts from predictions_samples.json. Symptoms, not error rates.</p>
            <dl className="mt-3 space-y-2.5 text-[13px]">
              <Diag value={short} of={all.length} label={`events shorter than ${SHORT_SEC} s`} note="unlikely to survive matching at tIoU 0.7 against a human boundary" />
              <Diag
                value={spanning}
                of={all.length}
                label="events spanning over 90% of their clip"
                note={spanning ? `${spanningClasses}: nothing in these clips lasts that long; the Results page explains the likely cause` : "none in these clips"}
              />
              <Diag
                value={CLASSES.length - IMPLEMENTED_CLASSES.length}
                of={CLASSES.length}
                label="official classes never emitted"
                note="each one present in the test set is a zero in the Score A class average"
              />
            </dl>
            <Link to="/results" className="mt-4 inline-block text-xs text-accent underline-offset-4 hover:underline">
              The full failure analysis on the Results page &rarr;
            </Link>
          </Panel>
        </div>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Card({
  n,
  title,
  status,
  to,
  cta,
  limits,
  children,
}: {
  n: string;
  title: string;
  status: ReactNode;
  to: string;
  cta: string;
  limits: ReactNode;
  children: ReactNode;
}) {
  const link = "mt-auto inline-flex items-center gap-1 pt-4 text-xs font-medium text-accent underline-offset-4 hover:underline";
  return (
    <Panel as="article" className="flex flex-col p-5">
      <div className="flex items-center gap-2">
        <span className="num text-sm text-accent">{n}</span>
        <h3 className="text-[15px] font-semibold">{title}</h3>
        <span className="ml-auto">{status}</span>
      </div>
      <div className="mt-2.5 text-[13px] leading-relaxed text-muted">{children}</div>
      <p className="mt-3 border-t border-linesoft pt-2.5 text-[11px] leading-relaxed text-faint">
        <span className="num uppercase tracking-wider">limits</span> &middot; {limits}
      </p>
      {to.startsWith("#") ? (
        <a href={to} className={link}>
          {cta} &rarr;
        </a>
      ) : (
        <Link to={to} className={link}>
          {cta} &rarr;
        </Link>
      )}
    </Panel>
  );
}

function Mini({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-panel2 px-2 py-2">
      <dd className="text-lg font-semibold leading-none text-text">{value}</dd>
      <dt className="mt-1 text-[10px] leading-tight text-faint">{label}</dt>
    </div>
  );
}

function Diag({ value, of, label, note }: { value: number; of: number; label: string; note: string }) {
  return (
    <div className="grid grid-cols-[3.5rem_1fr] items-baseline gap-3">
      <dt className="num text-right text-lg font-semibold text-text">
        {value}
        <span className="text-[10px] font-normal text-faint">/{of}</span>
      </dt>
      <dd>
        <span className="text-text">{label}</span>
        <span className="block text-[11px] text-faint">{note}</span>
      </dd>
    </div>
  );
}

/** One line per clip, one tick per event; picking a tick opens that moment in the player. */
function MiniClips({ samples, facts }: { samples: SampleData[]; facts: EventFacts | null }) {
  const navigate = useNavigate();
  const [ref, size] = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; y: number; clip: string; i: number } | null>(null);
  const hovered = hover ? samples.find((s) => s.id === hover.clip) : undefined;
  return (
    <div ref={ref} className="relative mt-3 space-y-1.5">
      {samples.map((s) => (
        <div key={s.id} className="flex items-center gap-2">
          <span className="num w-11 shrink-0 text-[10px] text-faint">{s.id}</span>
          <div className="relative h-4 flex-1 rounded-sm bg-ink2">
            {/* Longest first, so short events paint on top and stay pickable; long ones fade to a backdrop. */}
            {s.events
              .map((e, i) => ({ e, i }))
              .sort((a, b) => b.e[1] - b.e[0] - (a.e[1] - a.e[0]))
              .map(({ e, i }) => (
                <button
                  key={i}
                  type="button"
                  aria-label={`${classLabel(e[2])} at ${timecode(e[0])} in ${s.id}`}
                  onClick={() => navigate(`/samples?clip=${s.id}&ev=${i}`)}
                  onPointerMove={(ev) => {
                    const b = ref.current?.getBoundingClientRect();
                    if (b) setHover({ x: ev.clientX - b.left, y: ev.clientY - b.top, clip: s.id, i });
                  }}
                  onPointerLeave={() => setHover(null)}
                  className="absolute inset-y-0.5 rounded-[2px] transition-transform hover:scale-y-125 focus-visible:scale-y-125"
                  style={{
                    left: `${(e[0] / s.meta.duration) * 100}%`,
                    width: `max(3px, ${((e[1] - e[0]) / s.meta.duration) * 100}%)`,
                    background: classColor(e[2]),
                    opacity: e[1] - e[0] > 0.2 * s.meta.duration ? 0.28 : 0.9,
                  }}
                />
              ))}
          </div>
        </div>
      ))}
      {hover && hovered && (
        <Tip x={hover.x} y={hover.y} width={size.width || 300}>
          <EventTip event={hovered.events[hover.i]} fact={facts?.clips[hovered.id]?.events[hover.i]} prefix={hovered.id} />
          <div className="mt-1.5 text-[10px] text-faint">click to open this moment in the player</div>
        </Tip>
      )}
    </div>
  );
}

/** The recorded risk score per clip, against θ; alarm runs are marked. */
function RiskStrips({ samples }: { samples: SampleData[] }) {
  return (
    <div className="mt-3 space-y-1.5">
      {samples.map((s) => {
        const d = s.meta.duration;
        const pts = s.risk.map(([t, v]) => `${((t / d) * 100).toFixed(2)},${(20 - Math.min(v, 1) * 30).toFixed(2)}`).join(" ");
        const alarms = findAlarms(s.risk);
        return (
          <div key={s.id} className="flex items-center gap-2">
            <span className="num w-11 shrink-0 text-[10px] text-faint">{s.id}</span>
            <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="h-5 flex-1 rounded-sm bg-ink2" role="img" aria-label={`${s.id} risk, ${alarms.length} alarms`}>
              {alarms.map((a, i) => (
                <rect key={i} x={(a.start / d) * 100} y={0} width={Math.max(((a.end - a.start) / d) * 100, 0.6)} height={20} fill="var(--bad)" opacity={0.25} />
              ))}
              <line x1={0} x2={100} y1={20 - THETA * 30} y2={20 - THETA * 30} stroke="var(--bad)" strokeWidth={0.6} strokeDasharray="1.5 1.5" vectorEffect="non-scaling-stroke" />
              <polyline points={pts} fill="none" stroke="var(--bad)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
            </svg>
            <span className="num w-16 shrink-0 text-right text-[10px] text-muted">
              {alarms.length} alarm{alarms.length === 1 ? "" : "s"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const describe = (r: AblationRun) => `${r.detector.split(" ")[0]} · ${Math.round(r.fps)} fps${r.tracking ? "" : " · no tracking"}`;

/** Wall-clock seconds per configuration, one hue: magnitude, not identity. */
function RuntimeBars({ runs, compact = false }: { runs: AblationRun[]; compact?: boolean }) {
  const max = Math.max(1, ...runs.map((r) => r.seconds.total));
  return (
    <ul className={compact ? "mt-3 space-y-1" : "space-y-1.5"}>
      {runs.map((r) => (
        <li key={r.id} className="grid grid-cols-[minmax(0,9.5rem)_1fr_3.5rem] items-center gap-2 text-[11px]">
          <span className="truncate text-muted" title={r.perception_shared_with ? `detector stage shared with ${r.perception_shared_with}` : undefined}>
            {describe(r)}
          </span>
          <span className="h-2 overflow-hidden rounded-sm bg-ink2">
            <span
              className="block h-full rounded-r-[4px] bg-accent"
              style={{ width: `${(r.seconds.total / max) * 100}%`, opacity: r.perception_shared_with ? 0.4 : 1 }}
            />
          </span>
          <span className="num text-right text-text">{r.seconds.total.toFixed(0)} s</span>
        </li>
      ))}
    </ul>
  );
}

function Ablation({ data }: { data: AblationData }) {
  const base = data.runs.find((r) => r.id === data.baseline);
  const maxEvents = Math.max(1, ...data.runs.map((r) => r.events.length));
  const perVideoSec = (r: AblationRun) => r.seconds.total / data.input.seconds;
  const notrack = data.runs.find((r) => !r.tracking);
  const b3 = data.runs.find((r) => r.detector !== base?.detector && r.step === base?.step && r.tracking);
  const [hover, setHover] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Panel className="p-4">
          <div className="text-[11px] text-muted">Input</div>
          <div className="num mt-1 text-sm text-text">
            {data.input.clip}, first {data.input.seconds.toFixed(0)} s
          </div>
          <div className="mt-1 text-[11px] leading-snug text-faint">
            {data.input.video}: the site&rsquo;s {data.input.width}&times;{data.input.height} proxy. The 4K original is not in
            this checkout.
          </div>
        </Panel>
        <Panel className="p-4">
          <div className="text-[11px] text-muted">Measured on</div>
          <div className="num mt-1 text-sm text-text">
            {data.machine.cpu}, {data.machine.device.toUpperCase()}
          </div>
          <div className="mt-1 text-[11px] leading-snug text-faint">
            torch {data.machine.torch}, {data.machine.threads} threads. Slower than the RTX 5080 behind the submission&rsquo;s
            timings: compare rows with each other, not with those.
          </div>
        </Panel>
        <Panel className="p-4">
          <div className="text-[11px] text-muted">Agreement, not accuracy</div>
          <div className="num mt-1 text-sm text-text">same class, tIoU &ge; {data.match_iou}</div>
          <div className="mt-1 text-[11px] leading-snug text-faint">
            &ldquo;Shared&rdquo; counts events a run has in common with another, using evaluate.py&rsquo;s own greedy matcher.
            It measures stability between configurations; it says nothing about which is right.
          </div>
        </Panel>
      </div>

      <Panel className="p-0">
        <div className="thin-scroll overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-left text-xs">
            <thead className="text-faint">
              <tr className="border-b border-line">
                <th className="px-4 py-2.5 font-medium">configuration</th>
                <th className="px-2 py-2.5 text-right font-medium">detector frames</th>
                <th className="px-2 py-2.5 text-right font-medium">detections</th>
                <th className="px-2 py-2.5 text-right font-medium">tracks</th>
                <th className="px-2 py-2.5 text-right font-medium">trajectories</th>
                <th className="px-2 py-2.5 font-medium">events by class</th>
                <th className="px-2 py-2.5 text-right font-medium">shared w/ baseline</th>
                <th className="px-2 py-2.5 text-right font-medium">shared w/ submission</th>
                <th className="px-2 py-2.5 text-right font-medium">detect s</th>
                <th className="px-2 py-2.5 text-right font-medium">track + rules s</th>
                <th className="px-4 py-2.5 text-right font-medium">&times; video time</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr
                  key={r.id}
                  onPointerEnter={() => setHover(r.id)}
                  onPointerLeave={() => setHover(null)}
                  className={`border-b border-linesoft ${r.id === data.baseline ? "bg-panel2/60" : ""} ${hover === r.id ? "bg-panel2" : ""}`}
                >
                  <td className="px-4 py-2">
                    <div className="font-medium text-text">
                      {describe(r)}
                      {r.id === data.baseline && <span className="num ml-2 text-[10px] uppercase tracking-wider text-accent">baseline</span>}
                    </div>
                    <div className="num text-[10px] text-faint">
                      {r.detector}, every {r.step === 3 ? "3rd" : `${r.step}th`} frame
                    </div>
                  </td>
                  <td className="num px-2 py-2 text-right text-muted">{r.frames.toLocaleString()}</td>
                  <td className="num px-2 py-2 text-right text-muted">{r.detections.toLocaleString()}</td>
                  <td className="num px-2 py-2 text-right text-muted">{r.tracks.toLocaleString()}</td>
                  <td className="num px-2 py-2 text-right text-muted">{r.trajectories}</td>
                  <td className="px-2 py-2">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <b className="num text-text">{r.events.length}</b>
                      {Object.entries(r.by_class)
                        .sort((a, b) => byClassOrder(a[0], b[0]))
                        .map(([c, k]) => (
                          <span key={c} className="num inline-flex items-center gap-1 text-[10px] text-muted" title={classLabel(c)}>
                            <LineKey color={classColor(c)} />
                            {k}
                          </span>
                        ))}
                    </span>
                  </td>
                  <td className="num px-2 py-2 text-right text-text">
                    {r.shared_with_baseline}/{base?.events.length ?? "—"}
                  </td>
                  <td className="num px-2 py-2 text-right text-muted">
                    {r.shared_with_submission === null ? "—" : `${r.shared_with_submission}/${data.submission?.events.length ?? 0}`}
                  </td>
                  <td className="num px-2 py-2 text-right text-muted">
                    {r.perception_shared_with ? <span title={`reused from ${r.perception_shared_with}`}>(shared)</span> : r.seconds.perception.toFixed(1)}
                  </td>
                  <td className="num px-2 py-2 text-right text-muted">{(r.seconds.tracking + r.seconds.rules).toFixed(2)}</td>
                  <td className="num px-4 py-2 text-right text-text">{perVideoSec(r).toFixed(2)}&times;</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-linesoft px-4 py-2.5 text-[11px] leading-relaxed text-faint">
          Generated by <span className="num">{data.command}</span> at <span className="num">{data.generated_at}</span>. &ldquo;shared w/
          submission&rdquo; compares with predictions_samples.json cut to the same window &mdash; that run saw the 4K original,
          so it also shows how representative the proxy is.
        </p>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="p-4">
          <h3 className="text-sm font-semibold">Wall-clock per configuration</h3>
          <p className="mt-1 text-[11px] text-faint">Seconds for {data.input.seconds.toFixed(0)} s of video. Pale bar: detector stage reused, not re-run.</p>
          <div className="mt-3">
            <RuntimeBars runs={data.runs} />
          </div>
        </Panel>
        <Panel className="p-4">
          <h3 className="text-sm font-semibold">Events emitted, and how many the baseline also emits</h3>
          <p className="mt-1 text-[11px] text-faint">Bar = events the run emits; solid part = shared with the baseline.</p>
          <ul className="mt-3 space-y-1.5">
            {data.runs.map((r) => (
              <li key={r.id} className="grid grid-cols-[minmax(0,9.5rem)_1fr_3.5rem] items-center gap-2 text-[11px]">
                <span className="truncate text-muted">{describe(r)}</span>
                <span className="relative h-2 overflow-hidden rounded-sm bg-ink2">
                  <span className="absolute inset-y-0 left-0 rounded-r-[4px] bg-cyan/35" style={{ width: `${(r.events.length / maxEvents) * 100}%` }} />
                  <span className="absolute inset-y-0 left-0 bg-cyan" style={{ width: `${(r.shared_with_baseline / maxEvents) * 100}%` }} />
                </span>
                <span className="num text-right text-text">
                  {r.shared_with_baseline}/{r.events.length}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {base && (
        <Callout tone="note" title="What the measurements say">
          <ul className="list-disc space-y-1.5 pl-4">
            {b3 && (
              <li>
                <b className="text-text">Detector.</b> {b3.detector} spends {(b3.seconds.perception / Math.max(b3.frames, 1) * 1000).toFixed(0)} ms
                per frame against {(base.seconds.perception / Math.max(base.frames, 1) * 1000).toFixed(0)} ms for {base.detector} and
                keeps {b3.detections.toLocaleString()} boxes to {base.detections.toLocaleString()}; it emits {b3.events.length} events,{" "}
                {b3.shared_with_baseline} of them shared with the baseline&rsquo;s {base.events.length}.
              </li>
            )}
            <li>
              <b className="text-text">Frame rate.</b> Detector cost scales with the frames it sees:{" "}
              {data.runs
                .filter((r) => r.detector === base.detector && r.tracking)
                .map((r) => `${Math.round(r.fps)} fps → ${r.seconds.perception.toFixed(0)} s, ${r.events.length} events`)
                .join("; ")}
              . The tracker&rsquo;s patience is counted in frames, so at lower rates it also holds a lost track for longer in seconds.
            </li>
            {notrack && (
              <li>
                <b className="text-text">Tracking.</b> Without it, every box is its own one-frame track: {notrack.tracks.toLocaleString()} &ldquo;tracks&rdquo;,{" "}
                {notrack.trajectories} of them long enough to become a trajectory, {notrack.events.length} events. Every rule reasons about one road
                user over time, so identity is structural here, not an optional refinement.
              </li>
            )}
          </ul>
        </Callout>
      )}
      {!base && <p className="text-sm text-muted">The baseline run is missing from ablation.json.</p>}
    </div>
  );
}
