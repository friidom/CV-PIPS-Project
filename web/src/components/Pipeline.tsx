import { IMPLEMENTED_CLASSES } from "../lib/classes";
import { useReveal } from "../lib/hooks";
import { Tag } from "./ui";

export interface Stage {
  key: string;
  name: string;
  detail: string;
  kind: "learned" | "rule" | "post";
  source: string;
}

/** Part A, in the order a frame actually moves through src/traffic. */
export const PART_A: Stage[] = [
  {
    key: "decode",
    name: "Decode",
    detail: "PyAV, reference frames only — about every 3rd frame of a 15-frame GOP",
    kind: "post",
    source: "src/traffic/video.py",
  },
  {
    key: "detect",
    name: "Detect",
    detail: "YOLO11m TorchScript at 1280×736, batches of 16",
    kind: "learned",
    source: "src/traffic/perception.py",
  },
  {
    key: "track",
    name: "Track",
    detail: "Two-stage IoU association over a vectorised Kalman filter, gated by class group",
    kind: "rule",
    source: "src/traffic/tracker.py",
  },
  {
    key: "align",
    name: "Align",
    detail: "CLAHE + SIFT + MAGSAC homography onto the reference plate",
    kind: "rule",
    source: "src/traffic/scene.py",
  },
  {
    key: "signal",
    name: "Read signal",
    detail: "Lamp-pixel colour score with a sliding percentile threshold",
    kind: "rule",
    source: "src/traffic/signals.py",
  },
  {
    key: "rules",
    name: "Apply rules",
    detail: `${IMPLEMENTED_CLASSES.length} event rules over trajectories, geometry and signal phase`,
    kind: "rule",
    source: "src/traffic/events/",
  },
  {
    key: "segments",
    name: "Segment",
    detail: "Mask, merge and split into [start, end, label]",
    kind: "post",
    source: "src/traffic/intervals.py",
  },
];

/** Part B, which never looks forward in time. */
export const PART_B: Stage[] = [
  {
    key: "frame",
    name: "Frame in",
    detail: "Every frame, handed over one at a time by the harness",
    kind: "post",
    source: "run_submission.py",
  },
  {
    key: "detect-b",
    name: "Detect",
    detail: "YOLO11s at 960×544, every 5th frame, tracked online",
    kind: "learned",
    source: "src/traffic/risk.py",
  },
  {
    key: "cues",
    name: "Three cues",
    detail: "Constant-velocity TTC conflict, red-light runner, hard braking",
    kind: "rule",
    source: "src/traffic/risk.py",
  },
  {
    key: "fuse",
    name: "Fuse",
    detail: "Noisy-OR, then fast attack and slow decay",
    kind: "rule",
    source: "src/traffic/risk.py",
  },
  {
    key: "score",
    name: "Score out",
    detail: "One probability in 0…1, for this instant only",
    kind: "post",
    source: "solution.py",
  },
];

const KIND_LABEL = { learned: "learned", rule: "rule-based", post: "processing" } as const;

/**
 * The pipeline, lighting up stage by stage as it scrolls into view.
 *
 * The stagger is a CSS transition delay per stage rather than a chain of timers,
 * so scrolling straight past never leaves queued state updates behind.
 */
export function Pipeline({
  stages,
  title,
  dense = false,
}: {
  stages: Stage[];
  title?: string;
  dense?: boolean;
}) {
  const [ref, shown] = useReveal<HTMLDivElement>();

  return (
    <div ref={ref}>
      {title && (
        <div className="num mb-3 text-[11px] uppercase tracking-[0.14em] text-faint">{title}</div>
      )}
      <ol className="flex flex-col lg:flex-row lg:items-stretch">
        {stages.map((s, i) => (
          <li key={s.key} className="flex min-w-0 flex-1 flex-row items-stretch lg:flex-col">
            <Connector on={shown} delay={i * 130} first={i === 0} last={i === stages.length - 1} />
            <div
              className="group relative min-w-0 flex-1 rounded-lg border bg-panel p-3 transition-all duration-500"
              style={{
                transitionDelay: `${i * 130}ms`,
                opacity: shown ? 1 : 0.25,
                transform: shown ? "none" : "translateY(8px)",
                borderColor: shown ? "var(--line)" : "var(--line-soft)",
              }}
            >
              <div className="flex items-baseline gap-2">
                <span className="num text-[10px] text-faint">{String(i + 1).padStart(2, "0")}</span>
                <span className="text-[13px] font-medium leading-tight">{s.name}</span>
              </div>
              {!dense && <p className="mt-1.5 text-[11px] leading-snug text-muted">{s.detail}</p>}
              <div className="mt-2.5">
                <Tag tone={s.kind}>{KIND_LABEL[s.kind]}</Tag>
              </div>
              <div className="num mt-1.5 truncate text-[9px] text-faint opacity-0 transition-opacity group-hover:opacity-100">
                {s.source}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The rail between stages: vertical in the mobile column, horizontal on desktop. */
function Connector({
  on,
  delay,
  first,
  last,
}: {
  on: boolean;
  delay: number;
  first: boolean;
  last: boolean;
}) {
  const dot = (
    <span
      className="shrink-0 rounded-full transition-all duration-500"
      style={{
        width: 6,
        height: 6,
        background: on ? "var(--cyan)" : "var(--line)",
        transitionDelay: `${delay}ms`,
        boxShadow: on ? "0 0 8px color-mix(in srgb, var(--cyan) 70%, transparent)" : "none",
      }}
    />
  );

  return (
    <>
      <div className="flex w-8 shrink-0 flex-col items-center lg:hidden">
        <span
          className="w-px flex-1 bg-line transition-opacity duration-500"
          style={{ opacity: first ? 0 : on ? 1 : 0.2, transitionDelay: `${delay}ms` }}
        />
        <span className="my-1">{dot}</span>
        <span
          className="w-px flex-1 bg-line transition-opacity duration-500"
          style={{ opacity: last ? 0 : on ? 1 : 0.2, transitionDelay: `${delay}ms` }}
        />
      </div>

      <div className="hidden h-6 w-full items-center lg:flex">
        <span
          className="h-px flex-1 bg-line transition-opacity duration-500"
          style={{ opacity: first ? 0 : on ? 1 : 0.2, transitionDelay: `${delay}ms` }}
        />
        <span className="mx-1">{dot}</span>
        <span
          className="relative h-px flex-1 overflow-hidden bg-line"
          style={{ opacity: last ? 0 : 1 }}
        >
          {on && !last && (
            <span
              className="anim-sweep absolute inset-y-0 w-10"
              style={{
                background: "linear-gradient(90deg, transparent, var(--cyan), transparent)",
                animationDelay: `${delay}ms`,
              }}
            />
          )}
        </span>
      </div>
    </>
  );
}
