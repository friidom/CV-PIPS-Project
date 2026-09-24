import { useEffect, useRef, useState } from "react";
import { useElementSize } from "../lib/hooks";
import type { FlowFieldData } from "../lib/types";

type Mode = "direction" | "consistency" | "count";

const MODES: { key: Mode; label: string; note: string }[] = [
  { key: "direction", label: "Flow direction", note: "Mean unit velocity of moving vehicles per 60 px cell" },
  { key: "consistency", label: "One-way confidence", note: "Length of the mean unit vector: 1.0 = every vehicle agrees" },
  { key: "count", label: "Traffic density", note: "Number of moving-vehicle samples behind each cell" },
];

/**
 * The learned traffic flow field over the camera view.
 *
 * Canvas: 576 cells of arrows plus a heat map is far more DOM than it is worth,
 * and the whole thing repaints only when the mode changes.
 */
export function FlowFieldMap({ flow, base }: { flow: FlowFieldData; base: string }) {
  const [mode, setMode] = useState<Mode>("direction");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [wrapRef, size] = useElementSize<HTMLDivElement>();

  const aspect = flow.height / flow.width;
  const w = size.width || 800;
  const h = w * aspect;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !w) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const s = w / flow.width;
    const cell = flow.cell * s;
    const gh = flow.count.length;
    const gw = flow.count[0]?.length ?? 0;
    const maxCount = Math.max(1, ...flow.count.flat());

    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const n = flow.count[y][x];
        if (n === 0) continue;
        const cx = (x + 0.5) * cell;
        const cy = (y + 0.5) * cell;
        const c = flow.consistency[y][x];

        if (mode === "count") {
          // sqrt keeps the busy lanes from swamping the quieter approaches
          ctx.fillStyle = heat(Math.sqrt(n / maxCount));
          ctx.globalAlpha = 0.78;
          ctx.fillRect(x * cell, y * cell, cell, cell);
          ctx.globalAlpha = 1;
          continue;
        }
        if (mode === "consistency") {
          const reliable = c >= flow.min_consistency && n >= flow.min_count;
          ctx.fillStyle = reliable ? "#3ecf8e" : "#ffb020";
          ctx.globalAlpha = reliable ? 0.55 : 0.1 + 0.3 * c;
          ctx.fillRect(x * cell, y * cell, cell, cell);
          ctx.globalAlpha = 1;
          continue;
        }

        const len = cell * 0.42 * Math.max(0.35, c);
        const dx = flow.dx[y][x] * len;
        const dy = flow.dy[y][x] * len;
        const strong = c >= flow.min_consistency && n >= flow.min_count;
        ctx.strokeStyle = strong ? "#ffb020" : "#8d98a7";
        ctx.globalAlpha = strong ? 0.95 : 0.4;
        ctx.lineWidth = strong ? 1.8 : 1.1;
        ctx.beginPath();
        ctx.moveTo(cx - dx, cy - dy);
        ctx.lineTo(cx + dx, cy + dy);
        ctx.stroke();
        // arrow head
        const a = Math.atan2(dy, dx);
        const hl = Math.max(3, len * 0.45);
        ctx.beginPath();
        ctx.moveTo(cx + dx, cy + dy);
        ctx.lineTo(cx + dx - hl * Math.cos(a - 0.45), cy + dy - hl * Math.sin(a - 0.45));
        ctx.moveTo(cx + dx, cy + dy);
        ctx.lineTo(cx + dx - hl * Math.cos(a + 0.45), cy + dy - hl * Math.sin(a + 0.45));
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }, [flow, mode, w, h]);

  return (
    <div>
      <div ref={wrapRef} className="relative overflow-hidden rounded-lg border border-line bg-black">
        <img
          src={`${base}media/reference.jpg`}
          alt=""
          className="block w-full opacity-45"
          style={{ aspectRatio: `${flow.width} / ${flow.height}` }}
        />
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => setMode(m.key)}
            aria-pressed={mode === m.key}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
              mode === m.key ? "border-line bg-panel2 text-text" : "border-linesoft text-faint hover:text-muted"
            }`}
          >
            {m.label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-faint">{MODES.find((m) => m.key === mode)!.note}</span>
      </div>
    </div>
  );
}

/** Dark blue to amber ramp; monotone in lightness so it reads without colour vision. */
function heat(t: number): string {
  const x = Math.max(0, Math.min(t, 1));
  const stops: [number, number, number][] = [
    [17, 28, 48],
    [30, 78, 120],
    [70, 150, 150],
    [220, 170, 60],
    [255, 224, 150],
  ];
  const p = x * (stops.length - 1);
  const i = Math.min(Math.floor(p), stops.length - 2);
  const f = p - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
