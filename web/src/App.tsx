import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useTheme } from "./lib/hooks";
import { REPO_URL } from "./content/links";

const Overview = lazy(() => import("./routes/Overview"));
const Demo = lazy(() => import("./routes/Demo"));
const Samples = lazy(() => import("./routes/Samples"));
const Eda = lazy(() => import("./routes/Eda"));
const Approach = lazy(() => import("./routes/Approach"));
const Classes = lazy(() => import("./routes/Classes"));
const Results = lazy(() => import("./routes/Results"));
const Report = lazy(() => import("./routes/Report"));
const Team = lazy(() => import("./routes/Team"));
const Dashboard = lazy(() => import("./routes/Dashboard"));
const Extra = lazy(() => import("./routes/Extra"));

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/demo", label: "Live demo" },
  { to: "/samples", label: "Samples" },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/eda", label: "EDA" },
  { to: "/approach", label: "Approach" },
  { to: "/classes", label: "Classes" },
  { to: "/results", label: "Results" },
  { to: "/extra", label: "Extra credit" },
  { to: "/report", label: "Report" },
  { to: "/team", label: "Team" },
];

export function App() {
  const [theme, toggleTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    setOpen(false);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [pathname]);

  return (
    <div className="flex min-h-screen flex-col">
      {/* Fixed backdrop so every route sits on the same camera-grid surface
          rather than a flat panel. Masked out towards the bottom so long pages
          of prose stay quiet, and -z-10 keeps it behind everything. */}
      <div
        aria-hidden="true"
        className="cal-bg pointer-events-none fixed inset-0 -z-10 opacity-40"
        style={{
          maskImage: "radial-gradient(120% 90% at 50% 0%, #000 35%, transparent 85%)",
          WebkitMaskImage: "radial-gradient(120% 90% at 50% 0%, #000 35%, transparent 85%)",
        }}
      />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accentink"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-line bg-ink/85 backdrop-blur-md">
        <ScrollRail />
        <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-3 px-4">
          <NavLink to="/" className="flex shrink-0 items-center gap-2.5">
            <SignalMark />
            <span className="hidden text-sm font-semibold tracking-tight sm:block">
              Traffic Event Intelligence
            </span>
          </NavLink>

          <nav className="ml-2 hidden min-w-0 flex-1 items-center gap-0.5 xl:flex" aria-label="Primary">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
                    isActive ? "bg-panel2 text-text" : "text-muted hover:text-text"
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1.5">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="hidden rounded-md border border-line px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:text-text sm:block"
            >
              Repository
            </a>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              className="grid h-8 w-8 place-items-center rounded-md border border-line text-muted transition-colors hover:text-text"
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </button>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-label="Toggle navigation"
              aria-expanded={open}
              className="grid h-8 w-8 place-items-center rounded-md border border-line text-muted xl:hidden"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5">
                {open ? (
                  <path d="M3 3l9 9M12 3l-9 9" />
                ) : (
                  <>
                    <path d="M1.5 4h12" />
                    <path d="M1.5 7.5h12" />
                    <path d="M1.5 11h12" />
                  </>
                )}
              </svg>
            </button>
          </div>
        </div>

        {open && (
          <nav className="border-t border-line bg-panel xl:hidden" aria-label="Mobile">
            <div className="mx-auto grid max-w-[1320px] grid-cols-2 gap-1 px-4 py-3 sm:grid-cols-3">
              {NAV.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.end}
                  className={({ isActive }) =>
                    `rounded-md px-3 py-2 text-sm transition-colors ${
                      isActive ? "bg-panel2 text-text" : "text-muted"
                    }`
                  }
                >
                  {n.label}
                </NavLink>
              ))}
            </div>
          </nav>
        )}
      </header>

      <main id="main" className="flex-1">
        <Suspense
          fallback={
            <div className="mx-auto max-w-[1320px] px-4 py-24 text-sm text-muted">Loading…</div>
          }
        >
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/demo" element={<Demo />} />
            <Route path="/samples" element={<Samples />} />
            <Route path="/eda" element={<Eda />} />
            <Route path="/approach" element={<Approach />} />
            <Route path="/classes" element={<Classes />} />
            <Route path="/results" element={<Results />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/extra" element={<Extra />} />
            <Route path="/report" element={<Report />} />
            <Route path="/team" element={<Team />} />
            <Route path="*" element={<Overview />} />
          </Routes>
        </Suspense>
      </main>

      <SiteFooter />
    </div>
  );
}

/**
 * Read position as a hairline under the header.
 *
 * Writes the width straight to the element on scroll instead of holding it in
 * state — this fires on every scroll event on every page, and re-rendering the
 * whole shell that often would be the most expensive thing on the site.
 */
function ScrollRail() {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      el.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className="absolute inset-x-0 bottom-[-1px] h-px origin-left bg-cyan"
      style={{ transform: "scaleX(0)" }}
    />
  );
}

function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-line">
      <div className="mx-auto flex max-w-[1320px] flex-col gap-3 px-4 py-8 text-xs text-faint sm:flex-row sm:items-center">
        <p>
          WIUT Hackathon 2026 &mdash; Computer Vision Track, elimination round. Built around the
          pipeline in <span className="num">src/traffic</span>.
        </p>
        <nav className="flex flex-wrap gap-4 sm:ml-auto" aria-label="Footer">
          <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className="hover:text-text">
            Repository
          </a>
          <NavLink to="/report#links" className="hover:text-text">
            Links
          </NavLink>
          <NavLink to="/results" className="hover:text-text">
            Limitations
          </NavLink>
        </nav>
      </div>
    </footer>
  );
}

function SignalMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <rect x="10" y="3" width="12" height="26" rx="6" fill="none" stroke="var(--line)" strokeWidth="1.6" />
      <circle cx="16" cy="10" r="2.8" fill="var(--bad)" />
      <circle cx="16" cy="16" r="2.8" fill="var(--accent)" opacity="0.35" />
      <circle cx="16" cy="22" r="2.8" fill="var(--ok)" opacity="0.35" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="7.5" cy="7.5" r="3.1" />
      <path d="M7.5 1v1.6M7.5 12.4V14M14 7.5h-1.6M2.6 7.5H1M12.1 2.9l-1.1 1.1M4 11l-1.1 1.1M12.1 12.1L11 11M4 4L2.9 2.9" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M13 9.3A6 6 0 0 1 5.7 2a6 6 0 1 0 7.3 7.3Z" />
    </svg>
  );
}
