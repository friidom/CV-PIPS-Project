#!/usr/bin/env bash
# The live demo on the GPU server in one command: FastAPI (uvicorn, server.app:app) on
# port 8000, then a Cloudflare Quick Tunnel in front of it once /api/health answers.
#
#   git pull && ./start.sh        # from any directory; Ctrl+C stops both
#
# Settings are explicit here on purpose (no .env file). Logs: server.log, cloudflared.log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

PORT=8000
LOCAL_URL="http://localhost:$PORT"
HEALTH_URL="http://127.0.0.1:$PORT/api/health"

die() { echo "start.sh: $*" >&2; exit 1; }
nap() { sleep "$1" & wait $!; }  # a sleep that Ctrl+C interrupts at once
first_exe() { local f; for f; do [[ -f $f && -x $f ]] && { echo "$f"; return 0; }; done; return 1; }

# The environment and the tunnel binary live in the checkout or next to it.
PY=$(first_exe "$ROOT/.venv-wiut/bin/python" "$ROOT/../.venv-wiut/bin/python") \
  || die "no .venv-wiut/bin/python in $ROOT or its parent directory"
CLOUDFLARED=$(first_exe "$ROOT/cloudflared" "$ROOT/../cloudflared") \
  || die "no executable cloudflared in $ROOT or its parent directory"
command -v curl >/dev/null || die "curl is required"

# One server at a time: refuse while server.pid names a live process (another start.sh,
# possibly still importing before it binds) or while anything listens on the port.
if [[ -f server.pid ]] && kill -0 "$(cat server.pid)" 2>/dev/null; then
  die "already running (server.pid: $(cat server.pid)). Stop it with Ctrl+C in its terminal,
  or: kill \$(cat $ROOT/server.pid)    (if that pid is not the demo, delete the stale server.pid)"
fi
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  die "port $PORT is already in use by another process; stop it first."
fi

if [[ ! -f web/dist/index.html ]]; then
  echo "start.sh: warning: web/dist is missing; the API runs but the site is not served." >&2
  echo "  build it: (cd web && npm ci --no-audit --no-fund && npm run build)" >&2
elif [[ -n $(find web/src web/public web/index.html web/package.json -newer web/dist/index.html 2>/dev/null | head -n 1) ]]; then
  echo "start.sh: warning: web/ changed since the last build; the site may be stale." >&2
  echo "  rebuild: (cd web && npm ci --no-audit --no-fund && npm run build)" >&2
fi

SERVER_PID="" TUNNEL_PID=""
cleanup() {  # TERM both, KILL whatever is still up after 10 s; repeat signals cannot cut it short
  trap '' INT TERM HUP
  trap - EXIT
  echo "Stopping cloudflared and FastAPI..."
  local pid guard
  for pid in $TUNNEL_PID $SERVER_PID; do kill -TERM "$pid" 2>/dev/null; done
  ( sleep 10; kill -KILL $TUNNEL_PID $SERVER_PID 2>/dev/null ) &
  guard=$!
  for pid in $TUNNEL_PID $SERVER_PID; do wait "$pid" 2>/dev/null; done
  kill -KILL "$guard" 2>/dev/null; wait "$guard" 2>/dev/null
  [[ $(cat server.pid 2>/dev/null) == "$SERVER_PID" ]] && rm -f server.pid
  echo "Stopped."
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# env -u LD_LIBRARY_PATH: the B200 CUDA/cuDNN workaround (torch loads its own bundled libraries).
# One worker: jobs and live sessions live in this process's memory.
env -u LD_LIBRARY_PATH OMP_NUM_THREADS=16 DEMO_MAX_DURATION_SEC=120 \
  "$PY" -m uvicorn server.app:app --host 0.0.0.0 --port "$PORT" --workers 1 --timeout-keep-alive 75 \
  > server.log 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > server.pid
echo "FastAPI starting (pid $SERVER_PID, python $PY, log server.log)..."

for i in $(seq 1 180); do
  curl -fsS --noproxy '*' --max-time 2 -o /dev/null "$HEALTH_URL" 2>/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -n 20 server.log >&2; die "FastAPI exited during startup (see server.log)"; }
  [[ $i == 180 ]] && die "FastAPI did not answer $HEALTH_URL within 180 s (see server.log)"
  nap 1
done
echo "FastAPI ready: $(curl -s --noproxy '*' --max-time 2 "$HEALTH_URL")"

"$CLOUDFLARED" tunnel --url "$LOCAL_URL" > cloudflared.log 2>&1 &
TUNNEL_PID=$!
echo "cloudflared starting (pid $TUNNEL_PID, log cloudflared.log)..."

PUBLIC_URL=""
for i in $(seq 1 60); do
  PUBLIC_URL=$(grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' cloudflared.log | grep -v '^https://api\.' | head -n 1)
  [[ -n $PUBLIC_URL ]] && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || { tail -n 20 cloudflared.log >&2; die "cloudflared exited (see cloudflared.log)"; }
  nap 1
done

cat <<EOF

  Local:   $LOCAL_URL
  Public:  ${PUBLIC_URL:-not printed yet (grep trycloudflare cloudflared.log)}
  Config:  DEMO_MAX_DURATION_SEC=120  OMP_NUM_THREADS=16  (set in start.sh)
  Logs:    tail -f server.log cloudflared.log
  Ctrl+C stops both.

EOF

# Stay up while both run; if either one exits, stop the other.
while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$TUNNEL_PID" 2>/dev/null; do nap 2; done
if kill -0 "$SERVER_PID" 2>/dev/null; then tail -n 20 cloudflared.log >&2; die "cloudflared exited (see cloudflared.log)"; fi
tail -n 20 server.log >&2; die "FastAPI exited (see server.log)"
