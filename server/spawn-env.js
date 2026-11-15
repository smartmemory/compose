/**
 * spawn-env.js — COMP-PROJECT-GRAPH-DOC-PANEL-1: the one place that builds the environment for a child Claude process.
 * `CLAUDECODE` marks "this process runs inside a Claude Code session"; a child that inherits it can refuse to start
 * or behave as a nested session. Every other variable (CLAUDE_CONFIG_DIR included) is inherited as is.
 */
export const STRIPPED_SESSION_MARKERS = ['CLAUDECODE'];

export function cleanSpawnEnv(extra = {}, base = process.env) {
  const env = { ...base, ...extra };
  for (const k of STRIPPED_SESSION_MARKERS) delete env[k];
  return env;
}
