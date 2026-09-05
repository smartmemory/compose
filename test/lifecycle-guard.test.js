/**
 * Tests for server/lifecycle-guard.js — compose-owned STRAT-GUARD policy
 * (COMP-MCP-ENFORCE Slice 1). The guard client is stubbed; the real
 * Stratum TS subprocess is exercised by the golden-flow integration test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = `${REPO_ROOT}/server`;

const {
  buildPhaseGraph, edgePredicates, resourceId, ensureGuard, guardedTransition,
  policyChecksumFields, legacyPolicyProjection, policiesEqual,
  verifyCompletionEvidenceAsync,
  _testOnly_setGuardClient, _testOnly_resetGuardCache,
} = await import(`${SERVER_DIR}/lifecycle-guard.js`);

function stubClient() {
  const calls = { register: [], transition: [], policy: [], applyUpgrade: [] };
  let registerResult = { status: 'registered', checksum: 'c', guard_id: 'g' };
  let transitionResult = { status: 'applied', current_state: 'blueprint', verdict: { met: true }, ledger_ref: 'r' };
  let policyResult = { status: 'ok' };
  return {
    calls,
    setRegister(r) { registerResult = r; },
    setTransition(t) { transitionResult = t; },
    setPolicy(p) { policyResult = p; },
    client: {
      register: async (a) => { calls.register.push(a); return registerResult; },
      transition: async (a) => { calls.transition.push(a); return transitionResult; },
      policy: async (a) => { calls.policy.push(a); return policyResult; },
      applyUpgrade: async (a) => { calls.applyUpgrade.push(a); return { status: 'unchanged' }; },
    },
  };
}

test('buildPhaseGraph: adds ship→complete, *→killed, terminal sinks', () => {
  const g = buildPhaseGraph();
  assert.ok(g.ship.includes('complete'), 'ship→complete present');
  assert.ok(g.explore_design.includes('killed'), 'explore_design→killed present');
  assert.ok(g.plan.includes('killed'), 'plan→killed present');
  assert.deepEqual(g.complete, [], 'complete is terminal');
  assert.deepEqual(g.killed, [], 'killed is terminal');
  // existing edges preserved
  assert.ok(g.explore_design.includes('blueprint'));
  assert.ok(g.blueprint.includes('verification'));
  // complete/killed never get outgoing edges
  assert.ok(!g.complete.includes('killed'));
});

test('resourceId: project-scoped — different roots → different ids, same root stable', () => {
  const a = resourceId('FEAT-1', '/tmp/projA');
  const b = resourceId('FEAT-1', '/tmp/projB');
  const a2 = resourceId('FEAT-1', '/tmp/projA');
  assert.notEqual(a, b, 'distinct project roots must not collide');
  assert.equal(a, a2, 'same root+code is stable');
  assert.ok(a.startsWith('compose:'), 'namespaced');
  assert.ok(a.endsWith(':FEAT-1'), 'feature code is the suffix');
});

test('edgePredicates: server-read paths derived from feature dir, relative (no leading slash)', () => {
  const p = edgePredicates('docs/features/FEAT-1');
  assert.equal(p['explore_design->blueprint'][0].statement, "server_file_exists('docs/features/FEAT-1/design.md')");
  assert.equal(p['blueprint->verification'][0].statement, "server_file_exists('docs/features/FEAT-1/blueprint.md')");
  assert.equal(p['plan->execute'][0].statement, "server_file_exists('docs/features/FEAT-1/plan.md')");
  for (const preds of Object.values(p)) {
    for (const pred of preds) {
      assert.equal(pred.type, 'deterministic');
      assert.ok(!pred.statement.includes("('/"), 'paths must be workspace-relative');
    }
  }
});

test('ensureGuard: registers with initial=currentPhase, caches per resource', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  _testOnly_setGuardClient(s.client);

  await ensureGuard('FEAT-9', 'plan', '/tmp/projX');
  assert.equal(s.calls.register.length, 1);
  assert.equal(s.calls.register[0].initial, 'plan', 'seeds initial from current phase (backfill-safe)');
  assert.deepEqual(s.calls.register[0].terminal, ['complete', 'killed', 'complete_backfilled']);

  // Second call for same resource is cached — no second subprocess.
  await ensureGuard('FEAT-9', 'plan', '/tmp/projX');
  assert.equal(s.calls.register.length, 1, 'cached, not re-registered');
});

test('policy compatibility: projection removes only backfill additions and terminal order is ignored', () => {
  const oldPolicy = {
    graph: { explore_design: ['blueprint', 'killed'], blueprint: ['killed'], complete: [], killed: [] },
    edge_predicates: { 'explore_design->blueprint': [] },
    terminal: ['complete', 'killed'], stakes: {}, initial: 'explore_design',
  };
  const projected = legacyPolicyProjection({
    graph: {
      explore_design: ['blueprint', 'complete_backfilled', 'killed'],
      blueprint: ['complete_backfilled', 'killed'], complete: [], complete_backfilled: [], killed: [],
    },
    edge_predicates: oldPolicy.edge_predicates,
    terminal: ['complete', 'killed', 'complete_backfilled'], stakes: {},
  });
  assert.deepEqual(projected, policyChecksumFields(oldPolicy));
  assert.ok(policiesEqual(projected, { ...policyChecksumFields(oldPolicy), terminal: ['killed', 'complete'] }));
  assert.ok(!policiesEqual(projected, { ...policyChecksumFields(oldPolicy), graph: { ...oldPolicy.graph, blueprint: ['killed', 'complete'] } }));
});

test('ensureGuard: an already-registered projected legacy policy is cached as legacy', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  s.setRegister({ status: 'error', error_type: 'guard_already_registered', message: 'exists' });
  s.setPolicy({ status: 'ok', checksum: 'old-checksum', graph: {
    explore_design: ['prd', 'architecture', 'blueprint', 'killed'], prd: ['architecture', 'blueprint', 'killed'],
    architecture: ['blueprint', 'killed'], blueprint: ['verification', 'killed'], verification: ['plan', 'blueprint', 'killed'],
    plan: ['execute', 'killed'], execute: ['report', 'docs', 'killed'], report: ['docs', 'killed'], docs: ['ship', 'killed'],
    ship: ['complete', 'killed'], complete: [], killed: [],
  }, edge_predicates: edgePredicates('docs/features/FEAT-9'), terminal: ['complete', 'killed'], stakes: {}, initial: 'ship' });
  _testOnly_setGuardClient(s.client);
  const first = await ensureGuard('FEAT-9', 'explore_design', '/tmp/projX');
  assert.deepEqual(first, { guard_id: resourceId('FEAT-9', '/tmp/projX'), status: 'legacy', storedChecksum: 'old-checksum' });
  const second = await ensureGuard('FEAT-9', 'explore_design', '/tmp/projX');
  assert.equal(second.status, 'legacy');
  assert.equal(s.calls.register.length, 1);
  assert.equal(s.calls.policy.length, 1);
});

test('ensureGuard: a divergent stored policy fails closed', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  s.setRegister({ status: 'error', error_type: 'guard_already_registered', message: 'exists' });
  s.setPolicy({ status: 'ok', checksum: 'wrong', graph: {}, edge_predicates: {}, terminal: [], stakes: {} });
  _testOnly_setGuardClient(s.client);
  const result = await ensureGuard('FEAT-9', 'explore_design', '/tmp/projX');
  assert.equal(result.error.code, 'GUARD_POLICY_DIVERGED');
});

test('guardedTransition: forwards camelCase idempotency and expected policy checksum on legacy resources', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  s.setRegister({ status: 'error', error_type: 'guard_already_registered', message: 'exists' });
  s.setPolicy({ status: 'ok', checksum: 'old-checksum', graph: {
    explore_design: ['prd', 'architecture', 'blueprint', 'killed'], prd: ['architecture', 'blueprint', 'killed'], architecture: ['blueprint', 'killed'], blueprint: ['verification', 'killed'], verification: ['plan', 'blueprint', 'killed'], plan: ['execute', 'killed'], execute: ['report', 'docs', 'killed'], report: ['docs', 'killed'], docs: ['ship', 'killed'], ship: ['complete', 'killed'], complete: [], killed: [],
  }, edge_predicates: edgePredicates('docs/features/FEAT-1'), terminal: ['complete', 'killed'], stakes: {} });
  _testOnly_setGuardClient(s.client);
  const result = await guardedTransition({ featureCode: 'FEAT-1', from: 'explore_design', to: 'complete_backfilled', workspaceRoot: '/tmp/projX', idempotencyKey: 'op-1', expectedPolicyChecksum: 'a'.repeat(64) });
  assert.equal(result.applied, true);
  assert.equal(s.calls.transition[0].idempotencyKey, 'op-1');
  assert.equal(s.calls.transition[0].expectedPolicyChecksum, 'a'.repeat(64));
});

test('verifyCompletionEvidenceAsync preserves completion evidence result shape without blocking spawns', async () => {
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const result = await verifyCompletionEvidenceAsync({
    commitSha,
    cwd: REPO_ROOT,
    testCommand: [process.execPath, '-e', 'process.exit(0)'],
    testsPassClaim: false,
  });
  assert.deepEqual(result, { ok: true, reasons: [], testsAttested: true });
});

test('guardedTransition: applied → {applied:true} with verdict', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  _testOnly_setGuardClient(s.client);

  const r = await guardedTransition({
    featureCode: 'FEAT-1', from: 'explore_design', to: 'blueprint',
    workspaceRoot: '/tmp/projX', resolvedBy: 'agent',
  });
  assert.equal(r.applied, true);
  assert.equal(r.currentState, 'blueprint');
  assert.equal(s.calls.transition[0].fromState, 'explore_design');
  assert.equal(s.calls.transition[0].toState, 'blueprint');
});

test('guardedTransition: refused verdict → {applied:false, refused:true}', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  s.setTransition({ status: 'refused', current_state: 'blueprint', verdict: { met: false } });
  _testOnly_setGuardClient(s.client);

  const r = await guardedTransition({
    featureCode: 'FEAT-1', from: 'blueprint', to: 'verification', workspaceRoot: '/tmp/projX',
  });
  assert.equal(r.applied, false);
  assert.equal(r.refused, true);
  assert.equal(r.verdict.met, false);
});

test('guardedTransition: stratum error → fail-closed (applied:false, error set)', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  s.setTransition({ error: { code: 'TIMEOUT', message: 'timed out' } });
  _testOnly_setGuardClient(s.client);

  const r = await guardedTransition({
    featureCode: 'FEAT-1', from: 'explore_design', to: 'blueprint', workspaceRoot: '/tmp/projX',
  });
  assert.equal(r.applied, false, 'fail-closed: no transition on guard error');
  assert.ok(r.error, 'error surfaced');
});

test('guardedTransition: status:error dict from guard → fail-closed', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  s.setTransition({ status: 'error', error_type: 'IllegalEdge', message: 'x->y illegal' });
  _testOnly_setGuardClient(s.client);

  const r = await guardedTransition({
    featureCode: 'FEAT-1', from: 'x', to: 'y', workspaceRoot: '/tmp/projX',
  });
  assert.equal(r.applied, false);
  assert.ok(r.error);
});

test('guardedTransition: a thrown Stratum client failure fails closed', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  // register succeeds, transition throws like a real ENOENT spawn rejection
  s.client.transition = async () => { throw new Error('Stratum TS CLI not found'); };
  _testOnly_setGuardClient(s.client);

  const r = await guardedTransition({
    featureCode: 'FEAT-1', from: 'explore_design', to: 'blueprint', workspaceRoot: '/tmp/projX',
  });
  assert.equal(r.applied, false, 'thrown error must not apply a transition');
  assert.ok(r.error, 'normalised to a fail-closed error result');
});

test('ensureGuard: a THROWN register failure fails closed (no apply downstream)', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  s.client.register = async () => { throw new Error('ENOENT'); };
  _testOnly_setGuardClient(s.client);

  const r = await guardedTransition({
    featureCode: 'FEAT-1', from: 'explore_design', to: 'blueprint', workspaceRoot: '/tmp/projX',
  });
  assert.equal(r.applied, false);
  assert.ok(r.error);
  assert.equal(s.calls.transition.length, 0, 'transition not attempted when registration fails');
});

test('ensureGuard: predicate paths derive from the SERVED workspaceRoot config, not the global', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  _testOnly_resetGuardCache();
  const s = stubClient();
  _testOnly_setGuardClient(s.client);

  const ws = mkdtempSync(join(tmpdir(), 'lg-cfg-'));
  mkdirSync(join(ws, '.compose'), { recursive: true });
  writeFileSync(join(ws, '.compose', 'compose.json'), JSON.stringify({ paths: { features: 'custom/feat' } }));

  await ensureGuard('FEAT-7', 'explore_design', ws);
  const preds = s.calls.register[0].edgePredicates['explore_design->blueprint'];
  assert.equal(preds[0].statement, "server_file_exists('custom/feat/FEAT-7/design.md')",
    'feature dir must come from the served workspaceRoot config');
});

test('guardedTransition: commitSha is passed through artifacts', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  s.setTransition({ status: 'applied', current_state: 'complete', verdict: { met: true } });
  _testOnly_setGuardClient(s.client);

  await guardedTransition({
    featureCode: 'FEAT-1', from: 'ship', to: 'complete', workspaceRoot: '/tmp/projX', commitSha: 'abc123',
  });
  assert.equal(s.calls.transition[0].artifacts.commit_sha, 'abc123');
});

// ---------------------------------------------------------------------------
// COMP-ROADMAP-MODES S02 — mode-threading. build stays byte-identical; new
// modes get a namespaced resource id + their own graph/predicates.
// ---------------------------------------------------------------------------

test('resourceId: build mode is BYTE-IDENTICAL to the legacy 2-arg id (no mode segment)', () => {
  const legacy = resourceId('FEAT-1', '/tmp/projA');
  assert.equal(resourceId('FEAT-1', '/tmp/projA', 'build'), legacy, 'build must not change the id');
  assert.ok(legacy.endsWith(':FEAT-1'), 'no mode segment for build');
});

test('resourceId: non-build modes get a namespaced id that cannot collide with build', () => {
  const build = resourceId('FEAT-1', '/tmp/projA', 'build');
  const fix = resourceId('FEAT-1', '/tmp/projA', 'fix');
  const plan = resourceId('FEAT-1', '/tmp/projA', 'plan');
  assert.notEqual(fix, build);
  assert.notEqual(plan, build);
  assert.notEqual(fix, plan);
  assert.ok(fix.endsWith(':fix:FEAT-1'), 'fix id carries its mode segment');
  assert.ok(plan.endsWith(':plan:FEAT-1'));
  // legacy/runtime tokens normalize: bug→fix, feature→build
  assert.equal(resourceId('FEAT-1', '/tmp/projA', 'bug'), fix);
  assert.equal(resourceId('FEAT-1', '/tmp/projA', 'feature'), build);
});

test('buildPhaseGraph(mode): fix/plan graphs come from the registry with the right completion edge', () => {
  const fix = buildPhaseGraph('fix');
  assert.ok(fix.reproduce.includes('diagnose'), 'fix forward edges from registry');
  assert.ok(fix.ship.includes('complete'), 'completable phase → complete');
  assert.ok(fix.reproduce.includes('killed'), 'non-terminal → killed');
  assert.deepEqual(fix.complete, []);

  const plan = buildPhaseGraph('plan');
  assert.ok(plan.explore_design.includes('plan'));
  assert.ok(plan.ship.includes('complete'));
  assert.deepEqual(plan.killed, []);

  // build with an explicit mode equals the no-arg (legacy) graph
  assert.deepEqual(buildPhaseGraph('build'), buildPhaseGraph());
});

test('edgePredicates(relDir, mode): build unchanged; fix empty; plan has its own edge', () => {
  const rel = 'docs/features/FEAT-1';
  assert.deepEqual(edgePredicates(rel, 'build'), edgePredicates(rel), 'build unchanged');
  assert.deepEqual(edgePredicates(rel, 'fix'), {}, 'fix declares no evidence');
  const plan = edgePredicates(rel, 'plan');
  assert.equal(plan['explore_design->plan'][0].statement, "server_file_exists('docs/features/FEAT-1/design.md')");
});

test('ensureGuard(mode): build registers the legacy rid; fix registers a mode-namespaced rid + fix graph', async () => {
  _testOnly_resetGuardCache();
  const s = stubClient();
  _testOnly_setGuardClient(s.client);

  await ensureGuard('FEAT-9', 'explore_design', '/tmp/projX'); // legacy 3-arg → build
  await ensureGuard('BUG-3', 'reproduce', '/tmp/projX', 'fix');

  const buildReg = s.calls.register.find(r => r.resourceId.endsWith(':FEAT-9'));
  const fixReg = s.calls.register.find(r => r.resourceId.includes(':fix:BUG-3'));
  assert.ok(buildReg, 'build rid has no mode segment');
  assert.ok(fixReg, 'fix rid is mode-namespaced');
  assert.ok(fixReg.graph.reproduce.includes('diagnose'), 'fix registered with the fix graph');
});
