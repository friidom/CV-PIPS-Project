import { useState } from "react";
import { PART_A as FLOW_A, PART_B as FLOW_B, Pipeline } from "../components/Pipeline";
import { Callout, Panel, Section, Tag } from "../components/ui";
import { IMPLEMENTED_CLASSES } from "../lib/classes";

type Kind = "learned" | "rule" | "post";

interface Stage {
  id: string;
  name: string;
  kind: Kind;
  one_line: string;
  detail: string;
  source: string;
}

const PART_A: Stage[] = [
  {
    id: "decode",
    name: "Sampled decode",
    kind: "post",
    one_line: "Reference frames only, three threads",
    detail:
      "PyAV with skip_frame=NONREF. The camera's 15-frame GOP means that yields every third frame (~10 fps) for about half the CPU of a full decode. The file is split into three contiguous parts decoded concurrently, and corrupt packets are skipped rather than ending the read. A deadline is computed up front from a measured decode rate so Part A always leaves the harness enough time to stream every frame through Part B.",
    source: "src/traffic/video.py, src/traffic/perception.py",
  },
  {
    id: "detect",
    name: "Object detection",
    kind: "learned",
    one_line: "YOLO11m, COCO weights, TorchScript",
    detail:
      "The only learned component in Part A. Exported to a fixed 1280×736 batch-16 graph so evaluation needs plain PyTorch, not ultralytics. Frames are resized, padded and normalised on the GPU; decoding and NMS run in torchvision. Kept classes: person, bicycle, car, motorcycle, bus, truck, plus the COCO animals as road-obstacle candidates.",
    source: "src/traffic/detector.py, tools/export_weights.py",
  },
  {
    id: "track",
    name: "Multi-object tracking",
    kind: "rule",
    one_line: "ByteTrack-style two-stage IoU over a Kalman filter",
    detail:
      "Constant-velocity Kalman filter on (cx, cy, w, h), vectorised in numpy, with Hungarian assignment. Detections only associate within a class group — people, motor vehicles, two-wheelers, animals — so a pedestrian box can never take over a car track. car/bus/truck flips inside the vehicle group are tolerated and settled by a confidence-weighted majority vote per track.",
    source: "src/traffic/tracker.py, src/traffic/tracks.py",
  },
  {
    id: "align",
    name: "Scene alignment",
    kind: "rule",
    one_line: "SIFT homography onto a shared reference frame",
    detail:
      "The camera is fixed but framing differs slightly between recordings. A median background of twelve frames spread through the clip is matched to configs/reference.jpg with CLAHE + SIFT + MAGSAC. Under 40 inliers the homography falls back to identity, which the live demo reports rather than hides. Every trajectory is then expressed in reference pixels, so one set of polygons serves every video.",
    source: "src/traffic/scene.py",
  },
  {
    id: "phase",
    name: "Signal phase",
    kind: "rule",
    one_line: "Colour score of the lamp pixels, thresholded per video",
    detail:
      "Two heads face the camera. Each lamp window is summarised by how red or green its brightest pixels are, then thresholded halfway between the 15th and 85th percentile of a sliding ~90 s window so the level tracks exposure drift. Flashing green and the amber transition are recovered from the run structure; when the vehicle head is unreadable the pedestrian head is used as a fallback that can only say 'not green'.",
    source: "src/traffic/signals.py",
  },
  {
    id: "rules",
    name: "Event rules",
    kind: "rule",
    one_line: `${IMPLEMENTED_CLASSES.length} classes from trajectories, geometry and phase`,
    detail:
      "Each rule turns per-sample predicates into time segments. Thresholds are scale-free — speeds in object sizes per second, distances against the road distance transform or in a pedestrian's own body height, lane positions from the lane lines' vanishing point — so they hold at the top and bottom of a perspective frame. Every rule can also emit Evidence (the raw segment, the track ids, a note), which is what tools/render_video.py draws on the annotated clips.",
    source: "src/traffic/events/",
  },
  {
    id: "post",
    name: "Temporal post-processing",
    kind: "post",
    one_line: "Merge fragments, bridge gaps, split hand-overs",
    detail:
      "mask_segments turns a boolean mask into runs, bridging detector dropouts up to a per-rule gap and dropping anything shorter than a minimum length. merge_segments then unions overlapping segments of the same class — required, since the harness silently drops same-class overlaps — with a hand-over case: when one segment overlaps the previous by a hair and outlasts it, the earlier one is cut rather than swallowed, keeping two separate stopped vehicles as two events.",
    source: "src/traffic/intervals.py",
  },
];

const PART_B: Stage[] = [
  {
    id: "b-detect",
    name: "Online detection",
    kind: "learned",
    one_line: "YOLO11s at 960×544, every 5th frame",
    detail:
      "A smaller graph than Part A because step() is called for every frame. Frames in between repeat the previous score, which the task explicitly permits. The estimator never opens the video file — it only ever sees the frame it was handed.",
    source: "src/traffic/risk.py",
  },
  {
    id: "b-track",
    name: "Causal tracking",
    kind: "rule",
    one_line: "The same tracker, fed online",
    detail:
      "Positions are mapped to the reference frame through a homography estimated from the first processed frame and re-estimated at 10 s and 60 s, since the camera can still settle just after recording starts. A 1.5 s ring buffer per track gives velocity and deceleration.",
    source: "src/traffic/risk.py",
  },
  {
    id: "b-cues",
    name: "Danger cues",
    kind: "rule",
    one_line: "Conflict, red-runner, hard braking",
    detail:
      "Conflict: constant-velocity extrapolation of every pair on the carriageway gives time to closest approach and the miss distance in object sizes; only genuine near-misses inside a 2 s horizon with a fast closing speed count. Red-runner: a vehicle crossing the stop line at speed while the phase is red. Braking: a speed drop over ~3 object sizes per second per second, capped at 0.3 because drivers brake hard for every red light here.",
    source: "src/traffic/risk.py",
  },
  {
    id: "b-fuse",
    name: "Fusion and smoothing",
    kind: "post",
    one_line: "Noisy-OR, fast attack, slow decay",
    detail:
      "Cues combine as 1 − ∏(1 − cᵢ). The output rises instantly and decays with about a one-second half-life, so a warning persists briefly after the cue disappears — which is what the alarm metric rewards, since an alarm is a run of frames above θ = 0.5 and runs closer than 2 s merge into one.",
    source: "src/traffic/risk.py",
  },
];

