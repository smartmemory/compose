/** Route interactive agent traffic through the API's workspace-aware proxy. */
export function agentServerUrl(path) {
  return path.replace(/^\/api\/agent\/(?!proxy\/)/, '/api/agent/proxy/');
}
