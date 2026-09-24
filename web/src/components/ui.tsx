import type { ReactNode } from "react";
import { useReveal } from "../lib/hooks";

export function Section({
  id,
  eyebrow,
  title,
  lead,
  children,
  className = "",
}: {
  id?: string;
  eyebrow?: string;
  title?: string;
  lead?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const [ref, shown] = useReveal<HTMLElement>();
  return (
    <section
      id={id}
      ref={ref}
      className={`reveal scroll-mt-20 ${shown ? "is-in" : ""} ${className}`}
    >
      {eyebrow && (
        <div className="num mb-2 text-[11px] uppercase tracking-[0.14em] text-accent">{eyebrow}</div>
      )}
      {title && <h2 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>}
      {lead && <p className="mt-3 max-w-[68ch] text-pretty leading-relaxed text-muted">{lead}</p>}
      {children && <div className={title || lead ? "mt-7" : ""}>{children}</div>}
    </section>
  );
}

export function Panel({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "article" | "li";
}) {
  return (
    <Tag className={`rounded-xl border border-line bg-panel ${className}`}>{children}</Tag>
  );
}

export function Stat({
  value,
  label,
  hint,
  tone = "default",
}: {
  value: ReactNode;
  label: string;
  hint?: string;
  tone?: "default" | "accent" | "ok" | "bad";
}) {
  const colour =
    tone === "accent" ? "text-accent" : tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : "text-text";
  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <div className={`num text-2xl font-semibold leading-none tracking-tight ${colour}`}>{value}</div>
      <div className="mt-2 text-xs font-medium text-text">{label}</div>
      {hint && <div className="mt-1 text-xs leading-snug text-faint">{hint}</div>}
    </div>
  );
}

/**
 * Renders in place of data that does not exist yet.
 *
 * Every number on this site must be traceable to a file in the repository; where
 * a file is missing we say so and say what would fill it, rather than showing a
 * blank panel or an invented figure.
 */
export function DataGap({
  title,
  what,
  fill,
}: {
  title: string;
  what: string;
  fill?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-panel2 p-5">
      <div className="flex items-center gap-2">
        <span className="grid h-5 w-5 place-items-center rounded-full border border-line text-[11px] text-faint">
          ?
        </span>
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="num ml-auto rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-faint">
          not available
        </span>
      </div>
      <p className="mt-2.5 text-sm leading-relaxed text-muted">{what}</p>
      {fill && <p className="mt-2 text-xs leading-relaxed text-faint">{fill}</p>}
    </div>
  );
}

export function Callout({
  tone = "note",
  title,
  children,
}: {
  tone?: "note" | "warn" | "good";
  title?: string;
  children: ReactNode;
}) {
  const bar = tone === "warn" ? "bg-bad" : tone === "good" ? "bg-ok" : "bg-accent";
  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-panel p-4 pl-5">
      <span className={`absolute left-0 top-0 h-full w-[3px] ${bar}`} />
      {title && <div className="mb-1 text-sm font-semibold">{title}</div>}
      <div className="text-sm leading-relaxed text-muted">{children}</div>
    </div>
  );
}

export function Tag({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "learned" | "rule" | "post" | "ok" | "off";
}) {
  const map: Record<string, string> = {
    default: "border-line text-muted",
    learned: "border-[color-mix(in_srgb,var(--accent)_45%,transparent)] text-accent",
    rule: "border-[color-mix(in_srgb,var(--ok)_45%,transparent)] text-ok",
    post: "border-line text-muted",
    ok: "border-[color-mix(in_srgb,var(--ok)_45%,transparent)] text-ok",
    off: "border-line text-faint",
  };
  return (
    <span
      className={`num inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${map[tone]}`}
    >
      {children}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 text-sm text-muted">
      <span
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-accent"
        aria-hidden="true"
      />
      {label}
    </div>
  );
}