const KIND_LABEL: Record<Kind, string> = {
  learned: "learned",
  rule: "rule-based",
  post: "processing",
};

function StageList({ stages, open, setOpen }: { stages: Stage[]; open: string | null; setOpen: (id: string | null) => void }) {
  return (
    <ol className="space-y-2">
      {stages.map((s, i) => {
        const isOpen = open === s.id;
        return (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : s.id)}
              aria-expanded={isOpen}
              className={`w-full rounded-lg border p-4 text-left transition-colors ${
                isOpen ? "border-accent bg-panel2" : "border-line bg-panel hover:bg-panel2"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="num grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line text-[11px] text-faint">
                  {i + 1}
                </span>
                <span className="text-sm font-medium">{s.name}</span>
                <Tag tone={s.kind}>{KIND_LABEL[s.kind]}</Tag>
                <span className="ml-auto text-faint" aria-hidden="true">
                  {isOpen ? "\u2212" : "+"}
                </span>
              </div>
              <p className="mt-1.5 pl-[34px] text-[13px] text-muted">{s.one_line}</p>
              {isOpen && (
                <div className="mt-3 pl-[34px]">
                  <p className="max-w-[80ch] text-[13px] leading-relaxed text-text">{s.detail}</p>
                  <p className="num mt-2.5 text-[11px] text-faint">{s.source}</p>
                </div>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export default function Approach() {
  const [open, setOpen] = useState<string | null>("detect");

  return (
    <div className="mx-auto max-w-[1320px] space-y-14 px-4 py-10 sm:py-14">
      <Section
        eyebrow="Problem and approach"
        title="One learned component, everything else explainable"
        lead={
          <>
            The task is to turn a fixed CCTV view into <span className="num">[start_sec, end_sec, label]</span>{" "}
            segments, and to raise an alarm before a collision. We chose to learn only the hardest part
            &mdash; finding road users &mdash; and to derive the events from geometry and kinematics.
            That keeps every detection traceable to a specific condition, and keeps the whole clip far
            inside the 3&times; time budget.
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Panel className="p-5">
            <Tag tone="learned">learned</Tag>
            <h3 className="mt-2.5 text-sm font-semibold">Object detection only</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              Two COCO-pretrained YOLO11 graphs, used off the shelf. No fine-tuning, no external
              dataset, no video classifier.
            </p>
          </Panel>
          <Panel className="p-5">
            <Tag tone="rule">rule-based</Tag>
            <h3 className="mt-2.5 text-sm font-semibold">Tracking, geometry, phase, events</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              Kalman tracking, the SIFT homography, the lamp reader and all {IMPLEMENTED_CLASSES.length} event
              rules are deterministic code with thresholds you can read.
            </p>
          </Panel>
          <Panel className="p-5">
            <Tag tone="post">processing</Tag>
            <h3 className="mt-2.5 text-sm font-semibold">Segment shaping</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              Fragment merging, blip removal and hand-over splitting. Boundaries are what the metric
              measures, so this stage is not cosmetic.
            </p>
          </Panel>
        </div>
      </Section>

      <Section eyebrow="Part A" title="From pixels to event segments">
        <Pipeline stages={FLOW_A} title="the chain, end to end" />
        <div className="mt-6">
          <StageList stages={PART_A} open={open} setOpen={setOpen} />
        </div>
      </Section>

      <Section
        eyebrow="Part B"
        title="Causal accident anticipation"
        lead="A separate pass that sees frames one at a time and nothing else. It shares the tracker and the scene, but never Part A's output — reusing a result computed with future frames would break causality and the rules."
      >
        <Pipeline stages={FLOW_B} title="one frame in, one score out" />
        <div className="mt-6">
          <StageList stages={PART_B} open={open} setOpen={setOpen} />
        </div>
      </Section>

      <Section eyebrow="Why this shape" title="The trade we made">
        <div className="grid gap-4 md:grid-cols-2">
          <Callout tone="good" title="What it buys">
            Every event has a reason: the annotated renders draw the exact tracks that triggered each
            rule. Tuning is immediate — <span className="num">tools/predict_cached.py</span> re-runs
            all rules on cached perception in seconds instead of re-decoding 4K. And with no training
            loop there is nothing to overfit to four unlabelled clips.
          </Callout>
          <Callout tone="warn" title="What it costs">
            Classes that are appearance problems rather than geometry problems get nothing:{" "}
            <span className="num">accident</span>, <span className="num">near_miss</span>,{" "}
            <span className="num">fire_smoke</span>, <span className="num">road_obstacle</span>. A
            learned clip classifier is the obvious next step, and the risk model already computes the
            conflict and braking cues it would need.
          </Callout>
        </div>
      </Section>

      <Callout tone="note" title="Rules compliance">
        Open weights only: both detectors are COCO-pretrained YOLO11 exported to TorchScript and
        committed in <span className="num">weights/</span> (119&nbsp;MB total, against a 5&nbsp;GB
        limit). No hosted model is called at any stage of inference, no external dataset was used for
        training, and seeds are fixed in <span className="num">solution.py</span>.
      </Callout>
    </div>
  );
}
