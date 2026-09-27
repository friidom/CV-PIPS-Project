import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BarList } from "../components/charts";
import { DevClassTable, DevTimeline } from "../components/DevEval";
import { Callout, DataGap, Panel, Section, Stat } from "../components/ui";
import { loadData } from "../lib/api";
import { findAlarms, THETA } from "../components/RiskCurve";
import { byClassOrder, CLASS_BY_ID, CLASSES, classColor, IMPLEMENTED_CLASSES } from "../lib/classes";
import { timecode } from "../lib/format";
import type { DevEval, ExamplesData, Manifest, SampleData } from "../lib/types";

const SHORT_EVENT_SEC = 1.0;
const CLIPS = ["C3896", "C3897", "C3902", "C3905"];
/** A label whose both ends sit this close to one of our segments may have been taken from it. */
const SAME_BOUNDARY_SEC = 0.3;

export default function Results() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [dev, setDev] = useState<DevEval | null>(null);
  const [examples, setExamples] = useState<ExamplesData | null>(null);
  const [sample, setSample] = useState<SampleData | null>(null);
  const [clip, setClip] = useState("C3905");
  // Classes emitted on any of the four clips; null until all four are loaded.
  const [emitted, setEmitted] = useState<Set<string> | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void loadData<Manifest>("manifest.json", ac.signal).then((m) => {
      setManifest(m);
      if (m?.metrics.available && m.metrics.path) void loadData<DevEval>(m.metrics.path, ac.signal).then(setDev);
    });
    void loadData<ExamplesData>("examples.json", ac.signal).then(setExamples);
    void Promise.all(CLIPS.map((id) => loadData<SampleData>(`samples/${id}.json`, ac.signal))).then((rows) => {
      if (rows.every(Boolean)) setEmitted(new Set(rows.flatMap((r) => r!.events.map((e) => e[2]))));
    });
    return () => ac.abort();
  }, []);
  const silent = emitted ? IMPLEMENTED_CLASSES.map((c) => c.id).filter((id) => !emitted.has(id)) : [];
  const missing = CLASSES.filter((c) => c.rule === null).map((c) => c.id);

  useEffect(() => {
    const ac = new AbortController();
    setSample(null);
    void loadData<SampleData>(`samples/${clip}.json`, ac.signal).then(setSample);
    return () => ac.abort();
  }, [clip]);

  const analysis = useMemo(() => {
    if (!sample) return null;
    const events = sample.events;
    const dur = sample.meta.duration;
    const byClass = new Map<string, number>();
    for (const e of events) byClass.set(e[2], (byClass.get(e[2]) ?? 0) + 1);

    const short = events.filter((e) => e[1] - e[0] < SHORT_EVENT_SEC);
    const spanning = events.filter((e) => e[1] - e[0] > dur * 0.9);
    const peakRisk = sample.risk.reduce((m, p) => Math.max(m, p[1]), 0);
    const alarms = findAlarms(sample.risk);

    // Pairs of different classes that overlap in time, as the timeline shows them, and how
    // many of those pairs involve a clip-spanning segment.
    const overlaps = new Map<string, number>();
    const viaSpanning = new Map<string, number>();
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        if (events[i][2] === events[j][2]) continue;
        if (events[i][0] < events[j][1] && events[j][0] < events[i][1]) {
          const key = [events[i][2], events[j][2]].sort().join(" + ");
          overlaps.set(key, (overlaps.get(key) ?? 0) + 1);
          if (spanning.includes(events[i]) || spanning.includes(events[j])) {
            viaSpanning.set(key, (viaSpanning.get(key) ?? 0) + 1);
          }
        }
      }
    }

    return {
      byClass: [...byClass.entries()]
        .sort((a, b) => byClassOrder(a[0], b[0]))
        .map(([label, value]) => ({ label, value, color: classColor(label) })),
      short,
      spanning,
      peakRisk,
      alarms,
      overlaps: [...overlaps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
      viaSpanning,
      medianDur:
        events.length === 0
          ? 0
          : [...events].map((e) => e[1] - e[0]).sort((a, b) => a - b)[Math.floor(events.length / 2)],
    };
  }, [sample]);

  // What the dev-set numbers are made of, read off dev-eval.json rather than written by hand.
  const devFacts = useMemo(() => {
    if (!dev) return null;
    const videos = Object.entries(dev.videos);
    const zero = dev.classes.filter((c) => c.mean === 0).map((c) => c.id).sort(byClassOrder);
    const noRule = zero.filter((id) => CLASS_BY_ID[id]?.rule === null);
    const neverFired = zero.filter((id) => CLASS_BY_ID[id]?.rule && !dev.classes.find((c) => c.id === id)?.pred);
    const mostFp = [...dev.classes].sort((a, b) => b.fp - a.fp)[0];
    const sameBoundary = videos.flatMap(([, v]) =>
      v.gt.filter((g) =>
        v.pred.some(
          (p) => p[2] === g[2] && Math.abs(p[0] - g[0]) <= SAME_BOUNDARY_SEC && Math.abs(p[1] - g[1]) <= SAME_BOUNDARY_SEC,
        ),
      ),
    );
    const accidents = videos.flatMap(([id, v]) => v.accidents.map((a) => ({ clip: id, ...a })));
    return { clips: videos.map(([id]) => id), zero, noRule, neverFired, mostFp, sameBoundary, accidents };
  }, [dev]);
  const devClip = dev?.videos[clip] ?? null;

  return (
    <div className="mx-auto max-w-[1320px] space-y-14 px-4 py-10 sm:py-14">
      <Section
        eyebrow="Results"
        title="What is measured, and what is not"
        lead={
          dev && devFacts
            ? `The task publishes the exact metric, and evaluate.py is in the repository. We run it on the clip we labelled (${devFacts.clips.join(", ")}); the other clips are reported as output only, and this page says which is which.`
            : "The task publishes the exact metric. We can run it — evaluate.py is in the repository — but it needs labels we do not have, so this page reports what the pipeline actually produced and is explicit about the rest."
        }
      />

      {dev && devFacts ? (
        <Section
          id="dev-set"
          eyebrow="Accuracy · our dev labels"
          title={`Score A ${dev.score_a.toFixed(2)} on the clip we labelled`}
          lead={
            <>
              {devFacts.clips.join(", ")} is annotated by our team: {dev.n_gt} events in{" "}
              <span className="num">{dev.labels}</span>, following the task&rsquo;s start/end conventions.
              Every number below is <span className="num">evaluate.py</span>&rsquo;s own, run against those labels
              and the committed <span className="num">predictions_samples.json</span>. One clip is a small dev set and
              the rules were tuned on this footage, so read it as a sanity check, not as an estimate of the
              hidden-set score.
            </>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              value={dev.score_a.toFixed(3)}
              label="Score A"
              tone="accent"
              hint={`macro F1 over ${dev.classes.length} classes, mean of tIoU 0.3 / 0.5 / 0.7`}
            />
            <Stat
              value={dev.part_b ? dev.part_b.score_b.toFixed(3) : "—"}
              label="Score B"
              hint={
                dev.part_b
                  ? `${dev.part_b.n_accidents} labelled accident, ${dev.part_b.n_alarms} alarms, AP ${dev.part_b.ap.toFixed(2)}`
                  : "no accident in the labels, so undefined"
              }
            />
            <Stat value={dev.model_score.toFixed(3)} label="Model score M" hint="0.7·A + 0.3·B, as evaluate.py combines them" />
            <Stat
              value={`${dev.micro["0.3"].toFixed(2)} → ${dev.micro["0.7"].toFixed(2)}`}
              label="Micro F1, tIoU 0.3 → 0.7"
              hint={`${dev.n_pred} segments emitted against ${dev.n_gt} labels; ${dev.micro["0.5"].toFixed(2)} at 0.5`}
            />
          </div>

          <div className="mt-5 grid gap-4 xl:grid-cols-[1.1fr_1fr]">
            <Panel className="min-w-0 p-5">
              <h3 className="mb-3 text-sm font-semibold">Per class, as evaluate.py reports it</h3>
              <DevClassTable classes={dev.classes} />
            </Panel>
            {devFacts.clips.map((id) => (
              <Panel key={id} className="min-w-0 p-5">
                <h3 className="mb-1 text-sm font-semibold">Labels against our segments &mdash; {id}</h3>
                <p className="mb-3 text-[11px] leading-relaxed text-faint">
                  Coloured by the match at tIoU&nbsp;{dev.status_tiou}. Click a block to open that moment in the player.
                </p>
                <DevTimeline clip={id} video={dev.videos[id]} />
              </Panel>
            ))}
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <Callout title="What the score is made of">
              <p>
                {devFacts.zero.length} of {dev.classes.length} classes score zero:{" "}
                {devFacts.noRule.length > 0 && (
                  <>
                    <span className="num">{devFacts.noRule.join(", ")}</span> have no detector
                    {devFacts.neverFired.length > 0 ? "; " : "."}
                  </>
                )}
                {devFacts.neverFired.length > 0 && (
                  <>
                    <span className="num">{devFacts.neverFired.join(", ")}</span> have a rule that did not fire.
                  </>
                )}
              </p>
              {devFacts.mostFp.fp > 0 && (
                <p className="mt-2">
                  <span className="num">{devFacts.mostFp.id}</span> is the largest source of false positives:{" "}
                  {devFacts.mostFp.fp} of its {devFacts.mostFp.pred} segments have no label under them at tIoU&nbsp;0.5.
                </p>
              )}
              {dev.micro["0.3"] > 0 && (
                <p className="mt-2">
                  Pooled F1 falls from {dev.micro["0.3"].toFixed(2)} at tIoU&nbsp;0.3 to {dev.micro["0.7"].toFixed(2)} at 0.7:
                  with the segment counts fixed, that is{" "}
                  {Math.round((1 - dev.micro["0.7"] / dev.micro["0.3"]) * 100)}% of the matches lost to boundaries alone.
                </p>
              )}
            </Callout>
            <Callout title="How independent the labels are">
              <p>
                The labels were drawn in <span className="num">tools/labeler/index.html</span>, which shows our
                predictions beside the video for comparison.{" "}
                {devFacts.sameBoundary.length > 0 ? (
                  <>
                    {devFacts.sameBoundary.length === 1 ? "One label ends" : `${devFacts.sameBoundary.length} labels end`}{" "}
                    within {SAME_BOUNDARY_SEC}&nbsp;s of one of our segments at both boundaries (
                    <span className="num">{[...new Set(devFacts.sameBoundary.map((e) => e[2]))].join(", ")}</span>), so
                    those perfect scores are the least independent part of this evaluation.
                  </>
                ) : (
                  "No label copies one of our boundaries."
                )}
              </p>
            </Callout>
            {dev.disputed.length > 0 ? (
              <Callout tone="warn" title="One label did not hold up on review">
                {dev.disputed.map((d) => (
                  <p key={`${d.video}-${d.start}`}>
                    <span className="num">
                      {d.label} · {d.video} · {timecode(d.start)}–{timecode(d.end)}
                    </span>
                    : {d.note}
                  </p>
                ))}
                {dev.score_a_undisputed !== null && (
                  <p className="mt-2">
                    Without it Score&nbsp;A is <span className="num">{dev.score_a_undisputed.toFixed(3)}</span>
                    {devFacts.accidents.length > 0 && " and there is no accident left to score Part B against"}.
                  </p>
                )}
              </Callout>
            ) : (
              <Callout title="Labels under review">
                <p>No label has been disputed after a second look.</p>
              </Callout>
            )}
          </div>
        </Section>
      ) : (
      <Section eyebrow="Accuracy" title="Score A and Score B are not measured">
        <Callout tone="warn" title="No dev labels exist in this repository">
          <p>
            The organizers shipped the sample clips <em>unlabelled</em>, and we have not annotated
            them yet. <span className="num">evaluate.py</span> needs a{" "}
            <span className="num">ground_truth.json</span> to compute temporal IoU matches, so there is
            no Score&nbsp;A, no Score&nbsp;B, no per-class F1, no AP and no mTTA to show.
          </p>
          <p className="mt-2">
            {manifest?.metrics.reason}
          </p>
          <p className="mt-2">
            The labelling tool is already built &mdash;{" "}
            <span className="num">tools/labeler/index.html</span> loads a clip, imports our predictions
            for comparison and exports ground truth in exactly the shape{" "}
            <span className="num">evaluate.py</span> expects. What is missing is annotation time, not
            code.
          </p>
        </Callout>
      </Section>
      )}

      {examples && examples.examples.length > 0 && (
        <Section
          id="examples"
          eyebrow="Examples"
          title="One example of every class we detect"
          lead="A frame from inside one segment of each class the rules emitted on the sample clips, with that rule's evidence boxes drawn from the tracker output. Where our dev labels confirm a segment, that one is shown. Click an example to watch it in the player."
        >
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[...examples.examples]
              .sort((a, b) => byClassOrder(a.class, b.class))
              .map((ex) => {
                const to = `/samples?clip=${ex.clip}&t=${ex.start.toFixed(2)}`;
                return (
                  <li key={ex.class}>
                    <Panel className="h-full overflow-hidden">
                      <Link to={to} className="block bg-ink2">
                        <img
                          src={`${import.meta.env.BASE_URL}${ex.image}`}
                          alt={`${ex.class} in ${ex.clip} at ${timecode(ex.t)}, with the rule's evidence boxes`}
                          loading="lazy"
                          className="aspect-video w-full object-cover"
                        />
                      </Link>
                      <div className="p-3">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: classColor(ex.class) }} />
                          <span className="num">{ex.class}</span>
                        </div>
                        <p className="num mt-1 text-[11px] text-muted">
                          {ex.clip} &middot; {timecode(ex.start)}&ndash;{timecode(ex.end)}
                          {ex.labelled && <span className="text-ok"> &middot; matches a dev label</span>}
                        </p>
                        <Link to={to} className="mt-2 inline-block text-xs text-accent underline-offset-4 hover:underline">
                          Watch it in the player &rarr;
                        </Link>
                      </div>
                    </Panel>
                  </li>
                );
              })}
          </ul>
          {silent.length > 0 && (
            <p className="mt-3 text-xs text-faint">
              No example for <span className="num">{silent.join(", ")}</span>: those rules exist but never fired on the
              four sample clips.
            </p>
          )}
        </Section>
      )}

      <Section eyebrow="The metric" title="How the two scores are computed">
        <div className="grid gap-3 md:grid-cols-2">
          <Panel className="p-5">
            <h3 className="text-sm font-semibold">Score A &mdash; event detection</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              For each class and each threshold &tau; &isin; {"{"}0.3, 0.5, 0.7{"}"}, predicted and
              ground-truth segments are matched greedily by descending temporal IoU; TP/FP/FN pool over
              all videos into F1<sub>c</sub>(&tau;). Score&nbsp;A is the mean over classes of the mean
              over the three thresholds.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              Boundaries dominate: a segment that covers the right moment but is twice too long scores
              an IoU of 0.5 and fails at &tau; = 0.7 entirely.
            </p>
          </Panel>
          <Panel className="p-5">
            <h3 className="text-sm font-semibold">Score B &mdash; accident anticipation</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              Only accident events count. Frames in [s&minus;5s, s) are positive; frames inside
              accidents and around near-misses are ignored. Score&nbsp;B = 0.4&middot;AP +
              0.4&middot;F1<sub>alarm</sub> + 0.2&middot;mTTA/10, with AP chance-normalised so a
              constant score gets exactly 0.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              {devFacts && devFacts.accidents.length > 0 ? (
                <>
                  Our labels hold {devFacts.accidents.length === 1 ? "one accident" : `${devFacts.accidents.length} accidents`}
                  {devFacts.accidents.map((a) => (
                    <span key={`${a.clip}-${a.start}`} className="num">
                      {" "}
                      ({a.clip}, {timecode(a.start)}; risk peak in the 5&nbsp;s before it: {a.peak_before.toFixed(3)})
                    </span>
                  ))}
                  . The score never approaches &theta;&nbsp;=&nbsp;{THETA} there, so the local Score&nbsp;B is
                  zero &mdash; and that label is the one disputed above.
                </>
              ) : (
                <>
                  None of the labelled clips contains a collision, so the local Score&nbsp;B is undefined.
                </>
              )}
            </p>
          </Panel>
        </div>
      </Section>

      {sample?.runtime && (
        <Section
          eyebrow="Performance"
          title="Runtime against the budget"
          lead={
            <>
              Measured by the organizers&rsquo; own harness on{" "}
              <span className="num">{sample.meta.name}</span> &mdash; {sample.meta.duration.toFixed(0)}&nbsp;s of 4K
              footage, on one RTX&nbsp;5080. The limit is 3&times; the clip duration for Part A and Part B
              together.
            </>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              value={`${sample.runtime.part_a_sec.toFixed(1)}s`}
              label="Part A"
              hint={`${(sample.runtime.part_a_sec / sample.runtime.duration).toFixed(2)}× real time`}
            />
            <Stat
              value={`${sample.runtime.part_b_sec.toFixed(1)}s`}
              label="Part B"
              hint={`${(sample.runtime.part_b_sec / sample.runtime.duration).toFixed(2)}× — every frame decoded`}
            />
            <Stat
              value={`${sample.runtime.total_sec.toFixed(1)}s`}
              label="Total"
              tone="ok"
              hint={`budget ${sample.runtime.budget_sec.toFixed(0)}s`}
            />
            <Stat
              value={`${((sample.runtime.total_sec / sample.runtime.budget_sec) * 100).toFixed(0)}%`}
              label="Of the budget"
              tone="ok"
              hint="margin for a slower evaluation machine"
            />
          </div>
          <p className="mt-4 max-w-[80ch] text-sm leading-relaxed text-muted">
            Part&nbsp;B costs more than twice Part&nbsp;A despite using a smaller model, because the
            harness hands it every single frame: the cost is dominated by full-rate decoding, not by
            inference. Part&nbsp;A avoids that entirely by decoding only reference frames.
          </p>
        </Section>
      )}

      {sample && analysis && (
        <Section
          eyebrow="Output"
          title="What the pipeline produced on this clip"
          lead="Counts, not accuracy. Without labels these numbers say what the system claims, not how much of it is right."
        >
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-xs text-faint">Clip</span>
            {CLIPS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setClip(c)}
                aria-pressed={clip === c}
                className={`num rounded border px-2.5 py-1 text-xs transition-colors ${
                  clip === c ? "border-accent text-text" : "border-line text-muted hover:text-text"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
            <Panel className="p-5">
              <h3 className="mb-3 text-sm font-semibold">Events per class</h3>
              <BarList bars={analysis.byClass} />
              <dl className="mt-4 space-y-1.5 border-t border-linesoft pt-3 text-xs">
                <div className="flex justify-between">
                  <dt className="text-faint">Total events</dt>
                  <dd className="num">{sample.events.length}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-faint">Median duration</dt>
                  <dd className="num">{analysis.medianDur.toFixed(2)} s</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-faint">Peak risk score</dt>
                  <dd className="num">{analysis.peakRisk.toFixed(3)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-faint">Alarms raised</dt>
                  <dd className="num">{analysis.alarms.length}</dd>
                </div>
              </dl>
            </Panel>

            <Panel className="p-5">
              <h3 className="mb-1 text-sm font-semibold">Most common class co-occurrence</h3>
              <p className="mb-3 text-[11px] text-faint">
                Pairs of different classes overlapping in time. Legitimate by the rules, but worth
                reading as a causal chain.
              </p>
              <BarList
                bars={analysis.overlaps.map(([label, value]) => ({
                  label,
                  value,
                  color: "var(--accent)",
                }))}
                format={(v) => `${v} pairs`}
              />
              {analysis.overlaps.length > 0 && (
                <p className="mt-3 text-[12px] leading-relaxed text-muted">
                  The most frequent pair here is <span className="num">{analysis.overlaps[0][0]}</span>, with{" "}
                  {analysis.overlaps[0][1]} overlaps.
                  {(analysis.viaSpanning.get(analysis.overlaps[0][0]) ?? 0) > 0 && (
                    <>
                      {" "}
                      {analysis.viaSpanning.get(analysis.overlaps[0][0])} of them involve the{" "}
                      <span className="num">{analysis.spanning[0][2]}</span> segment spanning over 90% of the
                      clip &mdash; the probable false positive described below, not a pattern in the
                      traffic.
                    </>
                  )}
                </p>
              )}
            </Panel>
          </div>
        </Section>
      )}

      {sample && analysis && (
        <Section
          eyebrow="Failure analysis"
          title="Where this output is wrong, or probably wrong"
          lead="These are read directly off the predictions above. None of them needs ground truth to be visible — which is exactly why they are the first things to fix."
        >
          <div className="grid gap-3 md:grid-cols-2">
            {analysis.spanning.length > 0 &&
              (devClip?.pred.some(
                (p) => p[2] === analysis.spanning[0][2] && p[3] === "tp" && Math.abs(p[0] - analysis.spanning[0][0]) < 0.01,
              ) ? (
                <Panel className="p-5">
                  <div className="num text-[10px] uppercase tracking-[0.14em] text-accent">
                    Matches our label &middot; still a judgement call
                  </div>
                  <h3 className="mt-2 text-sm font-semibold">
                    A {analysis.spanning[0][2]} spanning the whole clip
                  </h3>
                  <p className="num mt-1.5 text-xs text-muted">
                    {timecode(analysis.spanning[0][0])} &rarr; {timecode(analysis.spanning[0][1])} &mdash;{" "}
                    {(analysis.spanning[0][1] - analysis.spanning[0][0]).toFixed(0)} s of a{" "}
                    {sample.meta.duration.toFixed(0)} s clip
                  </p>
                  <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
                    Our annotator marked the same vehicle as a <span className="num">{analysis.spanning[0][2]}</span> for
                    the whole clip, so on this clip the segment is a true positive at every threshold. Whether a
                    vehicle that never moves is &ldquo;stopped on the carriageway&rdquo; or parked is exactly the
                    call the hidden labels could make differently: the rule has no notion of a parking bay, and{" "}
                    <span className="num">stitch_parked</span> deliberately joins fragments of one standing vehicle.
                  </p>
                </Panel>
              ) : (
              <Panel className="p-5">
                <div className="num text-[10px] uppercase tracking-[0.14em] text-bad">
                  Probable false positive &middot; unverified without labels
                </div>
                <h3 className="mt-2 text-sm font-semibold">
                  A {analysis.spanning[0][2]} spanning the whole clip
                </h3>
                <p className="num mt-1.5 text-xs text-muted">
                  {timecode(analysis.spanning[0][0])} &rarr; {timecode(analysis.spanning[0][1])} &mdash;{" "}
                  {(analysis.spanning[0][1] - analysis.spanning[0][0]).toFixed(0)} s of a{" "}
                  {sample.meta.duration.toFixed(0)} s clip
                </p>
                <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
                  A vehicle standing still for the entire recording is most likely parked rather than
                  &ldquo;stopped on the carriageway&rdquo; &mdash; a judgement from watching the render, not a
                  labelled fact. The rule already excludes signal queues, bus dwell, stops inside the
                  junction and vehicles inside a congestion event, but it has no notion of a legal parking bay, and{" "}
                  <span className="num">stitch_parked</span> deliberately joins fragments of one
                  standing vehicle &mdash; which makes this segment longer, not shorter. A static-object
                  mask learned from the median background would remove it.
                </p>
              </Panel>
              ))}

            {analysis.short.length > 0 && (
              <Panel className="p-5">
                <div className="num text-[10px] uppercase tracking-[0.14em] text-bad">
                  Boundary precision
                </div>
                <h3 className="mt-2 text-sm font-semibold">
                  {analysis.short.length} events shorter than {SHORT_EVENT_SEC.toFixed(1)} s
                </h3>
                <p className="num mt-1.5 text-xs text-muted">
                  shortest {Math.min(...analysis.short.map((e) => e[1] - e[0])).toFixed(2)} s &middot;{" "}
                  {analysis.short.filter((e) => e[2] === "failure_to_yield").length} of them
                  failure_to_yield
                </p>
                <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
                  A sub-second segment has almost no chance of reaching IoU 0.7 against a
                  human-annotated boundary, and if the annotator merged several passes into one event
                  each of ours becomes a separate false positive. The rule fires per vehicle crossing;
                  the annotation convention is per vehicle too, but our start and end are the frames
                  where the box footprint touches the crossing mask, which is tighter than what a human
                  marks.
                </p>
              </Panel>
            )}

            <Panel className="p-5">
              <div className="num text-[10px] uppercase tracking-[0.14em] text-bad">Coverage</div>
              <h3 className="mt-2 text-sm font-semibold">{missing.length} classes are never produced</h3>
              <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
                {missing.slice(0, -1).join(", ")} and {missing[missing.length - 1]}.
                If any of them occurs in the hidden test set it contributes a zero to the class average
                in Score&nbsp;A, and there is nothing the rest of the pipeline can do about it. This is
                the single largest known cost in our model score.
              </p>
              {silent.length > 0 && (
                <p className="mt-2 text-[13px] leading-relaxed text-muted">
                  {silent.length === 1 ? "One more has a rule but never fires" : `${silent.length} more have a rule but never fire`} on
                  any of the four sample clips:{" "}
                  <span className="num">{silent.join(", ")}</span>.{" "}
                  {(() => {
                    const labelled = Object.entries(dev?.videos ?? {}).flatMap(([id, v]) =>
                      v.gt.filter((g) => (silent as string[]).includes(g[2])).map((g) => `${g[2]} (${id} ${timecode(g[0])})`),
                    );
                    return labelled.length > 0 ? (
                      <>
                        Our dev labels contain <span className="num">{labelled.join(", ")}</span>, so at least there the
                        rules are too strict rather than idle.
                      </>
                    ) : (
                      <>
                        That is consistent with none occurring in this footage, and equally with a threshold set too
                        strictly &mdash; without labels we cannot tell which.
                      </>
                    );
                  })()}
                </p>
              )}
              <Link to="/classes" className="mt-3 inline-block text-xs text-accent underline-offset-4 hover:underline">
                Per-class reasoning &rarr;
              </Link>
            </Panel>

            <Panel className="p-5">
              <div className="num text-[10px] uppercase tracking-[0.14em] text-accent">
                Expected, but unverified
              </div>
              <h3 className="mt-2 text-sm font-semibold">
                The risk curve peaks at {analysis.peakRisk.toFixed(3)} and raises{" "}
                {analysis.alarms.length === 0 ? "no alarm" : `${analysis.alarms.length} alarm${analysis.alarms.length === 1 ? "" : "s"}`}
              </h3>
              <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
                {analysis.alarms.length === 0 && devClip && devClip.accidents.length > 0 ? (
                  <>
                    Our labels put an accident at{" "}
                    <span className="num">{devClip.accidents.map((a) => timecode(a.start)).join(", ")}</span>, and the score
                    peaks at{" "}
                    <span className="num">{Math.max(...devClip.accidents.map((a) => a.peak_before)).toFixed(3)}</span> in
                    the 5&nbsp;s before it, so against these labels Part&nbsp;B misses it. On review we could not see
                    contact there either (see the disputed label above), which is why this reads as an open question
                    rather than a confirmed miss.
                  </>
                ) : analysis.alarms.length === 0 ? (
                  <>
                    Nothing in this clip looks like a collision, so a curve that stays below
                    &theta;&nbsp;=&nbsp;{THETA} is the behaviour we want &mdash; the cues are calibrated
                    so ordinary traffic does not trip the alarm.
                  </>
                ) : (
                  <>
                    The score crosses &theta;&nbsp;=&nbsp;{THETA}, so by <span className="num">evaluate.py</span>&rsquo;s
                    rule this clip raises an alarm. Whether that is a true positive is exactly what we
                    cannot say: there are no labels, and nothing in the footage was annotated as a
                    collision.
                  </>
                )}{" "}
                Either way we have never observed the estimator fire on a <em>confirmed</em> accident,
                so its true-positive behaviour is untested and the 0.4&middot;AP +
                0.4&middot;F1<sub>alarm</sub> part of Score&nbsp;B is a genuine unknown, not a
                conservative estimate.
              </p>
            </Panel>

            <Panel className="p-5">
              <div className="num text-[10px] uppercase tracking-[0.14em] text-bad">Generalisation</div>
              <h3 className="mt-2 text-sm font-semibold">Everything is tied to one camera pose</h3>
              <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
                The stop line, crossings, islands and flow field live in one reference frame. That is
                sound for this task &mdash; the hidden set is the same camera and angle &mdash; but if
                the framing shifted enough that SIFT fell below 40 inliers, the homography would drop to
                identity and every geometric rule would silently degrade. The live demo surfaces the
                inlier count for exactly this reason.
              </p>
            </Panel>

            <Panel className="p-5">
              <div className="num text-[10px] uppercase tracking-[0.14em] text-bad">Evaluation gap</div>
              {devFacts ? (
                <>
                  <h3 className="mt-2 text-sm font-semibold">
                    {devFacts.clips.length} of {manifest?.summary?.samples_total ?? 4} clips labelled, and tuned on
                  </h3>
                  <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
                    The dev score comes from {devFacts.clips.join(", ")} alone, and the thresholds in the rules were
                    chosen by watching the same four clips. A score measured on footage the rules were tuned on is
                    optimistic by construction; labelling the other clips, and holding one out, is the first thing
                    that would make it an estimate.
                  </p>
                </>
              ) : (
                <>
              <h3 className="mt-2 text-sm font-semibold">Sample clips are not a dev set</h3>
              <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
                All {manifest?.summary?.samples_processed ?? 4} of{" "}
                {manifest?.summary?.samples_total ?? 4} sample clips are processed here, but the
                thresholds in the rules were chosen against that same footage with no labels to check
                them against. Tuning and evaluating on one unlabelled set is not evaluation; some
                thresholds are very likely mistuned and we have no way to know which.
              </p>
                </>
              )}
            </Panel>
          </div>
        </Section>
      )}

      {!sample && (
        <DataGap
          title="No processed sample"
          what="predictions_samples.json is empty or missing, so there is nothing to report."
          fill="Run python run_submission.py --videos samples --out predictions_samples.json --team wiut-cv, then scripts/build_site_data.py."
        />
      )}
    </div>
  );
}
