import { useEffect, useState } from "react";
import { FlowFieldMap } from "../components/FlowFieldMap";
import { SceneMap } from "../components/SceneMap";
import { BarList, Histogram, PhaseRibbon, StackedArea } from "../components/charts";
import { Callout, DataGap, Panel, Section, Stat } from "../components/ui";
import { loadData } from "../lib/api";
import { group } from "../lib/format";
import type { DensitySeries, FlowFieldData, PhaseSeries, SampleData, SceneData } from "../lib/types";

const BASE = import.meta.env.BASE_URL;

interface DetectorStats {
  total: number;
  by_class: Record<string, number>;
  confidence: { counts: number[]; edges: number[] };
  box_width_px: { counts: number[]; edges: number[] };
  conf_threshold: number;
  median_width_px: number;
}

/** Each finding states what was observed and which code it changed. */
function Finding({ observation, changed }: { observation: string; changed: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-line bg-panel2 p-4">
      <div className="num text-[10px] uppercase tracking-[0.14em] text-accent">What we saw</div>
      <p className="mt-1.5 text-sm leading-relaxed text-text">{observation}</p>
      <div className="num mt-3 text-[10px] uppercase tracking-[0.14em] text-accent">What it changed</div>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{changed}</p>
    </div>
  );
}

const CLIPS = ["C3896", "C3897", "C3902", "C3905"];

