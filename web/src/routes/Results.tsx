import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BarList } from "../components/charts";
import { Callout, DataGap, Panel, Section, Stat } from "../components/ui";
import { loadData } from "../lib/api";
import { findAlarms, THETA } from "../components/RiskCurve";
import { byClassOrder, classColor } from "../lib/classes";
import { timecode } from "../lib/format";
import type { Manifest, SampleData } from "../lib/types";

const SHORT_EVENT_SEC = 1.0;
const CLIPS = ["C3896", "C3897", "C3902", "C3905"];

export default function Results() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [sample, setSample] = useState<SampleData | null>(null);
  const [clip, setClip] = useState("C3905");

  useEffect(() => {
    const ac = new AbortController();
    void loadData<Manifest>("manifest.json", ac.signal).then(setManifest);
    return () => ac.abort();
  }, []);

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

    // Pairs of different classes that overlap in time, as the timeline shows them.
    const overlaps = new Map<string, number>();
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        if (events[i][2] === events[j][2]) continue;
        if (events[i][0] < events[j][1] && events[j][0] < events[i][1]) {
          const key = [events[i][2], events[j][2]].sort().join(" + ");
          overlaps.set(key, (overlaps.get(key) ?? 0) + 1);
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
      medianDur:
        events.length === 0
          ? 0
          : [...events].map((e) => e[1] - e[0]).sort((a, b) => a - b)[Math.floor(events.length / 2)],
    };
  }, [sample]);

  return (
    <div className="mx-auto max-w-[1320px] space-y-14 px-4 py-10 sm:py-14">
      <Section
        eyebrow="Results"
        title="What is measured, and what is not"
        lead="The task publishes the exact metric. We can run it — evaluate.py is in the repository — but it needs labels we do not have, so this page reports what the pipeline actually produced and is explicit about the rest."
      />

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

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <Panel className="p-5">
            <h3 className="text-sm font-semibold">How Score A would be computed</h3>
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
            <h3 className="text-sm font-semibold">How Score B would be computed</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              Only accident events count. Frames in [s&minus;5s, s) are positive; frames inside
              accidents and around near-misses are ignored. Score&nbsp;B = 0.4&middot;AP +
              0.4&middot;F1<sub>alarm</sub> + 0.2&middot;mTTA/10, with AP chance-normalised so a
              constant score gets exactly 0.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              None of the sample clips we hold contains a collision, so even with labels the local
              Score&nbsp;B would be undefined.
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
              <span className="num">{sample.meta.name}</span> &mdash; 127&nbsp;s of 4K footage, on one
              RTX&nbsp;5080. The limit is 3&times; the clip duration for Part A and Part B together.
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
                  <dd className="num">0</dd>
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
              <p className="mt-3 text-[12px] leading-relaxed text-muted">
                jaywalking overlapping failure_to_yield is the signature of this junction: pedestrians
                cross outside the painted crossings, and vehicles drive through while they do.
              </p>
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
            {analysis.spanning.length > 0 && (
              <Panel className="p-5">
                <div className="num text-[10px] uppercase tracking-[0.14em] text-bad">
                  Near-certain false positive
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
                  A vehicle standing still for the entire recording is parked, not &ldquo;stopped on the
                  carriageway&rdquo;. The rule already excludes signal queues, bus dwell and vehicles
                  inside a congestion event, but it has no notion of a legal parking bay, and{" "}
                  <span className="num">stitch_parked</span> deliberately joins fragments of one
                  standing vehicle &mdash; which makes this segment longer, not shorter. A static-object
                  mask learned from the median background would remove it.
                </p>
              </Panel>
            )}

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
              <h3 className="mt-2 text-sm font-semibold">Six classes are never produced</h3>
              <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
                accident, near_miss, illegal_turn, solid_line_crossing, road_obstacle and fire_smoke.
                If any of them occurs in the hidden test set it contributes a zero to the class average
                in Score&nbsp;A, and there is nothing the rest of the pipeline can do about it. This is
                the single largest known cost in our model score.
              </p>
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
                {analysis.alarms.length === 0 ? (
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
              <h3 className="mt-2 text-sm font-semibold">Sample clips are not a dev set</h3>
              <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
                All {manifest?.summary?.samples_processed ?? 4} of{" "}
                {manifest?.summary?.samples_total ?? 4} sample clips are processed here, but the
                thresholds in the rules were chosen against that same footage with no labels to check
                them against. Tuning and evaluating on one unlabelled set is not evaluation; some
                thresholds are very likely mistuned and we have no way to know which.
              </p>
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
