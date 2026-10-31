#!/usr/bin/env bash
# On-demand supervised start of the Compose cockpit (API 4001, agent 4002, UI 5195), all on 127.0.0.1.
# Usage: scripts/cockpit.sh start|stop|status. Ports are registered to `compose` in ~/.ports.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="${COMPOSE_RUN_DIR:-$HOME/.compose/run}"
PIDFILE="$RUN/cockpit.pid"
LOG="$RUN/cockpit.log"
PORTS="${PORT:-4001} ${AGENT_PORT:-4002} ${VITE_PORT:-5195}"  # same env names the supervisor reads

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

# The wiki owner token: when the project's `.compose/compose.json` wiki block names a token env var that is not already set,
# read the Mac wiki host's sealed 0600 file (wiki `mac_host.sealed_dir_default`, `wiki-owner-token`) into that var for the
# supervisor only. The value is never echoed. The supervisor hands it to the API server alone (`wikiChildEnv`).
WIKI_SEALED_DIR="${WIKI_SEALED_DIR:-$HOME/.config/smartmemory-wiki/sealed}"
wiki_token_name() {
  node --input-type=module -e "import { readWikiConfig, checkWikiConfig } from './server/wiki-routes.js'; const c = checkWikiConfig(readWikiConfig(process.argv[1])); if (c.ok) console.log(c.tokenEnv);" "${COMPOSE_TARGET:-$HERE}" 2>/dev/null
}
# Exports the var named $1 from the sealed file $2 unless the var is already set. A symlink is never read.
# Returns 1 when the file is missing, empty or a symlink. The value is never echoed.
load_sealed_var() {
  local name="$1" f="$WIKI_SEALED_DIR/$2"
  [ -n "${!name:-}" ] && return 0
  if [ ! -L "$f" ] && [ -f "$f" ] && [ -r "$f" ] && [ -s "$f" ]; then export "$name=$(<"$f")"; return 0; fi
  return 1
}
load_wiki_token() {
  local name; name="$(cd "$HERE" && wiki_token_name)"
  [ -n "$name" ] || return 0
  local f="$WIKI_SEALED_DIR/wiki-owner-token"
  load_sealed_var "$name" wiki-owner-token || echo "wiki token: $name not set and $f is missing, the Wiki tab will answer token_missing"
}

# The LOCAL SmartMemory key for Recall (COMP-COCKPIT-WIRING-1 gap 6): the env var named by `smartmemory.apiKeyEnv`,
# from the sealed file `compose-sm-key` in the same dir (written by scripts/sealed-put.mjs). Loaded only when the
# smartmemory block is enabled and its baseUrl is loopback (`smartmemoryKeyEnv`). API server only, like the wiki token.
sm_key_name() {
  node --input-type=module -e "import { getSmartmemoryConfig, smartmemoryKeyEnv } from './lib/smartmemory-config.js'; const n = smartmemoryKeyEnv(getSmartmemoryConfig(process.argv[1])); if (n) console.log(n);" "${COMPOSE_TARGET:-$HERE}" 2>/dev/null
}
load_sm_key() {
  local name; name="$(cd "$HERE" && sm_key_name)"
  [ -n "$name" ] || return 0
  load_sealed_var "$name" compose-sm-key || echo "smartmemory key: $name not set and $WIKI_SEALED_DIR/compose-sm-key is missing, Recall will answer missing api key"
}

cmd_start() {
  mkdir -p "$RUN"
  if alive "$(sup_pid)"; then echo "already running pid $(sup_pid)"; return 0; fi
  for p in $PORTS; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "port $p is already in use, refusing to start (python3 ~/.claude/scripts/port_check.py $p)"; return 1
    fi
  done
  (load_wiki_token; load_sm_key; cd "$HERE" && nohup node server/supervisor.js > "$LOG" 2>&1 & echo $! > "$PIDFILE")
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

# Sourced by test/wiki-token-env.test.js, which calls load_wiki_token and load_sm_key directly.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    status) cmd_status ;;
    *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
  esac
fi
