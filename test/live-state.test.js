/**
 * live-state.test.js — COMP-DOGFOOD-LIVE-STATE-1.
 *
 * The workspace live-state store (lib/live-state.js): orders in, the supersede
 * rule, expiry, the hard-rules read, the injected section, the CLI the Claude
 * mod and other runners call, the contract, and get_current_session carrying
 * the view for a bound and an unbound session.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LiveStateError, activeOrders, addOrder, buildLiveState, configureLiveState, formatLiveStateSection,
  readHardRules, readStore, ruleBullets, storePath, supersedeOrder,
} from '../lib/live-state.js';
import { run as cliRun } from '../lib/live-state-cli.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const Ajv = (await import('ajv')).default;
const addFormats = (await import('ajv-formats')).default;

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const EVIDENCE = `# Evidence: Read, Verify (all projects; core)

Intro paragraph, not a bullet.

- **A factual claim carries its evidence.** file:line or output.
- **Relay gate** (OWNER 2026-11-03 "dispatch opus subagent"): any claim carries its evidence;
  a check that costs more than a trivial number of tokens goes to an Opus subagent.
- **Last** rule.
`;
const SESSIONS = `# Sessions (all projects; core)

- **Quota hop:** \`session_hop.py <name>\`; on a HOP line from hop-governor, flush and go idle: the governor hops you.
`;
const NOT_CORE = `# Scratchpad (local notes)

- **Not core** and never injected.
`;

/** A workspace with .compose/ and a rules dir; returns { root, dataDir }. */
function workspace({ rules = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'compose-live-state-'));
  made.push(root);
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  writeFileSync(join(root, '.compose', 'compose.json'), '{}');
  if (rules) {
    mkdirSync(join(root, 'ops', 'rules'), { recursive: true });
    writeFileSync(join(root, 'ops', 'rules', 'evidence.md'), EVIDENCE);
    writeFileSync(join(root, 'ops', 'rules', 'sessions.md'), SESSIONS);
    writeFileSync(join(root, 'ops', 'rules', 'scratch.md'), NOT_CORE);
  }
  return { root, dataDir: join(root, '.compose', 'data') };
}

const NOW = new Date('2026-11-03T14:00:00.000Z');

// ── the store ────────────────────────────────────────────────────────────────

test('addOrder assigns LO-1, LO-2 in order and keeps the text verbatim', () => {
  const { dataDir } = workspace();
  const a = addOrder(dataDir, { text: '  proof = sampled pixel + screenshot ', source: 'ledger.md:25722', by: 's1-chat',
    at: '2026-11-03T21:07:00+08:00' }, { now: NOW });
  const b = addOrder(dataDir, { text: 'second', source: 'ledger.md:1' }, { now: NOW });
  assert.equal(a.created, true);
  assert.equal(a.order.id, 'LO-1');
  assert.equal(b.order.id, 'LO-2');
  assert.equal(a.order.text, 'proof = sampled pixel + screenshot');
  assert.equal(a.order.at, '2026-11-03T13:07:00.000Z');
  assert.equal(b.order.at, NOW.toISOString(), 'at defaults to now');
  const store = readStore(dataDir);
  assert.equal(store.next_seq, 3);
  assert.deepEqual(store.live_orders.map((o) => o.id), ['LO-1', 'LO-2']);
});

test('the same text from the same source is added once (a hook firing twice)', () => {
  const { dataDir } = workspace();
  const first = addOrder(dataDir, { text: 'x', source: 'ledger.md:9' }, { now: NOW });
  const again = addOrder(dataDir, { text: 'x', source: 'ledger.md:9' }, { now: NOW });
  assert.equal(again.created, false);
  assert.equal(again.order.id, first.order.id);
  assert.equal(readStore(dataDir).live_orders.length, 1);
  assert.equal(addOrder(dataDir, { text: 'x', source: 'ledger.md:10' }, { now: NOW }).created, true, 'other source: a new order');
});

