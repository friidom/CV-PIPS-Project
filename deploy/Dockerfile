# syntax=docker/dockerfile:1
#
# The public website and the live-demo API in one container: server/app.py serves
# the built React site from web/dist and the inference API under /api, so there is
# one origin, no CORS and no frontend API URL to configure.
#
# This is the WEBSITE image. The organizers' evaluation does not use it: it runs
# `pip install -r requirements.txt` + `python run_submission.py` at the repo root,
# which is why this file lives in deploy/ and not at the root.
#
# Build from the public GitHub repository (what a Hugging Face Space does):
#   docker build -t wiut-cv-site deploy/
# Build from this working tree instead (local check before pushing):
#   docker build -t wiut-cv-site --build-context source=. deploy/
# Run:
#   docker run --rm -p 7860:7860 wiut-cv-site        # then open http://localhost:7860
#
# Build args (a Space passes its Variables as build args):
#   REPO_URL, REPO_REF  what to clone; pin REPO_REF to the submission tag or commit
#   TORCH_INDEX         CPU wheels by default; https://download.pytorch.org/whl/cu128 for a GPU host
# Optional build secret GITHUB_TOKEN: read access, only needed while the repo is private.

# ---- source: the repository at REPO_REF ------------------------------------------
FROM alpine/git:latest AS clone
ARG REPO_URL=https://github.com/friidom/CV-PIPS-Project.git
ARG REPO_REF=main
RUN --mount=type=secret,id=GITHUB_TOKEN,required=false \
    set -e; git init -q /repo; cd /repo; \
    if [ -s /run/secrets/GITHUB_TOKEN ]; then \
      git config http.extraHeader "Authorization: Basic $(printf 'x-access-token:%s' "$(cat /run/secrets/GITHUB_TOKEN)" | base64 | tr -d '\n')"; \
    fi; \
    git fetch -q --depth 1 "$REPO_URL" "$REPO_REF"; \
    git checkout -q FETCH_HEAD; \
    rm -rf .git

# `--build-context source=<dir>` replaces this stage with a local checkout.
FROM scratch AS source
COPY --from=clone /repo /

# ---- the website: npm ci + vite build ----------------------------------------------
FROM node:22-slim AS web
WORKDIR /web
COPY --from=source /web/package.json /web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --from=source /web/index.html /web/vite.config.ts /web/tsconfig.json /web/tsconfig.app.json /web/tsconfig.node.json ./
COPY --from=source /web/src ./src
COPY --from=source /web/public ./public
# Same origin as the API, so VITE_API_BASE stays empty.
RUN npm run build

# ---- runtime: FastAPI + the pipeline -----------------------------------------------
FROM python:3.12-slim
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

# Spaces run the container as uid 1000.
RUN useradd -m -u 1000 user
WORKDIR /app

COPY --from=source /requirements.txt ./
COPY --from=source /server/requirements.txt ./server/
RUN pip install --no-cache-dir torch torchvision --index-url "$TORCH_INDEX" \
 && pip install --no-cache-dir -r server/requirements.txt

COPY --from=source /solution.py ./
COPY --from=source /src ./src
COPY --from=source /configs ./configs
COPY --from=source /weights ./weights
COPY --from=source /scripts ./scripts
COPY --from=source /server ./server
COPY --from=web /web/dist ./web/dist

USER user
ENV HOME=/home/user PYTHONUNBUFFERED=1 PORT=7860
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python -c "import urllib.request,os; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/api/health', timeout=4)"

# One process: jobs and live sessions live in its memory. Torch would otherwise start
# one thread per HOST core and oversubscribe a CPU quota; Spaces export CPU_CORES.
CMD ["sh", "-c", "export OMP_NUM_THREADS=${OMP_NUM_THREADS:-${CPU_CORES:-$(nproc)}}; exec uvicorn server.app:app --host 0.0.0.0 --port ${PORT} --workers 1 --timeout-keep-alive 75"]
