import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const oracle = fileURLToPath(new URL('../scripts/cost-oracle.mjs', import.meta.url));

// COMP-COST-OWNER 0b Part B: the oracle reads dispatch-ledger.jsonl (compose's
// real cost record), keyed by FEATURE via build_id. build-history.jsonl is read
// only to measure the gap between the two surfaces.
function run(t, { ledger = [], history = [], flows = [], args = ['--all', '--json'] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'cost-oracle-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.compose/data'), { recursive: true });
  writeFileSync(join(cwd, '.compose/data/dispatch-ledger.jsonl'), ledger.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(cwd, '.compose/data/build-history.jsonl'), history.map((r) => JSON.stringify(r)).join('\n') + '\n');
  // Stratum flow inventory lives under the (stubbed) home directory.
  mkdirSync(join(cwd, '.stratum/ts/flows'), { recursive: true });
  for (const flow of flows) {
    writeFileSync(join(cwd, '.stratum/ts/flows', `${flow.id}.json`), JSON.stringify({ workspaceRoot: cwd, ...flow }));
  }
  const preload = join(cwd, 'preload.mjs');
  // Keep the real CLI/file/report path; replace the external ccusage response
  // and home-directory lookup so this test never reads user data or uses npx.
  writeFileSync(preload, `
import cp from 'node:child_process';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
cp.execFileSync = () => JSON.stringify({ session: [] });
os.homedir = () => ${JSON.stringify(cwd)};
syncBuiltinESMExports();
`);
  const child = spawnSync(process.execPath, ['--import', preload, oracle, ...args], {
    cwd, encoding: 'utf8', timeout: 30000, env: { ...process.env, COMPOSE_PORT: '19997' },
  });
  assert.ifError(child.error);
  return child;
}

// `expectStatus` is explicit because a real UNDER finding exits 1 by contract.
function features(t, options, expectStatus = 0) {
  const child = run(t, options);
  assert.equal(child.status, expectStatus, child.stderr);
  return JSON.parse(child.stdout).features;
}

const actuals = (build_id, feature_code, usd, ts, extra = {}) =>
  ({ kind: 'build-actuals', build_id, feature_code, usd, ts, ...extra });

test('ledger cost is the LAST row per build_id, summed across build_ids', t => {
  const [feature] = features(t, {
    ledger: [
      actuals('one', 'F-1', 2, '2026-09-13T01:00:00Z'),
      // Same accumulator lifetime accrues; only its final row counts.
      actuals('one', 'F-1', 4, '2026-09-13T02:00:00Z'),
      // A cleared accumulator starts a new lifetime, which adds.
      actuals('two', 'F-1', 0.5, '2026-09-13T03:00:00Z'),
    ],
  });
  assert.equal(feature.featureCode, 'F-1');
  assert.equal(feature.compose_usd, 4.5);
  assert.equal(feature.builds, 2);
});

test('per-build rows are emitted, so a roll-up cannot hide an outlier build', t => {
  // Measured 2026-09-13: build 3e95eb77 sits at 0.28x of its own flow's bound
  // while its feature roll-up reads OK. A count alone makes that invisible.
  const [feature] = features(t, {
    ledger: [
      actuals('big', 'F-1', 20, '2026-09-13T01:00:00Z', { tokens_total: 1000 }),
      actuals('small', 'F-1', 0.5, '2026-09-13T02:00:00Z', { tokens_total: 400, terminal_status: 'aborted' }),
    ],
  });
  assert.equal(feature.builds, 2);
  assert.deepEqual(feature.build_rows.map((b) => b.build_id).sort(), ['big', 'small']);
  const small = feature.build_rows.find((b) => b.build_id === 'small');
  assert.deepEqual(small, { build_id: 'small', usd: 0.5, tokens_total: 400, terminal_status: 'aborted' });
});

