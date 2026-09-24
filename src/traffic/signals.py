"""Signal phase of the east-bound approach, read from lamp pixels.

Two heads face the camera: the vehicle signal on the median island
(red / yellow / green) and the pedestrian signal on the left pole
(red man / green man). They turn green together, but the pedestrian head
turns red ~5 s before the vehicle head (vehicles still get flashing green and
yellow), so the vehicle head defines the phase and the pedestrian head is
only a fallback. Each lamp window (reference coordinates mapped into the
video by the inverse alignment homography) is summarised by how red / green
its most coloured pixels are: in daylight the housing is brighter than the
LED, so brightness alone does not work. Lit thresholds are fitted per video
because lighting ranges from noon sun to dusk.
"""
from __future__ import annotations

import numpy as np

from .intervals import runs
from .scene import Scene, apply_homography

UNKNOWN, RED, GREEN, AMBER = 0, 1, 2, 3
FLASH_GAP = 10          # sampled frames (~1 s): unlit gaps inside green are green flashing
MAX_TRANSITION = 150    # sampled frames (~15 s): unreadable green->red gap is treated as amber (never red)
# (head, lamp, colour that lamp shows when lit)
LAMPS = (("median_vehicle", "red", "red"), ("median_vehicle", "green", "green"),
         ("left_pole", "top", "red"), ("left_pole", "bottom", "green"))


def _lamp_score(win: np.ndarray, colour: str, top_k: int) -> float:
    """Mean of the top-k per-pixel R-max(G,B) (red lamps) or G-R (green lamps) of a BGR window."""
    win = win.reshape(-1, 3).astype(np.float32)
    if not len(win):
        return 0.0
    b, g, r = win[:, 0], win[:, 1], win[:, 2]
    score = r - np.maximum(g, b) if colour == "red" else g - r
    return float(np.sort(score)[-top_k:].mean())


class LampSampler:
    """Per frame: colour score of each lamp window.

    ``video_to_ref`` maps 1920-wide video pixels to the reference frame; ``pixel_scale``
    is the frame width / 1920 (2 for native 4K frames), windows scale with it.
    """

    def __init__(self, scene: Scene, video_to_ref: np.ndarray, pixel_scale: float = 1.0,
                 radius: int = 6, top_k: int = 6):
        ref_pts = np.float32([scene.signals[head][lamp] for head, lamp, _ in LAMPS])
        centres = apply_homography(np.linalg.inv(video_to_ref), ref_pts) * pixel_scale
        self.centres = np.round(centres).astype(int)
        self.radius = int(round(radius * pixel_scale))
        self.top_k = int(round(top_k * pixel_scale ** 2))

    def __call__(self, frame: np.ndarray) -> np.ndarray:
        """Return (n_lamps,) colour scores."""
        r = self.radius
        return np.array([_lamp_score(frame[max(0, y - r):y + r + 1, max(0, x - r):x + r + 1], colour, self.top_k)
                         for (x, y), (_, _, colour) in zip(self.centres, LAMPS)], np.float32)


class LampCrops:
    """Collects a generous crop around each signal head per frame, scored later with the final alignment.

    Lamp windows are only ~12 px wide: an alignment estimated from a single early frame
    can be off by that much (the camera may still settle when recording starts), so the
    precise lamp positions come from the homography fitted after the pass.
    """

    def __init__(self, scene: Scene, video_to_ref: np.ndarray, margin: int = 24):
        pts = apply_homography(np.linalg.inv(video_to_ref), np.float32([scene.signals[h][l] for h, l, _ in LAMPS]))
        heads = [h for h, _, _ in LAMPS]
        self.rects = {}
        for head in dict.fromkeys(heads):
            p = pts[[i for i, h in enumerate(heads) if h == head]]
            x0, y0 = (p.min(0) - margin).astype(int)
            x1, y1 = (p.max(0) + margin).astype(int)
            self.rects[head] = (max(x0, 0), max(y0, 0), x1, y1)
        self.frames: list[int] = []
        self.crops: dict[str, list[np.ndarray]] = {h: [] for h in self.rects}

    def add(self, idx: int, frame: np.ndarray) -> None:
        self.frames.append(idx)
        for head, (x0, y0, x1, y1) in self.rects.items():
            self.crops[head].append(frame[y0:y1, x0:x1].copy())

    def scores(self, scene: Scene, video_to_ref: np.ndarray, radius: int = 6, top_k: int = 6) -> tuple[np.ndarray, np.ndarray]:
        """(frame indices sorted, (F, n_lamps) scores) using the final alignment."""
        order = np.argsort(self.frames)
        centres = apply_homography(np.linalg.inv(video_to_ref), np.float32([scene.signals[h][l] for h, l, _ in LAMPS]))
        out = np.zeros((len(order), len(LAMPS)), np.float32)
        for j, ((x, y), (head, _, colour)) in enumerate(zip(np.round(centres).astype(int), LAMPS)):
            x0, y0, _, _ = self.rects[head]
            cx, cy = x - x0, y - y0
            for k, f in enumerate(order):
                crop = self.crops[head][f]
                out[k, j] = _lamp_score(crop[max(0, cy - radius):cy + radius + 1, max(0, cx - radius):cx + radius + 1],
                                        colour, top_k)
        return np.asarray(self.frames)[order], out


