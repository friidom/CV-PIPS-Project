"""Everything an event rule needs about one video, precomputed once."""
from __future__ import annotations

from dataclasses import dataclass
from functools import cached_property
from typing import NamedTuple

import cv2
import numpy as np

from ..scene import REF_SIZE, Scene
from ..signals import UNKNOWN
from ..tracker import GROUP_PERSON, GROUP_TWO_WHEELER, GROUP_VEHICLE
from ..trajectories import Trajectory


# the junction: past the east-bound stop line, before the west-bound crossing, the box and its exit
# (plus the painted crossings); vehicles standing here are finishing a manoeuvre, yielding or stuck
JUNCTION_ZONES = ("eb_stop", "wb_approach", "box", "eb_exit")


class Evidence(NamedTuple):
    """Why a rule fired: the raw (pre-merge) segment, the track ids involved and a short note."""
    start: float
    end: float
    tids: tuple[int, ...]
    note: str = ""


@dataclass
class SceneMasks:
    """Reference-frame rasters (uint8 0/1) derived from the scene polygons."""
    road: np.ndarray
    crosswalk: dict[str, np.ndarray]
    crosswalk_any: np.ndarray      # union of the painted crossings
    road_depth: np.ndarray         # float32 distance (px) from the nearest kerb; 0 off the carriageway
    jaywalk_depth: np.ndarray      # float32 distance (px) from the nearest kerb or painted crossing; 0 on either
    zone: dict[str, np.ndarray]    # traffic zones: eb_approach, eb_stop (stop line -> crossing), wb_approach, box, eb_exit, wb, wb_near
    junction: np.ndarray           # JUNCTION_ZONES and the crossings
    exit: dict[str, np.ndarray]    # exit regions of the junction legs (scene "exits")

    @classmethod
    def build(cls, scene: Scene) -> "SceneMasks":
        road = np.ones(REF_SIZE[::-1], np.uint8)
        cv2.fillPoly(road, [p.astype(np.int32) for p in list(scene.sidewalks.values()) + list(scene.islands.values())], 0)
        crosswalk = {k: scene.mask([p]) for k, p in scene.crosswalks.items()}
        crosswalk_any = scene.mask(list(scene.crosswalks.values()))
        zone = {k: scene.mask([p]) for k, p in scene.zones.items()}
        junction = crosswalk_any.copy()
        for name in JUNCTION_ZONES:
            junction |= zone[name]
        return cls(road=road, crosswalk=crosswalk, crosswalk_any=crosswalk_any,
                   road_depth=cv2.distanceTransform(road, cv2.DIST_L2, 5),
                   jaywalk_depth=cv2.distanceTransform(road & (1 - crosswalk_any), cv2.DIST_L2, 5),
                   zone=zone, junction=junction, exit={k: scene.mask([p]) for k, p in scene.exits.items()})


@dataclass
class EventContext:
    duration: float
    fps: float
    trajectories: list[Trajectory]
    phase_t: np.ndarray            # times of the EB signal phase samples
    phase: np.ndarray              # signals.RED / AMBER / GREEN / UNKNOWN
    scene: Scene
    masks: SceneMasks

    def of_group(self, *groups: int) -> list[Trajectory]:
        return [tr for tr in self.trajectories if tr.group in groups]

    @property
    def vehicles(self) -> list[Trajectory]:
        return self.of_group(GROUP_VEHICLE)

    @property
    def people(self) -> list[Trajectory]:
        return self.of_group(GROUP_PERSON)

    def phase_at(self, t: np.ndarray | float) -> np.ndarray:
        """EB phase at arbitrary times (nearest earlier sample)."""
        if len(self.phase_t) == 0:
            return np.full(np.shape(t), UNKNOWN)
        i = np.clip(np.searchsorted(self.phase_t, t, side="right") - 1, 0, len(self.phase) - 1)
        return self.phase[i]

    def frame_key(self, t: np.ndarray) -> np.ndarray:
        return np.round(np.asarray(t) * self.fps).astype(np.int64)

    @cached_property
    def boxes_by_frame(self) -> dict[int, np.ndarray]:
        """Frame -> (n, 5) boxes of vehicles and two-wheelers: x1 y1 x2 y2 group (reference pixels)."""
        rows: dict[int, list] = {}
        for tr in self.of_group(GROUP_VEHICLE, GROUP_TWO_WHEELER):
            for k, box in zip(self.frame_key(tr.t), tr.box):
                rows.setdefault(int(k), []).append((*box, tr.group))
        return {k: np.asarray(v, np.float32) for k, v in rows.items()}

    def covered_by_vehicle(self, tr: Trajectory, min_frac: float = 0.5) -> np.ndarray:
        """Per sample of a person track: is the person box mostly inside a vehicle or two-wheeler box?

        True for drivers seen through windscreens, passengers and riders.
        """
        out = np.zeros(len(tr.t), bool)
        for i, (k, (x1, y1, x2, y2)) in enumerate(zip(self.frame_key(tr.t), tr.box)):
            boxes = self.boxes_by_frame.get(int(k))
            if boxes is None:
                continue
            iw = np.clip(np.minimum(x2, boxes[:, 2]) - np.maximum(x1, boxes[:, 0]), 0, None)
            ih = np.clip(np.minimum(y2, boxes[:, 3]) - np.maximum(y1, boxes[:, 1]), 0, None)
            area = max((x2 - x1) * (y2 - y1), 1.0)
            out[i] = bool(((iw * ih) / area >= min_frac).any())
        return out
