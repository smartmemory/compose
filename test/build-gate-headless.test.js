import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pollGateResolution, runBuild } from '../lib/build.js';
import { installAgentHarness } from './helpers/ts-agent-harness.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';

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
