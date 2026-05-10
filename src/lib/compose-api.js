export const COMPOSE_API_TOKEN = import.meta.env.VITE_COMPOSE_API_TOKEN || '';

let _runtimeToken = null;

export function setSensitiveToken(t) {
  _runtimeToken = t || null;
}

export function getSensitiveToken() {
  return _runtimeToken || COMPOSE_API_TOKEN || '';
}

export function withComposeToken(headers = {}) {
  const tok = getSensitiveToken();
  if (!tok) return headers;
  return { ...headers, 'x-compose-token': tok };
}
