#!/usr/bin/env bash
# Starts the development servers in this terminal: the Go backend (port 8080) and the Vite frontend
# (port 5173). Ctrl+C (or ./stop.sh from another terminal) shuts both down gracefully.
set -u
cd "$(dirname "$0")"
export PATH="$HOME/.local/go/bin:$HOME/go/bin:$PATH"

PIDFILE=.dev-servers.pid
BACKEND_PORT=${ROADMAP_PORT:-8080}
FRONTEND_PORT=5173

port_busy() { ss -ltn "sport = :$1" | grep -q LISTEN; }

if [ -f "$PIDFILE" ] && kill -0 "$(head -1 "$PIDFILE")" 2>/dev/null; then
  echo "start.sh is already running (pid $(head -1 "$PIDFILE")). Use ./stop.sh first." >&2
  exit 1
fi
for p in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if port_busy "$p"; then
    echo "Port $p is already in use; run ./stop.sh or free it first." >&2
    exit 1
  fi
done
if [ ! -d web/node_modules ]; then
  echo "web/node_modules is missing; run 'cd web && npm install' first." >&2
  exit 1
fi

# Build the backend binary (instead of `go run`) so the process we signal is the server itself.
BIN_DIR=$(mktemp -d)
echo "[start] building backend..."
go build -o "$BIN_DIR/roadmap" ./cmd/roadmap || { rm -rf "$BIN_DIR"; exit 1; }

# LOG_PREFIX is cleared like in `make run`: the test prefix must not reach dev logs.
(LOG_PREFIX= exec "$BIN_DIR/roadmap" -config "$PWD/roadmap.conf") > >(sed -u 's/^/[backend]  /') 2>&1 &
BACKEND_PID=$!
(cd web && exec node_modules/.bin/vite) > >(sed -u 's/^/[frontend] /') 2>&1 &
FRONTEND_PID=$!
printf '%s\n%s\n%s\n' "$$" "$BACKEND_PID" "$FRONTEND_PID" > "$PIDFILE"

cleanup() {
  trap '' INT TERM
  echo
  echo "[start] shutting down..."
  kill -TERM "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
  for _ in $(seq 1 100); do
    kill -0 "$BACKEND_PID" 2>/dev/null || kill -0 "$FRONTEND_PID" 2>/dev/null || break
    sleep 0.1
  done
  for pid in "$BACKEND_PID" "$FRONTEND_PID"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "[start] pid $pid did not exit in 10s; killing it" >&2
      kill -KILL "$pid" 2>/dev/null
    fi
  done
  wait 2>/dev/null
  rm -rf "$BIN_DIR" "$PIDFILE"
  echo "[start] stopped."
}
trap 'cleanup; exit 0' INT TERM

echo "[start] backend  http://localhost:$BACKEND_PORT   frontend http://localhost:$FRONTEND_PORT   (Ctrl+C to stop)"
wait -n "$BACKEND_PID" "$FRONTEND_PID"
echo "[start] a server exited on its own; stopping the other one." >&2
cleanup
exit 1
