import { resolvePort } from './resolve-port.js';

/**
 * Probe whether the Compose server is reachable.
 * @param {number} [port] - Server port (default: resolvePort())
 * @param {number} [timeoutMs=500] - Timeout in ms
 * @returns {Promise<boolean>} true if server responds 2xx to GET /api/health
 */
export async function probeServer(port, timeoutMs = 500) {
  const p = port ?? resolvePort();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://localhost:${p}/api/health`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe whether the Compose server can resolve a specific workspace.
 * Uses a workspace-scoped, read-only endpoint because /api/health is exempt
 * from workspace resolution and therefore cannot prove addressability.
 *
 * @param {number} [port] - Server port (default: resolvePort())
 * @param {string} workspaceId - Workspace id to resolve
 * @param {number} [timeoutMs=500] - Timeout in ms
 * @returns {Promise<boolean>} true only when the workspace-scoped request succeeds
 */
export async function probeWorkspace(port, workspaceId, timeoutMs = 500) {
  if (!workspaceId) return false;
  const p = port ?? resolvePort();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://localhost:${p}/api/vision/items`, {
      signal: controller.signal,
      headers: { 'X-Compose-Workspace-Id': workspaceId },
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
