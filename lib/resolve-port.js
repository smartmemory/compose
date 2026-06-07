/**
 * Canonical port resolution for the Compose server.
 * Single source of truth: COMPOSE_PORT > PORT > 4001.
 *
 * The default MUST match server/index.js (`PORT || 4001`) and the supervisor,
 * which start the API server on 4001. A stale 3001 default here silently sent
 * every CLI probe / MCP lifecycle call / agent-hook to a dead port while the
 * real server was alive on 4001 — gates fell back to readline, completions and
 * loops failed with ECONNREFUSED.
 */
export function resolvePort() {
  return Number(process.env.COMPOSE_PORT) || Number(process.env.PORT) || 4001;
}
