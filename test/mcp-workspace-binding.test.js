import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Real JSON-RPC transport and server entrypoint: set_workspace must override
// COMPOSE_TARGET and never emit project-switch diagnostics on protocol stdout.
test('MCP rebind persists beyond the boot target through actual stdio requests', { timeout: 15000 }, async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-mcp-binding-'));
  const roots = ['a', 'b'].map(name => path.join(parent, name));
  for (const [index, root] of roots.entries()) {
    fs.mkdirSync(path.join(root, '.compose/data'), { recursive: true });
    fs.writeFileSync(path.join(root, '.compose/compose.json'), JSON.stringify({ workspaceId: `mcp-${index}`, capabilities: { stratum: false } }));
    fs.writeFileSync(path.join(root, '.compose/data/vision-state.json'), JSON.stringify({ items: [{ id: `item-${index}`, title: `Workspace ${index}`, type: 'feature' }] }));
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(import.meta.dirname, '../server/compose-mcp.js')], cwd: parent, env: { ...process.env, COMPOSE_TARGET: roots[0] }, stderr: 'pipe' });
  const client = new Client({ name: 'workspace-binding-probe', version: '1' });
  const errors = []; client.onerror = error => errors.push(error.message);
  t.after(async () => { await client.close(); fs.rmSync(parent, { recursive: true, force: true }); });
  await client.connect(transport);
  const invoke = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content.find(c => c.type === 'text').text);
  };
  assert.equal((await invoke('get_vision_items')).items[0].id, 'item-0');
  assert.equal((await invoke('set_workspace', { workspaceId: 'mcp-1' })).root, fs.realpathSync(roots[1]));
  assert.equal((await invoke('get_vision_items')).items[0].id, 'item-1');
  assert.equal((await invoke('get_vision_items')).items[0].id, 'item-1');
  assert.deepEqual(errors, []);
});

test('awaiting MCP work retains its root and bound-feature policy while another call rebinds', async () => {
  const { withProjectContext } = await import('../server/project-root.js');
  const { _testOnly_setSessionContext, _getBoundFeatureCode, _getSessionProfile } = await import('../server/compose-mcp-tools.js');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const a = { targetRoot: '/workspace-policy/a', workspaceId: 'policy-a' };
  const b = { targetRoot: '/workspace-policy/b', workspaceId: 'policy-b' };
  const pending = withProjectContext(a, async () => {
    _testOnly_setSessionContext({ profile: 'reviewer', boundFeatureCode: 'A-1' });
    await gate;
    assert.equal(_getBoundFeatureCode(), 'A-1');
    assert.equal(_getSessionProfile(), 'reviewer');
  });
  withProjectContext(b, () => {
    _testOnly_setSessionContext({ profile: 'implementer', boundFeatureCode: 'B-1' });
    assert.equal(_getBoundFeatureCode(), 'B-1');
    assert.equal(_getSessionProfile(), 'implementer');
  });
  release();
  await pending;
});
