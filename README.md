# WIUT Hackathon 2026 — Computer Vision Track

Traffic events from a fixed road camera: **detect** them as time segments
(`[start_sec, end_sec, label]`) and, causally, **anticipate** accidents with a
per-frame risk score.

Team **wiut-cv**. Website: see [`web/`](web) (run it locally with the commands at
the bottom, or deploy the built site plus `server/app.py` on one host).

## What we run

```bash
pip install -r requirements.txt
python run_submission.py --videos /data/test --out predictions.json
python evaluate.py --pred predictions.json --gt ground_truth.json
```

`solution.py` at the repo root exposes the required interface and delegates to
`src/traffic`. Nothing else has to be installed or configured.

Measured over all four organizer clips (18.4 min of 3840×2160 at 29.97 fps, one RTX 5080):

| clip | duration | Part A | Part B | total | × duration | events |
|---|---|---|---|---|---|---|
| `C3896.MP4` | 340.3 s | 99.4 s | 143.0 s | 242.4 s | 0.71× | 26 |
| `C3897.MP4` | 317.8 s | 43.5 s | 132.5 s | 176.0 s | 0.55× | 38 |
| `C3902.MP4` | 317.8 s | 44.0 s | 133.1 s | 177.1 s | 0.56× | 32 |
| `C3905.MP4` | 127.6 s | 21.1 s | 54.0 s | 75.0 s | 0.59× | 23 |
| **all four** | **1103.6 s** | **208.0 s** | **462.6 s** | **670.5 s** | **0.61×** | **119** |

That is **20% of the 3.00× budget**. `predictions_samples.json` in this repository is
that run, and passes `python evaluate.py --pred predictions_samples.json --validate-only`
(4 videos, 119 events, 0 errors, 0 warnings).

## Approach

One learned component, everything else explainable.

```
video → sampled decode (reference frames only) → YOLO11m → Kalman/IoU tracker
      → SIFT homography to a reference frame → scene masks + signal phase
      → 8 event rules → merge / split / length filter → segments

frames → YOLO11s (every 5th) → online tracks → TTC conflict + red-runner
       → braking → noisy-OR → fast attack / slow decay → risk score
```

| component | kind | where |
|---|---|---|
| Road-user detection (YOLO11m / YOLO11s, COCO) | **learned** | `src/traffic/detector.py` |
| Tracking (ByteTrack-style IoU over a Kalman filter) | rule-based | `src/traffic/tracker.py`, `tracks.py` |
| Scene alignment (CLAHE + SIFT + MAGSAC homography) | rule-based | `src/traffic/scene.py` |
| Signal phase from lamp pixels | rule-based | `src/traffic/signals.py` |
| 8 event rules | rule-based | `src/traffic/events/` |
| Segment merging, hand-over splitting, blip removal | post-processing | `src/traffic/intervals.py` |
| Accident risk (conflict / red-runner / braking cues) | rule-based | `src/traffic/risk.py` |

Why rules: the sample clips arrive **unlabelled**, so there is nothing to validate a
learned event classifier against. A rule states its assumption explicitly, can be
checked by eye on the annotated renders, and leaves a wide margin inside the time
budget. Details and the reasoning behind each threshold are on the website's
**Approach** and **EDA** pages.

### Classes we predict

`CLASSES` in `solution.py` lists **8 of the 14** official ids:

```
red_light  wrong_way  illegal_u_turn  stopped_vehicle
jaywalking  failure_to_yield  stop_line  congestion
```

Not predicted: `accident`, `near_miss`, `illegal_turn`, `solid_line_crossing`,
`road_obstacle`, `fire_smoke`. The task permits removing ids and forbids adding
them; since a predicted class that never matches is folded into the Score A class
average as a zero, emitting ids we cannot detect would only lower the score.

### Datasets and licences

**No external dataset was used for training, and no model was fine-tuned.**

| asset | source | licence |
|---|---|---|
| `weights/yolo11m_1280x736_b16.torchscript` | Ultralytics YOLO11m, COCO-pretrained, exported by `tools/export_weights.py` | AGPL-3.0 (Ultralytics); COCO images CC BY 4.0 |
| `weights/yolo11s_960x544_b1.torchscript` | Ultralytics YOLO11s, COCO-pretrained | AGPL-3.0 (Ultralytics); COCO images CC BY 4.0 |
| `configs/reference.jpg` | median background of sample clip C3896 | organizers' footage, not redistributed beyond this frame |
| `configs/scene.json` | hand-drawn scene geometry | ours |
| `configs/flow_field.npz` | vehicle motion statistics measured from the sample clips | ours, derived from organizers' footage |

