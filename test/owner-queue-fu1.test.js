/**
 * COMP-DOGFOOD-OWNER-QUEUE-FU-1: (F1) the cockpit `queue` panel carries EVERY open owner-queue row, so the inbox drawer's
 * "Decided for you" and "FYI" groups fill again; (F2) an MCP close of a scratch queue with the real notify spool and outbox
 * reachable is refused, never announced into the live owner channels.
 * Every env here puts HOME, NOTIFY_SPOOL and OWNER_QUEUE_OUTBOX in a scratch dir; the real owner_queue.py only ever sees them.
 */
import './helpers/git-env-scrub.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER_QUEUE_PY = join(homedir(), '.claude', 'scripts', 'owner_queue.py');
const SCRATCH = mkdtempSync(join(tmpdir(), 'owner-queue-fu1-'));
const QUEUE = join(SCRATCH, 'owner-queue.jsonl');
const HOME = join(SCRATCH, 'home');
const OUTBOX = join(SCRATCH, 'outbox');
for (const d of [HOME, OUTBOX]) mkdirSync(d, { recursive: true });

const SAVED = {};
for (const k of ['HOME', 'NOTIFY_SPOOL', 'OWNER_QUEUE_OUTBOX', 'SM_OWNER_QUEUE', 'COMPOSE_OWNER_QUEUE_FILE', 'COMPOSE_RIBBON_OWNER_QUEUE']) SAVED[k] = process.env[k];
process.env.HOME = HOME;
process.env.NOTIFY_SPOOL = join(SCRATCH, 'spool.jsonl');
process.env.OWNER_QUEUE_OUTBOX = OUTBOX;
for (const k of ['SM_OWNER_QUEUE', 'COMPOSE_RIBBON_OWNER_QUEUE']) delete process.env[k];
process.env.COMPOSE_OWNER_QUEUE_FILE = QUEUE;

const og = await import(`${REPO_ROOT}/lib/owner-gates.js`);
const tools = await import(`${REPO_ROOT}/server/compose-mcp-tools.js`);
const { attachFleetRoutes, resolveFleetReaders } = await import(`${REPO_ROOT}/server/fleet-routes.js`);
const { ownerWaits } = await import(`${REPO_ROOT}/server/ribbon-routes.js`);
const { ownerAsks } = await import(`${REPO_ROOT}/src/components/cockpit/notify/notifyLogic.js`);
const { groupInbox } = await import(`${REPO_ROOT}/src/components/cockpit/notify/inboxLogic.js`);

const ts = (n) => 1793740000 + n;
const ASK = { id: 'ASK-1', by: 's2-coord', text: 'Pick the pin.', ts: ts(1), status: 'open', answer: null,
  options: [{ value: 'a', label: 'wait (recommended)' }, { value: 'b', label: 'by hand' }], severity: 'warn' };
