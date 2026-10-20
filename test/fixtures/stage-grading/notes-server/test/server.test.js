// Golden suite: the MCP surface, over a real stdio child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/notes-server.js', import.meta.url));

function startServer() {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BIN], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  const waiting = [];
  lines.on('line', (l) => waiting.shift()?.(JSON.parse(l)));
  let next = 1;
  const send = (method, params) =>
    new Promise((resolve) => {
      waiting.push(resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next++, method, params }) + '\n');
    });
  const call = async (name, args) => {
    const { result } = await send('tools/call', { name, arguments: args });
    return { isError: result.isError, value: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
  };
  const stop = () => new Promise((resolve) => { child.on('close', resolve); child.stdin.end(); });
  return { send, call, stop, child };
}

test('initialize, tools/list and a write/search/recall round trip', async () => {
  const srv = startServer();
  try {
    const init = await srv.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'notes-server');
    srv.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await srv.send('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ['write_note', 'search_notes', 'recall_note']);

    const w = await srv.call('write_note', { title: 'Trip', body: 'Book the ferry to Hydra', tags: ['travel'] });
    assert.equal(w.isError, false);
    const byBody = await srv.call('search_notes', { query: 'ferry' });
    assert.deepEqual(byBody.value.map((n) => n.id), [w.value.id]);
    const byTitle = await srv.call('search_notes', { query: 'trip', tag: 'travel' });
    assert.deepEqual(byTitle.value.map((n) => n.id), [w.value.id]);
    const r = await srv.call('recall_note', { id: w.value.id });
    assert.equal(r.value.body, 'Book the ferry to Hydra');
  } finally {
    await srv.stop();
  }
});

test('tool errors come back as isError results; unknown methods as JSON-RPC errors', async () => {
  const srv = startServer();
  try {
    const bad = await srv.call('write_note', { body: 'no title' });
    assert.equal(bad.isError, true);
    assert.match(bad.value, /^INVALID:/);
    const unknown = await srv.call('delete_everything', {});
    assert.match(unknown.value, /^UNKNOWN_TOOL:/);
    const missing = await srv.send('resources/list', {});
    assert.equal(missing.error.code, -32601);
    const ping = await srv.send('ping');
    assert.deepEqual(ping.result, {});
  } finally {
    await srv.stop();
  }
});
