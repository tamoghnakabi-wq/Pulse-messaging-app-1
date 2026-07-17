#!/usr/bin/env bash
# Start Pulse fully detached so it survives terminal/session timeouts.
# Usage: ./scripts/start-detached.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/logs"
LOG="$LOG_DIR/start-dev.log"
PID_FILE="$LOG_DIR/start-dev.pid"

mkdir -p "$LOG_DIR"

if [[ -f "$PID_FILE" ]]; then
  old="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${old:-}" ]] && kill -0 "$old" 2>/dev/null; then
    echo "Already running (pid $old). Log: $LOG"
    exit 0
  fi
fi

# Free app ports only (not MongoDB)
for port in 5050 5173 4040 2000; do
  lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | xargs kill -TERM 2>/dev/null || true
done
sleep 0.5

docker start pulse-mongodb >/dev/null 2>&1 || true

python3 - <<PY
import os, subprocess
os.chdir("$ROOT")
log = open("$LOG", "a", buffering=1)
proc = subprocess.Popen(
    ["node", "scripts/start-dev.js"],
    stdout=log,
    stderr=subprocess.STDOUT,
    stdin=subprocess.DEVNULL,
    start_new_session=True,
)
open("$PID_FILE", "w").write(str(proc.pid))
print(f"Started Pulse (pid {proc.pid})")
print(f"Log: $LOG")
PY

for i in $(seq 1 45); do
  if curl -sf -o /dev/null http://127.0.0.1:5050/api/health 2>/dev/null \
    && curl -sf -o /dev/null http://127.0.0.1:5173/ 2>/dev/null; then
    echo "Healthy."
    grep -E "trycloudflare\.com|Public URL" "$LOG" | tail -5 || true
    exit 0
  fi
  sleep 1
done

echo "Started but health check timed out — check $LOG"
exit 1
