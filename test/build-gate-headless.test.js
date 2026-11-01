import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { pollGateResolution, runBuild } from '../lib/build.js';
import { installAgentHarness } from './helpers/ts-agent-harness.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';
import { lookupBuildCancel } from '../lib/build-cancel.js';
import { pointerPath } from '../lib/notify-gate.js';

const SIMPLE_SPEC = `version: 1
contracts:
  Result:
    value: string
flows:
  entry: build
  build:
    steps:
      - id: work
        do: work
        out: Result
`;

const GATED_SPEC = `version: 1
contracts:
  Result:
    value: string
flows:
  entry: build
  build:
    max_rounds: 3
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${finish.output}
      contract: Result
    steps:
      - id: work
        do: "build \${input.description}"
        out: Result
      - id: review
        after: [work]
        gate:
          on_approve: finish
          on_revise: work
          on_kill: null
          max_rounds: 3
      - id: finish
        after: [review]
        do: "finish \${input.description}"
        out: Result
`;

function makeWorkspace(t, workspaceId = 'foreign-build-ws', { spec = SIMPLE_SPEC, policies = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'compose-gate-headless-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'pipelines'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features', 'HEADLESS-1'), { recursive: true });
  writeFileSync(
    join(root, '.compose', 'compose.json'),
    JSON.stringify({ version: 2, workspaceId, capabilities: { stratum: true } }),
  );
  writeFileSync(join(root, '.compose', 'data', 'settings.json'), JSON.stringify({ policies }));
  writeFileSync(join(root, 'pipelines', 'build.stratum.yaml'), spec);
  writeFileSync(join(root, 'docs', 'features', 'HEADLESS-1', 'description.md'), '# Headless gate test\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function installStubAgent(client, workspace) {
  installAgentHarness(client, () => ({
    async *run() {
      yield { type: 'assistant', content: JSON.stringify({ value: 'built' }) };
      yield { type: 'system', subtype: 'complete', agent: 'stub' };
    },
    interrupt() {},
    get isRunning() { return false; },
  }), workspace);
}

function failingPlanClient(message) {
  return {
    connect: async () => {},
    close: async () => {},
    onEvent: () => () => {},
    hasTool: () => true,
    plan: async () => { throw new Error(message); },
  };
}

