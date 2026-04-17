/**
 * connector-shape.test.js — shape compliance for all three concrete connectors.
 *
 * Verifies that ClaudeSDKConnector, OpencodeConnector, and CodexConnector each
 * expose the full discovery + runtime interface defined by AgentConnector.
 * Does not invoke any backend — shape-only checks.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeSDKConnector } from '../server/connectors/claude-sdk-connector.js';
import { OpencodeConnector } from '../server/connectors/opencode-connector.js';
import { CodexConnector, CODEX_MODEL_IDS } from '../server/connectors/codex-connector.js';

// Pick a valid Codex model dynamically so the test isn't brittle to set changes.
const VALID_CODEX_MODEL = [...CODEX_MODEL_IDS][0];

const connectors = [
  // ClaudeSDKConnector uses `model`, not `modelID`
  ['ClaudeSDKConnector', () => new ClaudeSDKConnector({ model: 'claude-sonnet-4-6' })],
  // OpencodeConnector requires both providerID and modelID
  ['OpencodeConnector',  () => new OpencodeConnector({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6' })],
  // CodexConnector validates modelID at construction — must be in CODEX_MODEL_IDS
  ['CodexConnector',     () => new CodexConnector({ modelID: VALID_CODEX_MODEL })],
];

for (const [name, factory] of connectors) {
  describe(`${name} — shape compliance`, () => {
    let conn;
    before(() => { conn = factory(); });

    it('has listModels() returning an array', () => {
      assert.equal(typeof conn.listModels, 'function');
      assert.ok(Array.isArray(conn.listModels()));
    });

    it('has supportsModel() returning a boolean', () => {
      assert.equal(typeof conn.supportsModel, 'function');
      assert.equal(typeof conn.supportsModel('any-model'), 'boolean');
    });

    it('has loadHistory() returning a Promise', () => {
      assert.equal(typeof conn.loadHistory, 'function');
      const result = conn.loadHistory('test-session');
      assert.ok(result instanceof Promise);
      return result;
    });

    it('has run() as an async generator function', () => {
      assert.equal(typeof conn.run, 'function');
      assert.equal(conn.run.constructor.name, 'AsyncGeneratorFunction');
    });

    it('has interrupt() method', () => {
      assert.equal(typeof conn.interrupt, 'function');
    });

    it('has isRunning getter returning boolean', () => {
      // Walk the prototype chain to find the getter descriptor
      let descriptor;
      let proto = Object.getPrototypeOf(conn);
      while (proto && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(proto, 'isRunning');
        proto = Object.getPrototypeOf(proto);
      }
      assert.ok(descriptor?.get, 'isRunning must be a getter');
      assert.equal(typeof conn.isRunning, 'boolean');
    });
  });
}