const SECURITY = { id: 'SEC-1', by: 's2-coord', text: 'CREDENTIAL (owner-only, not applied): set the token.', ts: ts(2), status: 'open', answer: null };
const APPLIED = { id: 'APPLIED-1', by: 's2-coord', text: 'APPLIED: picked (a). reverse: say b', ts: ts(3), status: 'open', answer: null };
const FYI = { id: 'FYI-1', by: 's2-coord', text: 'FYI: the pin moved.', ts: ts(4), status: 'open', answer: null };
const CLOSED = { ...ASK, id: 'CLOSED-1', status: 'closed', answer: 'a', closed_ts: ts(9), answer_channel: 'chat:s1-chat' };
const pyLine = (r) => JSON.stringify(r).replace(/","/g, '", "').replace(/":/g, '": ').replace(/,"/g, ', "');
const seed = () => writeFileSync(QUEUE, [ASK, SECURITY, APPLIED, FYI, CLOSED].map(pyLine).join('\n') + '\n');
const records = () => readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

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

// Always scratch HOME, so even a refused-then-regressed close could not reach the real outbox.
const closeEnv = (extra = {}) => ({
  PATH: process.env.PATH, HOME, COMPOSE_OWNER_QUEUE_FILE: QUEUE, COMPOSE_FLEET_OWNER_QUEUE: OWNER_QUEUE_PY,
  OWNER_QUEUE_NOTIFIER: '/usr/bin/true', OPS_COMMIT_ON_WRITE: '0', NOTIFY_CLIENT_LOG: join(SCRATCH, 'notify-client.log'), ...extra,
});

before(seed);
after(() => {
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('F1: the cockpit queue panel keeps every open row', () => {
  it('Decided for you and FYI fill the inbox groups, and the four waiting counts still agree', async () => {
    await withFleet(async (get) => {
      const queue = (await get('/api/fleet')).sources.sm_status.value.queue;
      assert.equal(queue.error, null);
      const groups = Object.fromEntries(groupInbox(queue.value).map((g) => [g.id, g.rows.map((r) => r.id)]));
      assert.deepEqual(groups, { security: ['SEC-1'], asks: ['ASK-1'], decided: ['APPLIED-1'], fyi: ['FYI-1'] });
      assert.equal(groupInbox(queue.value).find((g) => g.id === 'decided').rows[0].reverse, 'say b');
      const ask = queue.value.find((r) => r.id === 'ASK-1');
      assert.deepEqual(ask.options, [{ value: 'a', label: 'wait (recommended)' }, { value: 'b', label: 'by hand' }]);
      assert.equal(ask.severity, 'warn');

      assert.equal(ownerAsks(queue.value).n, 2);
      assert.equal((await get('/api/fleet/owner-gates')).count, 2);
      assert.equal(tools.toolGetPendingGates({}).owner_gates.count, 2);
      const now = Date.now();
      const ribbon = ownerWaits({ queue: records(), lanes: ['ops'], from: now - 3_600_000, to: now, now });
      assert.equal(ownerAsks(ribbon.open).n, 2);
    });
  });

  it('an unreadable queue is unknown (value null), never an empty list', () => {
    const p = og.readOpenQueuePanel({ file: join(SCRATCH, 'missing.jsonl'), env: { HOME }, warn: () => {} });
    assert.equal(p.value, null);
    assert.match(p.error, /unreadable/);
  });
});

describe('F2: a scratch-queue MCP close cannot reach the live owner channels', () => {
  it('refuses with OWNER_GATE_SCRATCH_UNGUARDED when neither NOTIFY_SPOOL nor OWNER_QUEUE_OUTBOX is set, and writes nothing', () => {
    seed();
    const before = readFileSync(QUEUE, 'utf8');
    assert.throws(
      () => og.closeOwnerGate({ gateId: 'owner:ASK-1', option: 'a', env: closeEnv() }),
      (e) => e.code === 'OWNER_GATE_SCRATCH_UNGUARDED' && /NOTIFY_SPOOL/.test(e.message) && /OWNER_QUEUE_OUTBOX/.test(e.message),
    );
    assert.equal(readFileSync(QUEUE, 'utf8'), before);
  });

  it('still closes a scratch queue when NOTIFY_SPOOL and OWNER_QUEUE_OUTBOX are set', () => {
    seed();
    const env = closeEnv({ NOTIFY_SPOOL: join(SCRATCH, 'spool.jsonl'), OWNER_QUEUE_OUTBOX: OUTBOX });
    const r = og.closeOwnerGate({ gateId: 'owner:ASK-1', option: 'a', env });
    assert.equal(r.qid, 'ASK-1');
    assert.equal(records().filter((x) => x.id === 'ASK-1').pop().status, 'closed');
  });

  it('puts SM_OWNER_QUEUE=<path> in the child env beside --file (observed through a stub script)', () => {
    seed();
    const stub = join(SCRATCH, 'stub.mjs');
    const seen = join(SCRATCH, 'seen.json');
    writeFileSync(stub, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(seen)}, JSON.stringify({q: process.env.SM_OWNER_QUEUE, argv: process.argv.slice(2)})); process.exit(1);`);
    const env = closeEnv({ NOTIFY_SPOOL: join(SCRATCH, 'spool.jsonl'), OWNER_QUEUE_OUTBOX: OUTBOX, COMPOSE_FLEET_PYTHON: process.execPath, COMPOSE_FLEET_OWNER_QUEUE: stub });
    assert.throws(() => og.closeOwnerGate({ gateId: 'owner:ASK-1', option: 'a', env }), /owner_queue.py close failed/);
    const got = JSON.parse(readFileSync(seen, 'utf8'));
    assert.equal(got.q, QUEUE);
    assert.equal(got.argv[got.argv.indexOf('--file') + 1], QUEUE);
  });
});
