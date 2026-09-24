import type { EventTuple } from "./types";

/**
 * Real tracker output for one time window, as written by build_overlay() in
 * scripts/build_site_data.py.
 *
 * Stored column-wise rather than as an array of objects: a full clip is ~90 000
 * boxes, and one object per box would cost several megabytes of JSON and a GC
 * pause on every seek. `offsets[i]..offsets[i+1]` is the slice of the box
 * columns belonging to frame `i`.
 */
export interface OverlayData {
  video: string;
  /** "ref" = reference-plate coordinates, "video" = source-frame coordinates. */
  space: "ref" | "video";
  /** Window start inside the clip, in seconds. */
  t0: number;
  duration: number;
  ref: [number, number];
  /** Per-frame time, seconds relative to t0. */
  times: number[];
  /** Length times.length + 1. */
  offsets: number[];
  /** Per-frame east-bound signal phase: 0 unknown, 1 red, 2 green, 3 amber. */
  phase: number[];
  /** Tracked boxes per frame. Every one of them is exported and drawn. */
  n: number[];
  /** Event labels referenced by the `e` column. */
  event_labels: string[];
  /** Track id, renumbered from 1 within the window. */
  id: number[];
  /** Tracker group: 0 person, 1 vehicle, 2 two-wheeler, 3 animal. */
  g: number[];
  /** Index into event_labels when this box is evidence for an event, else -1. */
  e: number[];
  /** Box centre and size, in thousandths of the frame. */
  x: number[];
  y: number[];
  w: number[];
  h: number[];
  tracks: number;
  boxes: number;
  events: EventTuple[];
  source: string;
}

export interface Box {
  id: number;
  g: number;
  /** Event this box is evidence for, from the rules' own Evidence.tids. */
  ev: string | null;
  /** 0..1 of the frame. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Matches GROUP_COLOURS in tools/render_video.py so site and render agree. */
export const GROUP_COLORS = ["var(--g0)", "var(--g1)", "var(--g2)", "var(--g3)"];
export const GROUP_NAMES = ["person", "vehicle", "two-wheeler", "animal"];

export const PHASE_NAMES = ["UNKNOWN", "RED", "GREEN", "AMBER"];
export const PHASE_COLORS = ["var(--faint)", "var(--bad)", "var(--ok)", "var(--accent)"];

/** Index of the last sampled frame at or before `t` (seconds relative to t0). */
export function frameIndexAt(data: OverlayData, t: number): number {
  const times = data.times;
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0 || t <= times[0]) return 0;
  if (t >= times[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function boxesAt(data: OverlayData, frame: number): Box[] {
  const a = data.offsets[frame];
  const b = data.offsets[frame + 1];
  if (a === undefined || b === undefined) return [];
  const out: Box[] = [];
  for (let i = a; i < b; i++) {
    out.push({
      id: data.id[i],
      g: data.g[i],
      ev: data.e?.[i] >= 0 ? (data.event_labels[data.e[i]] ?? null) : null,
      x: data.x[i] / 1000,
      y: data.y[i] / 1000,
      w: data.w[i] / 1000,
      h: data.h[i] / 1000,
    });
  }
  return out;
}

/**
 * Centre points of one track across the window, for drawing its trail.
 *
 * Linear scan over the columns. Called only when a track is hovered, so the
 * cost lands on one pointer event rather than on every animation frame.
 */
export function trackPath(data: OverlayData, id: number): { x: number; y: number; t: number }[] {
  const pts: { x: number; y: number; t: number }[] = [];
  for (let f = 0; f < data.times.length; f++) {
    const a = data.offsets[f];
    const b = data.offsets[f + 1];
    for (let i = a; i < b; i++) {
      if (data.id[i] === id) {
        pts.push({ x: data.x[i] / 1000, y: data.y[i] / 1000, t: data.times[f] });
        break;
      }
    }
  }
  return pts;
}

/** Trailing positions of every visible track, oldest first, over `len` frames. */
export function trailsAt(data: OverlayData, frame: number, len: number): Map<number, Box[]> {
  const out = new Map<number, Box[]>();
  const from = Math.max(0, frame - len);
  for (let f = from; f <= frame; f++) {
    for (const b of boxesAt(data, f)) {
      const arr = out.get(b.id);
      if (arr) arr.push(b);
      else out.set(b.id, [b]);
    }
  }
  return out;
}
