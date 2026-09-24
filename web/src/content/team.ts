/**
 * Team members for the Team page.
 *
 * Nothing here is inferred. Fill in the real values before publishing: the page
 * renders each field only when it is present, and shows a visible notice while
 * any entry is still a placeholder, so an unfilled card can never be mistaken
 * for a real one.
 */
export interface TeamMember {
  /** Full name, or null while the entry is a placeholder. */
  name: string | null;
  /** Role on this project, e.g. "Perception and tracking". */
  role: string | null;
  /** What this person actually did, one or two sentences. */
  contribution: string | null;
  github?: string;
  linkedin?: string;
  portfolio?: string;
  /** Previous projects the member is proud of. */
  previous?: { name: string; url?: string; note?: string }[];
}

export const TEAM_NAME = "wiut-cv";

export const TEAM: TeamMember[] = [
  {
    name: null,
    role: null,
    contribution: null,
  },
  {
    name: null,
    role: null,
    contribution: null,
  },
  {
    name: null,
    role: null,
    contribution: null,
  },
];

export const isPlaceholder = (m: TeamMember): boolean => !m.name;
