import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runBuild, newBuildAccumulatorRecord, writeBuildAccumulator,
  readBuildAccumulator, buildAccumulatorPath } from '../lib/build.js';
import { makeBuildWorkspace, fakeBuildStratum } from './helpers/build-stratum-fixture.js';

function fixture(t) {
  const code = 'HISTORY-1';
  const cwd = makeBuildWorkspace(code);
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const rows = () => readFileSync(join(cwd, '.compose/data/build-history.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  const run = (stratum, opts = {}) => runBuild(code, { cwd, mode: 'bug', template: 'bug-fix',
    stratum, skipTriage: true, gateOpts: { nonInteractive: true }, ...opts });
  return { cwd, code, rows, run };
}

test('history persists the selected accumulator identity when its backing file disappears', async t => {
  const f = fixture(t);
  writeBuildAccumulator(f.cwd, newBuildAccumulatorRecord(f.code));
  let owner;
  const stratum = fakeBuildStratum({});
  stratum.resume = async () => {
    owner = readBuildAccumulator(f.cwd, f.code);
    rmSync(buildAccumulatorPath(f.cwd, f.code));
    return { status: 'failed', runId: 'initial-flow', failure: { reason: 'fixture failure' } };
  };
  await f.run(stratum, { resumeFlowId: 'initial-flow' });
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].status, 'failed');
  assert.equal(f.rows()[0].accumulator_build_id, owner.build_id);
  assert.equal(f.rows()[0].cost_usd, 0);
});

test('history persists the current owner identity and unchanged cost and token fields', async t => {
  const f = fixture(t);
  writeBuildAccumulator(f.cwd, newBuildAccumulatorRecord(f.code));
  let owner;
  const stratum = fakeBuildStratum({});
  stratum.resume = async () => {
    owner = { ...readBuildAccumulator(f.cwd, f.code), usd: 1.25,
      input_tokens: 10, output_tokens: 20, tokens_total: 30, usd_unknown_count: 2,
      cache_read_tokens: 900, cache_creation_tokens: 100, usd_source: 'estimated' };
    writeBuildAccumulator(f.cwd, owner);
    return { status: 'failed', runId: 'snapshot-flow', failure: { reason: 'fixture failure' } };
  };
  await f.run(stratum, { resumeFlowId: 'snapshot-flow' });
  const [row] = f.rows();
  assert.equal(row.status, 'failed');
  assert.equal(row.accumulator_build_id, owner.build_id);
  assert.equal(row.cost_usd, 1.25);
  assert.equal(row.input_tokens, 10);
  assert.equal(row.output_tokens, 20);
  assert.equal(row.usd_unknown_count, 2);
  assert.equal(row.usd_source, 'estimated');
  // COMP-COST-OWNER Open Question 0: the snapshot mirror carries cache onto the row.
  assert.equal(row.cache_read_tokens, 900);
  assert.equal(row.cache_creation_tokens, 100);
});

test('auto-resume terminal flow rotation persists the NEW identity from the zeroed mirror', async t => {
  const f = fixture(t);
  const prior = { ...newBuildAccumulatorRecord(f.code), usd: 4, tokens_total: 30,
    input_tokens: 10, output_tokens: 20, cache_read_tokens: 900, cache_creation_tokens: 100,
    last_terminal: 'failed' };
  writeBuildAccumulator(f.cwd, prior);
  writeFileSync(join(f.cwd, '.compose/data/active-build.json'), JSON.stringify({
    featureCode: f.code, flowId: 'rotating-flow', status: 'failed', mode: 'bug',
  }));
  let rotated;
  let resumes = 0;
  const stratum = fakeBuildStratum({
    audit: () => ({ status: 'running', steps: {}, events: [] }),
    plan: () => {
      rotated = readBuildAccumulator(f.cwd, f.code);
      // Force the persisted history to use site 3's mirror, not a subsequent
      // disk refresh in buildCostSnapshot that would hide a missing rotation ID.
      rmSync(buildAccumulatorPath(f.cwd, f.code));
      throw new Error('fresh plan failed after rotation');
    },
  });
  stratum.resume = async () => {
    resumes++;
    return { status: 'completed', runId: 'rotating-flow' };
  };
  await assert.rejects(f.run(stratum), /fresh plan failed after rotation/);
  assert.equal(resumes, 1);
  assert.notEqual(rotated.build_id, prior.build_id);
  const rows = f.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].flowId, 'rotating-flow');
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].cost_usd, 0);
  assert.equal(rows[0].input_tokens, 0);
  assert.equal(rows[0].output_tokens, 0);
  assert.equal(rows[0].usd_unknown_count, 0);
  assert.equal(rows[0].usd_source, null);
  // COMP-COST-OWNER Open Question 0. The rotation site zeroes the WHOLE mirror, cache
  // included. A rotation installs a fresh record, so 0 is a measured nothing here, not
  // the migrated-unknown null -- and the prior lifetime's 900/100 must not leak across.
  assert.equal(rows[0].cache_read_tokens, 0);
  assert.equal(rows[0].cache_creation_tokens, 0);
  assert.equal(rows[0].accumulator_build_id, rotated.build_id);
});
