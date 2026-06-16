#!/usr/bin/env bash
# watch-server.sh — restart the Compose :4001 API server on source changes (dev).
#
# Frees the port first (killing any stale/orphaned `node server/index.js` left by a
# dead session — exactly the leftover that reds the pre-push test suite), then runs
# the server under Node's built-in --watch so any change in the loaded module graph
# (server/**, lib/**) triggers a clean restart. server/index.js handles SIGTERM with
# process.exit(0), so the port releases cleanly between restarts.
#
# Scope: the :4001 API server only. For the full stack (agent server :4002 + Vite),
# use `npm run dev:server` (the supervisor) — it crash-restarts but does NOT watch files.
#
# Usage: npm run dev:watch   (or: bash scripts/watch-server.sh ; PORT=4099 to override)
set -euo pipefail

PORT="${PORT:-4001}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Free the port so --watch can bind: kill any current listener (stale orphan or a
# previous run). lsof exits non-zero when nothing is listening — the `|| true`
# keeps `set -e` from tripping on the empty case.
stale="$(lsof -ti ":$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$stale" ]; then
  echo "[watch-server] freeing :$PORT — killing listener(s): $(echo "$stale" | tr '\n' ' ')"
  # shellcheck disable=SC2086  # word-splitting intended: $stale may hold several PIDs
  kill $stale 2>/dev/null || true
  sleep 1
fi

echo "[watch-server] node --watch server/index.js on :$PORT — edit server/** or lib/** to restart (Ctrl-C to stop)"
exec env PORT="$PORT" node --watch server/index.js