Weights total 119 MB and are committed, so no `weights/download.sh` is needed.
No hosted or paid model is called at any stage of inference.

### Determinism

`solution.py` seeds `random`, `numpy` and `torch` (`SEED = 1234`) at import. The
only non-determinism is cuDNN autotuning, which does not change detector output.
Two runs on the same machine produce the same `predictions.json`.

## Results and limitations

**Score A and Score B are not measured.** The sample clips shipped unlabelled and
we have not annotated them, so `evaluate.py` has no ground truth and there is no
F1, AP or mTTA to report. `tools/labeler/index.html` is the tool for producing
those labels; what is missing is annotation time, not code.

Known problems, all visible in `predictions_samples.json` without any labels:

- `stopped_vehicle` segments span most of a clip — a parked car the rule cannot
  distinguish from a stopped one;
- 34 of 119 events are shorter than 1 s, which will not survive matching at IoU 0.7;
- 6 of 14 classes are never produced;
- Part B peaks at 0.558 on `C3902` and 0.523 on `C3896`, so it does cross θ = 0.5 and
  raise alarms, but with no labels we cannot say whether those alarms are correct;
  on `C3897` (0.384) and `C3905` (0.313) it never fires;
- `configs/reference.jpg` is the median plate of `C3896`, and the homography reflects
  that: 1436 and 1426 SIFT inliers on `C3896`/`C3897` against 123 and 112 on
  `C3902`/`C3905` — all well clear of the 40-inlier floor, but not equally so;
- every geometric rule assumes this camera pose.

The website's **Results** page expands each of these.

## Repository layout

```
solution.py                 the interface the harness imports  (Part A + Part B)
run_submission.py           organizers' harness                (unchanged)
evaluate.py                 official metric + format check     (unchanged)
requirements.txt            runtime dependencies
weights/                    TorchScript YOLO11 graphs (119 MB)
configs/                    reference frame, scene geometry, learned flow field
src/traffic/                the pipeline
  ├── video.py              sampled PyAV decoding
  ├── perception.py         parallel decode + batched detection
  ├── detector.py           YOLO11 TorchScript inference
  ├── tracker.py tracks.py  Kalman + IoU tracking
  ├── trajectories.py       tracks in reference coordinates
  ├── scene.py              geometry, homography, flow field
  ├── signals.py            signal phase from lamp pixels
  ├── intervals.py          run-length and segment helpers
  ├── events/               the 8 event rules
  ├── risk.py               Part B causal risk model
  └── pipeline.py           Part A end to end
tools/                      dev tooling: caching, rendering, labelling, calibration
scripts/                    website data and media generators
server/                     FastAPI backend for the live demo
web/                        the public website (Vite + React + TypeScript)
tests/                      rule tests on synthetic trajectories
predictions_samples.json    our output on the sample clips in this checkout
```

## Development

```bash
# cache one decoding pass per clip so rules can be re-run in seconds
python tools/cache_perception.py --videos samples

# re-run only the rules against that cache
python tools/predict_cached.py --out predictions_dev.json

# score against your own labels once they exist
python tools/eval_dev.py ../dev_labels.json predictions_dev.json

# annotated review video (tracks, phase, evidence, timeline)
python tools/render_video.py C3905.MP4 --proxy <720p proxy> \
    --pred predictions_samples.json --out renders/C3905_annotated.mp4

python -m pytest tests/ -q
```

## Running the website

```bash
# 1. regenerate the site's data and media from whatever is in this checkout
python run_submission.py --videos samples --out predictions_samples.json --team wiut-cv
python scripts/build_media.py --videos samples        # proxies, posters, annotated renders
python scripts/build_site_data.py                     # web/public/data/*.json

# 2. the live-demo backend (imports src/traffic directly; uses the GPU if present)
pip install -r server/requirements.txt
uvicorn server.app:app --host 127.0.0.1 --port 8000

# 3. the frontend
cd web && npm install
npm run dev        # dev server on :5173, proxies /api to :8000
npm run build      # production build into web/dist
```

`server/app.py` serves `web/dist` when that directory exists, so a production
deployment is a single origin: build the frontend, then run uvicorn. For a split
deployment (static host + separate API), set `VITE_API_BASE` at build time.

Demo limits are `DEMO_MAX_UPLOAD_MB` (default 200) and `DEMO_MAX_DURATION_SEC`
(default 120).

Missing inputs are handled rather than faked: `scripts/build_site_data.py` records
every absent asset in `web/public/data/manifest.json`, and the site renders an
explicit "not available" card in its place.

## Team

Members, roles and links live in `web/src/content/team.ts` and are rendered on the
website's Team page.