test('A: runBuild tracker requests carry the resolved workspace header', async (t) => {
  const workspaceId = 'header-build-ws';
  const root = makeWorkspace(t, workspaceId);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const headers = new Headers(opts.headers);
    requests.push({ url: new URL(url).pathname, workspaceId: headers.get('x-compose-workspace-id') });
    if (new URL(url).pathname === '/api/vision/items') {
      return new Response(JSON.stringify({
        items: [{ id: 'headless-item', lifecycle: { featureCode: 'HEADLESS-1' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const previousPort = process.env.COMPOSE_PORT;
  process.env.COMPOSE_PORT = '19997';
  t.after(() => {
    if (previousPort === undefined) delete process.env.COMPOSE_PORT;
    else process.env.COMPOSE_PORT = previousPort;
  });

  await assert.rejects(
    runBuild('HEADLESS-1', {
      cwd: root,
      stratum: failingPlanClient('stop after tracker construction'),
      template: 'build',
      skipTriage: true,
      description: 'header propagation regression',
    }),
    /stop after tracker construction/,
  );

  const trackerRequests = requests.filter(({ url }) => url.startsWith('/api/vision/'));
  assert.ok(trackerRequests.length > 0, 'the build must exercise the tracker REST path');
  assert.ok(
    trackerRequests.every((request) => request.workspaceId === workspaceId),
    `expected every tracker request to carry ${workspaceId}; got ${JSON.stringify(trackerRequests)}`,
  );
});

test('B: a healthy server that does not know the workspace cannot capture its gate', async (t) => {
  const workspaceId = 'unknown-to-server-ws';
  const root = makeWorkspace(t, workspaceId, { spec: GATED_SPEC, policies: { review: 'gate' } });
  const stateRoot = mkdtempSync(join(tmpdir(), 'compose-gate-headless-state-'));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const path = new URL(url).pathname;
    const headers = new Headers(opts.headers);
    requests.push({ method: opts.method ?? 'GET', path, workspaceId: headers.get('x-compose-workspace-id') });
    if (path === '/api/health') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: `Unknown workspaceId: ${workspaceId}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  const previousPort = process.env.COMPOSE_PORT;
  const previousStateRoot = process.env.STRATUM_STATE_ROOT;
  process.env.COMPOSE_PORT = '19997';
  process.env.STRATUM_STATE_ROOT = stateRoot;
  t.after(() => {
    if (previousPort === undefined) delete process.env.COMPOSE_PORT;
    else process.env.COMPOSE_PORT = previousPort;
    if (previousStateRoot === undefined) delete process.env.STRATUM_STATE_ROOT;
    else process.env.STRATUM_STATE_ROOT = previousStateRoot;
  });

  const client = new StratumMcpClient();
  await client.connect({
    command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
    args: [TS_MCP_BIN],
    env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
  });
  t.after(() => client.close());
  installStubAgent(client, root);

  const result = await runBuild('HEADLESS-1', {
    cwd: root,
    stratum: client,
    template: 'build',
    skipTriage: true,
    description: 'foreign workspace gate regression',
    gateOpts: { nonInteractive: true },
  });

  assert.equal(result.status, 'complete');
  assert.equal(requests.some(({ method, path }) => method === 'POST' && path === '/api/vision/gates'), false);
  assert.doesNotMatch(output.join('\n'), /Gate delegated to web UI/);
  assert.match(output.join('\n'), new RegExp(`server .* cannot address workspace "${workspaceId}".*headless`, 'i'));
});

test('C(i): gate polling expires on COMPOSE_GATE_TIMEOUT with headless resolution guidance', async (t) => {
  const previousTimeout = process.env.COMPOSE_GATE_TIMEOUT;
  process.env.COMPOSE_GATE_TIMEOUT = '15';
  t.after(() => {
    if (previousTimeout === undefined) delete process.env.COMPOSE_GATE_TIMEOUT;
    else process.env.COMPOSE_GATE_TIMEOUT = previousTimeout;
  });
  const started = Date.now();
  let polls = 0;
  const writer = {
    async getGate() {
      polls++;
      return Date.now() - started < 60
        ? { status: 'pending' }
        : { status: 'resolved', outcome: 'approve' };
    },
  };

  await assert.rejects(
    pollGateResolution(writer, 'flow-1:review:1', 2),
    (error) => {
      assert.equal(error.code, 'GATE_POLL_TIMEOUT');
      assert.match(error.message, /flow-1:review:1/);
      assert.match(error.message, /compose gate resolve flow-1:review:1 --approve/);
      return true;
    },
  );
  assert.ok(polls > 1, 'deadline should allow polling before it expires');
  assert.ok(Date.now() - started < 60, 'deadline must win before the fallback resolution');
});

test('C(ii): a Stratum gate resolved externally during polling is adopted', async (t) => {
  const workspaceId = 'external-resolution-ws';
  const root = makeWorkspace(t, workspaceId, { spec: GATED_SPEC, policies: { review: 'gate' } });
  const stateRoot = mkdtempSync(join(tmpdir(), 'compose-gate-external-state-'));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const previousPort = process.env.COMPOSE_PORT;
  const previousStateRoot = process.env.STRATUM_STATE_ROOT;
  process.env.COMPOSE_PORT = '19997';
  process.env.STRATUM_STATE_ROOT = stateRoot;
  t.after(() => {
    if (previousPort === undefined) delete process.env.COMPOSE_PORT;
    else process.env.COMPOSE_PORT = previousPort;
    if (previousStateRoot === undefined) delete process.env.STRATUM_STATE_ROOT;
    else process.env.STRATUM_STATE_ROOT = previousStateRoot;
  });

  const client = new StratumMcpClient();
  await client.connect({
    command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
    args: [TS_MCP_BIN],
    env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
  });
  t.after(() => client.close());
  installStubAgent(client, root);

  const realGateResolve = client.gateResolve.bind(client);
  let foregroundResolveAttempts = 0;
  client.gateResolve = async (...args) => {
    foregroundResolveAttempts++;
    return realGateResolve(...args);
  };
  let createdGate = null;
  let externalResolved = false;
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const path = new URL(url).pathname;
    const method = opts.method ?? 'GET';
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
    if (path === '/api/health') return json({ ok: true });
    if (path === '/api/vision/items') {
      return json({ items: [{ id: 'external-item', lifecycle: { featureCode: 'HEADLESS-1' } }] });
    }
    if (path === '/api/vision/gates' && method === 'POST') {
      const body = JSON.parse(opts.body);
      createdGate = { ...body, id: `${body.flowId}:${body.stepId}:${body.round}` };
      return json(createdGate);
    }
    if (createdGate && path === `/api/vision/gates/${encodeURIComponent(createdGate.id)}` && method === 'GET') {
      if (!externalResolved) {
        const audit = await client.audit(createdGate.flowId);
        const gateToken = audit.steps?.[createdGate.stepId]?.gateToken;
        assert.ok(gateToken, 'the external resolver must observe the authoritative gate token');
        await realGateResolve(
          createdGate.flowId,
          createdGate.stepId,
          'approve',
          'approved out of band',
          'external',
          gateToken,
        );
        externalResolved = true;
      }
      return json({ ...createdGate, status: 'resolved', outcome: 'approve', comment: 'approved out of band' });
    }
    return json({ ok: true });
  });

  const result = await runBuild('HEADLESS-1', {
    cwd: root,
    stratum: client,
    template: 'build',
    skipTriage: true,
    description: 'external gate resolution regression',
  });

  assert.equal(externalResolved, true);
  assert.equal(foregroundResolveAttempts, 1, 'the foreground runner should encounter the resolved-gate race once');
  assert.equal(result.status, 'complete');
});

// ---------------------------------------------------------------------------
// COMP-NOTIFY-GATES-1: a headless gate posted as an owner ask, answered through
// the real `compose gate answer` CLI. The notify transport is the only stub: a
// recorder standing in for `notify_client.py enqueue` (one op per stdin).
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPOSE_BIN = join(REPO_ROOT, 'bin', 'compose.js');
const REAL_NOTIFY_CLIENT = process.env.COMPOSE_TEST_NOTIFY_CLIENT || join(homedir(), '.claude', 'scripts', 'notify_client.py');
// Registered in ~/.ports as notify-gates (test range); nothing listens on it, so no
// Compose server can address the workspace from this process or the answer CLI.
const NO_SERVER_PORT = '19053';
const POST_ID_GRAMMAR = /^compose\.gate:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)?$/;

const RECORDER = `import json, os, sys
op = json.loads(sys.stdin.read())
with open(os.environ['NOTIFY_RECORDER_OUT'], 'a') as f:
    f.write(json.dumps(op) + '\\n')
print(1)
`;

function setEnv(t, vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function notifyHarness(t, { flag = '1' } = {}) {
  const root = makeWorkspace(t, `notify-gates-ws-${Math.random().toString(36).slice(2, 8)}`, { spec: GATED_SPEC, policies: { review: 'gate' } });
  const tmp = mkdtempSync(join(tmpdir(), 'compose-notify-gates-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const recorder = join(tmp, 'recorder.py');
  const recorded = join(tmp, 'ops.jsonl');
  writeFileSync(recorder, RECORDER);
  const env = {
    COMPOSE_NOTIFY_GATES: flag,
    COMPOSE_NOTIFY_CLIENT: recorder,
    NOTIFY_RECORDER_OUT: recorded,
    COMPOSE_NOTIFY_GATES_DIR: join(tmp, 'pointers'),
    COMPOSE_NOTIFY_GATE_SEVERITY: undefined,
    COMPOSE_GATE_TIMEOUT: undefined,
    COMPOSE_PORT: NO_SERVER_PORT,
    STRATUM_STATE_ROOT: join(tmp, 'stratum'),
  };
  setEnv(t, env);
  const client = new StratumMcpClient();
  await client.connect({
    command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
    args: [TS_MCP_BIN],
    env: { ...process.env },
  });
  t.after(() => client.close());
  installStubAgent(client, root);
  const ops = () => (existsSync(recorded)
    ? readFileSync(recorded, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
  return { root, tmp, client, ops, recorded };
}

async function waitFor(fn, what, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function runCli(args, stdin, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const answerEvent = (post, channel, value) => JSON.stringify({
  post_id: post.post_id, value, note: null, by: 'owner', channel,
  at: new Date().toISOString(), version: post.version, payload: post.payload,
});

test('D: a headless build posts its gate as an owner ask and the notify answer resolves it end to end', async (t) => {
  assert.ok(!process.stdin.isTTY, 'precondition: the test runner gives the build no TTY');
  const { root, tmp, client, ops } = await notifyHarness(t);

  const building = runBuild('HEADLESS-1', {
    cwd: root, stratum: client, template: 'build', skipTriage: true, description: 'notify gate golden flow',
  });

  // 1. exactly one post, contract-shaped
  const postOp = await waitFor(() => ops().find((o) => o.op === 'post'), 'the gate post');
  const post = postOp.body;
  assert.match(post.post_id, POST_ID_GRAMMAR);
  assert.ok(post.post_id.length <= 200);
  assert.equal(post.source, 'compose.gate');
  assert.equal(post.type, 'ask');
  assert.equal(post.realm, 'owner');
  assert.deepEqual(post.card.options.map((o) => o.value), ['approve', 'revise', 'kill']);
  assert.deepEqual(Object.keys(post.payload), ['gate_id']);
  assert.match(post.deadline, /(Z|[+-]\d\d:\d\d)$/);
  assert.equal(post.severity, 'critical');

  // The same op through the REAL client: enqueue (stdin), then its own send path
  // against its StubTransport, whose _post_problem is the client's contract check
  // (post-ok-ask-full, post-refuse-id-source-mismatch, post-ok-id-*, payload, time).
  if (existsSync(REAL_NOTIFY_CLIENT)) {
    const spool = join(tmp, 'spool.jsonl');
    const clientEnv = { ...process.env, NOTIFY_SPOOL: spool, NOTIFY_CLIENT_LOG: join(tmp, 'client.log') };
    const enq = spawnSync('python3', [REAL_NOTIFY_CLIENT, 'enqueue'], { input: JSON.stringify(postOp), env: clientEnv, encoding: 'utf8' });
    assert.equal(enq.status, 0, `notify_client enqueue refused: ${enq.stderr}`);
    const check = spawnSync('python3', ['-I', '-c', [
      'import json, sys',
      'from pathlib import Path',
      'sys.path.insert(0, sys.argv[1])',
      'import notify_client as n',
      'sp = Path(sys.argv[2])',
      'sent, err = n.send_pending(sp, n.StubTransport())',
      's = n.load(sp)',
      'print(json.dumps({"sent": sent, "err": str(err) if err else None, "refused": s.refused, "delivered": sorted(s.delivered)}))',
    ].join('\n'), dirname(REAL_NOTIFY_CLIENT), spool], { env: clientEnv, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    const sent = JSON.parse(check.stdout);
    assert.deepEqual(sent.refused, {}, `the client's contract check refused the post: ${check.stdout}`);
    assert.deepEqual(sent.delivered, [post.post_id]);
  } else {
    t.diagnostic(`real notify client not present at ${REAL_NOTIFY_CLIENT}: client acceptance not checked`);
  }

  // 2. play the spool's injection point: the real CLI handler gets the AnswerEvent
  const first = await runCli([COMPOSE_BIN, 'gate', 'answer'], answerEvent(post, 'phone', 'approve'), { cwd: root });
  assert.equal(first.code, 0, first.stderr);
  const reply = JSON.parse(first.stdout);
  assert.deepEqual(reply, { reply: 'accepted', close: { post_id: post.post_id, outcome: 'answered', channel: 'phone' } });
  // notify-cmd's pull_answers enqueues the reply's close after `accepted`
  appendFileSync(process.env.NOTIFY_RECORDER_OUT, `${JSON.stringify({ op: 'close', body: reply.close })}\n`);

  // 3. the build completes on that answer; one post, one close, pointer gone
  const result = await building;
  assert.equal(result.status, 'complete');
  const state = JSON.parse(readFileSync(join(root, '.compose', 'data', 'vision-state.json'), 'utf8'));
  const gate = state.gates.find((g) => g.id === post.payload.gate_id);
  assert.equal(gate.status, 'resolved');
  assert.equal(gate.outcome, 'approve');
  assert.equal(gate.resolvedBy, 'notify:phone');
  const all = ops();
  assert.equal(all.filter((o) => o.op === 'post').length, 1);
  const closes = all.filter((o) => o.op === 'close');
  assert.deepEqual(closes.map((o) => o.body), [{ post_id: post.post_id, outcome: 'answered', channel: 'phone' }]);
  assert.ok(!closes.some((o) => o.body.outcome === 'cleared'), 'close-refuse-ask-cleared');
  assert.equal(existsSync(pointerPath(post.post_id)), false, 'the pointer file is removed at close');

  // 4. a second answer gets conflict with the winner
  const second = await runCli([COMPOSE_BIN, 'gate', 'answer'], answerEvent(post, 'digest', 'revise'), { cwd: root });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { reply: 'conflict', winning_value: 'approve', channel: 'phone' });
});

test('D(cancel): a TTY-less build cancelled at its posted gate withdraws the ask exactly once', async (t) => {
  const { root, client, ops } = await notifyHarness(t);
  const building = runBuild('HEADLESS-1', {
    cwd: root, stratum: client, template: 'build', skipTriage: true, description: 'notify gate cancel',
  }).then((r) => r, (e) => e);
  const post = (await waitFor(() => ops().find((o) => o.op === 'post'), 'the gate post')).body;
  const flowId = post.payload.gate_id.split(':')[0];
  const handle = await waitFor(() => lookupBuildCancel(flowId), 'the build cancel handle');
  handle.cancel('test cancel');
  await building;
  const closes = ops().filter((o) => o.op === 'close');
  assert.deepEqual(closes.map((o) => o.body), [{ post_id: post.post_id, outcome: 'withdrawn', channel: 'compose' }]);
  assert.equal(existsSync(pointerPath(post.post_id)), false);
});

test('D(no post): flag unset, --all, or a terminal to answer never enqueues', async (t) => {
  const ROWS = [
    { name: 'flag unset (terminal input)', flag: undefined, gateOpts: 'input' },
    { name: 'flag on, --all', flag: '1', gateOpts: 'all' },
    { name: 'flag on, a terminal answers', flag: '1', gateOpts: 'input' },
  ];
  for (const row of ROWS) {
    await t.test(row.name, async (t) => {
      const { root, client, ops } = await notifyHarness(t, { flag: row.flag });
      let gateOpts;
      if (row.gateOpts === 'all') gateOpts = { nonInteractive: true };
      else {
        const input = new PassThrough();
        input.end('a\n');
        gateOpts = { input, output: new PassThrough() };
      }
      const result = await runBuild('HEADLESS-1', {
        cwd: root, stratum: client, template: 'build', skipTriage: true, description: `no post: ${row.name}`, gateOpts,
      });
      assert.equal(result.status, 'complete');
      assert.deepEqual(ops(), []);
    });
  }
});
