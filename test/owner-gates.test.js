/**
 * COMP-DOGFOOD-OWNER-QUEUE-1: the owner's open questions are ONE list (lib/owner-gates.js), shown the same by the MCP
 * gate tools, the cockpit's queue panel (GET /api/fleet, GET /api/fleet/owner-gates) and the day ribbon (ownerWaits).
 *
 * The queue is a scratch copy built from three real rows of the ops owner-queue.jsonl (one ask, one security row, one
 * answered), with the owner-facing details replaced by placeholders. The REAL `~/.claude/scripts/owner_queue.py` closes
 * rows in that scratch file only (`--file`), with HOME, the notify spool and the chat outbox all in the scratch dir.
 */
import './helpers/git-env-scrub.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER_QUEUE_PY = join(homedir(), '.claude', 'scripts', 'owner_queue.py');
const SCRATCH = mkdtempSync(join(tmpdir(), 'owner-gates-'));
const QUEUE = join(SCRATCH, 'owner-queue.jsonl');
const TARGET = join(SCRATCH, 'workspace');
const HOME = join(SCRATCH, 'home');
const OUTBOX = join(SCRATCH, 'outbox');
for (const d of [join(TARGET, '.compose', 'data'), HOME, OUTBOX]) mkdirSync(d, { recursive: true });
writeFileSync(join(TARGET, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { lifecycle: true } }));

const SAVED = {};
const ENV = {
  COMPOSE_TARGET: TARGET,
  COMPOSE_EVIDENCE_STORE: join(SCRATCH, 'evidence.jsonl'),
  COMPOSE_OWNER_QUEUE_FILE: QUEUE,
  COMPOSE_FLEET_OWNER_QUEUE: OWNER_QUEUE_PY,
  COMPOSE_SESSION_NAME: 's1-chat', // the default allow list of an owner gate answer (COMP-DOGFOOD-OWNER-GATE-SESSION-1)
  HOME,
  NOTIFY_SPOOL: join(SCRATCH, 'notify-spool.jsonl'),
  NOTIFY_CLIENT_LOG: join(SCRATCH, 'notify-client.log'),
  OWNER_QUEUE_OUTBOX: OUTBOX,
  OWNER_QUEUE_NOTIFIER: '/usr/bin/true',
  OPS_COMMIT_ON_WRITE: '0',
};
for (const [k, v] of Object.entries(ENV)) { SAVED[k] = process.env[k]; process.env[k] = v; }
for (const k of ['SM_OWNER_QUEUE', 'COMPOSE_RIBBON_OWNER_QUEUE', 'COMPOSE_GATE_TIMEOUT']) { SAVED[k] = process.env[k]; delete process.env[k]; }

const { withProjectContext } = await import(`${REPO_ROOT}/server/project-root.js`);
const og = await import(`${REPO_ROOT}/lib/owner-gates.js`);
const tools = await import(`${REPO_ROOT}/server/compose-mcp-tools.js`);
const { attachFleetRoutes, resolveFleetReaders } = await import(`${REPO_ROOT}/server/fleet-routes.js`);
const { ownerWaits } = await import(`${REPO_ROOT}/server/ribbon-routes.js`);
const { ownerAsks } = await import(`${REPO_ROOT}/src/components/cockpit/notify/notifyLogic.js`);
const { readEvidence } = await import(`${REPO_ROOT}/lib/evidence.js`);

