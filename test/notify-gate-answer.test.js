/**
 * COMP-NOTIFY-GATES-1: `compose gate answer` reply table. One row per answer
 * source and per double-answer class. Each row seeds a real vision-state.json (or
 * a real VisionStore behind the real REST routes) plus a pointer file, runs
 * answerGate, and asserts the ProductReply and the persisted gate.
 * Contract semantics honoured: seq-first-answer-latched, seq-product-rejected-reopens,
 * answer-refuse-caller-channel / -by (channel and by are only ever read).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

import { answerGate, gatePostId, buildGatePost, writePointer } from '../lib/notify-gate.js';
import { VisionWriter } from '../lib/vision-writer.js';
import { VisionStore } from '../server/vision-store.js';
import { attachVisionRoutes } from '../server/vision-routes.js';

const GATE_ID = 'flow-ng-1:review:1';
const POST_ID = 'compose.gate:flow-ng-1.review:1';
const CREATED = new Date(Date.now() - 60_000).toISOString();
const WS = 'notify-gate-answer-ws';

const pending = (over = {}) => ({
  id: GATE_ID, flowId: 'flow-ng-1', stepId: 'review', round: 1, itemId: null,
  status: 'pending', createdAt: CREATED, ...over,
});
const resolvedAs = (outcome, resolvedBy) => pending({
  status: 'resolved', outcome, resolvedBy, comment: null, resolvedAt: new Date().toISOString(),
});
const event = (channel, value, over = {}) => ({
  post_id: POST_ID, value, note: null, by: 'owner', channel, at: new Date().toISOString(),
  version: CREATED, payload: { gate_id: GATE_ID }, ...over,
});

// mode: direct = file store, no server; rest = VisionStore behind the real routes;
// race = rest, but the gate is resolved (by the CLI) between the handler's GET and POST.
const ROWS = [
  { name: 'phone', mode: 'direct', gate: pending(), ev: event('phone', 'approve'),
    reply: { reply: 'accepted' }, after: { status: 'resolved', outcome: 'approve', resolvedBy: 'notify:phone' } },
  { name: 'chat', mode: 'direct', gate: pending(), ev: event('chat:s1-chat', 'revise', { note: 'tighten the plan' }),
    reply: { reply: 'accepted' }, after: { status: 'resolved', outcome: 'revise', resolvedBy: 'notify:chat:s1-chat', comment: 'tighten the plan' } },
  { name: 'digest', mode: 'direct', gate: pending(), ev: event('digest', 'kill'),
    reply: { reply: 'accepted' }, after: { status: 'resolved', outcome: 'kill', resolvedBy: 'notify:digest' } },
  { name: 'rest', mode: 'rest', gate: pending(), ev: event('phone', 'approve'),
    reply: { reply: 'accepted' }, after: { status: 'resolved', outcome: 'approve', resolvedBy: 'notify:phone' } },
  { name: 'double-notify (seq-first-answer-latched)', mode: 'direct', gate: resolvedAs('approve', 'notify:phone'), ev: event('digest', 'revise'),
    reply: { reply: 'conflict', winning_value: 'approve', channel: 'phone' }, after: { status: 'resolved', outcome: 'approve', resolvedBy: 'notify:phone' } },
  { name: 'double-ui', mode: 'direct', gate: resolvedAs('revise', 'human'), ev: event('phone', 'approve'),
    reply: { reply: 'conflict', winning_value: 'revise', channel: 'compose' }, after: { status: 'resolved', outcome: 'revise', resolvedBy: 'human' } },
  { name: 'double-rest-race', mode: 'race', gate: pending(), ev: event('phone', 'approve'),
    reply: { reply: 'conflict', winning_value: 'kill', channel: 'compose' }, after: { status: 'resolved', outcome: 'kill', resolvedBy: 'cli' } },
  { name: 'stale (seq-product-rejected-reopens)', mode: 'direct', gate: pending(), ev: event('phone', 'approve', { version: '2026-01-01T00:00:00.000Z' }),
    reply: { reply: 'rejected', reason: 'stale version' }, after: { status: 'pending' } },
  { name: 'unknown', mode: 'direct', gate: pending(), pointer: false, ev: event('phone', 'approve'),
    reply: { reply: 'rejected', reason: 'unknown gate' }, after: { status: 'pending' } },
  { name: 'bad-value', mode: 'direct', gate: pending(), ev: event('phone', 'yes'),
    reply: { reply: 'rejected', reason: 'bad value' }, after: { status: 'pending' } },
  { name: 'expired (status)', mode: 'direct', gate: pending({ status: 'expired' }), ev: event('phone', 'approve'),
    reply: { reply: 'rejected', reason: 'expired' }, after: { status: 'expired' } },
  { name: 'expired (past deadline)', mode: 'direct', gate: pending({ createdAt: '2026-01-01T00:00:00.000Z' }),
    ev: event('phone', 'approve', { version: '2026-01-01T00:00:00.000Z' }), version: '2026-01-01T00:00:00.000Z',
    reply: { reply: 'rejected', reason: 'expired' }, after: { status: 'pending' } },
  { name: 'no channel on the event (R12: never defaulted by the product)', mode: 'direct', gate: pending(), ev: event(undefined, 'approve'),
    reply: { reply: 'rejected', reason: 'bad channel' }, after: { status: 'pending' } },
];

function seed(t, row) {
  const root = mkdtempSync(join(tmpdir(), 'notify-gate-answer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'vision-state.json'), JSON.stringify({ items: [], connections: [], gates: [row.gate] }));
  const env = { ...process.env, COMPOSE_NOTIFY_GATES_DIR: join(root, 'pointers') };
  delete env.COMPOSE_GATE_TIMEOUT;
  return { root, dataDir, env };
}

async function startServer(t, dataDir) {
  const store = new VisionStore(dataDir);
  const app = express();
  app.use(express.json());
  attachVisionRoutes(app, { store, scheduleBroadcast: () => {}, broadcastMessage: () => {}, projectRoot: dataDir });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { store, port: server.address().port };
}

test('gate answer: one reply per answer source and double-answer class', async (t) => {
  for (const row of ROWS) {
    await t.test(row.name, async (t) => {
      const { dataDir, env } = seed(t, row);
      let port = 1; // nothing listens on port 1: the probe fails, the handler uses the file store
      let store = null;
      if (row.mode !== 'direct') ({ store, port } = await startServer(t, dataDir));
      if (row.pointer !== false) {
        writePointer({ post_id: POST_ID, gate_id: GATE_ID, data_dir: dataDir, workspace_id: WS, port, version: row.version ?? CREATED }, env);
      }
      const writerFor = (ptr) => {
        const w = new VisionWriter(ptr.data_dir, { port: ptr.port, workspaceId: ptr.workspace_id });
        if (row.mode === 'race') {
          const get = w._restGetGate.bind(w);
          w._restGetGate = async (id) => {
            const seen = await get(id);
            store.resolveGate(id, { outcome: 'kill', resolvedBy: 'cli' });
            return seen;
          };
        }
        return w;
      };

      const reply = await answerGate(row.ev, { env, writerFor });

      const { close, ...rest } = reply;
      assert.deepEqual(rest, row.reply);
      if (row.reply.reply === 'accepted') {
        assert.deepEqual(close, { post_id: POST_ID, outcome: 'answered', channel: row.ev.channel });
      } else {
        assert.equal(close, undefined, 'only accepted carries a close (notify-cmd enqueues it)');
      }
      const gate = store
        ? store.gates.get(GATE_ID)
        : JSON.parse(readFileSync(join(dataDir, 'vision-state.json'), 'utf8')).gates[0];
      for (const [k, v] of Object.entries(row.after)) assert.equal(gate[k], v, `${row.name}: gate.${k}`);
      if (store) {
        const onDisk = JSON.parse(readFileSync(join(dataDir, 'vision-state.json'), 'utf8')).gates.find((g) => g.id === GATE_ID);
        assert.equal(onDisk.status, row.after.status, 'the REST path persists through the store');
      }
    });
  }
});

test('gate answer: the build\'s own post-decision write keeps resolvedBy (direct-rewrite)', async (t) => {
  const { dataDir } = seed(t, { gate: resolvedAs('approve', 'notify:phone') });
  const writer = new VisionWriter(dataDir, { port: 1, workspaceId: WS });
  await writer.resolveGate(GATE_ID, 'approve'); // build.js after the decision: no resolvedBy
  const gate = JSON.parse(readFileSync(join(dataDir, 'vision-state.json'), 'utf8')).gates[0];
  assert.equal(gate.resolvedBy, 'notify:phone');
  assert.equal(gate.outcome, 'approve');
});

test('gate post_id mapping and post bounds (_grammar.post_id, R14, R15, R16, R17)', () => {
  const long = 'f'.repeat(190);
  const ROWS_ID = [
    ['uuid flow', '3f2b6c1e-9a7d-4f8e-b1c2-0d9e8f7a6b5c:plan_gate:2', 'compose.gate:3f2b6c1e-9a7d-4f8e-b1c2-0d9e8f7a6b5c.plan_gate:2'],
    ['extra colon', 'a:b:c:1', null],
    ['bad character', 'flow 1:review:1', null],
    ['over 200', `${long}:review:1`, null],
    ['no round', 'flow:review', null],
  ];
  for (const [name, gateId, want] of ROWS_ID) assert.equal(gatePostId(gateId), want, name);

  const post = buildGatePost(
    { id: GATE_ID, stepId: 'review', createdAt: CREATED },
    { featureCode: 'FEAT-1', summary: `${'x'.repeat(1200)} api_key=abc123`, env: { COMPOSE_GATE_TIMEOUT: '1000' } },
  );
  assert.equal(post.card.body.length, 1000);
  assert.equal(post.severity, 'critical');
  assert.equal(post.deadline, new Date(Date.parse(CREATED) + 1000).toISOString());
  assert.deepEqual(post.payload, { gate_id: GATE_ID });
  assert.equal(post.default, undefined);
  assert.equal(post.escalation, undefined);
  const masked = buildGatePost({ id: GATE_ID, stepId: 'review', createdAt: CREATED },
    { featureCode: 'FEAT-1', summary: 'use token: ghp_abcdefghijklmnop1234 now', env: { COMPOSE_NOTIFY_GATE_SEVERITY: 'info' } });
  assert.doesNotMatch(masked.card.body, /ghp_abcdefghijklmnop1234/);
  assert.equal(masked.severity, 'info');
});
