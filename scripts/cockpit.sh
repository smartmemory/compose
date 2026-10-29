#!/usr/bin/env bash
# On-demand supervised start of the Compose cockpit (API 4001, agent 4002, UI 5195), all on 127.0.0.1.
# Usage: scripts/cockpit.sh start|stop|status. Ports are registered to `compose` in ~/.ports.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$HOME/.compose/run"
PIDFILE="$RUN/cockpit.pid"
LOG="$RUN/cockpit.log"
PORTS="4001 4002 5195"

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
sup_pid() { [ -f "$PIDFILE" ] && cat "$PIDFILE"; }
listening() { lsof -nP -iTCP@127.0.0.1:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

cmd_status() {
  local pid; pid="$(sup_pid)"
  if alive "$pid"; then echo "supervisor: running pid $pid"; else echo "supervisor: stopped"; fi
  for p in $PORTS; do
    if listening "$p"; then echo "port $p: listening on 127.0.0.1"; else echo "port $p: down"; fi
  done
  alive "$pid"
}

cmd_start() {
  mkdir -p "$RUN"
  if alive "$(sup_pid)"; then echo "already running pid $(sup_pid)"; return 0; fi
  for p in $PORTS; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "port $p is already in use, refusing to start (python3 ~/.claude/scripts/port_check.py $p)"; return 1
    fi
  done
  (cd "$HERE" && nohup node server/supervisor.js > "$LOG" 2>&1 & echo $! > "$PIDFILE")
  local deadline=$((SECONDS+90))
  for p in $PORTS; do
    until listening "$p"; do
      if ! alive "$(sup_pid)"; then echo "supervisor exited early, see $LOG"; return 1; fi
      if [ $SECONDS -ge $deadline ]; then echo "port $p did not answer in 90s, see $LOG"; return 1; fi
      sleep 1
    done
  done
  echo "cockpit up: http://127.0.0.1:5195 (pid $(sup_pid), log $LOG)"
}

cmd_stop() {
  local pid; pid="$(sup_pid)"
  if ! alive "$pid"; then echo "not running"; rm -f "$PIDFILE"; return 0; fi
  local kids; kids="$(pgrep -P "$pid" || true)"
  kill -TERM "$pid" 2>/dev/null
  local i=0
  while alive "$pid" && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done
  alive "$pid" && kill -KILL "$pid" 2>/dev/null
  # Only the supervisor's own children, by pid captured above. Never pkill.
  for k in $kids; do alive "$k" && kill -TERM "$k" 2>/dev/null; done
  sleep 1
  for k in $kids; do alive "$k" && kill -KILL "$k" 2>/dev/null; done
  rm -f "$PIDFILE"
  echo "stopped"
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