// Three real rows (ops coordination/owner-queue.jsonl, 2026-11-04), shortened; addresses, hosts and secret names replaced.
const ASK = {
  id: 'STUDIO-PIN-FALLBACK', by: 's2-coord',
  text: 'The Studio crash fix (an Enterprise writer could crash shared Studio) is merged at studio main 134f968152e6 but NOT live. If that row has not landed by the time you read this, you can move the pin by hand on <HOST>.',
  ts: 1793740674.390678, status: 'open', answer: null, unit: 'STUDIO-EVOLVER-DOTTED-PATH-1', post_id: 'ops.ask:STUDIO-PIN-FALLBACK',
  options: [{ value: 'a', label: 'wait for the row (recommended)' }, { value: 'b', label: "I'll move the pin by hand" }], severity: 'warn',
};
const SECURITY = {
  id: 'FORGE-WIKI-TAB-TOKEN', by: 's2-coord',
  text: 'CREDENTIAL (owner-only, not applied): the cockpit on 5195 hides the Wiki sub-tab because compose .compose/compose.json has no wiki block. Fix: wiki: {enabled: true, tokenEnv: <TOKEN_ENV_NAME>}.',
  ts: 1793377111.830015, status: 'open', answer: null,
};
const ANSWERED_OPEN = {
  id: 'NOTIFY-NTFY-1-subscribe', by: 'notify-ntfy',
  text: 'Phone push (NOTIFY-NTFY-1): install the ntfy app and subscribe it to server <NTFY_SERVER>, topic <TOPIC>, user <USER>.',
  ts: 1793608855.616723, status: 'open', answer: null, post_id: 'ops.ask:NOTIFY-NTFY-1-subscribe',
  options: [{ value: 'android', label: 'Subscribed, Android' }, { value: 'iphone', label: 'Subscribed, iPhone (turn on the ntfy.sh wake relay)' }, { value: 'later', label: 'Not yet' }],
  severity: 'info',
};
const ANSWERED = { ...ANSWERED_OPEN, status: 'closed', answer: 'later', closed_ts: 1793692696.067478, answer_channel: 'chat:s1-chat' };
// owner_queue.py writes `json.dumps(record)`: ", " and ": " separators.
const pyLine = (r) => JSON.stringify(r).replace(/","/g, '", "').replace(/":/g, '": ').replace(/,"/g, ', "');
const seedQueue = () => writeFileSync(QUEUE, [ASK, SECURITY, ANSWERED_OPEN, ANSWERED].map(pyLine).join('\n') + '\n');
const records = () => readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const OPEN_IDS = ['owner:FORGE-WIKI-TAB-TOKEN', 'owner:STUDIO-PIN-FALLBACK']; // security first, then oldest first

const MIN = 60_000;
function seedVision(now) {
  const gate = (id, createdAt) => ({ id, flowId: 'f', stepId: id, round: 1, itemId: null, status: 'pending', createdAt: new Date(createdAt).toISOString() });
  writeFileSync(join(TARGET, '.compose', 'data', 'vision-state.json'), JSON.stringify({
    items: [], connections: [], gates: [gate('compose-old', now - 31 * MIN), gate('compose-new', now - MIN)],
  }));
}

const FIX = join(REPO_ROOT, 'test', 'fixtures', 'fleet');
async function withFleet(fn) {
  const env = {
    PATH: process.env.PATH, HOME, COMPOSE_OWNER_QUEUE_FILE: QUEUE,
    COMPOSE_FLEET_PYTHON: process.execPath, COMPOSE_FLEET_SM_STATUS: join(FIX, 'sm-status.mjs'),
    COMPOSE_FLEET_STRATUM_BIN: join(FIX, 'stratum.mjs'), COMPOSE_FLEET_CADENCE_SHADOW: join(FIX, 'shadow.jsonl'),
  };
  const app = express();
  attachFleetRoutes(app, { env, readers: resolveFleetReaders(env), cadenceHandler: () => null, warn: () => {}, info: () => {} });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const get = async (p) => (await fetch(`http://127.0.0.1:${server.address().port}${p}`)).json();
  try { return await fn(get); } finally { await new Promise((r) => server.close(r)); }
}

before(() => { seedQueue(); seedVision(Date.now()); });
after(() => {
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('owner gates: one list on every surface', () => {
  it('the server function, get_pending_gates, the panel routes and the ribbon return the same 2 open gates', async () => {
    const list = og.readOwnerGates({ file: QUEUE, warn: () => {} });
    assert.equal(list.unreadable, undefined);
    assert.deepEqual(list.gates.map((g) => g.id), OPEN_IDS);
    for (const g of list.gates) assert.deepEqual(og.validateOwnerGate(g), { ok: true, errors: [] });
    const ask = list.gates.find((g) => g.qid === 'STUDIO-PIN-FALLBACK');
    assert.deepEqual(ask.options, [{ key: 'a', label: 'wait for the row (recommended)' }, { key: 'b', label: "I'll move the pin by hand" }]);
    assert.equal(ask.version, '1793740674.390678');
    assert.equal(list.gates[0].group, 'security');

    const mcp = tools.toolGetPendingGates({});
    assert.deepEqual(mcp.gates.filter((g) => g.kind === 'owner').map((g) => g.id), OPEN_IDS);
    assert.equal(mcp.owner_gates.count, 2);

    await withFleet(async (get) => {
      const route = await get('/api/fleet/owner-gates');
      assert.deepEqual(route.gates.map((g) => g.id), OPEN_IDS);
      const queue = (await get('/api/fleet')).sources.sm_status.value.queue;
      assert.equal(queue.source, 'owner-gates');
      assert.equal(ownerAsks(queue.value).n, 2);
      assert.deepEqual(ownerAsks(queue.value).rows.map((r) => r.id), OPEN_IDS.map((id) => id.slice(6)));
    });

    const now = Date.now();
    const ribbon = ownerWaits({ queue: records(), lanes: ['ops'], from: now - 60 * MIN, to: now, now });
    assert.deepEqual(ribbon.open.map((r) => r.id).sort(), OPEN_IDS.map((id) => id.slice(6)).sort());
    assert.equal(ownerAsks(ribbon.open).n, 2);
  });

  it('an owner gate is still pending after 31 minutes, a Compose gate is not', () => {
    const now = Date.now();
    const gates = tools.toolGetPendingGates({}).gates;
    assert.deepEqual(gates.filter((g) => g.kind !== 'owner').map((g) => g.id), ['compose-new']);
    const owner = og.readOwnerGates({ file: QUEUE, now: ASK.ts * 1000 + 31 * MIN, warn: () => {} }).gates;
    assert.ok(owner.some((g) => g.qid === 'STUDIO-PIN-FALLBACK' && g.age_s >= 31 * 60));
    for (const g of owner) assert.equal(og.isComposeGateExpired(g, now, 30 * MIN), false);
    assert.equal(og.isComposeGateExpired({ status: 'pending', createdAt: new Date(now - 31 * MIN).toISOString() }, now, 30 * MIN), true);
  });

  it('approve_gate owner:<qid> option=<key> closes the row once; the old version is then refused OWNER_GATE_STALE', { skip: !existsSync(OWNER_QUEUE_PY) && 'owner_queue.py absent' }, async () => {
    const { version } = og.readOwnerGates({ file: QUEUE, warn: () => {} }).gates.find((g) => g.qid === 'STUDIO-PIN-FALLBACK');
    await assert.rejects(tools.toolApproveGate({ gateId: 'owner:STUDIO-PIN-FALLBACK', option: 'z', version }), /^Error: OWNER_GATE_OPTION/);
    await assert.rejects(tools.toolApproveGate({ gateId: 'owner:FORGE-WIKI-TAB-TOKEN', option: 'a' }), /^Error: OWNER_GATE_OPTION: .*no options/);
    await assert.rejects(tools.toolApproveGate({ gateId: 'owner:STUDIO-PIN-FALLBACK', option: 'a', version: '1.5' }), /^Error: OWNER_GATE_STALE: .*re-asked/);
    assert.equal(records().length, 4, 'no refusal wrote anything');

    const r = await tools.toolApproveGate({ gateId: 'owner:STUDIO-PIN-FALLBACK', option: 'a', version });
    const answer = 'OWNER (via mcp): (a) wait for the row (recommended)';
    assert.equal(r.closed, true);
    assert.equal(r.answer, answer);
    const closes = records().filter((x) => x.id === 'STUDIO-PIN-FALLBACK' && x.status === 'closed');
    assert.equal(closes.length, 1);
    assert.equal(closes[0].answer, answer);
    assert.equal(closes[0].answer_channel, 'mcp');
    // the receipt: a log receipt on the line the close wrote, minted after it
    assert.match(r.evidence_id, /^ev:[0-9a-f]{16}$/, JSON.stringify(r));
    const rec = readEvidence(r.evidence_id);
    assert.equal(rec.evidence.kind, 'log');
    assert.equal(rec.evidence.path, QUEUE);
    assert.ok(rec.evidence.line.includes(answer));
    assert.deepEqual(rec.subject, { tool: 'approve_gate', gate: 'owner:STUDIO-PIN-FALLBACK', outcome: 'a' });
    assert.ok(Date.parse(rec.checked_at) >= closes[0].closed_ts * 1000 - 1000);

    await assert.rejects(tools.toolApproveGate({ gateId: 'owner:STUDIO-PIN-FALLBACK', option: 'b', version }), /^Error: OWNER_GATE_STALE: .*already answered in mcp/);
    assert.equal(records().filter((x) => x.id === 'STUDIO-PIN-FALLBACK' && x.status === 'closed').length, 1, 'still one close');
    assert.deepEqual(og.readOwnerGates({ file: QUEUE, warn: () => {} }).gates.map((g) => g.id), ['owner:FORGE-WIKI-TAB-TOKEN']);
    seedQueue();
  });

  it('an unreadable queue gives a WARNING and unreadable: true, never an empty list', async () => {
    const warns = [];
    const missing = join(SCRATCH, 'no-such-queue.jsonl');
    const r = og.readOwnerGates({ file: missing, warn: (m) => warns.push(m) });
    assert.equal(r.unreadable, true);
    assert.equal(r.gates, null);
    assert.equal(r.count, null);
    assert.match(warns.join('\n'), /WARNING owner queue .* unreadable \(ENOENT\).*unknown, not zero/);
    assert.equal(og.panelOf(r).value, null);
    assert.equal(ownerAsks(og.panelOf(r).value), null, 'the cockpit shows unknown, not zero');

    process.env.COMPOSE_OWNER_QUEUE_FILE = missing;
    try {
      const mcp = tools.toolGetPendingGates({});
      assert.equal(mcp.owner_gates.unreadable, true);
      assert.deepEqual(mcp.gates.map((g) => g.id), ['compose-new']);
    } finally { process.env.COMPOSE_OWNER_QUEUE_FILE = QUEUE; }
  });

  it('the read-only CLI prints the same list', () => {
    const run = spawnSync(process.execPath, [join(REPO_ROOT, 'lib', 'owner-gates-cli.js'), 'list', '--file', QUEUE], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).gates.map((g) => g.id), OPEN_IDS);
    const bad = spawnSync(process.execPath, [join(REPO_ROOT, 'lib', 'owner-gates-cli.js'), 'list', '--file', join(SCRATCH, 'nope.jsonl')], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.equal(JSON.parse(bad.stdout).unreadable, true);
  });
});

// COMP-DOGFOOD-OWNER-GATE-SESSION-1: only an allow-listed session (default s1-chat) answers an owner question through MCP.
describe('owner gate answers: who may speak for the owner', () => {
  const GATE = 'owner:STUDIO-PIN-FALLBACK';
  const evidenceText = () => (existsSync(process.env.COMPOSE_EVIDENCE_STORE) ? readFileSync(process.env.COMPOSE_EVIDENCE_STORE, 'utf8') : '');
  const asSession = async (name, fn) => {
    const saved = process.env.COMPOSE_SESSION_NAME;
    if (name === null) delete process.env.COMPOSE_SESSION_NAME; else process.env.COMPOSE_SESSION_NAME = name;
    try { return await fn(); } finally { process.env.COMPOSE_SESSION_NAME = saved; }
  };
  const gateVersion = () => og.readOwnerGates({ file: QUEUE, warn: () => {} }).gates.find((g) => g.id === GATE).version;
  const withConfig = (extra, fn) => withProjectContext(
    { targetRoot: TARGET, dataDir: join(TARGET, '.compose', 'data'), config: { version: 2, capabilities: { lifecycle: true }, ...extra } }, fn);

  it('a lane lead session (forge-main) is refused: OWNER_GATE_SESSION, the queue row untouched, no receipt', async () => {
    seedQueue();
    const queueBefore = readFileSync(QUEUE, 'utf8');
    const evBefore = evidenceText();
    await asSession('forge-main', () => assert.rejects(
      tools.toolApproveGate({ gateId: GATE, option: 'a', version: gateVersion() }),
      (e) => e.code === 'OWNER_GATE_SESSION' && /"forge-main"/.test(e.message) && /\bs1-chat\b/.test(e.message)));
    assert.equal(readFileSync(QUEUE, 'utf8'), queueBefore, 'the queue file is byte-identical');
    assert.equal(evidenceText(), evBefore, 'no receipt was minted');
  });

  it('an unnamed session is refused and the message says unnamed', async () => {
    seedQueue();
    const queueBefore = readFileSync(QUEUE, 'utf8');
    await asSession(null, () => assert.rejects(
      tools.toolApproveGate({ gateId: GATE, option: 'a', version: gateVersion() }),
      (e) => e.code === 'OWNER_GATE_SESSION' && /unnamed/.test(e.message)));
    assert.equal(readFileSync(QUEUE, 'utf8'), queueBefore);
  });

  it('s1-chat (the default allow list) closes the row and the result names the relaying session', async () => {
    seedQueue();
    const r = await asSession('s1-chat', () => tools.toolApproveGate({ gateId: GATE, option: 'a', version: gateVersion() }));
    assert.equal(r.closed, true);
    assert.equal(r.relayed_by, 's1-chat');
    assert.equal(records().filter((x) => x.id === 'STUDIO-PIN-FALLBACK' && x.status === 'closed').length, 1);
    assert.equal(readEvidence(r.evidence_id).evidence.by, 's1-chat', 'the receipt names the session');
    seedQueue();
  });

  it('ownerGateSessions in .compose/compose.json replaces the default list', async () => {
    seedQueue();
    await withConfig({ ownerGateSessions: ['forge-main'] }, async () => {
      await asSession('s1-chat', () => assert.rejects(
        tools.toolApproveGate({ gateId: GATE, option: 'a', version: gateVersion() }), (e) => e.code === 'OWNER_GATE_SESSION'));
      const r = await asSession('forge-main', () => tools.toolApproveGate({ gateId: GATE, option: 'a', version: gateVersion() }));
      assert.equal(r.closed, true);
      assert.equal(r.relayed_by, 'forge-main');
    });
    seedQueue();
  });

  it('a malformed ownerGateSessions falls back to the default with a WARNING, never to "anyone"', () => {
    const warns = [];
    assert.deepEqual(og.ownerGateSessions({}), ['s1-chat']);
    assert.deepEqual(og.ownerGateSessions(null), ['s1-chat']);
    assert.deepEqual(og.ownerGateSessions({ ownerGateSessions: 'forge-main' }, (m) => warns.push(m)), ['s1-chat']);
    assert.deepEqual(og.ownerGateSessions({ ownerGateSessions: ['a', 3, ''] }, (m) => warns.push(m)), ['a']);
    assert.equal(warns.length, 2);
    assert.match(warns.join('\n'), /WARNING ownerGateSessions/);
    assert.deepEqual(og.ownerGateSessions({ ownerGateSessions: [] }), [], 'an explicit empty list means nobody');
  });

  it('a Compose gate is not subject to the session check', async () => {
    await asSession('forge-main', async () => {
      try { await tools.toolApproveGate({ gateId: 'compose-new', outcome: 'revised' }); } catch (e) {
        assert.notEqual(e.code, 'OWNER_GATE_SESSION');
        assert.doesNotMatch(String(e.message), /OWNER_GATE_SESSION/);
      }
    });
  });
});
