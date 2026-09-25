import { useEffect, useState } from "react";
import { Callout, Panel, Section, Stat } from "../components/ui";
import { LINKS } from "../content/links";
import { loadData } from "../lib/api";
import { IMPLEMENTED_CLASSES } from "../lib/classes";
import type { Manifest, SampleData } from "../lib/types";

export default function Report() {
  const [sample, setSample] = useState<SampleData | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    void loadData<SampleData>("samples/C3905.json", ac.signal).then(setSample);
    void loadData<Manifest>("manifest.json", ac.signal).then(setManifest);
    return () => ac.abort();
  }, []);

  const rt = sample?.runtime;

  return (
    <div className="mx-auto max-w-[900px] space-y-12 px-4 py-10 sm:py-14">
      <Section
        eyebrow="Technical report"
        title="Traffic event detection on a fixed CCTV view"
        lead="One page: what we built, what worked, what did not, and what we would do next. Written so the pipeline can be rebuilt from this page without opening the source."
      />

      <article className="space-y-10">
        <Block n="1" title="Problem">
          <p>
            A single fixed camera watches one road junction in 4K at 29.97&nbsp;fps. Given an{" "}
            <span className="num">.mp4</span>, return every traffic event as{" "}
            <span className="num">[start_sec, end_sec, label]</span> from a fixed vocabulary of 14
            classes (Part&nbsp;A), and, frame by frame using only the past, the probability that an
            accident starts within the next five seconds (Part&nbsp;B). Evaluation is offline on a
            hidden set from the same camera, with a wall-clock budget of 3&times; the clip duration.
          </p>
          <p>
            The defining constraint is that <em>we got no labels</em>. Four unlabelled sample clips,
            roughly 18&nbsp;minutes in total, and nothing else. Any supervised approach would have to
            be trained on public data from other cameras and hoped to transfer; any tuned approach
            would be tuned blind.
          </p>
        </Block>

        <Block n="2" title="Approach">
          <p>
            We learn one thing and reason about the rest. A COCO-pretrained YOLO11 detector finds road
            users; a Kalman tracker turns detections into trajectories; a homography puts every
            trajectory into a single reference frame in which the junction&rsquo;s geometry was drawn
            once; the traffic signal is read from lamp pixels. Events are then rules over trajectories,
            geometry and phase.
          </p>
          <p>
            The reasoning is deliberate, not a fallback. With four unlabelled clips there is nothing to
            validate a learned event classifier against, while a rule states its assumption explicitly
            and can be checked by eye on the annotated renders. It also fits the budget with room to
            spare.
          </p>
          <Panel className="my-4 p-4">
            <div className="num text-xs leading-relaxed text-muted">
              video &rarr; sampled decode (ref frames only) &rarr; YOLO11m &rarr; Kalman/IoU tracker
              &rarr; SIFT homography &rarr; scene masks + signal phase &rarr; 10 event rules &rarr;
              merge/split/filter &rarr; segments
            </div>
            <div className="num mt-2 text-xs leading-relaxed text-muted">
              frames &rarr; YOLO11s (every 5th) &rarr; online tracks &rarr; TTC conflict + red-runner +
              braking &rarr; noisy-OR &rarr; attack/decay &rarr; risk score
            </div>
          </Panel>
        </Block>

        <Block n="3" title="Architecture and models">
          <ul>
            <li>
              <b>Detection (learned).</b> YOLO11m at 1280&times;736, batch 16, and YOLO11s at
              960&times;544, batch 1 for the causal pass. Both COCO-pretrained, exported to TorchScript
              so evaluation needs only PyTorch and torchvision. Confidence floor 0.15; NMS in
              torchvision.
            </li>
            <li>
              <b>Tracking (rule-based).</b> ByteTrack-style two-stage IoU association over a
              constant-velocity Kalman filter on (cx, cy, w, h), vectorised in numpy with Hungarian
              assignment. Association is restricted to a class group, so a pedestrian box cannot take
              over a vehicle track.
            </li>
            <li>
              <b>Geometry (rule-based).</b> <span className="num">configs/scene.json</span> holds the
              stop line, three crossings, four islands, two sidewalk regions, three direction zones and
              the signal-head lamp coordinates, all in a 1920&times;1080 reference frame. Masks are
              rasterised once into distance transforms for O(1) point queries.
            </li>
            <li>
              <b>Signal phase (rule-based).</b> Per-lamp colour score with a sliding-window threshold
              fitted per video, plus run-structure reconstruction of flashing green and amber.
            </li>
            <li>
              <b>Events (rule-based).</b> {IMPLEMENTED_CLASSES.length} rules, each producing time
              segments plus optional evidence (which tracks fired it).
            </li>
            <li>
              <b>Risk (rule-based).</b> Three interpretable cues combined by noisy-OR with asymmetric
              smoothing.
            </li>
          </ul>
        </Block>

        <Block n="4" title="Datasets and licences">
          <p>
            <b>No external dataset was used for training.</b> The only pretrained weights are
            Ultralytics YOLO11m and YOLO11s, trained on <b>COCO</b> and used off the shelf with no
            fine-tuning. Ultralytics models are distributed under <b>AGPL-3.0</b>; COCO images are
            <b> CC BY 4.0</b> with annotations under the COCO terms.
          </p>
          <p>
            The traffic flow field in <span className="num">configs/flow_field.npz</span> is derived
            from the organizers&rsquo; own sample clips and is the only data in the repository learned
            from the competition footage. No footage is redistributed: the 4K originals are gitignored
            and the site serves generated 720p proxies of the clips present in this checkout.
          </p>
        </Block>

        <Block n="5" title="Results">
          {rt ? (
            <>
              <div className="my-4 grid gap-3 sm:grid-cols-4">
                <Stat value={`${rt.part_a_sec.toFixed(1)}s`} label="Part A" />
                <Stat value={`${rt.part_b_sec.toFixed(1)}s`} label="Part B" />
                <Stat value={`${rt.total_sec.toFixed(1)}s`} label="Total" tone="ok" />
                <Stat value={`${rt.budget_sec.toFixed(0)}s`} label="Budget" />
              </div>
              <p>
                On {sample!.meta.name} &mdash; {rt.duration.toFixed(0)}&nbsp;s of 4K footage on one
                RTX&nbsp;5080 &mdash; the full pipeline used{" "}
                <b>{((rt.total_sec / rt.budget_sec) * 100).toFixed(0)}% of the time budget</b> and
                produced {sample!.events.length} events across{" "}
                {new Set(sample!.events.map((e) => e[2])).size} classes. The format check (
                <span className="num">evaluate.py --validate-only</span>) passes with no errors and no
                warnings.
              </p>
              <p>
                <b>Accuracy is not measured.</b> The sample clips are unlabelled and we have not
                annotated them, so there is no ground truth for{" "}
                <span className="num">evaluate.py</span> and therefore no Score&nbsp;A, Score&nbsp;B,
                per-class F1, AP or mTTA. We would rather publish that gap than a number we cannot
                stand behind.
              </p>
            </>
          ) : (
            <p>No processed sample in this checkout, so there is no runtime to report.</p>
          )}
        </Block>

        <Block n="6" title="What worked">
          <ul>
            <li>
              <b>Decoding reference frames only.</b> The camera&rsquo;s 15-frame GOP means{" "}
              <span className="num">skip_frame=NONREF</span> yields every third frame for about half
              the CPU. This single change is why Part&nbsp;A runs at a fraction of real time, and it
              bought the headroom that made a full-resolution detector affordable.
            </li>
            <li>
              <b>Scale-free thresholds.</b> Expressing every speed and distance in <em>object sizes</em>{" "}
              rather than pixels made one set of constants work at the top and bottom of a strongly
              perspective frame. Nothing else we tried survived the depth range.
            </li>
            <li>
              <b>Learning the flow field instead of drawing lanes.</b> Measuring the mean vehicle
              direction per 60&nbsp;px cell gave wrong-way and U-turn detection without hand-labelling
              a single lane, and it self-reports where it is unreliable.
            </li>
            <li>
              <b>Caching perception.</b> <span className="num">tools/cache_perception.py</span> plus{" "}
              <span className="num">tools/predict_cached.py</span> re-run every rule in seconds instead
              of re-decoding 4K, which is what made rule tuning practical at all.
            </li>
            <li>
              <b>Evidence from every rule.</b> Because each rule reports the tracks that triggered it,
              the annotated renders show exactly why a segment exists &mdash; the fastest debugging
              tool we built.
            </li>
          </ul>
        </Block>

        <Block n="7" title="What did not work">
          <ul>
            <li>
              <b>Brightness-based lamp reading.</b> In daylight the signal housing is brighter than the
              lit LED, so thresholding luminance detects the wrong thing. Only a per-channel colour
              contrast with a per-video sliding threshold was robust from noon to dusk.
            </li>
            <li>
              <b>A single early frame for alignment.</b> The lamp windows are ~12&nbsp;px wide and the
              camera can still settle after recording starts, so a homography from frame&nbsp;0 put the
              sampling windows off the lamps entirely. Generous crops scored after the final
              homography fixed it.
            </li>
            <li>
              <b>Naive same-class merging.</b> Unioning overlapping segments turned two consecutive
              stopped vehicles into one long event. The hand-over case in{" "}
              <span className="num">merge_segments</span> exists specifically for that.
            </li>
            <li>
              <b>Treating every person box as a pedestrian.</b> Drivers seen through windscreens and
              passengers produced constant phantom jaywalking until person boxes mostly inside a
              vehicle box were excluded.
            </li>
            <li>
              <b>Appearance-based classes.</b> We have no working approach for accident, near_miss,
              fire_smoke or road_obstacle, and shipped none rather than ship a guess.
            </li>
          </ul>
        </Block>

        <Block n="8" title="Limitations">
          <ul>
            <li>
              {14 - IMPLEMENTED_CLASSES.length} of 14 classes are never emitted. Each one that occurs in
              the hidden set is a zero in the Score&nbsp;A class average.
            </li>
            <li>
              No dev labels, so every threshold was chosen by eye on unlabelled footage. Some are
              probably mistuned and we cannot currently tell which.
            </li>
            <li>
              Part&nbsp;B has never been observed firing on a real collision, because none of the
              sample clips contains one. Its true-positive behaviour is untested.
            </li>
            <li>
              Everything geometric assumes this camera pose. The demo reports the SIFT inlier count so
              a failed alignment is visible rather than silent.
            </li>
            <li>
              A parked vehicle is indistinguishable from a stopped one to the current rule, which
              produces at least one clip-length false positive.
            </li>
          </ul>
        </Block>

        <Block n="9" title="What we would do next">
          <ol>
            <li>
              <b>Annotate the sample clips.</b> The tool is already built (
              <span className="num">tools/labeler/index.html</span>). Everything else is guesswork
              until Score&nbsp;A can be computed, and boundary tuning at IoU&nbsp;0.7 is where the
              cheapest points are.
            </li>
            <li>
              <b>A clip classifier for accident and near_miss.</b> Trained on DoTA or CCD, applied only
              to windows the risk model already flags, so the cost stays negligible.
            </li>
            <li>
              <b>A static-object mask</b> from the median background to separate parked vehicles from
              stopped ones.
            </li>
            <li>
              <b>Lane lines for the other approaches.</b> illegal_turn and solid_line_crossing only
              cover the east-bound approach, the one with drawn lane lines and a turn-permission table.
            </li>
            <li>
              <b>Accuracy ablations.</b> Detector size, frame stride and tracking are already ablated
              for cost and agreement (<span className="num">tools/ablation.py</span>, on the Extra credit
              page); which configuration is <em>more accurate</em> needs the labelled dev set first.
            </li>
          </ol>
        </Block>
      </article>

      <Section id="links" eyebrow="Links" title="Repository, weights, predictions">
        <ul className="space-y-2">
          {LINKS.map((l) => (
            <li key={l.label}>
              <a
                href={l.href}
                target="_blank"
                rel="noreferrer noopener"
                className="block rounded-lg border border-line bg-panel p-4 transition-colors hover:bg-panel2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{l.label}</span>
                  <span className="text-faint" aria-hidden="true">
                    &#8599;
                  </span>
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">{l.note}</p>
                <p className="num mt-1.5 break-all text-[11px] text-faint">{l.href}</p>
              </a>
            </li>
          ))}
        </ul>
      </Section>

      <Callout tone="note" title="Reproducing this">
        <p>
          <span className="num">pip install -r requirements.txt</span> then{" "}
          <span className="num">python run_submission.py --videos /data/test --out predictions.json</span>{" "}
          &mdash; the two commands from the task, unchanged. Seeds for{" "}
          <span className="num">random</span>, <span className="num">numpy</span> and{" "}
          <span className="num">torch</span> are fixed at import in{" "}
          <span className="num">solution.py</span>; the only non-determinism is cuDNN autotuning, which
          does not change detector output.
        </p>
        {manifest && (
          <p className="num mt-2 text-[11px] text-faint">
            Site data generated {manifest.generated_at} from commit {manifest.source_commit}.
            {manifest.events_refresh && ` Events refreshed ${manifest.events_refresh.at}: ${manifest.events_refresh.note}`}
          </p>
        )}
      </Callout>
    </div>
  );
}

function Block({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="scroll-mt-20">
      <h2 className="flex items-baseline gap-3 text-lg font-semibold tracking-tight">
        <span className="num text-sm text-accent">{n}</span>
        {title}
      </h2>
      <div className="report-body mt-3 space-y-3 text-[14px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}
