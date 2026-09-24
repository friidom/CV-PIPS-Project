"""Learn the normal direction of vehicle traffic per 60 px cell from the sample videos.

Writes configs/flow_field.npz (reference-frame grid): summed unit velocity vectors and
sample counts of moving vehicles. The wrong-way rule flags vehicles moving against
cells where traffic is consistently one-way.

    python tools/build_flow_field.py
"""
from __future__ import annotations

import numpy as np

import devdata
from traffic.scene import REF_SIZE
from traffic.tracker import GROUP_VEHICLE

CELL = 60


def main() -> None:
    gw, gh = REF_SIZE[0] // CELL, REF_SIZE[1] // CELL
    sx, sy, n = np.zeros((gh, gw)), np.zeros((gh, gw)), np.zeros((gh, gw))
    for name in devdata.VIDEOS:
        for tr in devdata.load(name).trajectories:
            if tr.group != GROUP_VEHICLE or len(tr.t) < 20:
                continue
            vel = tr.velocity(1.0)
            speed = np.linalg.norm(vel, axis=1)
            moving = speed / np.maximum(tr.size, 1.0) > 1.0
            cx = np.clip((tr.foot[moving, 0] // CELL).astype(int), 0, gw - 1)
            cy = np.clip((tr.foot[moving, 1] // CELL).astype(int), 0, gh - 1)
            unit = vel[moving] / speed[moving, None]
            np.add.at(sx, (cy, cx), unit[:, 0])
            np.add.at(sy, (cy, cx), unit[:, 1])
            np.add.at(n, (cy, cx), 1)
    out = devdata.ROOT / "configs" / "flow_field.npz"
    np.savez_compressed(out, cell=CELL, sx=sx.astype(np.float32), sy=sy.astype(np.float32), n=n.astype(np.int32))
    consistency = np.hypot(sx, sy) / np.maximum(n, 1)
    print(f"wrote {out}: {int((n >= 40).sum())} cells with data, {int(((consistency > 0.85) & (n >= 40)).sum())} one-way")


if __name__ == "__main__":
    main()
