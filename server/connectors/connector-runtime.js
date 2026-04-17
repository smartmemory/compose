// compose/server/connectors/connector-runtime.js
/**
 * @interface ConnectorRuntime
 *
 * Stateful execution contract.
 * See agent-connector.js for the message envelope spec.
 */
export const ConnectorRuntimeInterface = {
  /** @yields typed message envelopes */
  async *run(_prompt, _opts) {},
  interrupt() {},
  get isRunning() { return false; },
};
