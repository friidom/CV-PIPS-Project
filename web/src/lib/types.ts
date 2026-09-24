/** Shapes written by scripts/build_site_data.py and served by server/app.py. */

/** The official Part A output shape: [start_sec, end_sec, label]. */
export type EventTuple = [number, number, string];

/** One [t_sec, score] pair of the Part B risk curve. */
export type RiskPoint = [number, number];

export interface VideoMeta {
  name: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  n_frames: number;
}

export interface RuntimeLog {
  duration: number;
  budget_sec: number;
  part_a_sec: number;
  part_b_sec: number;
  total_sec: number;
  errors: string[];
}

export interface Alignment {
  /** RANSAC inliers from estimate_homography(); < 40 means the fallback identity was used. */
  inliers: number;
  aligned: boolean;
}

export interface SampleData {
  id: string;
  meta: VideoMeta;
  events: EventTuple[];
  risk: RiskPoint[];
  /** Decimation factor applied to `risk` before serving; 1 = untouched. */
  risk_stride: number;
  runtime: RuntimeLog | null;
  /** Measured by re-running estimate_homography() on the clip's first frame. */
  alignment: (Alignment & { min_inliers: number }) | null;
  media: { proxy: string | null; annotated: string | null; poster: string | null };
  produced_by: string;
}

export interface AssetState {
  available: boolean;
  reason: string;
}

export interface ManifestSummary {
  samples_total: number;
  samples_processed: number;
  processed_ids: string[];
  /** Total seconds of footage across all four sample clips. */
  corpus_seconds: number;
  /** Clip whose replay the hero uses — the one with the most tracks. */
  hero_replay?: string | null;
}

export interface Manifest {
  generated_at: string;
  source_commit: string;
  samples: Record<string, AssetState & { path?: string }>;
  eda: Record<string, AssetState & { path?: string }>;
  metrics: AssetState;
  summary?: ManifestSummary;
}

export interface FlowFieldData {
  cell: number;
  width: number;
  height: number;
  /** Row-major [gh][gw] grids. */
  dx: number[][];
  dy: number[][];
  consistency: number[][];
  count: number[][];
  total_samples: number;
  cells_with_data: number;
  cells_one_way: number;
  min_count: number;
  min_consistency: number;
}

export interface ScenePolygon {
  name: string;
  points: [number, number][];
}

export interface SceneData {
  size: [number, number];
  reference: string;
  stop_lines: ScenePolygon[];
  crosswalks: ScenePolygon[];
  islands: ScenePolygon[];
  sidewalks: ScenePolygon[];
  zones: ScenePolygon[];
  signals: { name: string; lamps: { name: string; x: number; y: number; r: number }[] }[];
}

export interface DensitySeries {
  video: string;
  /** Bin centre in seconds. */
  t: number[];
  /** Mean simultaneous count per second, not a cumulative total. */
  person: number[];
  vehicle: number[];
  two_wheeler: number[];
  tracks: number[];
  total_boxes: number;
  sampled_frames: number;
  total_tracks: number;
}

export interface PhaseSeries {
  video: string;
  t: number[];
  /** 0 unknown, 1 red, 2 green, 3 amber — src/traffic/signals.py. */
  phase: number[];
  cycles: { start: number; end: number; phase: number }[];
  seconds_by_phase: { red: number; green: number; amber: number; unknown: number };
  /** Red onset to red onset, in seconds. */
  cycle_periods: number[];
}

/* ---------- live demo ---------- */

export type JobStage =
  | "queued"
  | "probing"
  | "perception"
  | "tracking"
  | "rules"
  | "risk"
  | "encoding"
  | "done"
  | "error"
  | "cancelled";

export interface JobProgress {
  id: string;
  stage: JobStage;
  /** 0..1 within the whole job. */
  progress: number;
  message: string;
  elapsed_sec: number;
  frames_processed: number;
  detections: number;
}

export interface JobResult extends JobProgress {
  meta: VideoMeta;
  events: EventTuple[];
  risk: RiskPoint[];
  alignment: Alignment;
  timings: { part_a_sec: number; part_b_sec: number; total_sec: number };
  media: { playback: string };
  device: string;
}

export interface ServerCapabilities {
  ok: boolean;
  device: string;
  gpu: string | null;
  detector: string;
  risk_detector: string;
  max_upload_bytes: number;
  max_duration_sec: number;
  classes: string[];
  queue_depth: number;
}