def lit_mask(scores: np.ndarray, window: int = 901, min_contrast: float = 20.0) -> np.ndarray:
    """(F, n_lamps) lit flags with a sliding threshold halfway between the local off and on levels.

    Every lamp is dark for at least half of a signal cycle (75-80 s here), so within
    a ~90 s window the 15th percentile is its off level and the 85th its on level.
    Local levels follow the lamp brightness drifting with camera exposure (e.g. at
    sunset). Windows whose on/off contrast is below ``min_contrast`` count as unlit.
    """
    n = len(scores)
    if n == 0:
        return np.zeros(scores.shape, bool)
    w = min(window, n) | 1
    half = w // 2
    padded = np.pad(scores, ((half, half), (0, 0)), mode="reflect" if n > half else "edge")
    win = np.lib.stride_tricks.sliding_window_view(padded, w, axis=0)[::10]  # every 10th frame is enough
    off = np.repeat(np.percentile(win, 15, axis=2), 10, axis=0)[:n]
    on = np.repeat(np.percentile(win, 85, axis=2), 10, axis=0)[:n]
    return (scores > (off + on) / 2) & (on - off >= min_contrast)


class CausalPhase:
    """Online vehicle-phase estimate for Part B: uses only lamp scores seen so far.

    Keeps running on/off levels per lamp (slow min/max trackers) and reports RED
    while the vehicle red lamp is lit, GREEN while its green lamp is lit, AMBER in between.
    """

    def __init__(self, decay: float = 0.0003):  # per update; a lamp may stay lit ~45 s (450 updates)
        self.lo = None
        self.hi = None
        self.decay = decay
        self.state = UNKNOWN

    def update(self, scores: np.ndarray) -> int:
        if self.lo is None:
            self.lo, self.hi = scores.copy(), scores.copy()
        self.lo = np.minimum(scores, self.lo + self.decay * (self.hi - self.lo))
        self.hi = np.maximum(scores, self.hi - self.decay * (self.hi - self.lo))
        lit = (scores > (self.lo + self.hi) / 2) & (self.hi - self.lo >= 20.0)
        if lit[0] and not lit[1]:
            self.state = RED
        elif lit[1] and not lit[0]:
            self.state = GREEN
        elif self.state == GREEN and not lit[0] and not lit[1]:
            self.state = AMBER
        return self.state


def _head_state(lit_red: np.ndarray, lit_green: np.ndarray) -> np.ndarray:
    state = np.full(len(lit_red), UNKNOWN, np.int8)
    state[lit_green & ~lit_red] = GREEN
    state[lit_red & ~lit_green] = RED
    return _majority3(state)


def _majority3(x: np.ndarray) -> np.ndarray:
    """Remove single-frame blips: a value flanked by two equal neighbours takes theirs."""
    y = x.copy()
    if len(x) >= 3:
        flip = (x[:-2] == x[2:]) & (x[1:-1] != x[:-2])
        y[1:-1][flip] = x[:-2][flip]
    return y


def eb_phase(scores: np.ndarray) -> np.ndarray:
    """Vehicle phase per sampled frame from (F, n_lamps) scores: RED, AMBER, GREEN or UNKNOWN."""
    lit = lit_mask(scores)
    vehicle = _head_state(lit[:, 0], lit[:, 1])
    pedestrian = _head_state(lit[:, 2], lit[:, 3])
    phase = vehicle.copy()
    spans = runs(vehicle)
    for k, (s, e, v) in enumerate(spans):
        if v != UNKNOWN:
            continue
        before = spans[k - 1][2] if k > 0 else UNKNOWN
        after = spans[k + 1][2] if k + 1 < len(spans) else UNKNOWN
        if before == GREEN and after == GREEN and e - s <= FLASH_GAP:
            phase[s:e] = GREEN                       # flashing green
        elif before == GREEN and after == RED and e - s <= MAX_TRANSITION:
            phase[s:e] = AMBER                       # yellow (or head occluded while changing): not red
        else:
            # vehicle head unreadable: fall back to the pedestrian head. It turns red before the
            # vehicle head does, so right after vehicle green its red only means "not green".
            ped = pedestrian[s:e]
            red = AMBER if before == GREEN else RED
            phase[s:e] = np.where(ped == GREEN, GREEN, np.where(ped == RED, red, UNKNOWN))
    return phase