test('rows for different features do not merge', t => {
  const rows = features(t, {
    ledger: [
      actuals('one', 'F-1', 3, '2026-09-13T01:00:00Z'),
      actuals('two', 'F-2', 7, '2026-09-13T01:00:00Z'),
    ],
  });
  assert.deepEqual(rows.map((r) => [r.featureCode, r.compose_usd]).sort(), [['F-1', 3], ['F-2', 7]]);
});

test('_seq breaks a tie when two rows share a timestamp', t => {
  const [feature] = features(t, {
    ledger: [
      actuals('one', 'F-1', 9, '2026-09-13T01:00:00Z', { _seq: 2 }),
      actuals('one', 'F-1', 1, '2026-09-13T01:00:00Z', { _seq: 1 }),
    ],
  });
  assert.equal(feature.compose_usd, 9);
});

test('non build-actuals ledger kinds are ignored', t => {
  const [feature] = features(t, {
    ledger: [
      { kind: 'dispatch', build_id: 'one', feature_code: 'F-1', usd: 99, ts: '2026-09-13T00:00:00Z' },
      { kind: 'settlement', build_id: 'one', feature_code: 'F-1', usd: 99, ts: '2026-09-13T00:30:00Z' },
      actuals('one', 'F-1', 2, '2026-09-13T01:00:00Z'),
    ],
  });
  assert.equal(feature.compose_usd, 2);
});

test('the build-history shortfall is measured and reported, not silently preferred', t => {
  const [feature] = features(t, {
    ledger: [actuals('one', 'F-1', 10, '2026-09-13T02:00:00Z')],
    history: [{ featureCode: 'F-1', flowId: 'flow-a', cost_usd: 2.5, startedAt: '2026-09-13T01:00:00Z' }],
  });
  // The ledger stays the cost of record; history is the short surface.
  assert.equal(feature.compose_usd, 10);
  assert.equal(feature.history_usd, 2.5);
  assert.equal(feature.history_shortfall_usd, 7.5);
  assert.equal(feature.history_gap, true);
});

test('no history gap is reported when the two surfaces agree', t => {
  const [feature] = features(t, {
    ledger: [actuals('one', 'F-1', 10, '2026-09-13T02:00:00Z')],
    history: [{ featureCode: 'F-1', flowId: 'flow-a', cost_usd: 10, startedAt: '2026-09-13T01:00:00Z' }],
  });
  assert.equal(feature.history_gap, false);
  assert.equal(feature.history_shortfall_usd, 0);
});

test('UNDER fires only when the ledger falls below the independent bound', t => {
  const [feature] = features(t, {
    ledger: [actuals('one', 'F-1', 1, '2026-09-13T02:00:00Z')],
    flows: [{ id: 'flow-a', input: { featureCode: 'F-1' }, flowSpent: { usd: 10 } }],
  }, 1);
  assert.equal(feature.stratum_flow_spent_usd, 10);
  assert.equal(feature.verdict, 'UNDER');
  assert.equal(feature.finding, true);
});

test('a ledger at or above the bound is OK, and UNDER sets exit 1', t => {
  const [ok] = features(t, {
    ledger: [actuals('one', 'F-1', 12, '2026-09-13T02:00:00Z')],
    flows: [{ id: 'flow-a', input: { featureCode: 'F-1' }, flowSpent: { usd: 10 } }],
  });
  assert.equal(ok.verdict, 'OK');
  assert.equal(ok.finding, false);
  const child = run(t, {
    ledger: [actuals('one', 'F-1', 1, '2026-09-13T02:00:00Z')],
    flows: [{ id: 'flow-a', input: { featureCode: 'F-1' }, flowSpent: { usd: 10 } }],
  });
  assert.equal(child.status, 1, child.stderr);
});