test('addOrder refuses bad input with a LiveStateError and writes nothing', () => {
  const { dataDir } = workspace();
  const bad = [
    [{ source: 's' }, /text is required/],
    [{ text: 't' }, /source is required/],
    [{ text: 'x'.repeat(4001), source: 's' }, /text is over 4000/],
    [{ text: 't', source: 's', at: 'yesterday' }, /at must be an ISO/],
    [{ text: 't', source: 's', at: '2026-11-03T10:00:00Z', expires: '2026-11-03T09:00:00Z' }, /expires must be after at/],
    [{ text: 't', source: 's', supersedes: 'LO-1' }, /supersedes must be a list/],
  ];
  for (const [input, re] of bad) {
    assert.throws(() => addOrder(dataDir, input, { now: NOW }), (e) => e instanceof LiveStateError && re.test(e.message));
  }
  assert.equal(existsSync(storePath(dataDir)), false);
});

test('a corrupt store is never overwritten: writes refuse, reads warn and say no orders were read', () => {
  const { root, dataDir } = workspace();
  writeFileSync(storePath(dataDir), '{ not json');
  assert.throws(() => addOrder(dataDir, { text: 't', source: 's' }), (e) => e.code === 'corrupt');
  assert.equal(readFileSync(storePath(dataDir), 'utf8'), '{ not json');
  const view = buildLiveState({ root, dataDir, now: NOW });
  assert.deepEqual(view.orders, []);
  assert.match(view.warnings.join('\n'), /WARNING live-state store unreadable .*no live orders read/);
});

test('a held lock older than the stale bound is taken over; the lock dir is gone after the write', () => {
  const { dataDir } = workspace();
  const lock = join(dataDir, 'live-state.lock');
  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  execFileSync('touch', ['-t', old.toISOString().replace(/[-:T]/g, '').slice(0, 12), lock]);
  addOrder(dataDir, { text: 't', source: 's' }, { now: NOW });
  assert.equal(existsSync(lock), false);
  assert.equal(readStore(dataDir).live_orders.length, 1);
});

// ── the supersede rule ───────────────────────────────────────────────────────

test('a superseded order drops out of the active list and stays in the store', () => {
  const { dataDir } = workspace();
  addOrder(dataDir, { text: 'hop on the overall meter', source: 'ledger.md:1', at: '2026-11-03T12:00:00Z' }, { now: NOW });
  const r = addOrder(dataDir, { text: 'hop on the Fable meter', source: 'ledger.md:2', at: '2026-11-03T13:00:00Z',
    supersedes: ['LO-1'] }, { now: NOW });
  assert.deepEqual(r.superseded, ['LO-1']);
  const store = readStore(dataDir);
  assert.equal(store.live_orders[0].superseded_by, 'LO-2');
  assert.equal(store.live_orders[0].superseded_at, NOW.toISOString());
  assert.deepEqual(activeOrders(store, NOW).map((o) => o.id), ['LO-2']);
});

test('supersedeOrder: by an order id or a source; unknown, self, repeat and dangling refs refused', () => {
  const { dataDir } = workspace();
  addOrder(dataDir, { text: 'a', source: 's1' }, { now: NOW });
  addOrder(dataDir, { text: 'b', source: 's2' }, { now: NOW });
  assert.throws(() => supersedeOrder(dataDir, { id: 'LO-9', superseded_by: 'LO-1' }), (e) => e.code === 'not_found');
  assert.throws(() => supersedeOrder(dataDir, { id: 'LO-1', superseded_by: 'LO-1' }), (e) => e.code === 'invalid');
  assert.throws(() => supersedeOrder(dataDir, { id: 'LO-1', superseded_by: 'LO-7' }), /names no order/);
  const r = supersedeOrder(dataDir, { id: 'LO-1', superseded_by: 'ledger.md:25761', reason: 'owner restated' }, { now: NOW });
  assert.equal(r.order.superseded_by, 'ledger.md:25761');
  assert.equal(r.order.supersede_reason, 'owner restated');
  assert.throws(() => supersedeOrder(dataDir, { id: 'LO-1', superseded_by: 'LO-2' }), (e) => e.code === 'conflict');
});

test('a bad id in supersedes leaves the store exactly as it was', () => {
  const { dataDir } = workspace();
  addOrder(dataDir, { text: 'a', source: 's1' }, { now: NOW });
  const before = readFileSync(storePath(dataDir), 'utf8');
  assert.throws(() => addOrder(dataDir, { text: 'b', source: 's2', supersedes: ['LO-1', 'LO-5'] }, { now: NOW }), /no order LO-5/);
  assert.equal(readFileSync(storePath(dataDir), 'utf8'), before);
});

