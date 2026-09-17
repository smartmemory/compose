export const DEFAULT_GATE_TIMEOUT_MS = 30 * 60 * 1000;

/** Keep client polling and server-side lazy expiry on one timeout contract. */
export function resolveGateTimeoutMs(env = process.env) {
  return Number(env.COMPOSE_GATE_TIMEOUT) || DEFAULT_GATE_TIMEOUT_MS;
}
