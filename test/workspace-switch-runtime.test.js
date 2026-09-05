import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const repo = path.resolve(import.meta.dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let n = 0; n < 120; n++) { const value = await check(); if (value) return value; await pause(25); }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }

// This launches the production entrypoint. No route/store/manager is mocked;
// only the paid CLI executable is replaced with a cwd-reporting local process.
test('production HTTP server switches all workspace services and preserves running A work', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-switch-runtime-'));
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  for (const [root, id, theme, guardAuth] of [[a, 'switch-a', 'light', false], [b, 'switch-b', 'dark', true]]) {
    write(path.join(root, '.compose/compose.json'), JSON.stringify({ workspaceId: id, capabilities: { stratum: false, guardAuth }, paths: { features: 'specs/features' } }));
    write(path.join(root, '.compose/data/settings.json'), JSON.stringify({ ui: { theme }, models: { interactive: `model-${id}` } }));
    write(path.join(root, 'docs/readme.md'), id);
    write(path.join(root, '.compose/data/pipeline-draft.json'), JSON.stringify({ instruction: id, spec: id }));
    fs.mkdirSync(path.join(root, 'specs/features'), { recursive: true });
    fs.mkdirSync(path.join(root, 'pipelines'), { recursive: true });
  }
  const cli = path.join(dir, 'bin/claude');
  write(cli, `#!${process.execPath}\nconst fs=require('fs'); fs.writeFileSync('spawn-cwd.json',JSON.stringify({cwd:process.cwd(),target:process.env.COMPOSE_TARGET})); console.log(process.cwd()); const timer=setInterval(()=>{if(fs.existsSync('release-agent')){clearInterval(timer);process.exit(0);}},20);`);
  fs.chmodSync(cli, 0o755);
  const port = await freePort();
  const oldPort = process.env.COMPOSE_PORT, oldToken = process.env.COMPOSE_API_TOKEN;
  process.env.COMPOSE_PORT = String(port); process.env.COMPOSE_API_TOKEN = 'switch-token';
  const { createAgentApp } = await import('../server/agent-workspace.js');
  const queries = [];
  const sdk = createAgentApp({ query: ({ prompt, options }) => {
    let release;
    const done = new Promise(resolve => { release = resolve; });
    const record = { prompt, options, returned: false, release };
    queries.push(record);
    return {
      async *[Symbol.asyncIterator]() {
        await options.hooks.SessionStart[0].hooks[0]({ source: 'startup' });
        yield { type: 'system', subtype: 'init', session_id: `sdk-${path.basename(options.cwd)}` };
        await done;
      },
      return() { record.returned = true; release(); },
      interrupt() { release(); },
    };
  } });
  const sdkServer = http.createServer(sdk.app); sdkServer.listen(0, '127.0.0.1'); await once(sdkServer, 'listening');
  const agentPort = sdkServer.address().port;
  t.after(async () => {
    sdk.close(); sdkServer.closeAllConnections(); await new Promise(resolve => sdkServer.close(resolve));
    if (oldPort === undefined) delete process.env.COMPOSE_PORT; else process.env.COMPOSE_PORT = oldPort;
    if (oldToken === undefined) delete process.env.COMPOSE_API_TOKEN; else process.env.COMPOSE_API_TOKEN = oldToken;
  });
  const child = spawn(process.execPath, ['server/index.js'], { cwd: repo, env: { ...process.env, COMPOSE_TARGET: a, PORT: String(port), AGENT_PORT: String(agentPort), COMPOSE_HOST: '127.0.0.1', COMPOSE_API_TOKEN: 'switch-token', PATH: `${path.dirname(cli)}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', c => { logs += c; }); child.stderr.on('data', c => { logs += c; });
  const sockets = [];
  t.after(async () => { write(path.join(a, 'release-agent'), ''); write(path.join(b, 'release-agent'), ''); for (const s of sockets) s.terminate(); child.kill('SIGTERM'); await once(child, 'exit').catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${port}`;
  async function request(route, method = 'GET', body, headers = {}) {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  await until(async () => { try { return (await request('/api/health')).status === 200; } catch { if (child.exitCode !== null) throw new Error(logs); } }, 'server startup');
  assert.equal((await request('/api/settings')).body.ui.theme, 'light');
  assert.equal((await request('/api/pipeline/draft')).body.draft.instruction, 'switch-a');
  assert.equal((await request('/api/agent/proxy/session', 'POST', { prompt: 'sdk-A' })).status, 200);
  await until(async () => (await request('/api/agent/proxy/session/status')).body.sessionId === 'sdk-a', 'SDK A init');
  // createAgentApp realpaths its target root (/var -> /private/var on macOS).
  assert.equal(queries[0].options.cwd, fs.realpathSync(a));
  assert.equal(queries[0].options.model, 'model-switch-a');
  const startA = await request('/api/session/start', 'POST', {}); assert.equal(startA.status, 200);
  assert.equal((await request('/api/agent/spawn', 'POST', { id: 'agent-a', prompt: 'fixture' }, { 'x-compose-token': 'switch-token' })).status, 201);
  await until(() => fs.existsSync(path.join(a, 'spawn-cwd.json')), 'A subprocess');
  assert.equal((await request('/api/project/switch', 'POST', { path: b })).status, 200);
  assert.equal((await request('/api/settings')).body.ui.theme, 'dark');
  assert.equal((await request('/api/pipeline/draft')).body.draft.instruction, 'switch-b');
  assert.equal((await request('/api/session/current')).body.session, null);
  assert.equal((await request('/api/agent/proxy/session/status')).body.sessionId, null);
  assert.equal((await request('/api/agent/proxy/session', 'POST', { prompt: 'sdk-B' })).status, 200);
  await until(async () => (await request('/api/agent/proxy/session/status')).body.sessionId === 'sdk-b', 'SDK B init');
  assert.equal(queries[0].returned, false, 'A SDK query must survive switching and starting B');
  assert.equal(queries[1].options.cwd, fs.realpathSync(b));
  assert.equal(queries[1].options.env.COMPOSE_TARGET, fs.realpathSync(b));
  assert.equal(queries[1].options.model, 'model-switch-b');
  assert.equal((await request('/api/agent/proxy/session/status', 'GET', undefined, { 'x-compose-workspace-id': 'switch-a' })).body.sessionId, 'sdk-a');
  // Invoke A hook after switching B: the production hook must still post into A.
  await queries[0].options.hooks.SessionStart[0].hooks[0]({ source: 'resume' });
  assert.equal((await request('/api/session/current', 'GET', undefined, { 'x-compose-workspace-id': 'switch-a' })).body.session.source, 'resume');
  assert.equal((await request('/api/session/current')).body.session.source, 'startup');
  assert.equal((await request('/api/file?path=docs/readme.md')).body.content, 'switch-b');
  assert.equal((await request('/api/settings', 'PATCH', { ui: { theme: 'system' } })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(a, '.compose/data/settings.json'))).ui.theme, 'light');
  assert.equal(JSON.parse(fs.readFileSync(path.join(b, '.compose/data/settings.json'))).ui.theme, 'system');
  // B's guardAuth is loaded at route construction; startup A did not require it.
  assert.equal((await request('/api/vision/items', 'POST', { title: 'B feature', type: 'feature' })).status, 401);
  const item = await request('/api/vision/items', 'POST', { title: 'B feature', type: 'feature' }, { 'x-compose-token': 'switch-token' }); assert.equal(item.status, 201);
  const itemId = item.body.id;
  assert.equal((await request(`/api/vision/items/${itemId}/lifecycle/start`, 'POST', { featureCode: 'SWITCH-1' }, { 'x-compose-token': 'switch-token' })).status, 200);
  assert.equal((await request(`/api/vision/items/${itemId}/artifacts/scaffold`, 'POST', {})).status, 200);
  assert.ok(fs.existsSync(path.join(b, 'specs/features/SWITCH-1')));
  assert.ok(!fs.existsSync(path.join(a, 'specs/features/SWITCH-1')));
  assert.equal((await request('/api/agent/spawn', 'POST', { id: 'agent-b', prompt: 'fixture' }, { 'x-compose-token': 'switch-token' })).status, 201);
  await until(() => fs.existsSync(path.join(b, 'spawn-cwd.json')), 'B subprocess');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b, 'spawn-cwd.json'))), { cwd: fs.realpathSync(b), target: b });
  write(path.join(a, 'release-agent'), '');
  await until(async () => (await request('/api/agent/agent-a', 'GET', undefined, { 'x-compose-workspace-id': 'switch-a' })).body.status === 'complete', 'A completion after B switch');
  const registryA = JSON.parse(fs.readFileSync(path.join(a, '.compose/data/agents.json')));
  assert.ok(JSON.stringify(registryA).includes('complete'));
  assert.ok(!fs.readFileSync(path.join(b, '.compose/data/agents.json'), 'utf8').includes('agent-a'));
  // Header-selected A uses A's retained services while B remains the UI default.
  assert.equal((await request('/api/settings', 'GET', undefined, { 'x-compose-workspace-id': 'switch-a' })).body.ui.theme, 'light');
  assert.equal((await request('/api/project')).body.targetRoot, b);
  const unprepared = path.join(b, 'child');
  write(path.join(unprepared, '.compose/compose.json'), JSON.stringify({ workspaceId: 'unprepared-child', capabilities: { stratum: false } }));
  assert.equal((await request('/api/settings', 'PATCH', { ui: { theme: 'dark' } }, { 'x-compose-workspace-id': 'unprepared-child' })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(unprepared, '.compose/data/settings.json'))).ui.theme, 'dark');
  assert.equal(JSON.parse(fs.readFileSync(path.join(b, '.compose/data/settings.json'))).ui.theme, 'system');
  const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws/vision?workspaceId=switch-a`);
  sockets.push(wsA);
  const aFrames = []; wsA.on('message', msg => aFrames.push(JSON.parse(msg)));
  await once(wsA, 'open');
  await until(() => aFrames.some(frame => frame.type === 'settingsState'), 'explicit A socket hydration');
  assert.equal(aFrames.find(frame => frame.type === 'settingsState').settings.ui.theme, 'light');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/files`); sockets.push(ws); await once(ws, 'open');
  const events = []; ws.on('message', msg => events.push(JSON.parse(msg)));
  write(path.join(a, 'docs/readme.md'), 'A changed'); write(path.join(b, 'docs/readme.md'), 'B changed');
  await until(() => events.some(e => e.content === 'B changed'), 'B file watcher');
  assert.ok(!events.some(e => e.content === 'A changed'));
  const bad = path.join(dir, 'blocked'); fs.mkdirSync(bad); write(path.join(bad, '.compose'), 'file blocks data directory');
  assert.equal((await request('/api/project/switch', 'POST', { path: bad })).status, 400);
  assert.equal((await request('/api/project/switch', 'POST', { path: path.join(b, 'docs/readme.md') })).status, 400);
  const corrupt = path.join(dir, 'corrupt');
  write(path.join(corrupt, '.compose/compose.json'), '{');
  assert.equal((await request('/api/project/switch', 'POST', { path: corrupt })).status, 400);
  assert.equal((await request('/api/project')).body.targetRoot, b);
  assert.equal((await request('/api/settings')).body.ui.theme, 'system');
  assert.equal((await request('/api/project/switch', 'POST', { path: a })).status, 200);
  assert.equal((await request('/api/agent/agent-a')).body.status, 'complete');
  assert.equal((await request('/api/settings')).body.ui.theme, 'light');
  assert.ok(!logs.includes('Uncaught exception'), logs);
});
