/**
 * agentServer.js — COMP-COCKPIT-2.
 *
 * Single source of truth for the agent/terminal server base URL. The agent
 * server runs on AGENT_PORT (default 4002) on the **same hostname as the page**
 * — never hardcode localhost, or the pressure-test / terminal features break on
 * any non-localhost deploy (remote, staging, Docker).
 *
 * Note: the orchestrator API (agent spawn / status, port 4001) is same-origin as
 * the served cockpit and reached via relative `wsFetch('/api/...')`. Only the
 * directly-connected agent server (4002: stream, terminal/inject) needs this.
 */

export function agentServerUrl(path) {
  if (typeof window === 'undefined' || !window.location) return path;
  const port =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_AGENT_PORT) || '4002';
  return `${window.location.protocol}//${window.location.hostname}:${port}${path}`;
}
