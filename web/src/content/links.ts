/** Links required by the task's "Links" section. Only URLs that actually resolve. */
export const REPO_URL = "https://github.com/friidom/CV-PIPS-Project";

export interface SiteLink {
  label: string;
  href: string;
  note: string;
  /** false when the target lives only inside the repository, not on the public web. */
  external: boolean;
}

export const LINKS: SiteLink[] = [
  {
    label: "Repository",
    href: REPO_URL,
    note: "Source, scene configuration, event rules, the website and this page.",
    external: true,
  },
  {
    label: "Model weights",
    href: `${REPO_URL}/tree/main/weights`,
    note: "yolo11m_1280x736_b16.torchscript (81 MB) and yolo11s_960x544_b1.torchscript (38 MB), committed in the repository — well inside the 5 GB limit, so no download.sh is needed.",
    external: true,
  },
  {
    label: "predictions_samples.json",
    href: `${REPO_URL}/blob/main/predictions_samples.json`,
    note: "Output of run_submission.py on the sample clips present in this checkout.",
    external: true,
  },
  {
    label: "solution.py",
    href: `${REPO_URL}/blob/main/solution.py`,
    note: "The interface the organizers' harness imports: detect_events and RiskEstimator.",
    external: true,
  },
];