test('active orders: newest `at` first, expired ones left out', () => {
  const { dataDir } = workspace();
  addOrder(dataDir, { text: 'old', source: 'a', at: '2026-11-03T10:00:00Z' }, { now: NOW });
  addOrder(dataDir, { text: 'new', source: 'b', at: '2026-11-03T12:00:00Z' }, { now: NOW });
  addOrder(dataDir, { text: 'gone', source: 'c', at: '2026-11-03T11:00:00Z', expires: '2026-11-03T13:00:00Z' }, { now: NOW });
  const store = readStore(dataDir);
  assert.deepEqual(activeOrders(store, NOW).map((o) => o.text), ['new', 'old']);
  assert.deepEqual(activeOrders(store, new Date('2026-11-03T12:30:00Z')).map((o) => o.text), ['new', 'gone', 'old']);
});

// ── hard rules ───────────────────────────────────────────────────────────────

test('ruleBullets keeps each top-level bullet whole with its indented continuation', () => {
  const b = ruleBullets(EVIDENCE);
  assert.equal(b.length, 3);
  assert.match(b[1], /^- \*\*Relay gate\*\*.*\n {2}a check that costs more .* Opus subagent\.$/);
});

test('readHardRules reads only core files, fresh from disk each call', () => {
  const { root } = workspace();
  const r = readHardRules(root, 'ops/rules');
  assert.equal(r.error, null);
  assert.deepEqual(r.files.map((f) => f.file), ['evidence.md', 'sessions.md']);
  writeFileSync(join(root, 'ops', 'rules', 'sessions.md'), SESSIONS.replace('flush and go idle', 'FLUSH AND GO IDLE'));
  assert.match(readHardRules(root, 'ops/rules').files[1].bullets[0], /FLUSH AND GO IDLE/);
});

test('readHardRules names what is missing instead of returning an empty block', () => {
  const { root } = workspace();
  assert.match(readHardRules(root, null).error, /no rules_dir configured/);
  assert.match(readHardRules(root, 'nope').error, /rules_dir unreadable: nope/);
  const outside = mkdtempSync(join(tmpdir(), 'compose-live-outside-'));
  made.push(outside);
  assert.match(readHardRules(root, outside).error, /outside the workspace/);
  symlinkSync(outside, join(root, 'escape'));
  assert.match(readHardRules(root, 'escape').error, /outside the workspace/, 'a symlink out of the root is refused');
  const empty = join(root, 'empty');
  mkdirSync(empty);
  assert.match(readHardRules(root, 'empty').error, /no core rule files in empty/);
});

test('configureLiveState stores rules_dir only when it is a directory inside the root', () => {
  const { root, dataDir } = workspace();
  assert.throws(() => configureLiveState(dataDir, { root, rules_dir: '../..' }), /outside the workspace/);
  assert.deepEqual(configureLiveState(dataDir, { root, rules_dir: 'ops/rules' }), { rules_dir: 'ops/rules' });
  assert.equal(readStore(dataDir).rules_dir, 'ops/rules');
});

// ── the section ──────────────────────────────────────────────────────────────