test('flowSpent sums across a feature flows and counts those lacking usd', t => {
  const [feature] = features(t, {
    ledger: [actuals('one', 'F-1', 12, '2026-09-13T02:00:00Z')],
    flows: [
      { id: 'flow-a', input: { featureCode: 'F-1' }, flowSpent: { usd: 4 } },
      { id: 'flow-b', input: { featureCode: 'F-1' }, flowSpent: { usd: 6 } },
      { id: 'flow-c', input: { featureCode: 'F-1' }, flowSpent: { tokens: 10 } },
    ],
  });
  assert.equal(feature.stratum_flow_spent_usd, 10);
  assert.equal(feature.stratum_flows, 3);
  assert.equal(feature.stratum_flows_without_usd, 1);
});

test('flows belonging to another workspace are not counted', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'cost-oracle-foreign-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const [feature] = features(t, {
    ledger: [actuals('one', 'F-1', 12, '2026-09-13T02:00:00Z')],
    flows: [{ id: 'flow-a', workspaceRoot: cwd, input: { featureCode: 'F-1' }, flowSpent: { usd: 999 } }],
  });
  assert.equal(feature.stratum_flow_spent_usd, null);
  assert.equal(feature.stratum_flows, 0);
});

test('a build far below its feature dollars-per-token is flagged, but is NOT a finding', t => {
  const [feature] = features(t, {
    ledger: [
      actuals('rich', 'F-1', 10, '2026-09-13T01:00:00Z', { tokens_total: 100_000 }),
      actuals('poor', 'F-1', 0.01, '2026-09-13T02:00:00Z', { tokens_total: 100_000 }),
    ],
    flows: [{ id: 'flow-a', input: { featureCode: 'F-1' }, flowSpent: { usd: 1 } }],
  });
  assert.equal(feature.unpriced_suspects.length, 1);
  assert.equal(feature.unpriced_suspects[0].build_id, 'poor');
  // Heuristic only — it must not change the verdict or the exit code.
  assert.equal(feature.verdict, 'OK');
  assert.equal(feature.finding, false);
});

test('a consistently priced feature raises no unpriced suspects', t => {
  const [feature] = features(t, {
    ledger: [
      actuals('a', 'F-1', 10, '2026-09-13T01:00:00Z', { tokens_total: 100_000 }),
      actuals('b', 'F-1', 9, '2026-09-13T02:00:00Z', { tokens_total: 100_000 }),
    ],
  });
  assert.deepEqual(feature.unpriced_suspects, []);
});

test('--flow resolves through the stratum inventory to its feature', t => {
  const [feature] = features(t, {
    ledger: [
      actuals('one', 'F-1', 3, '2026-09-13T01:00:00Z'),
      actuals('two', 'F-2', 7, '2026-09-13T01:00:00Z'),
    ],
    flows: [
      { id: 'aaaaaaaa-1111', input: { featureCode: 'F-2' }, flowSpent: { usd: 1 } },
      { id: 'bbbbbbbb-2222', input: { featureCode: 'F-1' }, flowSpent: { usd: 1 } },
    ],
    args: ['--flow', 'aaaaaaaa', '--json'],
  });
  assert.equal(feature.featureCode, 'F-2');
  assert.equal(feature.compose_usd, 7);
});

test('a malformed build-actuals row fails loudly rather than counting as zero', t => {
  for (const bad of [{ usd: -1 }, { usd: 'free' }, { build_id: '' }]) {
    const child = run(t, {
      ledger: [{ kind: 'build-actuals', build_id: 'one', feature_code: 'F-1', usd: 1, ts: 'x', ...bad }],
    });
    assert.equal(child.status, 2, `expected a hard failure for ${JSON.stringify(bad)}`);
    assert.match(child.stderr, /cost-oracle:/);
  }
});

test('a missing dispatch ledger is an error, not an empty clean report', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'cost-oracle-noledger-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.compose/data'), { recursive: true });
  const child = spawnSync(process.execPath, [oracle, '--all', '--json'], {
    cwd, encoding: 'utf8', timeout: 30000, env: { ...process.env, COMPOSE_PORT: '19997' },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 2);
  assert.match(child.stderr, /dispatch-ledger\.jsonl: not found/);
});
