/** Seconds -> mm:ss.s, the same convention tools/render_video.py stamps on frames. */
export function timecode(t: number): string {
  if (!Number.isFinite(t) || t < 0) return "00:00.0";
  // Round to tenths before splitting, so 119.97 s reads 02:00.0 rather than 01:60.0.
  const tenths = Math.round(t * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

export function seconds(t: number, digits = 2): string {
  return `${t.toFixed(digits)} s`;
}

/** 63434 -> "63 434". Thin spaces keep long counts scannable without commas. */
export function group(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} kB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function percent(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
