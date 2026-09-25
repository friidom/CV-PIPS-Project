import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { EventInspector } from "../components/EventInspector";
import { EventTimeline } from "../components/EventTimeline";
import { LiveMode } from "../components/LiveMode";
import { RiskCurve } from "../components/RiskCurve";
import { TrafficMonitor } from "../components/TrafficMonitor";
import { VideoStage } from "../components/VideoStage";
import { Callout, Panel, Section, Spinner, Stat } from "../components/ui";
import { ApiError, api, cancelJob, getCapabilities, getJob, streamJob, submitVideo } from "../lib/api";
import { factsFromOverlay } from "../lib/events";
import { bytes, duration as fmtDuration } from "../lib/format";
import { PlaybackProvider } from "../lib/playback";
import type { JobProgress, JobResult, ServerCapabilities } from "../lib/types";

type Phase = "idle" | "uploading" | "running" | "done" | "error";

const STAGE_LABEL: Record<string, string> = {
  queued: "Queued",
  probing: "Reading the file",
  perception: "Detecting road users",
  tracking: "Building tracks",
  rules: "Applying event rules",
  risk: "Estimating accident risk",
  encoding: "Preparing playback",
  done: "Complete",
};

function isResult(j: JobProgress | JobResult | null): j is JobResult {
  return !!j && "events" in j && "meta" in j;
}

