/**
 * stratum-connection.js — one Stratum TS MCP connection PER target project root,
 * shared by every cockpit route that dispatches an agent run (design conversation,
 * COMP-PIPE-EDIT-CHAT-PANE-1 spec chat). Lifted verbatim from design-routes.js with
 * no behaviour change; design-routes re-exports the old names.
 */

import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { getTargetRoot } from './project-root.js';
import { resolveStratumMcpConnection } from '../lib/stratum-engine.js';

// Lazy per-project-root singletons — design conversations share one Stratum TS
// MCP connection PER target project root. H2: keying on root (and threading the
// root into the connection) is load-bearing. `resolveStratumMcpConnection(root)`
// reads the project's `.compose/compose.json` engine pin and THROWS the
// python-legacy error for a python-pinned project; connecting without a cwd (the
// old behaviour) resolved the process cwd and silently handed a python project a
// TS engine, and the single cached client leaked across project switches. Keying
// the cache on root re-resolves the engine on every project switch.
const _stratumClients = new Map();         // root key -> connected client
const _stratumConnectPromises = new Map(); // root key -> in-flight connect promise

export async function getStratum(root = getTargetRoot(), { factory } = {}) {
  const key = root || '';
  if (_stratumClients.has(key)) return _stratumClients.get(key);
  if (!_stratumConnectPromises.has(key)) {
    // Throws synchronously for a python-pinned (or otherwise invalid) root, before
    // any subprocess is spawned — the caller sees a rejected promise.
    const connection = resolveStratumMcpConnection(root);
    const c = factory ? factory() : new StratumMcpClient();
    const p = c.connect(connection)
      .then(() => { _stratumClients.set(key, c); return c; })
      .catch((err) => { _stratumConnectPromises.delete(key); throw err; });
    _stratumConnectPromises.set(key, p);
  }
  return _stratumConnectPromises.get(key);
}

/** Tear down an evicted workspace's connection, or all connections at shutdown. */
export async function closeStratum(projectRoot) {
  const keys = projectRoot === undefined ? [..._stratumConnectPromises.keys()] : [projectRoot];
  const clients = keys.map(key => _stratumClients.get(key)).filter(Boolean);
  for (const key of keys) { _stratumClients.delete(key); _stratumConnectPromises.delete(key); }
  for (const c of clients) {
    try { await c.close(); } catch { /* ignore */ }
  }
}
