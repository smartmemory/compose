// compose/server/connectors/connector-discovery.js
/**
 * @interface ConnectorDiscovery
 *
 * Stateless vendor capability contract.
 * Implementations must not hold execution state.
 *
 * All three concrete connectors (ClaudeSDKConnector, CodexConnector, OpencodeConnector)
 * satisfy this interface. Shape verified by test/connector-shape.test.js.
 */
export const ConnectorDiscoveryInterface = {
  /** @returns {string[]} model IDs available for this vendor */
  listModels() {},
  /** @param {string} modelId @returns {boolean} */
  supportsModel(_modelId) {},
  /** @param {string} sessionId @returns {Promise<object[]>} message history */
  async loadHistory(_sessionId) { return []; },
};
