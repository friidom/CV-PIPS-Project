"""Export the COCO-pretrained YOLO11 checkpoints to TorchScript (dev-time only; needs ultralytics).

The submission runs the exported graphs with plain PyTorch, so ultralytics (and the
GUI OpenCV build it pulls in) is not needed at evaluation time.

    python tools/export_weights.py
"""
from __future__ import annotations

import shutil
from pathlib import Path

from ultralytics import YOLO

WEIGHTS = Path(__file__).resolve().parents[1] / "weights"
# (checkpoint, (height, width) of the network input, batch size)
EXPORTS = [("yolo11m.pt", (736, 1280), 16), ("yolo11s.pt", (544, 960), 1)]


def main() -> None:
    for name, imgsz, batch in EXPORTS:
        out = YOLO(str(WEIGHTS / name)).export(format="torchscript", imgsz=imgsz, batch=batch, optimize=False)
        target = WEIGHTS / f"{Path(name).stem}_{imgsz[1]}x{imgsz[0]}_b{batch}.torchscript"
        shutil.move(out, target)
        print("wrote", target)


if __name__ == "__main__":
    main()
