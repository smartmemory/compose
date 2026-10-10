/**
 * gate-jev.test.js — COMP-GATE-JEV-1. No live network: the transport is injected,
 * and the proxy/keep-alive cases run against loopback servers.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  jevGateDefault, buildJevBody, proxyFor, noProxyMatches, createJevTransport, resetJevWarnings,
} = await import(`${REPO_ROOT}/lib/gate-jev.js`);
const { promptGate } = await import(`${REPO_ROOT}/lib/gate-prompt.js`);

const KEY = 'test-key-not-a-real-secret';
const ON = { COMPOSE_GATE_JEV: '1', JEV_API_KEY: KEY };
const answer = (choice) => async () => ({ answers: { gate: { choice } } });

afterEach(() => resetJevWarnings());

function run(env, transport, extra = {}) {
  const warnings = [];
  return jevGateDefault('Step done.', { env, transport, warn: (m) => warnings.push(m), ...extra })
    .then((label) => ({ label, warnings }));
}

const CASES = [
  { name: 'Jev approve', env: ON, transport: answer('APPROVE'), label: 'approve', warns: 0 },
  { name: 'Jev revise (lowercase answer)', env: ON, transport: answer('revise'), label: 'revise', warns: 0 },
  { name: 'transport error', env: ON, transport: async () => { throw new Error(`boom ${KEY}`); }, label: null, warns: 1 },
  { name: 'timeout', env: ON, transport: () => new Promise(() => {}), timeoutMs: 40, label: null, warns: 1 },
  { name: 'unexpected choice', env: ON, transport: answer('MAYBE'), label: null, warns: 1 },
  { name: 'missing answer', env: ON, transport: async () => ({}), label: null, warns: 1 },
];

for (const c of CASES) {
  test(`jevGateDefault: ${c.name}`, async () => {
    let calls = 0;
    const counted = (...a) => { calls++; return c.transport(...a); };
    const { label, warnings } = await run(c.env, counted, c.timeoutMs ? { timeoutMs: c.timeoutMs } : {});
    assert.equal(label, c.label);
    assert.equal(warnings.length, c.warns);
    assert.equal(calls, c.calls ?? 1);
    for (const w of warnings) assert.ok(!w.includes(KEY), 'warning must not carry the key');
  });
}

// On by default: {flag unset, '0', '1', other} x {key set, key empty, key unset}.
const FLAGS = [undefined, '0', '1', 'other'];
const KEYS = [KEY, '', undefined];
for (const flag of FLAGS) {
  for (const key of KEYS) {
    test(`jevGateDefault enablement: flag=${flag} key=${key === KEY ? 'set' : key === '' ? 'empty' : 'unset'}`, async () => {
      const env = {};
      if (flag !== undefined) env.COMPOSE_GATE_JEV = flag;
      if (key !== undefined) env.JEV_API_KEY = key;
      let calls = 0;
      const warnings = [];
      const t = async () => { calls++; return { answers: { gate: { choice: 'REVISE' } } }; };
      const first = await jevGateDefault('Step done.', { env, transport: t, warn: (m) => warnings.push(m) });
      const second = await jevGateDefault('Step done.', { env, transport: t, warn: (m) => warnings.push(m) });
      const enabled = Boolean(key) && flag !== '0';
      assert.equal(first, enabled ? 'revise' : null);
      assert.equal(second, first);
      assert.equal(calls, enabled ? 2 : 0, 'disabled means no network');
      // Only "asked for with =1 but no key" warns, exactly once per process.
      assert.equal(warnings.length, !key && flag === '1' ? 1 : 0);
      for (const w of warnings) assert.ok(!w.includes(KEY));
    });
  }
}

test('jevGateDefault: one WARNING per failure kind, not per gate', async () => {
  const warnings = [];
  const bad = async () => { throw new Error('x'); };
  for (let i = 0; i < 3; i++) await jevGateDefault('s', { env: ON, transport: bad, warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  await jevGateDefault('s', { env: ON, transport: answer('??'), warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 2);
});

test('payload is the spike payload (question, criteria, state shape, model)', () => {
  const body = JSON.parse(buildJevBody('Done "é".'));
  const question = readFileSync(resolve(REPO_ROOT, '../scratch/2026-10-11-gate-jev-retime/question.txt'), 'utf8');
  assert.equal(body.model, 'jev-latest');
  assert.equal(body.questions.gate.instructions, question);
  assert.deepEqual(Object.keys(body.questions.gate.criteria), ['APPROVE', 'REVISE']);
  assert.deepEqual(JSON.parse(body.state), { step_summary: 'Done "é".' });
});

test('proxy env is honored (either case), NO_PROXY bypasses it', () => {
  const rows = [
    [{ HTTPS_PROXY: 'http://127.0.0.1:8118' }, { host: '127.0.0.1', port: 8118 }],
    [{ https_proxy: '127.0.0.1:8118' }, { host: '127.0.0.1', port: 8118 }],
    [{}, null],
    [{ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'api.typesafe.ai' }, null],
    [{ HTTPS_PROXY: 'http://p:1', no_proxy: '.typesafe.ai' }, null],
    [{ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'typesafe.ai' }, null],
    [{ HTTPS_PROXY: 'http://p:1', NO_PROXY: '*' }, null],
    [{ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'localhost, example.com' }, { host: 'p', port: 1 }],
    [{ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'notypesafe.ai' }, { host: 'p', port: 1 }],
  ];
  for (const [env, want] of rows) assert.deepEqual(proxyFor(env), want, JSON.stringify(env));
  assert.equal(noProxyMatches({ NO_PROXY: 'a.com' }, 'api.typesafe.ai'), false);
});

// Loopback proxy + upstream: CONNECT is answered 200 and spliced to a plain-HTTP
// "Jev". `tlsWrap` is identity, so the tunnel carries plain HTTP (no TLS in test).
async function rig({ connectStatus = 200, upstreamStatus = 200, upstreamBody } = {}) {
  const stats = { connects: [], requests: 0, auth: [], socketsToKill: [] };
  const upstream = http.createServer((req, res) => {
    stats.requests++;
    stats.auth.push(req.headers.authorization);
    req.resume();
    req.on('end', () => {
      res.statusCode = upstreamStatus;
      res.setHeader('Content-Type', 'application/json');
      res.end(upstreamBody ?? JSON.stringify({ answers: { gate: { choice: 'REVISE' } } }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const proxy = http.createServer();
  proxy.on('connect', (req, clientSocket) => {
    stats.connects.push(req.url);
    if (connectStatus !== 200) {
      clientSocket.end(`HTTP/1.1 ${connectStatus} no\r\n\r\n`);
      return;
    }
    const up = net.connect(upstream.address().port, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    });
    stats.socketsToKill.push(clientSocket);
    clientSocket.on('error', () => {});
    up.on('error', () => {});
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const transport = createJevTransport({
    proxy: { host: '127.0.0.1', port: proxy.address().port },
    tlsWrap: (s) => s,
    hostOverride: '127.0.0.1',
  });
  const close = () => { transport.close(); proxy.close(); upstream.close(); proxy.closeAllConnections?.(); upstream.closeAllConnections?.(); };
  return { stats, transport, close };
}

test('default transport: CONNECT tunnel, bearer header, connection reused across two calls', async () => {
  const { stats, transport, close } = await rig();
  try {
    const a = await jevGateDefault('one', { env: ON, transport });
    const b = await jevGateDefault('two', { env: ON, transport });
    assert.deepEqual([a, b], ['revise', 'revise']);
    assert.deepEqual(stats.connects, ['api.typesafe.ai:443']);
    assert.equal(stats.requests, 2);
    assert.deepEqual(stats.auth, [`Bearer ${KEY}`, `Bearer ${KEY}`]);
  } finally { close(); }
});

test('default transport: dead socket triggers exactly one reconnect and still answers', async () => {
  const { stats, transport, close } = await rig();
  try {
    assert.equal(await jevGateDefault('one', { env: ON, transport }), 'revise');
    for (const s of stats.socketsToKill) s.destroy();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(await jevGateDefault('two', { env: ON, transport }), 'revise');
    assert.equal(stats.connects.length, 2);
  } finally { close(); }
});

test('default transport: proxy refusal yields null with a warning, no throw', async () => {
  const { transport, close } = await rig({ connectStatus: 403 });
  try {
    const { label, warnings } = await run(ON, transport);
    assert.equal(label, null);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes(KEY));
  } finally { close(); }
});

// Failure kinds lib/gate-jev.js can produce: error, timeout, proxy, http, malformed, unexpected.
// Each row: null, no throw, exactly one WARNING naming the kind, and a second gate stays quiet.
const FAILURE_ROWS = [
  { kind: 'error', rig: null, transport: async () => { throw new Error(`boom ${KEY}`); } },
  { kind: 'timeout', rig: null, transport: () => new Promise(() => {}), timeoutMs: 40 },
  { kind: 'unexpected', rig: null, transport: answer('MAYBE') },
  { kind: 'proxy', rig: { connectStatus: 403 } },
  { kind: 'http', rig: { upstreamStatus: 502, upstreamBody: '{"error":"bad gateway"}' } },
  { kind: 'malformed', rig: { upstreamBody: '{not json' } },
];
for (const row of FAILURE_ROWS) {
  test(`failure kind table: ${row.kind} -> null, no throw, one WARNING`, async () => {
    const r = row.rig ? await rig(row.rig) : null;
    try {
      const transport = r ? r.transport : row.transport;
      const warnings = [];
      const opts = { env: ON, transport, warn: (m) => warnings.push(m), ...(row.timeoutMs ? { timeoutMs: row.timeoutMs } : {}) };
      assert.equal(await jevGateDefault('s', opts), null);
      assert.equal(await jevGateDefault('s', opts), null);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes(`gate-jev ${row.kind};`), warnings[0]);
      assert.ok(!warnings[0].includes(KEY));
    } finally { r?.close(); }
  });
}

async function gate(gateExtras, jevOptions, keys = ['']) {
  const input = new PassThrough(); const output = new PassThrough();
  let text = ''; output.on('data', (d) => { text += d; });
  keys.forEach((k, i) => setTimeout(() => input.write(k + '\n'), 20 + i * 10));
  const result = await promptGate({ step_id: 's' }, { input, output, gateExtras, jevOptions });
  return { result, text };
}

test('promptGate: Jev revise overrides a clean-looking summary and the sentence names jev', async () => {
  let calls = 0;
  const transport = async () => { calls++; return { answers: { gate: { choice: 'REVISE' } } }; };
  const { result, text } = await gate({ summary: 'All good.' }, { env: ON, transport }, ['', 'because']);
  assert.equal(result.outcome, 'revise');
  assert.ok(text.includes('All good. Revise? (default by jev)'));
  assert.equal(calls, 1);
});

test('promptGate: Jev enabled but silent falls back to the regex and says keyword', async () => {
  const transport = async () => { throw new Error('down'); };
  const { result, text } = await gate({ summary: 'All good.' }, { env: ON, transport, warn() {} });
  assert.equal(result.outcome, 'approve');
  assert.ok(text.includes('All good. Ship it? (default by keyword)'));
});

test('promptGate: opt-out (COMPOSE_GATE_JEV=0) leaves the sentence unchanged and makes no call', async () => {
  let calls = 0;
  const transport = async () => { calls++; return {}; };
  const { result, text } = await gate({ summary: 'All good.' }, { env: { JEV_API_KEY: KEY, COMPOSE_GATE_JEV: '0' }, transport });
  assert.equal(result.outcome, 'approve');
  assert.ok(text.includes('All good. Ship it?') && !text.includes('default by'));
  assert.equal(calls, 0);
});

test('promptGate: no Stratum summary means Jev is not called', async () => {
  let calls = 0;
  const transport = async () => { calls++; return {}; };
  await gate({ fromPhase: 'a', toPhase: 'b' }, { env: ON, transport }, ['a']);
  assert.equal(calls, 0);
});

test('promptGate: no key leaves the sentence byte-identical (no source, no call)', async () => {
  let calls = 0;
  const transport = async () => { calls++; return {}; };
  const { text } = await gate({ summary: 'All good.' }, { env: {}, transport });
  assert.ok(text.includes('All good. Ship it?') && !text.includes('default by'));
  assert.equal(calls, 0);
});
