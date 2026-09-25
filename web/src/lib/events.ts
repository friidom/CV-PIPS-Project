import { frameIndexAt, PHASE_NAMES, type OverlayData } from "./overlay";
import type { EventTuple, RiskPoint } from "./types";

/**
 * What the rules' own evidence says about one event. Samples read it from
 * events.json (scripts/build_event_facts.py); an upload derives the same fields,
 * bar the region, from its overlay.
 */
export interface EventFact {
  /** Evidence.tids, numbered as the player draws them. */
  tracks: number[];
  /** Scene region where the event began; null when the overlay held no evidence for it. */
  region: string | null;
  /** East-bound signal phase at the event's start. */
  phase: string;
  /** Median evidence ground point, reference-plate pixels. */
  foot?: [number, number] | null;
  /** Share of the opening evidence boxes that agree on `region`. */
  share?: number;
}

export interface EventFacts {
  generated_at: string;
  regions: string[];
  opening_sec: number;
  clips: Record<string, { inliers: number; events: EventFact[] }>;
}

/**
 * configs/scene.json crossing and zone ids. Lane lines exist only on the east-bound approach
 * (for the lane rules), so an event's place is a region, not a lane.
 */
export const REGION_LABEL: Record<string, string> = {
  cw1_eb: "Crossing 1, EB side",
  cw1_wb: "Crossing 1, WB side",
  cw2: "Crossing 2",
  eb_approach: "EB approach",
  eb_stop: "EB stop line to crossing",
  wb_approach: "WB approach",
  box: "Junction box",
  eb_exit: "EB exit",
  wb: "WB carriageway",
  wb_near: "WB past the crossing",
  other: "Other road",
};

export const regionLabel = (id: string | null | undefined): string =>
  id ? (REGION_LABEL[id] ?? id) : "not placed";

/** Evidence tracks and start phase per event, straight from an overlay. */
export function factsFromOverlay(overlay: OverlayData, events: EventTuple[]): EventFact[] {
  return events.map(([s, e, label]) => {
    const li = overlay.event_labels.indexOf(label);
    const f0 = frameIndexAt(overlay, s - overlay.t0);
    const tracks = new Set<number>();
    if (li >= 0) {
      for (let f = f0; f < overlay.times.length && overlay.times[f] + overlay.t0 <= e + 0.05; f++) {
        if (overlay.times[f] + overlay.t0 < s - 0.05) continue;
        for (let i = overlay.offsets[f]; i < overlay.offsets[f + 1]; i++) {
          if (overlay.e[i] === li) tracks.add(overlay.id[i]);
        }
      }
    }
    return {
      tracks: [...tracks].sort((a, b) => a - b),
      region: null,
      phase: PHASE_NAMES[overlay.phase[f0] ?? 0] ?? "UNKNOWN",
    };
  });
}

/** Index of the last risk sample at or before `t`. */
function riskIndex(risk: RiskPoint[], t: number): number {
  let lo = 0;
  let hi = risk.length - 1;
  if (hi < 0 || t <= risk[0][0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (risk[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The score the harness recorded for the moment `t` (the last sample at or before it). */
export function riskAt(risk: RiskPoint[], t: number): number {
  return risk.length ? risk[riskIndex(risk, t)][1] : 0;
}

/** Highest recorded score inside [s, e]; the sample covering `s` counts, so short events still get one. */
export function peakRisk(risk: RiskPoint[], s: number, e: number): number {
  if (!risk.length) return 0;
  let peak = 0;
  for (let i = riskIndex(risk, s); i < risk.length && risk[i][0] <= e; i++) peak = Math.max(peak, risk[i][1]);
  return peak;
}

export const pad3 = (n: number): string => String(n).padStart(3, "0");
