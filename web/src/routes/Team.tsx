import { Callout, Panel, Section } from "../components/ui";
import { REPO_URL } from "../content/links";
import { TEAM, TEAM_NAME, WORK_AREAS, isPlaceholder, missingFields, type TeamMember } from "../content/team";

const memberName = (m: TeamMember, i: number) => m.name ?? `Member ${i + 1}`;

export default function Team() {
  const gaps = TEAM.map((m, i) => ({ who: memberName(m, i), missing: missingFields(m) })).filter((g) => g.missing.length);

  return (
    <div className="mx-auto max-w-[1320px] space-y-12 px-4 py-10 sm:py-14">
      <Section
        eyebrow="Team"
        title={`Team ${TEAM_NAME}`}
        lead="Three people, one submission. Roles below map onto the parts of the repository each person owns."
      />

      {gaps.length > 0 && (
        <Callout tone="warn" title="This section is not finished">
          <p>
            Names, roles and links are deliberately left blank rather than invented. Still missing, per member
            &mdash; fill them in <span className="num">web/src/content/team.ts</span> and this page populates itself:
          </p>
          <ul className="mt-2 space-y-0.5">
            {gaps.map((g) => (
              <li key={g.who}>
                <b className="text-text">{g.who}</b>: {g.missing.join(", ")}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {TEAM.map((m, i) => (
          <MemberCard key={i} member={m} index={i} />
        ))}
      </ul>

      <Section eyebrow="Who did what" title="Work areas in this repository">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {WORK_AREAS.map((c) => {
            const owners = TEAM.filter((m) => m.name && m.areas?.includes(c.id)).map((m) => m.name);
            return (
              <Panel key={c.id} className="p-4">
                <h3 className="text-sm font-semibold">{c.area}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{c.detail}</p>
                <p className={`num mt-2.5 border-t border-linesoft pt-2 text-[11px] ${owners.length ? "text-accent" : "text-faint"}`}>
                  {owners.length ? owners.join(" · ") : "owner not filled in yet"}
                </p>
              </Panel>
            );
          })}
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
      {member.areas && member.areas.length > 0 && (
        <ul className="mt-2.5 flex flex-wrap gap-1" aria-label="Work areas">
          {member.areas.map((id) => (
            <li key={id} className="num rounded border border-linesoft px-1.5 py-0.5 text-[10px] text-muted">
              {WORK_AREAS.find((a) => a.id === id)?.area ?? id}
            </li>
          ))}
        </ul>
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
