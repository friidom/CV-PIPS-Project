import { useState } from "react";
import type { SceneData } from "../lib/types";

type LayerKey = "zones" | "crosswalks" | "islands" | "sidewalks" | "stop_lines" | "signals";

const LAYERS: { key: LayerKey; label: string; color: string; note: string }[] = [
  { key: "stop_lines", label: "Stop line", color: "#f5222d", note: "red_light and stop_line measure signed distance to it" },
  { key: "crosswalks", label: "Crossings", color: "#40a9ff", note: "failure_to_yield overlap test and the jaywalking exclusion" },
  { key: "zones", label: "Direction zones", color: "#ffb020", note: "congestion is evaluated per zone" },
  { key: "islands", label: "Islands", color: "#9254de", note: "cut out of the carriageway mask" },
  { key: "sidewalks", label: "Sidewalks", color: "#3ecf8e", note: "cut out of the carriageway mask" },
  { key: "signals", label: "Signal heads", color: "#fadb14", note: "lamp windows sampled every frame for the phase" },
];

/** The camera's reference frame with the hand-labelled scene geometry over it. */
export function SceneMap({ scene, base }: { scene: SceneData; base: string }) {
  const [on, setOn] = useState<Set<LayerKey>>(
    () => new Set<LayerKey>(["stop_lines", "crosswalks", "zones", "signals"]),
  );
  const [w, h] = scene.size;

  const toggle = (k: LayerKey) =>
    setOn((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const colorOf = (k: LayerKey) => LAYERS.find((l) => l.key === k)!.color;

  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-line bg-black">
        <svg viewBox={`0 0 ${w} ${h}`} className="block w-full" role="img" aria-label="Camera reference frame with the annotated scene geometry">
          <image href={`${base}${scene.reference}`} x="0" y="0" width={w} height={h} />

          {on.has("zones") &&
            scene.zones.map((p) => (
              <polygon
                key={p.name}
                points={p.points.map((q) => q.join(",")).join(" ")}
                fill={colorOf("zones")}
                fillOpacity={0.12}
                stroke={colorOf("zones")}
                strokeWidth={2}
                strokeOpacity={0.55}
              />
            ))}

          {on.has("sidewalks") &&
            scene.sidewalks.map((p) => (
              <polygon
                key={p.name}
                points={p.points.map((q) => q.join(",")).join(" ")}
                fill={colorOf("sidewalks")}
                fillOpacity={0.14}
                stroke={colorOf("sidewalks")}
                strokeWidth={1.5}
              />
            ))}

          {on.has("islands") &&
            scene.islands.map((p) => (
              <polygon
                key={p.name}
                points={p.points.map((q) => q.join(",")).join(" ")}
                fill={colorOf("islands")}
                fillOpacity={0.3}
                stroke={colorOf("islands")}
                strokeWidth={1.5}
              />
            ))}

          {on.has("crosswalks") &&
            scene.crosswalks.map((p) => (
              <polygon
                key={p.name}
                points={p.points.map((q) => q.join(",")).join(" ")}
                fill={colorOf("crosswalks")}
                fillOpacity={0.24}
                stroke={colorOf("crosswalks")}
                strokeWidth={2}
              />
            ))}

          {on.has("stop_lines") &&
            scene.stop_lines.map((p) => (
              <g key={p.name}>
                <line
                  x1={p.points[0][0]}
                  y1={p.points[0][1]}
                  x2={p.points[1][0]}
                  y2={p.points[1][1]}
                  stroke={colorOf("stop_lines")}
                  strokeWidth={6}
                  strokeLinecap="round"
                />
              </g>
            ))}

          {on.has("signals") &&
            scene.signals.flatMap((head) =>
              head.lamps.map((l) => (
                <g key={`${head.name}-${l.name}`}>
                  <circle cx={l.x} cy={l.y} r={Math.max(l.r, 5)} fill="none" stroke={colorOf("signals")} strokeWidth={2} />
                  <circle cx={l.x} cy={l.y} r={26} fill="none" stroke={colorOf("signals")} strokeWidth={1} strokeOpacity={0.35} />
                </g>
              )),
            )}
        </svg>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {LAYERS.map((l) => {
          const active = on.has(l.key);
          return (
            <button
              key={l.key}
              type="button"
              onClick={() => toggle(l.key)}
              aria-pressed={active}
              title={l.note}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                active ? "border-line bg-panel2 text-text" : "border-linesoft text-faint"
              }`}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: l.color, opacity: active ? 1 : 0.3 }}
              />
              {l.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
