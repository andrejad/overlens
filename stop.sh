#!/usr/bin/env bash
# Stops the development servers started by ./start.sh (use it from another terminal). Sends a
# graceful termination signal, waits up to 10 s, and force-kills only what is still running.
set -u
cd "$(dirname "$0")"

PIDFILE=.dev-servers.pid
BACKEND_PORT=${OVERLENS_PORT:-8080}
FRONTEND_PORT=5173

port_pid() { ss -ltnp "sport = :$1" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }

pids=()
if [ -f "$PIDFILE" ] && kill -0 "$(head -1 "$PIDFILE")" 2>/dev/null; then
  mapfile -t pids < "$PIDFILE"
else
  rm -f "$PIDFILE" # missing or stale (start.sh is gone): fall back to whatever holds the ports
  for p in "$BACKEND_PORT" "$FRONTEND_PORT"; do
    pid=$(port_pid "$p")
    if [ -n "$pid" ]; then
      echo "No PID file; port $p is held by pid $pid ($(ps -o comm= -p "$pid"))."
      pids+=("$pid")
    fi
  done
fi

if [ ${#pids[@]} -eq 0 ]; then
  echo "Nothing to stop: no dev servers found."
  exit 0
fi

kill -TERM "${pids[@]}" 2>/dev/null
for _ in $(seq 1 100); do
  alive=0
  for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
  [ $alive -eq 0 ] && break
  sleep 0.1
done
for pid in "${pids[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "pid $pid did not exit in 10s; killing it" >&2
    kill -KILL "$pid" 2>/dev/null
  fi
done
rm -f "$PIDFILE"
echo "Dev servers stopped."
