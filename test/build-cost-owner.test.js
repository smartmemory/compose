/**
 * build-cost-owner.test.js — COMP-COST-OWNER S1.
 *
 * One owner for "what did this build cost". Before this, `buildCostTotals` was a
 * SECOND tally fed from exactly one site (build.js, the main step) while
 * `recordBuildUsage` fed the persisted accumulator from nine sites including every
 * fix, revise, gate-fix and error-carried usage — and the history record was written
 * from the former.
 *
 * Measured on the retained 2026-09-12 live-fire run (evidence in
 * docs/features/COMP-COST-OWNER/evidence/three-totals-2026-09-12.md): the routing
 * ledger and the accumulators agreed to the cent at $1.4257732 while
 * build-history.jsonl reported $1.38900475 — short $0.0367685 — and 589,373 tokens
 * against the accumulator's 808,002, short 218,629 (27.1%). That measurement is the
 * failing case these tests pin; it is real-world evidence, not a synthetic control.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  newBuildAccumulatorRecord,
  readBuildAccumulator,
  writeBuildAccumulator,
  updateBuildAccumulator,
  buildAccumulatorPath,
} = await import('../lib/build.js');

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cost-owner-'));
  mkdirSync(join(dir, '.compose', 'data'), { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('COMP-COST-OWNER S1: the accumulator owns the whole cost shape', () => {
  test('a fresh record carries the split and the unknown counter, all zeroed', () => {
    const record = newBuildAccumulatorRecord('COST-1');
    assert.equal(record.usd, 0);
    assert.equal(record.tokens_total, 0);
    // The split is what build-history needs and the accumulator did not carry, which
    // is why history was written from a second tally at all.
    assert.equal(record.input_tokens, 0);
    assert.equal(record.output_tokens, 0);
    // Unknown cost is COUNTED, never folded into usd as a zero. A build that spent
    // money we cannot price must not report a total as though it were complete.
    assert.equal(record.usd_unknown_count, 0);
    assert.equal(record.usd_source, null);
  });

  test('the new fields survive a write/read round trip', (t) => {
    const cwd = workspace(t);
    const record = { ...newBuildAccumulatorRecord('COST-2'), usd: 1.25, tokens_total: 300, input_tokens: 100, output_tokens: 200, usd_unknown_count: 2 };
    writeBuildAccumulator(cwd, record);
    const read = readBuildAccumulator(cwd, 'COST-2');
    assert.equal(read.usd, 1.25);
    assert.equal(read.input_tokens, 100);
    assert.equal(read.output_tokens, 200);
    assert.equal(read.usd_unknown_count, 2);
    // The split must actually add up to the total it sits beside.
    assert.equal(read.input_tokens + read.output_tokens, read.tokens_total);
  });

  test('the split and the unknown count accumulate through updateBuildAccumulator', (t) => {
    const cwd = workspace(t);
    writeBuildAccumulator(cwd, newBuildAccumulatorRecord('COST-3'));
    updateBuildAccumulator(cwd, 'COST-3', (a) => ({
      ...a, usd: a.usd + 0.5, tokens_total: a.tokens_total + 30, input_tokens: a.input_tokens + 10, output_tokens: a.output_tokens + 20,
    }));
    updateBuildAccumulator(cwd, 'COST-3', (a) => ({
      ...a, tokens_total: a.tokens_total + 7, input_tokens: a.input_tokens + 3, output_tokens: a.output_tokens + 4,
      usd_unknown_count: a.usd_unknown_count + 1,
    }));
    const read = readBuildAccumulator(cwd, 'COST-3');
    assert.equal(read.usd, 0.5);
    assert.equal(read.input_tokens, 13);
    assert.equal(read.output_tokens, 24);
    assert.equal(read.tokens_total, 37);
    // The second entry spent tokens we could not price. usd did NOT move, and the
    // count says so — the distinction the old `?? 0` destroyed.
    assert.equal(read.usd_unknown_count, 1);
  });
});

describe('COMP-COST-OWNER S1: migration is honest about what it cannot know', () => {
  test('a v2 record migrates with a NULL split, never a fabricated one', (t) => {
    const cwd = workspace(t);
    // A real v2 record, shaped exactly as the live-fire run wrote it.
    const v2 = {
      v: 2,
      build_id: '61a01101-4c86-4554-b585-457b72b4cce4',
      feature_code: 'LEGACY-1',
      last_terminal: 'failed',
      review_iterations: 0,
      escalations: 0,
      files_changed: ['src/stats.js'],
      ship_files_changed: null,
      test_count: null,
      pass_rate: null,
      tests_attested: 'no-signal',
      evidence_root: null,
      tokens_total: 352394,
      usd: 0.5410395000000001,
    };
    mkdirSync(join(cwd, '.compose', 'data', 'build-accumulator'), { recursive: true });
    writeFileSync(buildAccumulatorPath(cwd, 'LEGACY-1'), JSON.stringify(v2));

    const read = readBuildAccumulator(cwd, 'LEGACY-1');
    // Chains v2 -> v3 -> v4 -> v5: each hop nulls only what THAT hop cannot recover.
    assert.equal(read.v, 5);
    assert.equal(read.cache_read_tokens, null);
    assert.equal(read.cache_creation_tokens, null);
    assert.equal(read.usd_source, null);
    // What it DOES know is carried forward untouched.
    assert.equal(read.usd, 0.5410395000000001);
    assert.equal(read.tokens_total, 352394);
    // What it CANNOT know stays null. Splitting 352394 into a guessed input/output,
    // or seeding output_tokens from tokens_total the way build.js:3748 did, would be
    // a fabricated number wearing the shape of a measured one.
    assert.equal(read.input_tokens, null);
    assert.equal(read.output_tokens, null);
    // Nor can a v2 record say whether any step went unpriced.
    assert.equal(read.usd_unknown_count, null);
  });

  test('a v1 record migrates all the way to the current version', (t) => {
    const cwd = workspace(t);
    const v1 = {
      v: 1,
      build_id: '61a01101-4c86-4554-b585-457b72b4cce4',
      feature_code: 'LEGACY-2',
      last_terminal: null,
      review_iterations: 1,
      escalations: 0,
      files_changed: [],
      ship_files_changed: null,
      test_count: null,
      pass_rate: null,
      tokens_total: 10,
      usd: 0.5,
    };
    mkdirSync(join(cwd, '.compose', 'data', 'build-accumulator'), { recursive: true });
    writeFileSync(buildAccumulatorPath(cwd, 'LEGACY-2'), JSON.stringify(v1));
    const read = readBuildAccumulator(cwd, 'LEGACY-2');
    assert.equal(read.v, 5);
    assert.equal(read.tests_attested, 'no-signal');   // v1 -> v2 still applies
    assert.equal(read.input_tokens, null);            // v2 -> v3
    assert.equal(read.usd_unknown_count, null);
    assert.equal(read.cache_read_tokens, null);       // v3 -> v4
    assert.equal(read.cache_creation_tokens, null);
    assert.equal(read.usd_source, null);              // v4 -> v5
  });
});

describe('COMP-COST-OWNER S1: the validator refuses a fabricated shape', () => {
  test('a negative or non-integer split is corrupt', (t) => {
    const cwd = workspace(t);
    for (const bad of [-1, 1.5, 'x']) {
      const record = { ...newBuildAccumulatorRecord('COST-BAD'), input_tokens: bad };
      assert.throws(() => writeBuildAccumulator(cwd, record), /input_tokens/, `accepted input_tokens=${bad}`);
    }
  });

  test('a negative unknown count is corrupt', (t) => {
    const cwd = workspace(t);
    const record = { ...newBuildAccumulatorRecord('COST-BAD2'), usd_unknown_count: -1 };
    assert.throws(() => writeBuildAccumulator(cwd, record), /usd_unknown_count/);
  });

  test('an unknown field is still refused, so the record cannot drift open', (t) => {
    const cwd = workspace(t);
    const record = { ...newBuildAccumulatorRecord('COST-BAD3'), surprise: 1 };
    assert.throws(() => writeBuildAccumulator(cwd, record), /unknown field "surprise"/);
  });
});

// ---------------------------------------------------------------------------
// End to end, through the real runBuild. The invariant that was FALSE in the
// wild: the history record's cost must equal the owner's, because it is now read
// from it rather than tallied a second time.
// ---------------------------------------------------------------------------
describe('COMP-COST-OWNER Open Question 0: a v3 record cannot invent its cache split', () => {
  test('a v3 record migrates with NULL cache totals, never a fabricated zero', (t) => {
    const cwd = workspace(t);
    // A v3 record, shaped exactly as the shipped v3 factory wrote it.
    const v3 = {
      v: 3,
      build_id: '61a01101-4c86-4554-b585-457b72b4cce4',
      feature_code: 'LEGACY-3',
      last_terminal: 'failed',
      review_iterations: 0,
      escalations: 0,
      files_changed: [],
      ship_files_changed: null,
      test_count: null,
      pass_rate: null,
      tests_attested: 'no-signal',
      evidence_root: null,
      tokens_total: 352394,
      usd: 0.54,
      input_tokens: 120,
      output_tokens: 352274,
      usd_unknown_count: 0,
    };
    mkdirSync(join(cwd, '.compose', 'data', 'build-accumulator'), { recursive: true });
    writeFileSync(buildAccumulatorPath(cwd, 'LEGACY-3'), JSON.stringify(v3));

    const read = readBuildAccumulator(cwd, 'LEGACY-3');
    assert.equal(read.v, 5);
    // What it DOES know is carried forward untouched.
    assert.equal(read.usd, 0.54);
    assert.equal(read.input_tokens, 120);
    assert.equal(read.output_tokens, 352274);
    // What it CANNOT know stays null. A 0 here would read downstream as a measured
    // "nothing was cached", which on a real build is the opposite of the truth.
    assert.equal(read.cache_read_tokens, null);
    assert.equal(read.cache_creation_tokens, null);
  });

  test('a fresh record starts cache at a measured zero, not null', (t) => {
    const record = newBuildAccumulatorRecord('FRESH-1');
    assert.equal(record.v, 5);
    assert.equal(record.cache_read_tokens, 0);
    assert.equal(record.cache_creation_tokens, 0);
  });
});

describe('COMP-COST-OWNER S1: a v4 record cannot invent aggregate provenance', () => {
  test('v4 -> v5 preserves the total and migrates usd_source to null', (t) => {
    const cwd = workspace(t);
    const v4 = {
      v: 4,
      build_id: '61a01101-4c86-4554-b585-457b72b4cce4',
      feature_code: 'LEGACY-4',
      last_terminal: 'failed',
      review_iterations: 0,
      escalations: 0,
      files_changed: [],
      ship_files_changed: null,
      test_count: null,
      pass_rate: null,
      tests_attested: 'no-signal',
      evidence_root: null,
      tokens_total: 40,
      usd: 0.75,
      input_tokens: 10,
      output_tokens: 30,
      cache_read_tokens: 100,
      cache_creation_tokens: 5,
      usd_unknown_count: 0,
    };
    mkdirSync(join(cwd, '.compose', 'data', 'build-accumulator'), { recursive: true });
    writeFileSync(buildAccumulatorPath(cwd, 'LEGACY-4'), JSON.stringify(v4));

    const read = readBuildAccumulator(cwd, 'LEGACY-4');
    assert.equal(read.v, 5);
    assert.equal(read.usd, 0.75);
    assert.equal(read.usd_source, null);
  });
});

describe('COMP-COST-OWNER S1: history reads the owner, end to end', () => {
  async function runOneStep(t, usage) {
    const dispatchUsages = Array.isArray(usage) ? usage : [usage];
    const YAML = (await import('yaml')).default;
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { buildWaveFixture, waveSpec } = await import('./helpers/build-wave-fixture.js');
    const { agentResult } = await import('./helpers/build-stratum-fixture.js');
    const spec = waveSpec();
    const stepIds = dispatchUsages.map((_, index) => `work${index + 1}`);
    spec.flows.bug_fix.steps = stepIds.map((id, index) => ({
      id,
      ...(index > 0 ? { after: [stepIds[index - 1]] } : {}),
      agent: 'codex',
      do: 'Return a complete result.',
      out: 'R',
    }));
    spec.flows.bug_fix.output = { from: `\${${stepIds.at(-1)}.output}`, contract: 'R' };
    const profiles = Object.fromEntries(stepIds.map((id) => [id, { default: 'codex:implementer:standard' }]));
    const f = buildWaveFixture(t, { spec, profiles });
    const old = process.env.STRATUM_STATE_ROOT;
    process.env.STRATUM_STATE_ROOT = f.stateRoot;
    t.after(() => { if (old === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = old; });
    let id;
    f.stratum.plan = async (yaml, flow, input, options) => {
      id = 'cost-owner-1';
      Object.assign(f.state, { id, spec: YAML.parse(yaml), input, workspaceRoot: options.workspaceRoot,
        status: 'running', steps: Object.fromEntries(stepIds.map((stepId, index) => [
          stepId,
          index === 0
            ? { status: 'ready', dispatchToken: `${id}-token-${index}` }
            : { status: 'pending' },
        ])) });
      writeFileSync(join(f.stateRoot, `${id}.json`), JSON.stringify(f.state));
      return { status: 'ready', runId: id, revisionDigest: f.state.revisionDigest,
        ready: [{ id: stepIds[0], agent: 'codex', do: 'Return a complete result.', epoch: 0, dispatchToken: `${id}-token-0` }] };
    };
    let dispatchIndex = 0;
    f.stratum.agentRun = async () => agentResult(
      { outcome: 'complete', summary: 'done' },
      `dispatch-${dispatchIndex + 1}`,
      dispatchUsages[dispatchIndex++],
    );
    f.stratum.stepDone = async (_flowId, stepId) => {
      const index = stepIds.indexOf(stepId);
      f.state.steps[stepId] = { status: 'succeeded', epoch: 0 };
      const nextId = stepIds[index + 1];
      if (nextId) {
        const dispatchToken = `${id}-token-${index + 1}`;
        f.state.steps[nextId] = { status: 'ready', dispatchToken };
        writeFileSync(join(f.stateRoot, `${id}.json`), JSON.stringify(f.state));
        return { status: 'ready', runId: id, revisionDigest: f.state.revisionDigest,
          ready: [{ id: nextId, agent: 'codex', do: 'Return a complete result.', epoch: 0, dispatchToken }] };
      }
      f.state.status = 'completed';
      writeFileSync(join(f.stateRoot, `${id}.json`), JSON.stringify(f.state));
      return { status: 'completed', runId: id };
    };
    f.stratum.resume = async () => ({ status: 'completed', runId: id });
    await f.run().catch(() => {});   // terminal status is not what this asserts
    const historyPath = join(f.cwd, '.compose', 'data', 'build-history.jsonl');
    const rows = readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    return { rows, cwd: f.cwd, code: f.code };
  }

  // NOTE on what is NOT asserted here. The accumulator is DELETED on a complete or
  // aborted terminal (clearBuildAccumulator, build.js:2820), so it cannot be read back
  // after a clean run — which is itself why buildCostSnapshot keeps a mirror. These
  // tests therefore assert the VALUE that reached history end to end. The
  // owner-vs-history DIVERGENCE is pinned by real-world measurement instead: the
  // live-fire run's $1.4257732 owner against a $1.38900475 history total, recorded in
  // docs/features/COMP-COST-OWNER/evidence/three-totals-2026-09-12.md.

  test('the spend that happened is the spend history records', async (t) => {
    const { rows } = await runOneStep(t, { tokens: 60, usd: 0.25, ms: 4, usd_source: 'reported' });
    assert.ok(rows.length > 0, 'no history row written');
    const row = rows.at(-1);
    assert.equal(row.cost_usd, 0.25, 'history lost the dispatch cost');
    assert.equal((row.input_tokens ?? 0) + (row.output_tokens ?? 0), 60, 'history lost the tokens');
    // Nothing went unpriced, and history says so rather than staying silent.
    assert.equal(row.usd_unknown_count, 0);
  });

  // COMP-COST-OWNER Open Question 0. The real producer path: a connector usage record
  // carrying cache tokens, through result-normalizer, recordBuildUsage and the accumulator,
  // onto the row. Before this the row had no cache field at all, so `input_tokens: 0` on a
  // cached build read as "no input" when it meant "all of it was cached".
  test('cache tokens reported by the producer reach the history row', async (t) => {
    const { rows } = await runOneStep(t, {
      tokens: 60, usd: 0.25, ms: 4, usd_source: 'reported',
      cache_read_input_tokens: 900, cache_creation_input_tokens: 100,
    });
    const row = rows.at(-1);
    assert.equal(row.cache_read_tokens, 900, 'history lost the cache-read tokens');
    assert.equal(row.cache_creation_tokens, 100, 'history lost the cache-creation tokens');
    // tokens_total keeps meaning input+output. Folding cache in would break the S1
    // ledger/accumulator reconciliation, which is why these are separate fields.
    assert.equal((row.input_tokens ?? 0) + (row.output_tokens ?? 0), 60);
  });

  test('an UNPRICED step is counted, never added as a zero', async (t) => {
    // Tokens moved and nobody said what they cost — stratum's connectors omit both
    // keys for a model they cannot price, precisely so this stays unknown.
    const { rows } = await runOneStep(t, { tokens: 60, ms: 4 });
    const row = rows.at(-1);
    assert.equal(row.cost_usd, 0, 'an unpriced step must not invent spend');
    // The distinction the old `?? 0` destroyed: this row is NOT a free build, it is a
    // build with unpriced spend, and a reader can now tell the two apart.
    assert.ok(row.usd_unknown_count > 0,
      `an unpriced step must be COUNTED, got usd_unknown_count=${row.usd_unknown_count}`);
  });

  test('all reported dispatches make the build provenance reported', async (t) => {
    const { rows } = await runOneStep(t, [
      { tokens: 20, usd: 0.1, ms: 4, usd_source: 'reported' },
      { tokens: 40, usd: 0.2, ms: 4, usd_source: 'reported' },
    ]);
    const row = rows.at(-1);
    assert.ok(Math.abs(row.cost_usd - 0.3) < 1e-12);
    assert.equal(row.usd_source, 'reported');
  });

  test('one estimated dispatch makes build provenance sticky estimated', async (t) => {
    const { rows } = await runOneStep(t, [
      { tokens: 20, usd: 0.1, ms: 4, usd_source: 'reported' },
      { tokens: 20, usd: 0.1, ms: 4, usd_source: 'estimated' },
      { tokens: 20, usd: 0.1, ms: 4, usd_source: 'reported' },
    ]);
    const row = rows.at(-1);
    assert.ok(Math.abs(row.cost_usd - 0.3) < 1e-12);
    assert.equal(row.usd_source, 'estimated');
  });

  test('one unknown dispatch makes build provenance sticky null', async (t) => {
    const { rows } = await runOneStep(t, [
      { tokens: 20, usd: 0.1, ms: 4, usd_source: 'reported' },
      { tokens: 20, ms: 4 },
      { tokens: 20, usd: 0.1, ms: 4, usd_source: 'reported' },
    ]);
    const row = rows.at(-1);
    assert.equal(row.cost_usd, 0.2);
    assert.equal(row.usd_source, null);
  });

  test('a labelled zero-dollar dispatch remains a reported cost observation', async (t) => {
    const { rows } = await runOneStep(t, { tokens: 0, usd: 0, ms: 4, usd_source: 'reported' });
    const row = rows.at(-1);
    assert.equal(row.cost_usd, 0);
    assert.equal(row.usd_source, 'reported');
  });

  test('estimated zero dollars with zero tokens and duration makes provenance sticky', async (t) => {
    const { rows } = await runOneStep(t, [
      { tokens: 0, usd: 0, ms: 4, usd_source: 'estimated' },
      { tokens: 20, usd: 0.1, ms: 4, usd_source: 'reported' },
    ]);
    const row = rows.at(-1);
    assert.equal(row.cost_usd, 0.1);
    assert.equal(row.usd_source, 'estimated');
  });

  test('the accumulator never carries provenance without a cost', async (t) => {
    const { rows } = await runOneStep(t, { tokens: 0, ms: 4, usd_source: 'reported' });
    const row = rows.at(-1);
    assert.equal(row.cost_usd, 0);
    assert.equal(row.usd_source, null);
  });
});