export default function Demo() {
  const [caps, setCaps] = useState<ServerCapabilities | null>(null);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [job, setJob] = useState<JobProgress | JobResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  // /demo#live opens straight into live mode; switching modes leaves an upload's result intact.
  const { hash } = useLocation();
  const [mode, setMode] = useState<"upload" | "live">(hash === "#live" ? "live" : "upload");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    getCapabilities(ac.signal)
      .then(setCaps)
      .catch((e: Error) => {
        if (e.name !== "AbortError") setCapsError(e.message);
      });
    return () => ac.abort();
  }, []);

  useEffect(() => () => cleanup.current?.(), []);

  const result = isResult(job) && job.stage === "done" ? job : null;

  useEffect(() => {
    if (result) setVisible(new Set(result.events.map((e) => e[2])));
  }, [result]);

  // Which tracks each rule fired on, read from this upload's own overlay.
  const facts = useMemo(
    () => (result?.overlay ? factsFromOverlay(result.overlay, result.events) : null),
    [result],
  );

  const maxMb = caps ? Math.round(caps.max_upload_bytes / (1024 * 1024)) : 200;
  const maxSec = caps?.max_duration_sec ?? 120;

  const start = useCallback(
    async (file: File) => {
      setError(null);
      setJob(null);

      if (!/\.mp4$/i.test(file.name)) {
        setError("Only .mp4 files are accepted.");
        setPhase("error");
        return;
      }
      if (caps && file.size > caps.max_upload_bytes) {
        setError(`${file.name} is ${bytes(file.size)}; the limit is ${maxMb} MB.`);
        setPhase("error");
        return;
      }

      setPhase("uploading");
      let id: string;
      try {
        ({ id } = await submitVideo(file));
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Could not reach the inference server.");
        setPhase("error");
        return;
      }

      setPhase("running");
      // SSE is the primary channel; a slow poll covers proxies that buffer it.
      const stop = streamJob(
        id,
        (update) => {
          setJob(update);
          if (update.stage === "done") setPhase("done");
          if (update.stage === "error") {
            setError(update.message);
            setPhase("error");
          }
        },
        () => undefined,
      );
      const poll = window.setInterval(async () => {
        try {
          const update = await getJob(id);
          setJob((prev) => (prev && prev.stage === "done" ? prev : update));
          if (update.stage === "done") {
            setPhase("done");
            window.clearInterval(poll);
          } else if (update.stage === "error") {
            setError(update.message);
            setPhase("error");
            window.clearInterval(poll);
          }
        } catch {
          /* transient: the next tick retries */
        }
      }, 2500);
      cleanup.current = () => {
        stop();
        window.clearInterval(poll);
      };
    },
    [caps, maxMb],
  );

  const resetRun = () => {
    cleanup.current?.();
    if (job) void cancelJob(job.id);
    setJob(null);
    setPhase("idle");
    setError(null);
  };

  const toggleClass = (id: string) =>
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const timings = result?.timings as (JobResult["timings"] & { budget_sec?: number }) | undefined;
  const budget = timings?.budget_sec ?? (result ? result.meta.duration * 3 : 0);
  const stats = (result as unknown as { stats?: Record<string, number> })?.stats;

  return (
    // Keyed by job, so a new result never inherits the previous one's selection or clock.
    <PlaybackProvider key={result?.id ?? "idle"}>
      <div className="mx-auto max-w-[1320px] px-4 py-10 sm:py-14">
        <Section
          eyebrow="Live demo"
          title={mode === "live" ? "Detection and tracking on a live feed" : "Upload a clip, get its events back"}
          lead={
            mode === "live" ? (
              <>
                The causal, per-frame half of the system on frames streamed from your webcam or from a
                sample clip played in real time: the YOLO11s detector the risk model uses and the same
                online tracker, answered frame by frame with the measured latency.
              </>
            ) : (
              <>
                The same code the submission runs: one sampled decoding pass through YOLO11m, a
                ByteTrack-style tracker, scene alignment and the event rules, then a second causal pass
                for the accident-risk curve. Nothing is pre-computed &mdash; every number on this page
                comes from the file you hand it.
              </>
            )
          }
        />

        <div id="live" role="tablist" aria-label="Demo mode" className="mt-7 inline-flex scroll-mt-24 overflow-hidden rounded-md border border-line">
          {(
            [
              ["upload", "Upload a clip"],
              ["live", "Live camera / stream"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`px-3.5 py-1.5 text-xs transition-colors ${mode === m ? "bg-panel2 text-text" : "text-muted hover:text-text"}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
          <div className="min-w-0 space-y-4">
            {mode === "live" ? (
              <LiveMode />
            ) : (
              <>
              {(phase === "idle" || phase === "error") && (
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) void start(f);
                  }}
                  className={`grid-bg flex min-h-[320px] flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
                    dragging ? "border-accent bg-panel2" : "border-line bg-panel"
                  }`}
                >
                  <UploadMark />
                  <h2 className="mt-4 text-lg font-semibold">Drop an .mp4 here</h2>
                  <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted">
                    Up to <span className="num">{maxMb}&nbsp;MB</span> and{" "}
                    <span className="num">{Math.round(maxSec)}&nbsp;seconds</span>. Footage from this
                    fixed camera gives the most meaningful result &mdash; the geometric rules are tied
                    to its scene layout.
                  </p>
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    className="mt-5 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accentink transition-opacity hover:opacity-90"
                  >
                    Choose a file
                  </button>
                  <input
                    ref={inputRef}
                    type="file"
                    accept="video/mp4,.mp4"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void start(f);
                      e.target.value = "";
                    }}
                  />
                  {error && (
                    <p className="mt-5 max-w-md rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
                      {error}
                    </p>
                  )}
                </div>
              )}

              {(phase === "uploading" || phase === "running") && (
                <Panel className="p-6">
                  <div className="flex items-center justify-between gap-4">
                    <Spinner
                      label={
                        phase === "uploading" ? "Uploading…" : STAGE_LABEL[job?.stage ?? "queued"] ?? "Working"
                      }
                    />
                    <button
                      type="button"
                      onClick={resetRun}
                      className="rounded border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:text-text"
                    >
                      Cancel
                    </button>
                  </div>

                  <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-panel2">
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-300"
                      style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }}
                    />
                  </div>

                  <p className="num mt-3 text-xs text-muted">{job?.message ?? "Preparing the upload"}</p>

                  <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <MiniStat label="Progress" value={`${Math.round((job?.progress ?? 0) * 100)}%`} />
                    <MiniStat label="Elapsed" value={`${(job?.elapsed_sec ?? 0).toFixed(0)}s`} />
                    <MiniStat label="Frames" value={(job?.frames_processed ?? 0).toLocaleString()} />
                    <MiniStat label="Detections" value={(job?.detections ?? 0).toLocaleString()} />
                  </div>

                  <ol className="mt-5 space-y-1.5 text-xs">
                    {["perception", "tracking", "rules", "risk", "encoding"].map((s) => {
                      const order = ["queued", "probing", "perception", "tracking", "rules", "risk", "encoding", "done"];
                      const now = order.indexOf(job?.stage ?? "queued");
                      const mine = order.indexOf(s);
                      const state = now > mine ? "done" : now === mine ? "active" : "todo";
                      return (
                        <li key={s} className="flex items-center gap-2.5">
                          <span
                            className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[9px] ${
                              state === "done"
                                ? "border-ok bg-ok text-ink"
                                : state === "active"
                                  ? "border-accent text-accent"
                                  : "border-line text-faint"
                            }`}
                          >
                            {state === "done" ? "\u2713" : ""}
                          </span>
                          <span className={state === "todo" ? "text-faint" : "text-muted"}>
                            {STAGE_LABEL[s]}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </Panel>
              )}

              {result && (
                <>
                  <VideoStage
                    src={api(result.media.playback)}
                    events={result.events}
                    label={result.meta.name}
                    fps={result.meta.fps}
                    overlay={result.overlay}
                    alignment={result.alignment}
                    facts={facts}
                  />
                  <Panel className="p-4">
                    <h3 className="mb-3 text-sm font-semibold">Event timeline</h3>
                    <EventTimeline
                      events={result.events}
                      duration={result.meta.duration}
                      visible={visible}
                      facts={facts}
                    />
                    <p className="mt-2 text-[11px] text-faint">
                      Click a block to jump the video to that moment. Lanes are per class, so segments
                      of different classes that overlap in time stay visible.
                    </p>
                  </Panel>
                  <Panel className="p-4">
                    <h3 className="mb-1 text-sm font-semibold">Accident risk &mdash; Part B</h3>
                    <p className="mb-3 text-xs leading-relaxed text-muted">
                      P(an accident starts within the next 5&nbsp;s), computed causally: the estimator
                      sees frames in order and never reads ahead.
                    </p>
                    <RiskCurve
                      risk={result.risk}
                      duration={result.meta.duration}
                      events={result.events}
                      visible={visible}
                      facts={facts}
                      cues={result.risk_cues}
                    />
                  </Panel>
                </>
              )}
              </>
            )}
          </div>

          <aside className="min-w-0 space-y-4">
            {result && mode === "upload" ? (
              <>
                <TrafficMonitor
                  mode="upload"
                  clip={result.meta.name}
                  events={result.events}
                  risk={result.risk}
                  duration={result.meta.duration}
                  overlay={result.overlay}
                  facts={facts}
                  processing={
                    timings
                      ? { partA: timings.part_a_sec, partB: timings.part_b_sec, total: timings.total_sec, by: `the demo server (${result.device})` }
                      : null
                  }
                />
                <Panel className="flex max-h-[520px] flex-col p-4">
                  <h3 className="mb-3 text-sm font-semibold">
                    Detected events <span className="num text-muted">({result.events.length})</span>
                  </h3>
                  <EventInspector
                    events={result.events}
                    visible={visible}
                    onToggleClass={toggleClass}
                    onShowAll={() => setVisible(new Set(result.events.map((e) => e[2])))}
                    facts={facts}
                    risk={result.risk}
                  />
                </Panel>

                <Panel className="p-4">
                  <h3 className="mb-3 text-sm font-semibold">Run</h3>
                  <dl className="space-y-2 text-xs">
                    <Row k="Clip" v={`${fmtDuration(result.meta.duration)} · ${result.meta.width}×${result.meta.height}`} />
                    <Row k="Part A" v={`${timings?.part_a_sec.toFixed(1)} s`} />
                    <Row k="Part B" v={`${timings?.part_b_sec.toFixed(1)} s`} />
                    <Row
                      k="Total vs budget"
                      v={`${timings?.total_sec.toFixed(1)} s / ${budget.toFixed(0)} s`}
                      tone={timings && timings.total_sec < budget ? "ok" : "bad"}
                    />
                    {stats && (
                      <>
                        <Row k="Sampled frames" v={stats.sampled_frames.toLocaleString()} />
                        <Row k="Detections" v={stats.detections.toLocaleString()} />
                        <Row k="Tracks" v={stats.tracks.toLocaleString()} />
                      </>
                    )}
                    <Row k="Device" v={result.device} />
                  </dl>
                </Panel>

                <Panel className="p-4">
                  <h3 className="mb-2 text-sm font-semibold">Scene alignment</h3>
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${result.alignment.aligned ? "bg-ok" : "bg-bad"}`}
                    />
                    <span className="num text-xs">
                      {result.alignment.inliers} SIFT inliers &mdash;{" "}
                      {result.alignment.aligned ? "aligned" : "not aligned"}
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-faint">
                    {result.alignment.aligned
                      ? "The clip matched the reference frame, so the stop line, crossings and traffic-flow field sit where they belong and every geometric rule applies."
                      : "Under 40 inliers, so the homography fell back to identity. This clip is not from the camera the scene was drawn for: jaywalking, failure_to_yield, red_light, stop_line and congestion all depend on that geometry, and their output here is not meaningful."}
                  </p>
                </Panel>

                <button
                  type="button"
                  onClick={resetRun}
                  className="w-full rounded-md border border-line py-2 text-sm text-muted transition-colors hover:text-text"
                >
                  Analyse another clip
                </button>
              </>
            ) : (
              <Panel className="p-4">
                <h3 className="mb-3 text-sm font-semibold">Inference server</h3>
                {capsError ? (
                  <Callout tone="warn" title="Server unreachable">
                    {capsError}. The demo needs <span className="num">server/app.py</span> running;
                    everything else on this site is static and works without it.
                  </Callout>
                ) : caps ? (
                  <dl className="space-y-2 text-xs">
                    <Row k="Status" v={caps.ok ? "ready" : "degraded"} tone={caps.ok ? "ok" : "bad"} />
                    <Row k="Device" v={caps.gpu ?? caps.device} />
                    <Row k="Part A model" v={caps.detector} />
                    <Row k="Part B model" v={caps.risk_detector} />
                    <Row k="Max upload" v={`${maxMb} MB`} />
                    <Row k="Max length" v={`${Math.round(maxSec)} s`} />
                    <Row k="Queue" v={`${caps.queue_depth} waiting`} />
                    <Row k="Classes" v={`${caps.classes.length} of 14`} />
                  </dl>
                ) : (
                  <Spinner label="Checking…" />
                )}
                <p className="mt-3 text-[11px] leading-relaxed text-faint">
                  One clip is processed at a time: the pipeline already uses a batched detector and
                  three decoder threads, so running two at once would only make both slower.
                </p>
              </Panel>
            )}
          </aside>
        </div>

        {result && mode === "upload" && (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat value={result.events.length} label="Events detected" hint="Part A segments" />
            <Stat
              value={`${((timings?.total_sec ?? 0) / Math.max(result.meta.duration, 1)).toFixed(2)}×`}
              label="Of real time"
              tone="ok"
              hint={`Budget is 3.00× — used ${(((timings?.total_sec ?? 0) / Math.max(budget, 1)) * 100).toFixed(0)}% of it`}
            />
            <Stat
              value={Math.max(0, ...result.risk.map((r) => r[1])).toFixed(3)}
              label="Peak risk score"
              hint="Alarm threshold θ = 0.50"
            />
            <Stat value={result.alignment.inliers} label="Alignment inliers" hint="≥ 40 means the scene matched" />
          </div>
        )}
      </div>
    </PlaybackProvider>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: "ok" | "bad" }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-faint">{k}</dt>
      <dd
        className={`num truncate text-right ${tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : "text-text"}`}
      >
        {v}
      </dd>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-panel2 px-3 py-2">
      <div className="num text-base font-semibold leading-none">{value}</div>
      <div className="mt-1 text-[11px] text-faint">{label}</div>
    </div>
  );
}

function UploadMark() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <rect x="2.5" y="8.5" width="35" height="23" rx="3" stroke="var(--line)" strokeWidth="1.5" />
      <path
        d="M13 23l5-5 4 4 5-6 4 5"
        stroke="var(--muted)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="13.5" cy="15" r="1.8" fill="var(--accent)" />
    </svg>
  );
}
