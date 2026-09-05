import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentRunRequest } from '../lib/stratum-mcp-client.js';

test('explicit empty tool allowlist is preserved rather than enabling default tools', () => {
  assert.deepEqual(buildAgentRunRequest('claude', 'probe', { allowedTools: [] }).allowedTools, []);
});
