"""Rule-based event detectors over trajectories, scene layout and signal phase."""
from __future__ import annotations

from typing import Callable

from .context import EventContext, Evidence, SceneMasks
from .maneuvers import u_turn, wrong_way
from .pedestrians import failure_to_yield, jaywalking
from .signal_violations import red_light, stop_line
from .stationary import congestion, stopped_vehicle

Rule = Callable[[EventContext], list[tuple[float, float]]]

RULES: dict[str, Rule] = {
    "red_light": red_light,
    "wrong_way": wrong_way,
    "illegal_u_turn": u_turn,  # any U-turn here counts: turning across the median end is not signposted as allowed
    "stopped_vehicle": stopped_vehicle,
    "jaywalking": jaywalking,
    "failure_to_yield": failure_to_yield,
    "stop_line": stop_line,
    "congestion": congestion,
}


def detect_all(ctx: EventContext, classes: list[str] | None = None,
               evidence: dict[str, list[Evidence]] | None = None) -> list[list]:
    """Run the rules for ``classes`` (default: all) -> [[start, end, label], ...] clipped to the video.

    ``evidence`` (optional) receives, per label, what made each rule fire (for visualisation).
    """
    events = []
    for label, rule in RULES.items():
        if classes is not None and label not in classes:
            continue
        found = rule(ctx) if evidence is None else rule(ctx, evidence=evidence.setdefault(label, []))
        for s, e in found:
            s, e = max(0.0, s), min(ctx.duration, e)
            if e > s:
                events.append([round(s, 2), round(e, 2), label])
    return sorted(events)


__all__ = ["EventContext", "Evidence", "SceneMasks", "RULES", "detect_all"]
