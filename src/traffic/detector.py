"""Road-user detection with COCO-pretrained YOLO11 exported to TorchScript.

The graphs in weights/ were exported by tools/export_weights.py for a fixed input
size and batch; frames are resized, padded and normalised on the GPU and the raw
output is decoded + NMS'ed here with torchvision, so evaluation needs only PyTorch.
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
import torchvision

PERSON, BICYCLE, CAR, MOTORCYCLE, BUS, TRUCK = 0, 1, 2, 3, 5, 7
ANIMALS = (15, 16, 17, 18, 19)  # cat, dog, horse, sheep, cow -> road_obstacle candidates
DETECT_CLASSES = (PERSON, BICYCLE, CAR, MOTORCYCLE, BUS, TRUCK) + ANIMALS


class Detector:
    """Batched YOLO inference returning boxes in original video pixels.

    Output per frame: float32 array (N, 6) = x1, y1, x2, y2, confidence, coco_class.
    """

    def __init__(self, weights: str | Path, conf: float = 0.15, iou: float = 0.7, max_det: int = 300,
                 device: str | None = None):
        m = re.search(r"_(\d+)x(\d+)_b(\d+)\.torchscript$", str(weights))
        if not m:
            raise ValueError(f"expected <name>_<W>x<H>_b<B>.torchscript, got {weights}")
        self.width, self.height, self.batch = (int(g) for g in m.groups())
        self.device = torch.device(device or ("cuda:0" if torch.cuda.is_available() else "cpu"))
        self.dtype = torch.float16 if self.device.type == "cuda" else torch.float32
        self.model = torch.jit.load(str(weights), map_location=self.device).eval().to(self.dtype)
        self.conf, self.iou, self.max_det = conf, iou, max_det
        self.keep = torch.zeros(80, dtype=torch.bool, device=self.device)
        self.keep[list(DETECT_CLASSES)] = True
        with torch.inference_mode():  # the TorchScript profiling executor optimises during the first runs
            for _ in range(3):
                self.model(torch.zeros((self.batch, 3, self.height, self.width), dtype=self.dtype, device=self.device))

    @torch.inference_mode()
    def __call__(self, frames: list[np.ndarray], scale: float) -> list[np.ndarray]:
        """Detect on same-size BGR frames; ``scale`` maps frame pixels back to video pixels."""
        out: list[np.ndarray] = []
        for i in range(0, len(frames), self.batch):
            out += self._run(frames[i:i + self.batch], scale)
        return out

    def _run(self, frames: list[np.ndarray], scale: float) -> list[np.ndarray]:
        n = len(frames)
        h, w = frames[0].shape[:2]
        th = int(round(h * self.width / w))  # keep aspect ratio, pad the bottom to the export height
        x = torch.from_numpy(np.stack(frames)).to(self.device, non_blocking=True)
        x = x.permute(0, 3, 1, 2).flip(1).to(self.dtype) / 255.0  # BHWC BGR uint8 -> BCHW RGB [0, 1]
        x = F.interpolate(x, size=(th, self.width), mode="bilinear", align_corners=False, antialias=True)
        x = F.pad(x, (0, 0, 0, self.height - th), value=114 / 255.0)
        if n < self.batch:  # the graph was traced for a fixed batch
            x = torch.cat([x, x.new_zeros((self.batch - n, *x.shape[1:]))])
        preds = self.model(x)
        preds = (preds[0] if isinstance(preds, (list, tuple)) else preds)[:n].float()  # (n, 4 + 80, anchors)
        to_video = scale * w / self.width
        return [self._nms(p, to_video) for p in preds]

    def _nms(self, pred: torch.Tensor, to_video: float) -> np.ndarray:
        pred = pred.T  # (anchors, 84): cx cy w h, class scores
        score, cls = pred[:, 4:].max(1)
        ok = (score > self.conf) & self.keep[cls]
        pred, score, cls = pred[ok], score[ok], cls[ok]
        cx, cy, bw, bh = pred[:, 0], pred[:, 1], pred[:, 2], pred[:, 3]
        boxes = torch.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], 1)
        idx = torchvision.ops.batched_nms(boxes, score, cls, self.iou)[:self.max_det]
        det = torch.cat([boxes[idx] * to_video, score[idx, None], cls[idx, None].float()], 1)
        return det.cpu().numpy().astype(np.float32)
