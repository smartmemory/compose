/** Review-1 reproductions through the real CLI and its installed signal handlers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/compose.js', import.meta.url));
const clientUrl = new URL('../lib/stratum-mcp-client.js', import.meta.url).href;
const visionUrl = new URL('../lib/vision-writer.js', import.meta.url).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runScenario(t, scenario) {
  const root = mkdtempSync(join(tmpdir(), 'cancel-review1-'));
  t.after(() => {
    const probePath = join(root, 'probe-path.txt');
    if (existsSync(probePath)) rmSync(readFileSync(probePath, 'utf8'), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const data = join(root, '.compose', 'data');
  mkdirSync(data, { recursive: true });
  mkdirSync(join(root, 'pipelines'));
  mkdirSync(join(root, 'docs', 'features', 'R1'), { recursive: true });
  writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({ capabilities: { stratum: true, stratumEngine: 'ts' } }));
  writeFileSync(join(data, 'vision-state.json'), JSON.stringify({ items: [{ id: 'r1-item', status: 'planned', lifecycle: { featureCode: 'R1' } }], connections: [], gates: [] }));
  writeFileSync(join(root, 'pipelines', 'build.stratum.yaml'), `version: 1
contracts:
  Result:
    value: string
flows:
  entry: main
  main:
    steps:
      - id: work
        agent: claude
        do: work
        out: Result
`);
  if (scenario === 'preflight') {
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git(['init', '-q']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'fixture']);
  }
  const preload = join(root, 'preload.mjs');
  writeFileSync(preload, `
import { StratumMcpClient } from ${JSON.stringify(clientUrl)};
import { VisionWriter } from ${JSON.stringify(visionUrl)};
import { writeFileSync, appendFileSync } from 'node:fs';
const scenario = ${JSON.stringify(scenario)};
const mark = event => appendFileSync('events.txt', event + '\\n');
const client = StratumMcpClient.prototype;
client.connect = async () => {};
client.close = async () => {};
client.onEvent = () => () => {};
client.plan = async () => ({ status: 'ready', runId: 'r1-flow', ready: [{ id: 'work', agent: 'claude', do: 'work', dispatchToken: 'token' }] });
client.audit = async () => ({ status: 'completed', steps: [] });
client.flowCancel = async () => { mark('flow-cancel'); return { status: 'cancelled', flowSettled: true }; };
client.runAgentText = async (_agent, _prompt, opts) => {
  writeFileSync('probe-path.txt', opts.cwd);
  mark('preflight-entered');
  opts.signal.addEventListener('abort', () => mark('preflight-aborted'), { once: true });
  // Deliberately ignores abort: teardown must not await a wedged agent/pump.
  return new Promise(() => {});
};
client.agentRun = async (_agent, _prompt, opts) => {
  if (scenario === 'completion') return { text: '{"value":"ok"}' };
  mark('agent-entered');
  return new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('agent aborted')), { once: true });
  });
};
client.stepDone = async () => {
  mark('final-stepDone');
  process.emit('SIGINT');
  return { status: 'completed', runId: 'r1-flow' };
};
VisionWriter.prototype._serverAvailable = async () => false;
const update = VisionWriter.prototype.updateItemStatus;
VisionWriter.prototype.updateItemStatus = async function(id, status) {
  if (status === 'killed') {
    mark('vision-kill');
    if (scenario === 'slow-vision') await new Promise(resolve => setTimeout(resolve, 5000));
  }
  return update.call(this, id, status);
};
`);
  const child = spawn(process.execPath, ['--import', preload, cli, 'build', 'R1', '--skip-triage', '--non-interactive', ...(scenario === 'preflight' ? ['--codex'] : [])], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', NODE_TEST_CONTEXT: 'child-v8', COMPOSE_SKIP_CODEX_PROBE: '', COMPOSE_CANCEL_TIMEOUT_MS: '50', COMPOSE_TEARDOWN_DRAIN_MS: '50', COMPOSE_PORT: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 12000);
  t.after(async () => { clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const events = () => existsSync(join(root, 'events.txt')) ? readFileSync(join(root, 'events.txt'), 'utf8') : '';
  const activePath = join(data, 'active-build.json');
  let signalledAt;
  if (scenario !== 'completion') {
    const marker = scenario === 'preflight' ? 'preflight-entered' : 'agent-entered';
    const until = Date.now() + 8000;
    while (!events().includes(marker) && child.exitCode === null && child.signalCode === null && Date.now() < until) await delay(20);
    assert.ok(events().includes(marker), `fixture did not reach ${marker}: ${output}`);
    if (scenario === 'replacement') {
      const active = JSON.parse(readFileSync(activePath));
      writeFileSync(activePath, JSON.stringify({ ...active, flowId: 'replacement-flow', pid: 987654, startedAt: 'replacement-start' }));
    }
    signalledAt = Date.now();
    child.kill('SIGINT');
  }
  const result = await exited;
  clearTimeout(watchdog);
  return { ...result, signalElapsedMs: Date.now() - signalledAt, output, events: events(), active: JSON.parse(readFileSync(activePath)),
    vision: JSON.parse(readFileSync(join(data, 'vision-state.json'))),
    history: existsSync(join(data, 'build-history.jsonl')) ? readFileSync(join(data, 'build-history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [],
  };
}

test('R1-1: CLI SIGINT during a never-settling Codex preflight exits 130 and aborts the record', { timeout: 15000 }, async t => {
  const result = await runScenario(t, 'preflight');
  assert.equal(result.code, 130, result.output);
  assert.equal(result.active.status, 'aborted');
  assert.match(result.events, /preflight-aborted/);
  assert.match(result.events, /flow-cancel/);
});

test('R1-2: CLI with a 5s vision update and 50ms budgets terminalizes before exit', { timeout: 15000 }, async t => {
  const result = await runScenario(t, 'slow-vision');
  assert.equal(result.code, 130, `active=${result.active.status}\n${result.output}`);
  assert.equal(result.active.status, 'aborted');
  assert.match(result.events, /vision-kill/);
  assert.ok(result.signalElapsedMs < 2000, `teardown waited ${result.signalElapsedMs}ms for a 5s vision operation`);
});

test('R1-3: SIGINT does not kill the replacement build vision item for the same feature', { timeout: 15000 }, async t => {
  const result = await runScenario(t, 'replacement');
  assert.equal(result.code, 130, result.output);
  assert.equal(result.vision.items[0].status, 'in_progress');
  assert.doesNotMatch(result.events, /vision-kill/);
  assert.equal(result.active.flowId, 'replacement-flow');
  assert.equal(result.active.status, 'running');
});

test('R1-4: SIGINT just before final successful stepDone keeps history and active state aborted', { timeout: 15000 }, async t => {
  const result = await runScenario(t, 'completion');
  assert.equal(result.code, 130, result.output);
  assert.match(result.events, /final-stepDone/);
  assert.equal(result.active.status, 'aborted');
  assert.equal(result.history.length, 1, result.output);
  assert.equal(result.history[0].status, result.active.status);
});