export default function Eda() {
  const [scene, setScene] = useState<SceneData | null>(null);
  const [flow, setFlow] = useState<FlowFieldData | null>(null);
  const [density, setDensity] = useState<DensitySeries | null>(null);
  const [phase, setPhase] = useState<PhaseSeries | null>(null);
  const [detector, setDetector] = useState<DetectorStats | null>(null);
  const [sample, setSample] = useState<SampleData | null>(null);
  const [clip, setClip] = useState("C3905");

  useEffect(() => {
    const ac = new AbortController();
    void loadData<SceneData>("eda/scene.json", ac.signal).then(setScene);
    void loadData<FlowFieldData>("eda/flow-field.json", ac.signal).then(setFlow);
    return () => ac.abort();
  }, []);

  // The time-resolved charts are per clip; the scene and the flow field are not.
  useEffect(() => {
    const ac = new AbortController();
    setDensity(null);
    setPhase(null);
    setDetector(null);
    void loadData<DensitySeries>(`eda/density-${clip}.json`, ac.signal).then(setDensity);
    void loadData<PhaseSeries>(`eda/phase-${clip}.json`, ac.signal).then(setPhase);
    void loadData<DetectorStats>(`eda/detector-${clip}.json`, ac.signal).then(setDetector);
    void loadData<SampleData>(`samples/${clip}.json`, ac.signal).then(setSample);
    return () => ac.abort();
  }, [clip]);

  const duration = sample?.meta.duration ?? 127.6;
  const clipPicker = (
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
  );

  return (
    <div className="mx-auto max-w-[1320px] space-y-16 px-4 py-10 sm:py-14">
      <Section
        eyebrow="EDA"
        title="What the footage is, and what it forced us to build"
        lead="The camera is fixed, 4K, 29.97 fps, 10-bit 4:2:2 H.264. Nothing below is a generic chart: each one records something we measured in the clips and the design decision it produced."
      />

      <Section eyebrow="01 — Recording format" title="4K at 29.97 fps, with a 15-frame GOP">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat value="3840×2160" label="Resolution" hint="every sample and the hidden test set" />
          <Stat value="29.97" label="Frames per second" hint="30000/1001, not 25" />
          <Stat value="10-bit 4:2:2" label="H.264 profile" hint="High 4:2:2 — not browser-playable" />
          <Stat
            value={density ? group(density.sampled_frames) : "—"}
            label="Frames actually decoded"
            hint="of ~3 825 in the 127 s clip"
          />
        </div>
        <Finding
          observation="The GOP is I B B P B B P… so only every third frame is a reference frame. Asking the decoder to skip non-reference frames yields ~10 fps of usable frames at roughly half the CPU of a full decode. Some sample files also contain zero-filled holes that abort a naive read."
          changed={
            <>
              <span className="num">src/traffic/video.py</span> sets{" "}
              <span className="num">skip_frame=&quot;NONREF&quot;</span> and swallows{" "}
              <span className="num">InvalidDataError</span> per packet instead of ending the stream,
              and <span className="num">perception.py</span> splits the file across three decoder
              threads. That single decision is why Part A finishes in{" "}
              <span className="num">
                {sample?.runtime ? (sample.runtime.part_a_sec / sample.runtime.duration).toFixed(2) : "0.18"}×
              </span>{" "}
              real time rather than hitting the budget.
            </>
          }
        />
      </Section>

      <Section
        eyebrow="02 — Scene geometry"
        title="The intersection, drawn once"
        lead="Every geometric rule is expressed against this reference frame: the median background of C3896 at 1920×1080. Per-video differences in framing are absorbed by a SIFT homography, so the polygons only had to be drawn once."
      >
        {scene ? (
          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <SceneMap scene={scene} base={BASE} />
            <div>
              <div className="grid grid-cols-2 gap-3">
                <Stat value={scene.crosswalks.length} label="Crossings" />
                <Stat value={scene.zones.length} label="Direction zones" />
                <Stat value={scene.islands.length} label="Islands" />
                <Stat value={scene.signals.reduce((n, s) => n + s.lamps.length, 0)} label="Lamp windows" />
              </div>
              <Finding
                observation="One east-bound stop line, three painted crossings, four traffic islands and two sidewalk regions. The carriageway is everything left after the sidewalks and islands are cut out — and the lamp windows are only about 12 px wide in the reference frame."
                changed={
                  <>
                    <span className="num">SceneMasks</span> rasterises the polygons once into distance
                    transforms, so a rule asks &ldquo;how far into the road is this foot point?&rdquo;
                    in O(1). Because the lamp windows are smaller than the alignment error of a single
                    early frame, <span className="num">LampCrops</span> stores a generous crop per
                    frame and only scores the exact pixels after the final homography is known.
                  </>
                }
              />
            </div>
          </div>
        ) : (
          <DataGap title="Scene geometry" what="configs/scene.json was not found in this checkout." />
        )}
      </Section>

      <Section
        eyebrow="03 — Traffic flow"
        title="Which way each lane actually runs"
        lead="Nobody labelled the lane directions. They were measured: every moving vehicle in all four sample clips contributes its unit velocity to a 60 px cell, and the length of the mean vector says how strongly that cell agrees with itself."
      >
        {flow ? (
          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <FlowFieldMap flow={flow} base={BASE} />
            <div>
              <div className="grid grid-cols-2 gap-3">
                <Stat value={group(flow.total_samples)} label="Motion samples" hint="moving vehicles, 4 clips" />
                <Stat value={flow.cells_with_data} label="Cells with data" hint={`of ${18 * 32} in the grid`} />
                <Stat value={flow.cells_one_way} label="Reliably one-way" tone="accent" hint={`consistency ≥ ${flow.min_consistency}, ≥ ${flow.min_count} samples`} />
                <Stat
                  value={`${((flow.cells_one_way / Math.max(flow.cells_with_data, 1)) * 100).toFixed(0)}%`}
                  label="Of observed cells"
                  hint="the rest are junction interiors and turn paths"
                />
              </div>
              <Finding
                observation={`Only ${flow.cells_one_way} of ${flow.cells_with_data} observed cells are consistently one-way. The rest sit in the junction itself or on turn paths, where vehicles legitimately travel in several directions.`}
                changed={
                  <>
                    <span className="num">wrong_way</span> only fires where the cell is one-way (
                    <span className="num">consistency ≥ {flow.min_consistency}</span>,{" "}
                    <span className="num">≥ {flow.min_count} samples</span>) and requires the vehicle to
                    oppose the flow across at least three such cells for two seconds. Without that gate
                    every turning car at the junction would be a wrong-way event.
                  </>
                }
              />
            </div>
          </div>
        ) : (
          <DataGap title="Flow field" what="configs/flow_field.npz was not found." fill="Rebuild it with tools/build_flow_field.py." />
        )}
      </Section>

      <Section
        eyebrow="04 — Signal cycle"
        title="Reading the phase off the lamp pixels"
        lead="There is no signal feed, only two heads facing the camera. The phase is recovered from how red or green the brightest pixels in each lamp window are, with a threshold fitted per video."
      >
        {phase && phase.cycles.length > 0 ? (
          <>
            <Panel className="p-4">
              <PhaseRibbon cycles={phase.cycles} duration={duration} />
            </Panel>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                value={phase.cycle_periods.length ? `${phase.cycle_periods[0]}s` : "—"}
                label="Cycle period"
                hint="red onset to red onset"
              />
              <Stat value={`${phase.seconds_by_phase.red}s`} label="Red" tone="bad" />
              <Stat value={`${phase.seconds_by_phase.green}s`} label="Green" tone="ok" />
              <Stat
                value={`${phase.seconds_by_phase.unknown}s`}
                label="Unreadable"
                hint="fallback to the pedestrian head"
              />
            </div>
            <Finding
              observation={`One full cycle lasts ${phase.cycle_periods[0] ?? 75}s on this approach, and every lamp is dark for well over half of it. In daylight the lamp housing is brighter than the lit LED, so raw brightness does not separate on from off.`}
              changed={
                <>
                  <span className="num">signals.py</span> scores each lamp as{" "}
                  <span className="num">R − max(G,B)</span> (or <span className="num">G − R</span>) over
                  its brightest pixels, then thresholds halfway between the 15th and 85th percentile of
                  a ~90&nbsp;s sliding window &mdash; long enough to contain both states, short enough to
                  follow the exposure drifting toward dusk. Flashing green and the amber transition are
                  reconstructed from the run structure rather than being misread as red.
                </>
              }
            />
          </>
        ) : (
          <DataGap title="Signal phase" what="No cached perception to read lamp scores from." fill="Run tools/cache_perception.py --videos samples." />
        )}
      </Section>

      <Section
        eyebrow="05 — Traffic over time"
        title="Who is in frame, second by second"
        lead="Counts are per sampled frame, averaged within each second — so the vertical axis is 'road users visible at once', not a cumulative total."
      >
        {clipPicker}
        {density ? (
          <>
            <Panel className="p-4">
              <StackedArea
                t={density.t}
                series={[
                  { key: "vehicle", label: "Vehicles", color: "#40a9ff", values: density.vehicle },
                  { key: "person", label: "People", color: "#36cfc9", values: density.person },
                  { key: "two_wheeler", label: "Two-wheelers", color: "#73d13d", values: density.two_wheeler },
                ]}
                height={190}
              />
            </Panel>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat value={group(density.total_boxes)} label="Detections" hint={`over ${group(density.sampled_frames)} sampled frames`} />
              <Stat value={group(density.total_tracks)} label="Tracks formed" />
              <Stat
                value={(density.total_boxes / Math.max(density.sampled_frames, 1)).toFixed(1)}
                label="Objects per frame"
                hint="mean across the clip"
              />
              <Stat
                value={Math.max(...density.vehicle.map((v, i) => v + density.person[i] + density.two_wheeler[i])).toFixed(0)}
                label="Busiest second"
                hint="peak simultaneous road users"
              />
            </div>
            <Finding
              observation="Pedestrian counts spike in a regular rhythm that lines up with the signal cycle, and vehicle counts collapse and rebuild across the same period. People routinely outnumber vehicles in this view."
              changed={
                <>
                  Because people are this common, a person box overlapping a vehicle box is a driver or
                  passenger far more often than a pedestrian.{" "}
                  <span className="num">EventContext.covered_by_vehicle</span> drops any person whose box
                  is over half inside a vehicle, and <span className="num">jaywalking</span> additionally
                  requires a plausible walking speed &mdash; without both, every windscreen in the queue
                  became a jaywalker.
                </>
              }
            />
          </>
        ) : (
          <DataGap title="Object counts over time" what={`No cached perception for ${clip} in this checkout.`} fill="Run tools/cache_perception.py --videos samples." />
        )}
      </Section>

      <Section
        eyebrow="06 — Detector behaviour"
        title="What the detector sees, and how big it is"
        lead="COCO-pretrained YOLO11m at 1280×736, confidence floor 0.15. Two distributions decided how the rules normalise distance and speed."
      >
        {detector ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <Panel className="p-4">
                <h3 className="mb-3 text-sm font-semibold">Detections by COCO class</h3>
                <BarList
                  bars={Object.entries(detector.by_class)
                    .sort((a, b) => b[1] - a[1])
                    .map(([label, value]) => ({ label, value, color: "var(--accent)" }))}
                />
              </Panel>
              <Panel className="mt-3 p-4">
                <h3 className="mb-1 text-sm font-semibold">Confidence distribution</h3>
                <p className="mb-2 text-[11px] text-faint">
                  Threshold {detector.conf_threshold} — deliberately low, the tracker filters the rest.
                </p>
                <Histogram counts={detector.confidence.counts} edges={detector.confidence.edges} color="#40a9ff" />
              </Panel>
            </div>
            <div>
              <Panel className="p-4">
                <h3 className="mb-1 text-sm font-semibold">Box width in reference pixels</h3>
                <p className="mb-2 text-[11px] text-faint">
                  Median {detector.median_width_px} px. Perspective makes far vehicles a fraction of near ones.
                </p>
                <Histogram counts={detector.box_width_px.counts} edges={detector.box_width_px.edges} color="#73d13d" />
              </Panel>
              <Finding
                observation={`Box widths span more than an order of magnitude across the frame, and the confidence histogram has a long low tail — most of it far-away objects only a few dozen pixels wide.`}
                changed={
                  <>
                    Every threshold in the rules is expressed in <em>object sizes per second</em> rather
                    than pixels: <span className="num">Trajectory.rel_speed()</span> divides velocity by
                    box width (height for people), so &ldquo;stationary&rdquo; and &ldquo;crawling&rdquo;
                    mean the same thing at the top and bottom of the frame. The heading tests additionally
                    ignore tracks under 50&nbsp;px wide, whose direction is too noisy to trust.
                  </>
                }
              />
            </div>
          </div>
        ) : (
          <DataGap title="Detector statistics" what="No cached perception to summarise." />
        )}
      </Section>

      <Callout tone="note" title="Scope of this analysis">
        The scene geometry and the flow field are built from all four sample clips together.
        Everything time-resolved on this page is one clip at a time — pick it above; the charts come
        from that clip&rsquo;s own perception cache.
      </Callout>
    </div>
  );
}