test('the section carries every active order (id, source, verbatim text) and the rules block', () => {
  const { root, dataDir } = workspace();
  configureLiveState(dataDir, { root, rules_dir: 'ops/rules' });
  addOrder(dataDir, { text: 'proof = sampled pixel + screenshot', source: 'ledger.md:25722', at: '2026-11-03T13:07:00Z' }, { now: NOW });
  addOrder(dataDir, { text: 'superseded one', source: 'x', supersedes: [] }, { now: NOW });
  supersedeOrder(dataDir, { id: 'LO-2', superseded_by: 'LO-1' }, { now: NOW });
  const text = formatLiveStateSection(buildLiveState({ root, dataDir, workspaceId: 'ws', now: NOW }));
  assert.match(text, /^## Live orders and hard rules \(Compose, \d{4}-\d\d-\d\d \d\d:\d\d\)\n/);
  assert.match(text, /- \[LO-1\] .* \(ledger\.md:25722\): proof = sampled pixel \+ screenshot\n/);
  assert.doesNotMatch(text, /superseded one/);
  assert.match(text, /#### evidence\.md: .*\n.*\n- \*\*Relay gate\*\*/);
  assert.match(text, /governor hops you/);
  assert.doesNotMatch(text, /Not core/);
  assert.match(text, /session unbound/);
});

test('past the byte cap, rule bullets are cut with a WARNING; orders are never cut', () => {
  const { root, dataDir } = workspace();
  configureLiveState(dataDir, { root, rules_dir: 'ops/rules' });
  addOrder(dataDir, { text: 'keep me', source: 's' }, { now: NOW });
  const text = formatLiveStateSection(buildLiveState({ root, dataDir, now: NOW }), { maxBytes: 700 });
  assert.match(text, /keep me/);
  assert.match(text, /WARNING \d+ hard-rule bullets cut at the 700 B cap; read the rest from ops\/rules/);
});

test('no rules_dir: the section says HARD RULES UNAVAILABLE, and a cached note leads the body', () => {
  const { root, dataDir } = workspace({ rules: false });
  const text = formatLiveStateSection(buildLiveState({ root, dataDir, now: NOW }), { cachedNote: 'WARNING live state from cache 5m' });
  assert.match(text, /HARD RULES UNAVAILABLE: no rules_dir configured/);
  assert.match(text, /^## .*\n\nWARNING live state from cache 5m\n/);
  assert.match(text, /- \(none active\)/);
});

// ── the CLI (what the mod and any other runner call) ─────────────────────────

test('CLI: configure, add with --expires-in and --supersedes, supersede, read', () => {
  const { root } = workspace();
  assert.deepEqual(JSON.parse(cliRun(['configure', '--root', root, '--rules-dir', 'ops/rules'])), { rules_dir: 'ops/rules' });
  const a = JSON.parse(cliRun(['add', '--root', root, '--text', 'one', '--source', 'ledger.md:1', '--by', 's1-chat',
    '--at', '2026-11-03T10:00:00Z', '--expires-in', '24h'], { now: NOW }));
  assert.equal(a.order.expires, '2026-11-04T10:00:00.000Z');
  const b = JSON.parse(cliRun(['add', '--root', root, '--text', 'two', '--source', 'ledger.md:2', '--supersedes', 'LO-1'], { now: NOW }));
  assert.deepEqual(b.superseded, ['LO-1']);
  JSON.parse(cliRun(['add', '--root', root, '--text', 'three', '--source', 'ledger.md:3'], { now: NOW }));
  const s = JSON.parse(cliRun(['supersede', '--root', root, '--id', 'LO-3', '--by', 'LO-2', '--reason', 'dup'], { now: NOW }));
  assert.equal(s.order.superseded_by, 'LO-2');
  const out = JSON.parse(cliRun(['read', '--root', root], { now: NOW }));
  assert.deepEqual(out.view.orders.map((o) => o.id), ['LO-2']);
  assert.match(out.text, /\[LO-2\]/);
  assert.equal(cliRun(['read', '--root', root, '--text'], { now: NOW }), out.text);
});

test('CLI as a process: exit 2 on usage, exit 3 off a workspace, stdout JSON on success', () => {
  const { root } = workspace();
  const cli = join(REPO, 'lib', 'live-state-cli.js');
  const node = process.execPath;
  assert.equal(spawnSync(node, [cli, 'bogus', '--root', root]).status, 2);
  const off = mkdtempSync(join(tmpdir(), 'compose-live-nows-'));
  made.push(off);
  const r3 = spawnSync(node, [cli, 'read', '--root', off], { encoding: 'utf8' });
  assert.equal(r3.status, 3);
  assert.match(r3.stderr, /not a Compose workspace/);
  const ok = spawnSync(node, [cli, 'read', '--root', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).view.workspace.root, root);
});

// ── the contract ─────────────────────────────────────────────────────────────

test('contract: the written store and the read view validate against live-state.schema.json', () => {
  const schema = JSON.parse(readFileSync(join(REPO, 'contracts', 'live-state.schema.json'), 'utf8'));
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  const store = ajv.getSchema('live-state.schema.json#/$defs/Store');
  const view = ajv.getSchema('live-state.schema.json#/$defs/View');
  const { root, dataDir } = workspace();
  configureLiveState(dataDir, { root, rules_dir: 'ops/rules' });
  addOrder(dataDir, { text: 'a', source: 's', by: 'me', expires: '2026-11-05T00:00:00Z' }, { now: NOW });
  addOrder(dataDir, { text: 'b', source: 's', supersedes: ['LO-1'] }, { now: NOW });
  const doc = JSON.parse(readFileSync(storePath(dataDir), 'utf8'));
  assert.ok(store(doc), JSON.stringify(store.errors));
  const v = buildLiveState({ root, dataDir, workspaceId: 'ws', boundFeature: 'F-1', now: NOW });
  assert.ok(view(v), JSON.stringify(view.errors));
  assert.equal(store({ ...doc, version: 2 }), false, 'a wrong version is refused');
  assert.equal(store({ ...doc, live_orders: [{ ...doc.live_orders[0], id: 'X-1' }] }), false, 'a bad id is refused');
});

// ── get_current_session ──────────────────────────────────────────────────────

test('get_current_session: live_state for an unbound session, then the same orders with bound: true', async () => {
  const { switchProject } = await import('../server/project-root.js');
  const tools = await import('../server/compose-mcp-tools.js');
  const { root, dataDir } = workspace();
  configureLiveState(dataDir, { root, rules_dir: 'ops/rules' });
  addOrder(dataDir, { text: 'hop = cadence action, never the session', source: 'ledger.md:25761' });
  switchProject(root);
  const unbound = await tools.toolGetCurrentSession();
  assert.equal(unbound.session, null, 'no sessions file: the session part is unchanged');
  assert.equal(unbound.live_state.bound, false);
  assert.equal(unbound.live_state.workspace.root, root);
  assert.deepEqual(unbound.live_state.orders.map((o) => o.text), ['hop = cadence action, never the session']);
  assert.deepEqual(unbound.live_state.hard_rules.files.map((f) => f.file), ['evidence.md', 'sessions.md']);

  tools._testOnly_setSessionContext({ boundFeatureCode: 'COMP-X-1' });
  const bound = await tools.toolGetCurrentSession();
  assert.equal(bound.live_state.bound, true);
  assert.equal(bound.live_state.bound_feature, 'COMP-X-1');
  assert.deepEqual(bound.live_state.orders.map((o) => o.id), ['LO-1']);

  const got = tools.toolLiveStateGet({ format: 'text' });
  assert.match(got.section, /\[LO-1\] .*hop = cadence action, never the session/);
  const added = tools.toolLiveOrderAdd({ text: 'n', source: 'ledger.md:2', supersedes: ['LO-1'] });
  assert.equal(added.order.id, 'LO-2');
  assert.deepEqual((await tools.toolGetCurrentSession()).live_state.orders.map((o) => o.id), ['LO-2']);
  tools._testOnly_setSessionContext({ boundFeatureCode: null });
});

test('get_current_session off a Compose workspace: workspace null with a warning, never a throw', async () => {
  const { switchProject } = await import('../server/project-root.js');
  const tools = await import('../server/compose-mcp-tools.js');
  const off = mkdtempSync(join(tmpdir(), 'compose-live-nows-'));
  made.push(off);
  switchProject(off);
  const r = await tools.toolGetCurrentSession();
  assert.equal(r.live_state.workspace, null);
  assert.deepEqual(r.live_state.orders, []);
  assert.match(r.live_state.warnings.join('\n'), /workspace unknown/);
  assert.throws(() => tools.toolLiveOrderAdd({ text: 't', source: 's' }), /not a Compose workspace/);
});

test('policy: the three live-state writers are denied to implementer and reviewer; the read is allowed', async () => {
  const { isToolAllowed } = await import('../server/mcp-tool-policy.js');
  for (const tool of ['live_order_add', 'live_order_supersede', 'live_state_configure']) {
    assert.equal(isToolAllowed({ tool, profile: 'implementer', phase: 'execute' }).allowed, false, `${tool} implementer`);
    assert.equal(isToolAllowed({ tool, profile: 'reviewer' }).allowed, false, `${tool} reviewer`);
    assert.equal(isToolAllowed({ tool, profile: 'orchestrator' }).allowed, true, `${tool} orchestrator`);
  }
  assert.equal(isToolAllowed({ tool: 'live_state_get', profile: 'reviewer' }).allowed, true);
});
