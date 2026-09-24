import { useEffect, useRef, useState } from "react";

/**
 * Reveal-on-scroll state for one element.
 *
 * Deliberately a scroll check rather than an IntersectionObserver. Two reasons:
 * the observer's callback is throttled to zero in backgrounded or occluded tabs,
 * which would leave content stuck at opacity 0; and these sections re-render
 * whenever their data resolves, so the flag has to be state React owns rather
 * than a class that the next render overwrites. The first check runs on mount,
 * so anything already on screen is never waiting on an event.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el) return;

    let raf = 0;
    const check = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.95 && r.bottom > 0) setShown(true);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };

    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [shown]);

  return [ref, shown] as const;
}

/** Element size in CSS pixels; charts use it instead of guessing a viewport. */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/**
 * One requestAnimationFrame loop per caller, with the callback held in a ref.
 *
 * The callback is intentionally *not* a dependency: animated components
 * re-create it every render, and re-subscribing would cancel and restart the
 * loop on each one. Callers mutate canvas or style properties directly from
 * here rather than calling setState 60 times a second.
 */
export function useRafLoop(cb: (elapsed: number, dt: number) => void, active = true): void {
  const saved = useRef(cb);
  saved.current = cb;
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let start = 0;
    let prev = 0;
    const tick = (now: number) => {
      if (!start) start = prev = now;
      const elapsed = (now - start) / 1000;
      saved.current(elapsed, Math.min((now - prev) / 1000, 0.05));
      prev = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
}

/**
 * Counts from 0 to `target` once `run` turns true.
 *
 * Deliberately capped at ~30 updates: these drive headline figures, and the
 * difference between 30 and 60 steps is invisible while the render cost is not.
 */
export function useCountUp(target: number, run: boolean, ms = 900): number {
  const [value, setValue] = useState(0);
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    if (!run) return;
    if (reduced || !Number.isFinite(target) || ms <= 0) {
      setValue(target);
      return;
    }
    const steps = 30;
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      const p = i / steps;
      setValue(target * (1 - Math.pow(1 - p, 3)));
      if (i >= steps) {
        setValue(target);
        window.clearInterval(id);
      }
    }, ms / steps);
    return () => window.clearInterval(id);
  }, [target, run, ms, reduced]);
  return value;
}

/**
 * Pointer parallax as CSS custom properties (--px, --py in -1..1).
 *
 * Written straight to the element's style so moving the mouse never triggers a
 * React render; children position themselves with calc() off these variables.
 */
export function usePointerParallax<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced) return;
    let raf = 0;
    let tx = 0;
    let ty = 0;
    let x = 0;
    let y = 0;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width) * 2 - 1;
      ty = ((e.clientY - r.top) / r.height) * 2 - 1;
      if (!raf) raf = requestAnimationFrame(ease);
    };
    const ease = () => {
      x += (tx - x) * 0.09;
      y += (ty - y) * 0.09;
      el.style.setProperty("--px", x.toFixed(4));
      el.style.setProperty("--py", y.toFixed(4));
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.002 ? requestAnimationFrame(ease) : 0;
    };
    const onLeave = () => {
      tx = ty = 0;
      if (!raf) raf = requestAnimationFrame(ease);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [reduced]);
  return ref;
}

export type Theme = "dark" | "light";

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("wiut-cv-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* private mode or blocked storage: fall back to the default */
    }
    return "dark";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("wiut-cv-theme", theme);
    } catch {
      /* nothing to do: the theme still applies for this page view */
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}
