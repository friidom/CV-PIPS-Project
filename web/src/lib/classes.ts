/**
 * The 14 official event classes.
 *
 * `label`, `definition`, `start` and `end` are transcribed verbatim from the
 * "Event classes" table of the WIUT Hackathon 2026 CV Track Elimination Task PDF.
 * `color` matches tools/labeler/index.html so the site, the labeling tool and the
 * rendered review videos agree on every hue.
 * `rule` is null where this repository has no detector for the class.
 */

export type ClassId =
  | "accident"
  | "near_miss"
  | "red_light"
  | "wrong_way"
  | "illegal_u_turn"
  | "stopped_vehicle"
  | "jaywalking"
  | "failure_to_yield"
  | "illegal_turn"
  | "solid_line_crossing"
  | "stop_line"
  | "congestion"
  | "road_obstacle"
  | "fire_smoke";

export interface ClassMeta {
  id: ClassId;
  label: string;
  definition: string;
  start: string;
  end: string;
  color: string;
  /** Source module implementing the rule, or null when the class is not detected. */
  rule: string | null;
  /** How the class is decided in this repository. */
  how: string;
}

export const CLASSES: ClassMeta[] = [
  {
    id: "accident",
    label: "Collision",
    definition: "Contact between two or more road users, or a road user and a fixed object",
    start: "First frame where contact is visible",
    end: "All involved objects stop moving or leave the frame",
    color: "#ff4d4f",
    rule: null,
    how: "Not detected. Part B estimates accident risk from the same tracks, but no Part A segment is emitted.",
  },
  {
    id: "near_miss",
    label: "Near miss",
    definition: "Sharp braking or swerving to avoid a collision; no contact",
    start: "Onset of the evasive action",
    end: "Road users are clear of each other",
    color: "#ff9c6e",
    rule: null,
    how: "Not detected. The braking and conflict cues exist in the Part B risk model but are not thresholded into segments.",
  },
  {
    id: "red_light",
    label: "Red-light running",
    definition: "A vehicle crosses the stop line while its signal is red",
    start: "Front of the vehicle crosses the stop line",
    end: "Vehicle leaves the intersection or the frame",
    color: "#f5222d",
    rule: "src/traffic/events/signal_violations.py",
    how: "Sub-sample interpolated crossing of the east-bound stop line, gated on the lamp-derived signal phase being RED.",
  },
  {
    id: "wrong_way",
    label: "Wrong-way",
    definition:
      "A vehicle moves against the traffic direction of its lane, including driving in the oncoming lane",
    start: "Vehicle enters the opposing lane",
    end: "Vehicle returns to a correct lane or leaves the frame",
    color: "#eb2f96",
    rule: "src/traffic/events/maneuvers.py",
    how: "Heading cosine below -0.6 against the learned flow field, for >= 2 s across >= 3 grid cells that are reliably one-way.",
  },
  {
    id: "illegal_u_turn",
    label: "Illegal U-turn",
    definition: "A U-turn where the road markings or signs prohibit it",
    start: "Vehicle starts turning",
    end: "Vehicle completes the turn",
    color: "#9254de",
    rule: "src/traffic/events/maneuvers.py",
    how: "A track that follows one flow direction and, within 15 s, the opposite one — with continuity checks that reject ID switches at the frame edge.",
  },
  {
    id: "stopped_vehicle",
    label: "Stopped vehicle",
    definition: "A vehicle stationary on the carriageway for 10 s or more, not in a queue at a signal",
    start: "Vehicle stops",
    end: "Vehicle moves again or is removed",
    color: "#fadb14",
    rule: "src/traffic/events/stationary.py",
    how: "Foot point static within 0.12 object sizes over 2 s, minus signal queues, minus bus dwell in the west-bound lanes, minus stops inside the junction (a vehicle there is manoeuvring or yielding), minus seconds inside a congestion event.",
  },
  {
    id: "jaywalking",
    label: "Pedestrian on roadway",
    definition: "A pedestrian on the carriageway outside a crossing",
    start: "Pedestrian steps onto the road",
    end: "Pedestrian leaves the road",
    color: "#36cfc9",
    rule: "src/traffic/events/pedestrians.py",
    how: "Person track not covered by a vehicle box, more than a quarter of its own height from the kerbs and painted crossings for >= 1.5 s, reaching >= 1 body height clear and walking >= 1 body height. Body heights keep the test the same near and far from the camera.",
  },
  {
    id: "failure_to_yield",
    label: "Not yielding to a pedestrian",
    definition: "A vehicle drives through a crossing while a pedestrian is on it or stepping onto it",
    start: "Vehicle enters the crossing",
    end: "Vehicle leaves the crossing",
    color: "#40a9ff",
    rule: "src/traffic/events/pedestrians.py",
    how: "Vehicle ground footprint overlaps a crosswalk mask while moving, with a pedestrian inside the slightly dilated crossing within half of that pedestrian's body height of the footprint.",
  },
  {
    id: "illegal_turn",
    label: "Illegal turn",
    definition: "A turn from the wrong lane or in a prohibited direction",
    start: "Vehicle starts turning",
    end: "Vehicle completes the turn",
    color: "#597ef7",
    rule: "src/traffic/events/lanes.py",
    how: "East-bound approach only. The lane a vehicle holds 180 px before the stop line (measured in perspective from the lane lines' vanishing point) is checked against the scene's turn-permission table (kerb lane: sharp right only; lane 2: straight or right; lanes 3-4: straight; median lane: straight or U-turn). The exit leg it reaches decides the turn.",
  },
  {
    id: "solid_line_crossing",
    label: "Solid line crossing",
    definition: "A lane change or manoeuvre across a solid marking",
    start: "Wheel crosses the line",
    end: "Vehicle is fully in the new lane",
    color: "#73d13d",
    rule: "src/traffic/events/lanes.py",
    how: "East-bound approach only. The vehicle's lane coordinate passes a lane line on its solid part (the last stretch before the stop line), holding each side >= 0.3 s and moving sideways by about a third of a lane.",
  },
  {
    id: "stop_line",
    label: "Stop-line violation",
    definition: "A vehicle stops past the stop line on red without entering the intersection",
    start: "Vehicle stops",
    end: "Signal turns green",
    color: "#ffc53d",
    rule: "src/traffic/events/signal_violations.py",
    how: "Vehicle standing 15-140 px beyond the stop line, before the far edge of the crossing, on RED for >= 2 s; the segment ends at the next GREEN onset. A vehicle held inside the junction has entered the intersection and is not counted.",
  },
  {
    id: "congestion",
    label: "Congestion",
    definition: "Traffic at a standstill or moving crawling across all lanes of a direction",
    start: "Queue stops moving",
    end: "Queue clears",
    color: "#d48806",
    rule: "src/traffic/events/stationary.py",
    how: "Per second in the junction box, the east-bound exit and the west-bound carriageway past its crossing: >= 4 vehicles whose median speed is below 0.25 sizes/s, for >= 8 s. Queues in front of a stop line or crossing are signal or pedestrian waits, not congestion.",
  },
  {
    id: "road_obstacle",
    label: "Obstacle on road",
    definition: "Debris, animal, or fallen object on the carriageway",
    start: "Obstacle appears",
    end: "Obstacle is removed",
    color: "#8c8c8c",
    rule: null,
    how: "Not detected. COCO animal classes are tracked as a group but no obstacle rule consumes them.",
  },
  {
    id: "fire_smoke",
    label: "Fire or smoke",
    definition: "Visible fire or smoke from a vehicle or on the road",
    start: "First visible smoke",
    end: "Smoke clears or the frame ends",
    color: "#ff7a45",
    rule: null,
    how: "Not detected. Would need an appearance model; the detector is COCO object detection only.",
  },
];

export const CLASS_BY_ID: Record<string, ClassMeta> = Object.fromEntries(
  CLASSES.map((c) => [c.id, c]),
);

export const CLASS_ORDER: string[] = CLASSES.map((c) => c.id);

export const IMPLEMENTED_CLASSES: ClassMeta[] = CLASSES.filter((c) => c.rule !== null);

export function classColor(id: string): string {
  return CLASS_BY_ID[id]?.color ?? "#8c8c8c";
}

export function classLabel(id: string): string {
  return CLASS_BY_ID[id]?.label ?? id;
}

/** Stable ordering for timeline lanes: official class order, unknown ids last. */
export function byClassOrder(a: string, b: string): number {
  const ia = CLASS_ORDER.indexOf(a);
  const ib = CLASS_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
}
