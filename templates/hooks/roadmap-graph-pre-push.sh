#!/usr/bin/env bash
# Compose roadmap-graph pre-push gate — COMP-ROADMAP-GRAPH-1-1.
#
# Blocks a push when the project's roadmap dependency graph is broken or stale:
#   • a deps.yaml edge points at a feature that exists nowhere (DANGLING_EDGE —
#     the Cytoscape-crash bug class), or
#   • the committed roadmap-graph.html no longer matches a fresh regeneration
#     (someone hand-edited it, or changed feature.json / deps.yaml / frontmatter
#     without regenerating).
#
# OPT-IN by file presence: if the graph file does not exist, this project is not
# using the graph and the gate no-ops. Generate + commit the graph once
# (`compose roadmap graph`) to turn the gate on.
#
# Use it one of two ways:
#   1. Standalone — copy to .git/hooks/pre-push and `chmod +x`. Executed
#      directly, it runs the gate and exits with its status.
#   2. Compose with an existing hook — `source` this file from your pre-push
#      hook and call the function yourself, so you can combine gates:
#        source path/to/roadmap-graph-pre-push.sh
#        roadmap_graph_gate || exit 1
#      When sourced it only DEFINES the function (no exit), so it never
#      terminates your shell.
#
# Config (env):
#   COMPOSE           command used to invoke compose (default: "compose")
#   COMPOSE_GRAPH_OUT path to the graph HTML (default: "roadmap-graph.html";
#                     set this if compose.json#roadmap_graph.out is customized)

roadmap_graph_gate() {
  local compose="${COMPOSE:-compose}"
  local out="${COMPOSE_GRAPH_OUT:-roadmap-graph.html}"

  # Opt-in: no graph on disk → not in use → skip silently.
  [ -f "$out" ] || return 0

  if ! $compose roadmap graph --check --out "$out" >&2; then
    echo "" >&2
    echo "pre-push: roadmap graph is broken or stale — push aborted." >&2
    echo "  Fix: \`$compose roadmap graph\` (regenerate), or repair the dangling deps.yaml edge above." >&2
    echo "  Bypass at your own risk: git push --no-verify" >&2
    return 1
  fi
  return 0
}

# Executed directly (not sourced): run the gate and exit with its status.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  roadmap_graph_gate
  exit $?
fi
