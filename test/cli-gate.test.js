import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

// COMP-PARITY-1: `compose gate list` + `compose gate resolve` wrap the existing
// GET /api/vision/gates and POST /api/vision/gates/:id/resolve endpoints.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const COMPOSE_BIN = resolve(REPO_ROOT, 'bin', 'compose.js');

// In-memory gate fixtures + a record of the last resolve the stub received.
const GATES = [
  { id: 'flowA:write_design:1', flowId: 'flowA', stepId: 'write_design', itemId: 'item-1', fromPhase: 'design', toPhase: 'blueprint', status: 'pending', createdAt: new Date(Date.now() - 5 * 60000).toISOString() },
  { id: 'flowB:implement:2', flowId: 'flowB', stepId: 'implement', itemId: 'item-2', fromPhase: 'plan', toPhase: 'ship', status: 'pending', createdAt: new Date(Date.now() - 90 * 60000).toISOString() },
  { id: 'flowC:research:1', flowId: 'flowC', stepId: 'research', itemId: 'item-1', fromPhase: null, toPhase: 'design', status: 'resolved', createdAt: new Date(Date.now() - 200 * 60000).toISOString() },
];
let lastResolve = null;
let server, baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.get('/api/vision/gates', (req, res) => {
    const { status, itemId } = req.query;
    let gates;
    if (status === 'all') gates = GATES;
    else if (status === 'resolved') gates = GATES.filter(g => g.status === 'resolved');
    else {
      // Mirror the REAL server (vision-routes.js): itemId is honored ONLY on the
      // pending path — the CLI must filter client-side for all/resolved.
      gates = GATES.filter(g => g.status === 'pending');
      if (itemId) gates = gates.filter(g => g.itemId === itemId);
    }
    res.json({ gates });
  });
  app.post('/api/vision/gates/:id/resolve', (req, res) => {
    const { outcome: raw, comment, resolvedBy } = req.body || {};
    if (!raw) return res.status(400).json({ error: 'outcome is required' });
    const map = { approved: 'approve', killed: 'kill', revised: 'revise' };
    const outcome = map[raw] || raw;
    if (!['approve', 'revise', 'kill'].includes(outcome)) {
      return res.status(400).json({ error: `outcome must be one of: approve, revise, kill (got '${raw}')` });
    }
    const gate = GATES.find(g => g.id === req.params.id);
    if (!gate) return res.status(404).json({ error: `Gate not found: ${req.params.id}` });
    lastResolve = { id: req.params.id, outcome, comment: comment ?? null, resolvedBy: resolvedBy ?? null };
    res.json({ ok: true, gate: { ...gate, status: 'resolved' } });
  });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); });
beforeEach(() => { lastResolve = null; });

function runCli(args, { url = baseUrl, extraEnv = {} } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [COMPOSE_BIN, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, COMPOSE_URL: url, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => res({ code, stdout, stderr }));
  });
}

test('gate list (default) shows only pending gates', async () => {
  const { code, stdout } = await runCli(['gate', 'list']);
  assert.equal(code, 0);
  assert.match(stdout, /flowA:write_design:1/);
  assert.match(stdout, /flowB:implement:2/);
  assert.doesNotMatch(stdout, /flowC:research:1/); // resolved, excluded
});

test('gate list --status all includes resolved', async () => {
  const { code, stdout } = await runCli(['gate', 'list', '--status', 'all']);
  assert.equal(code, 0);
  assert.match(stdout, /flowC:research:1/);
});

test('gate list --item filters by item id', async () => {
  const { code, stdout } = await runCli(['gate', 'list', '--item', 'item-2']);
  assert.equal(code, 0);
  assert.match(stdout, /flowB:implement:2/);
  assert.doesNotMatch(stdout, /flowA:write_design:1/);
});

test('gate list --item with --status all filters client-side', async () => {
  // Server ignores itemId on the all/resolved path; CLI must filter client-side.
  const { code, stdout } = await runCli(['gate', 'list', '--item', 'item-1', '--status', 'all']);
  assert.equal(code, 0);
  assert.match(stdout, /flowA:write_design:1/);     // item-1, pending
  assert.match(stdout, /flowC:research:1/);          // item-1, resolved
  assert.doesNotMatch(stdout, /flowB:implement:2/);  // item-2, excluded
});

test('gate list rejects an invalid --status', async () => {
  const { code, stderr } = await runCli(['gate', 'list', '--status', 'bogus']);
  assert.equal(code, 1);
  assert.match(stderr, /--status must be one of/);
});

test('gate list rejects an invalid --format', async () => {
  const { code, stderr } = await runCli(['gate', 'list', '--format', 'xml']);
  assert.equal(code, 1);
  assert.match(stderr, /--format must be one of/);
});

test('gate list --format json emits a parseable array', async () => {
  const { code, stdout } = await runCli(['gate', 'list', '--format', 'json']);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.some(g => g.id === 'flowA:write_design:1'));
});

test('gates list (plural alias) works', async () => {
  const { code, stdout } = await runCli(['gates', 'list']);
  assert.equal(code, 0);
  assert.match(stdout, /flowA:write_design:1/);
});

test('gate resolve --approve sends outcome=approve, resolvedBy=cli', async () => {
  const { code, stdout } = await runCli(['gate', 'resolve', 'flowA:write_design:1', '--approve']);
  assert.equal(code, 0);
  assert.match(stdout, /approve/);
  assert.deepEqual(lastResolve, { id: 'flowA:write_design:1', outcome: 'approve', comment: null, resolvedBy: 'cli' });
});

test('gate resolve --revise --comment maps comment', async () => {
  const { code } = await runCli(['gate', 'resolve', 'flowA:write_design:1', '--revise', '--comment', 'tighten the contract']);
  assert.equal(code, 0);
  assert.equal(lastResolve.outcome, 'revise');
  assert.equal(lastResolve.comment, 'tighten the contract');
});

test('gate resolve --kill --reason maps reason to comment', async () => {
  const { code } = await runCli(['gate', 'resolve', 'flowA:write_design:1', '--kill', '--reason', 'superseded']);
  assert.equal(code, 0);
  assert.equal(lastResolve.outcome, 'kill');
  assert.equal(lastResolve.comment, 'superseded');
});

test('gate resolve with no outcome flag errors (no POST made)', async () => {
  const { code, stderr } = await runCli(['gate', 'resolve', 'flowA:write_design:1']);
  assert.equal(code, 1);
  assert.match(stderr, /--approve|--revise|--kill|exactly one/i);
  assert.equal(lastResolve, null);
});

test('gate resolve with two outcome flags errors', async () => {
  const { code } = await runCli(['gate', 'resolve', 'flowA:write_design:1', '--approve', '--kill']);
  assert.equal(code, 1);
  assert.equal(lastResolve, null);
});

test('gate resolve without a gate id errors', async () => {
  const { code, stderr } = await runCli(['gate', 'resolve', '--approve']);
  assert.equal(code, 1);
  assert.match(stderr, /gate.?id|usage/i);
});

test('gate resolve surfaces a 404 for an unknown gate', async () => {
  const { code, stderr } = await runCli(['gate', 'resolve', 'no-such-gate', '--approve']);
  assert.equal(code, 1);
  assert.match(stderr + '', /not found/i);
});

test('gate list against a down server prints a friendly message', async () => {
  const { code, stderr } = await runCli(['gate', 'list'], { url: 'http://127.0.0.1:59599' });
  assert.equal(code, 1);
  assert.match(stderr, /not reachable|ECONNREFUSED|server/i);
});
