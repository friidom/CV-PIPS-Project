import { Callout, Panel, Section } from "../components/ui";
import { REPO_URL } from "../content/links";
import { TEAM, TEAM_NAME, isPlaceholder, type TeamMember } from "../content/team";

const CONTRIBUTIONS = [
  { area: "Perception", detail: "YOLO11 TorchScript export, batched GPU inference, sampled PyAV decoding" },
  { area: "Tracking", detail: "Kalman filter, two-stage IoU association, per-group class gating" },
  { area: "Scene", detail: "Reference frame, polygon layout, SIFT homography, signal-lamp reader" },
  { area: "Event rules", detail: "Eight class rules, temporal post-processing, the labelling tool" },
  { area: "Part B", detail: "Causal risk model: conflict, red-runner and braking cues" },
  { area: "Website", detail: "This site and the live-demo inference server" },
];

export default function Team() {
  const unfilled = TEAM.filter(isPlaceholder).length;

  return (
    <div className="mx-auto max-w-[1320px] space-y-12 px-4 py-10 sm:py-14">
      <Section
        eyebrow="Team"
        title={`Team ${TEAM_NAME}`}
        lead="Three people, one submission. Roles below map onto the parts of the repository each person owns."
      />

      {unfilled > 0 && (
        <Callout tone="warn" title="This section is not finished">
          {unfilled} of {TEAM.length} member entries are still placeholders. Names, roles and links are
          deliberately left blank rather than invented &mdash; fill in{" "}
          <span className="num">web/src/content/team.ts</span> and this page populates itself.
        </Callout>
      )}

      <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {TEAM.map((m, i) => (
          <MemberCard key={i} member={m} index={i} />
        ))}
      </ul>

      <Section eyebrow="Who did what" title="Work areas in this repository">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CONTRIBUTIONS.map((c) => (
            <Panel key={c.area} className="p-4">
              <h3 className="text-sm font-semibold">{c.area}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{c.detail}</p>
            </Panel>
          ))}
        </div>
        <p className="mt-4 text-sm text-muted">
          Commit history and file ownership are visible in the{" "}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent underline-offset-4 hover:underline"
          >
            repository
          </a>
          .
        </p>
      </Section>
    </div>
  );
}

function MemberCard({ member, index }: { member: TeamMember; index: number }) {
  if (isPlaceholder(member)) {
    return (
      <li className="rounded-xl border border-dashed border-line bg-panel2 p-5">
        <div className="grid h-11 w-11 place-items-center rounded-full border border-line text-sm text-faint">
          {index + 1}
        </div>
        <h3 className="mt-3 text-sm font-semibold text-muted">Member {index + 1}</h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-faint">
          Not filled in yet. Add name, role, contribution and links to{" "}
          <span className="num">web/src/content/team.ts</span>.
        </p>
      </li>
    );
  }

  const links = [
    member.github && { label: "GitHub", href: member.github },
    member.linkedin && { label: "LinkedIn", href: member.linkedin },
    member.portfolio && { label: "Portfolio", href: member.portfolio },
  ].filter(Boolean) as { label: string; href: string }[];

  return (
    <li className="rounded-xl border border-line bg-panel p-5">
      <div className="grid h-11 w-11 place-items-center rounded-full border border-line bg-panel2 text-sm font-semibold">
        {member.name!.slice(0, 1).toUpperCase()}
      </div>
      <h3 className="mt-3 text-base font-semibold">{member.name}</h3>
      {member.role && <p className="num mt-0.5 text-xs text-accent">{member.role}</p>}
      {member.contribution && (
        <p className="mt-2.5 text-[13px] leading-relaxed text-muted">{member.contribution}</p>
      )}

      {member.previous && member.previous.length > 0 && (
        <div className="mt-3 border-t border-linesoft pt-3">
          <div className="num text-[10px] uppercase tracking-[0.14em] text-faint">Previous work</div>
          <ul className="mt-1.5 space-y-1">
            {member.previous.map((p) => (
              <li key={p.name} className="text-[13px]">
                {p.url ? (
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-text underline-offset-4 hover:underline"
                  >
                    {p.name}
                  </a>
                ) : (
                  <span className="text-text">{p.name}</span>
                )}
                {p.note && <span className="text-faint"> &mdash; {p.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {links.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:text-text"
            >
              {l.label}
            </a>
          ))}
        </div>
      )}
    </li>
  );
}
