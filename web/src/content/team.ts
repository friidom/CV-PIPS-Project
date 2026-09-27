/**
 * Team members for the Team page. The only file to edit to fill that page in.
 *
 * Nothing here is inferred. Every field is null / absent until a member supplies it:
 * the page renders a field only when it is present and, while anything required is
 * missing, lists exactly what is missing per member, so an unfilled card can never
 * be mistaken for a real one.
 */

/** The parts of the repository, for "who did what". Reference them by id in `areas`. */
export const WORK_AREAS = [
  { id: "perception", area: "Perception", detail: "YOLO11 TorchScript export, batched inference, sampled PyAV decoding" },
  { id: "tracking", area: "Tracking", detail: "Kalman filter, two-stage IoU association, per-group class gating" },
  { id: "scene", area: "Scene", detail: "Reference frame, polygon layout, SIFT homography, signal-lamp reader" },
  { id: "rules", area: "Event rules", detail: "Ten class rules, lane geometry, temporal post-processing, the labelling tool" },
  { id: "risk", area: "Part B", detail: "Causal risk model: conflict, red-runner and braking cues" },
  { id: "website", area: "Website", detail: "This site, the live-demo inference server and its deployment" },
  { id: "research", area: "Research and evaluation", detail: "Information gathering, the dev-set labels in labels/, checking the submission end to end, the README" },
] as const;

export type WorkAreaId = (typeof WORK_AREAS)[number]["id"];

export interface TeamMember {
  /** Full name, or null while the entry is a placeholder. */
  name: string | null;
  /** Role on this project, e.g. "Perception and tracking". */
  role: string | null;
  /** What this person actually did, one or two sentences. */
  contribution: string | null;
  /** Work areas this person owned (ids from WORK_AREAS); drives the "who did what" table. */
  areas?: WorkAreaId[];
  /** Full URLs, e.g. "https://github.com/…", "https://www.linkedin.com/in/…". */
  github?: string;
  linkedin?: string;
  portfolio?: string;
  /** Previous projects the member is proud of. */
  previous?: { name: string; url?: string; note?: string }[];
}

export const TEAM_NAME = "PIPS";

export const TEAM: TeamMember[] = [
  {
    name: "Plaxov Ilya",
    role: "Model and pipeline",
    contribution:
      "The technical side of the model: detection, tracking, scene alignment, the event rules and the " +
      "Part B risk model, and fitting the whole pipeline into the time budget.",
    areas: ["perception", "tracking", "scene", "rules", "risk"],
    github: "https://github.com/nasik666",
    linkedin: "https://www.linkedin.com/in/ilya-plaxov-312452359/",
  },
  {
    name: "Aminjonov Kamoliddin",
    role: "Website and live demo",
    contribution:
      "The website: every page, its charts and the live demo, and its deployment together with the " +
      "inference server on the GPU host.",
    areas: ["website"],
    github: "https://github.com/friidom",
    linkedin: "https://www.linkedin.com/in/kamoliddin-aminjonov-829547359",
  },
  {
    name: "Sunnat",
    role: "Research and evaluation",
    contribution:
      "Everything outside the model and the website: gathering the information the work started from, " +
      "labelling the dev set, checking the submission end to end, and the documentation.",
    areas: ["research"],
    linkedin: "https://uz.linkedin.com/in/sunnat-begiev-40ba1643a",
  },
];

export const isPlaceholder = (m: TeamMember): boolean => !m.name;

/** The task's Team requirements this entry does not meet yet, in words. */
export function missingFields(m: TeamMember): string[] {
  const out: string[] = [];
  if (!m.name) out.push("name");
  if (!m.role) out.push("role");
  if (!m.contribution) out.push("what they did");
  if (!m.areas?.length) out.push("work areas");
  if (!m.github) out.push("GitHub");
  if (!m.linkedin) out.push("LinkedIn");
  if (!m.portfolio) out.push("portfolio");
  if (!m.previous?.length) out.push("previous projects");
  return out;
}

/** Fields without which a card cannot stand in front of a visitor at all. */
export const missingCore = (m: TeamMember): boolean => !m.name || !m.role || !m.contribution;
