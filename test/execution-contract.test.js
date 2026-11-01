import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentRunRequest } from '../lib/stratum-mcp-client.js';

test('explicit empty tool allowlist is preserved rather than enabling default tools', () => {
  assert.deepEqual(buildAgentRunRequest('claude', 'probe', { allowedTools: [] }).allowedTools, []);
});

// COMP-PIPE-EDIT-CHAT-PANE-1 F6: the isolation pair reaches stratum_agent_run by presence, so a
// caller's isolated:false or empty systemPrompt is judged by Stratum, never dropped here.
test('isolated and systemPrompt are forwarded by presence and omitted when absent', () => {
  const req = buildAgentRunRequest('claude', 'probe', { isolated: true, systemPrompt: 'sys', allowedTools: [] });
  assert.equal(req.isolated, true);
  assert.equal(req.systemPrompt, 'sys');
  assert.equal(buildAgentRunRequest('claude', 'probe', { isolated: false, systemPrompt: '' }).isolated, false);
  assert.equal(buildAgentRunRequest('claude', 'probe', { isolated: false, systemPrompt: '' }).systemPrompt, '');
  const plain = buildAgentRunRequest('claude', 'probe', {});
  assert.equal('isolated' in plain, false);
  assert.equal('systemPrompt' in plain, false);
});
