# Deploying the website and live demo

One Docker container serves everything: `server/app.py` (FastAPI) serves the built
React site from `web/dist` **and** the inference API under `/api`, on one origin.

```
judge's browser ── HTTPS ──> https://<user>-<space>.hf.space        (Hugging Face Space, Docker SDK)
                                  │
                                  └─ uvicorn server.app:app  (1 process, port 7860)
                                       ├─ /, /demo, /samples, …   built React site (web/dist)
                                       ├─ /data/*, /media/*       sample results + 720p proxies/renders
                                       └─ /api/*                  upload → queue → YOLO11m + tracker
                                                                  + scene/signal + 10 event rules
                                                                  + RiskModel (YOLO11s) → results
```

This image is for the **website only**. The organizers' evaluation never uses it: it
runs `pip install -r requirements.txt` and `run_submission.py` at the repository root,
which is why the Dockerfile lives in `deploy/` and not at the root (a root `Dockerfile`
is what the task's `docker build -t team .` option would pick up).

## Recommended host: a Hugging Face Space (Docker SDK)

Why this and not a split frontend/backend setup:

- The server is one long-lived process by design: the upload queue, finished results,
  progress streams (SSE) and live-mode tracker sessions all live in its memory. A
  persistent container runs that unchanged; serverless platforms (Vercel/Netlify
  functions, Modal, Cloud Run with scale-to-zero) would need that state redesigned, and
  cap each request (Vercel/Netlify functions are sized for web handlers — bundle, memory
  and duration limits that PyTorch plus multi-minute jobs do not fit; Modal web
  endpoints stop at 150 s).
- Inference needs ~1.5 GB RAM at peak and PyTorch; the free tiers of Render, Railway and
  Koyeb stop at 0.5 GB.
- One origin: no CORS, no API URL baked into the frontend, HTTPS and a stable URL
  provided by the host.

| | HF Space, Docker | Render / Railway / Koyeb free | Vercel / Netlify | Modal (+ static host) | Oracle Always Free VM |
|---|---|---|---|---|---|
| React site | yes, same container | yes | yes | needs a second host | yes |
| FastAPI + PyTorch YOLO | yes (16 GB RAM) | no — 0.5 GB RAM | no — function limits | yes, GPU | yes (24 GB, 4 ARM cores) |
| Uploads + long jobs | yes, no request cap | — | no | 150 s per request | yes |
| Persistent process | yes | sleeps (15 min / 1 h) | no | scale-to-zero | yes |
| HTTPS | automatic | automatic | automatic | automatic | set up yourself |
| Cost for judging | $9 PRO month (+ optional hardware) | — | — | $0 ($30 monthly credits) | $0 |
| Card needed | yes (PRO) | — | — | no | yes (verification) |
| Setup | 2 files, web UI | — | — | code changes + 2 hosts | VM, Docker, TLS by hand |

Since 2026, creating a Docker (or Gradio) Space needs a paid plan: **PRO, $9/month** for
a personal account. CPU Basic hardware (2 vCPU, 16 GB RAM, 50 GB disk) then costs
nothing extra. [Spaces overview](https://huggingface.co/docs/hub/spaces-overview),
[hardware and sleep](https://huggingface.co/docs/hub/spaces-gpus).

### Steps (≈15 minutes, all in the browser)

1. **Repository.** The Space clones `https://github.com/friidom/CV-PIPS-Project`. It must be
   public for the task anyway; until it is, add a Space secret `GITHUB_TOKEN` (a
   fine-grained GitHub token with *Contents: read* on this repository only).
2. **Account.** Sign up at huggingface.co and subscribe to PRO (card required).
3. **Create the Space.** huggingface.co/new-space → name e.g. `wiut-cv-traffic` →
   SDK **Docker** → template **Blank** → hardware **CPU basic** → visibility **Public**.
4. **Add two files** (Files tab → *Add file* → *Create a new file*, paste, commit):
   - `README.md` ← contents of `deploy/huggingface/README.md` (replace the generated one)
   - `Dockerfile` ← contents of `deploy/Dockerfile`
5. **Variables** (Settings → *Variables and secrets* → *New variable*):
   - `REPO_REF` = the commit hash or tag you submit (e.g. the output of
     `git rev-parse HEAD` after you push). Variables are passed as Docker build args,
     so the Space builds exactly that commit. Leaving it unset builds `main`.
   - optional runtime limits, see the table below.
6. **Wait for the build** (Logs tab; ~5–10 min the first time). The Space turns
   *Running*; the app answers at **`https://<user>-<space-name>.hf.space`**
   (Settings → *Embed this Space* shows the exact host).
7. **Check it:** open `/api/health` (should say `"models": "ready"` about a minute after
   start), then `/demo` → upload a 10 s MP4.
8. **Give judges the direct `*.hf.space` URL**, not the `huggingface.co/spaces/...`
   page: that page wraps the site in an iframe, where browsers may block the webcam.

Updating: push to GitHub, then change `REPO_REF` to the new commit (triggers a rebuild),
or use Settings → *Factory rebuild* when `REPO_REF` is a branch.

### Environment variables

All optional. On a Space set them under Settings → *Variables*.

| name | default | what it does |
|---|---|---|
| `REPO_REF` | `main` | build arg: branch, tag or commit to clone |
| `REPO_URL` | this repo on GitHub | build arg: repository to clone |
| `TORCH_INDEX` | CPU wheels | build arg: `https://download.pytorch.org/whl/cu128` on a GPU Space |
| `GITHUB_TOKEN` (secret) | — | build secret: only while the repository is private |
| `DEMO_MAX_UPLOAD_MB` | `200` | largest accepted upload; rejected from `Content-Length` before the body is read |
| `DEMO_MAX_DURATION_SEC` | `120` | longest accepted clip (the task asks for "2 minutes is enough") |
| `DEMO_MAX_QUEUE` | `3` | uploads allowed to wait behind the running one; more get a 503 "try again" |
| `DEMO_CORS_ORIGINS` | `*` | only matters for a split deployment (below) |
| `OMP_NUM_THREADS` | `$CPU_CORES` | torch threads; Spaces export `CPU_CORES`, so leave it |

No secrets are needed at runtime and none are in the repository.

### Performance you should expect

Measured with this image restricted to 2 CPUs (`docker run --cpus=2`) on an Apple M4 Pro,
which is faster per core than a Space's shared vCPUs — treat these as best case:

| | CPU Basic (2 vCPU) |
|---|---|
| cold start → models ready | ~60 s (the site itself is up within seconds) |
| 10 s 720p clip, upload → full result | 88 s (Part A 76 s, Part B 10 s) |
| peak memory | ~1.5 GB of 16 GB |

So the full pipeline runs at roughly 9–20× real time on CPU Basic: a 10–20 s clip answers
in a few minutes, a full 120 s clip can take 20–40 minutes. The demo page shows a live
ETA, the queue position and the speed of the last clip, and says to prefer short clips.
The task states "CPU inference is fine for the demo", so this is compliant, but for the
judging window consider:

- **CPU Upgrade** (8 vCPU, 32 GB): **$0.03/hour** ≈ $0.72/day, roughly 3–4× faster, and it
  never sleeps. Settings → *Space hardware*.
- **Nvidia T4 small**: $0.40/hour; set the variable `TORCH_INDEX=https://download.pytorch.org/whl/cu128`
  first (rebuild), then switch hardware. The detector then runs in fp16 on the GPU, as in
  the submission.

Switch back to CPU Basic after judging to stop billing.

### Sleeping, restarts, staying online

- On CPU Basic a Space sleeps after **48 hours without visitors**; the next visitor wakes
  it automatically (a "starting" page for a minute or two, then the models load in the
  background). Upgraded hardware does not sleep unless you set a sleep time.
- `.github/workflows/keepalive.yml` pings `/api/health` twice a day so a quiet judging
  period never reaches 48 h. Enable it by adding a repository variable `DEMO_URL`
  (GitHub → Settings → Secrets and variables → Actions → Variables) =
  `https://<user>-<space-name>.hf.space`. Without that variable it does nothing.
- Restart: Settings → *Restart this Space*. A restart loses in-flight jobs and results
  (they are in memory by design); the sample pages are static and unaffected.
- Logs: the Space's *Logs* tab (build and container output).

### How requests are handled

- **Uploads:** `POST /api/jobs` (multipart field `file`, `.mp4` only). Oversized bodies
  are refused from the `Content-Length` header before anything is written; the clip is
  then streamed to a temp directory, probed with PyAV, and rejected (and deleted) if
  unreadable or longer than the limit. The browser shows upload progress.
- **Queue:** one worker runs one clip at a time (the pipeline already uses every core);
  up to `DEMO_MAX_QUEUE` wait behind it. Live mode pauses while an upload runs.
- **Results:** kept in memory with the browser-playable H.264 copy
  (`/api/jobs/{id}/media`, supports Range for seeking); deleted 45 minutes after they
  finish, or oldest-first beyond 24 jobs. Queued and running jobs are never evicted.
  Nothing is written outside the container's temp directory.
- **Health:** `GET /api/health` never touches a model: `{"ok": true, "models": "loading|ready|error", …}`.
- **Errors:** every rejection returns a JSON `detail` the page shows verbatim; a job that
  crashes reports its error instead of hanging, and the worker keeps serving.

## Running the same image elsewhere

```bash
# build from this working tree (what you want before pushing)
docker build -t wiut-cv-site --build-context source=. deploy/
# or from GitHub at a commit:  docker build -t wiut-cv-site --build-arg REPO_REF=<sha> deploy/
docker run --rm -p 7860:7860 wiut-cv-site          # http://localhost:7860
docker run --rm -p 7860:7860 --cpus=2 -e CPU_CORES=2 wiut-cv-site   # imitate CPU Basic
```

Any Docker host with ~3 GB of RAM works the same way (an Oracle Always Free VM, a VPS):
run the container and put HTTPS in front of it, e.g. `caddy reverse-proxy --from
your.domain --to :7860`. Browsers only allow the webcam on HTTPS.

### Split deployment (static frontend + API elsewhere)

Not recommended here, but supported: build the site with the API origin baked in and
allow that origin on the server.

```bash
cd web && VITE_API_BASE=https://api.example.org npm run build     # → web/dist, any static host
DEMO_CORS_ORIGINS=https://site.example.org uvicorn server.app:app --host 0.0.0.0 --port 7860
```

The static host must rewrite unknown paths to `/index.html` (client-side routes) and
accept files up to 47 MB (the annotated renders), which rules out Cloudflare Pages.

## Local development (unchanged)

```bash
pip install -r server/requirements.txt
uvicorn server.app:app --host 127.0.0.1 --port 8000
cd web && npm install && npm run dev      # http://localhost:5173, proxies /api to :8000
```
