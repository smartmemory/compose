/**
 * judgment-gen.test.js — coverage for lib/judgment-gen.js (T4/S04):
 * fixed-point regeneration, hand-edit overwrite, OKF frontmatter rules.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RecordsStore } from '../lib/judgment/store/records.js';
import { regenerateProjections, checkProjectionRoundtrip } from '../lib/judgment-gen.js';

const provenance = {
  actor: 'agent',
  session: null,
  written_at: '2026-07-22T12:00:00Z',
};

function seededCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'judgment-gen-'));
  const store = new RecordsStore(cwd);
  store.writePositionRevision({
    slug: 'objective',
    claims: [{ id: 'c1', text: 'Ship the judgment writer.', grounding: 'INT', supports: [] }],
    conviction: { level: 'high', source: 'stated' },
    provenance,
  });
  store.writePositionRevision({
    slug: 'old-take',
    claims: [{ id: 'c1', text: 'Markdown canon is fine.', grounding: 'AGENT', supports: [] }],
    conviction: { level: 'low', source: 'inferred' },
    provenance,
  });
  store.writePositionRevision({
    slug: 'provider-floor',
    claims: [{ id: 'c1', text: 'Tracked records are the v1 canon.', grounding: 'INT', supports: [] }],
    conviction: { level: 'high', source: 'stated' },
    rejected_alternatives: [{ what: 'vision store', why: 'gitignored' }],
    supersedes: 'old-take#r1',
    provenance,
  });
  store.writeJoint({
    slug: 'guard-predicate',
    question: 'Is ONE-UNDER-TEST expressible as a guard predicate?',
    branch_true: 'Register it upstream.',
    branch_false: 'Writer-local lock.',
    resolve_by: 'CONSTRUCT',
    cost: 'days',
    rank: 'high',
    state: 'open',
    provenance,
  });
  store.writeJoint({
    slug: 'okf-parse',
    question: 'Do emitted projections parse under the bridge codec?',
    branch_true: 'Obsidian reads canon natively.',
    branch_false: 'Fix the emitter.',
    resolve_by: 'EXT',
    ext: { sharpened_question: 'Does parseOkf accept them?', bar: 'zero parse errors', falsifier: 'any OkfParseError' },
    cost: 'hours',
    rank: 'medium',
    state: 'under_test',
    provenance,
  });
  store.appendLedgerEvent({
    kind: 'note',
    title: 'Register banner',
    body: 'This register is generated from records. Do not hand-edit.',
    anchor: 'register-header',
    provenance,
  });
  store.appendLedgerEvent({
    kind: 'note',
    title: 'Reading ceiling',
    body: 'This joint is at its reading ceiling.',
    anchor: 'joint:guard-predicate',
    provenance,
  });
  store.appendLedgerEvent({
    kind: 'decide',
    title: 'Pick the substrate',
    body: 'Tracked floor under docs/.',
    rejected: [{ what: 'vision store', why: 'gitignored' }],
    conviction: { level: 'high', source: 'stated' },
    provenance,
  });
  return cwd;
}

const PROJECTIONS = [
  'docs/judgment/REGISTER.md',
  'docs/judgment/LEDGER.md',
  'docs/judgment/OBJECTIVE.md',
  'docs/judgment/index.md',
  'docs/judgment/positions/objective.md',
  'docs/judgment/positions/old-take.md',
  'docs/judgment/positions/provider-floor.md',
];

describe('regenerateProjections', () => {
  test('emits all projection files', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    for (const rel of PROJECTIONS) {
      assert.ok(existsSync(join(cwd, rel)), `${rel} should exist`);
    }
  });

  test('fixed point: second regen is byte-identical; roundtrip guard passes', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    const before = PROJECTIONS.map((rel) => readFileSync(join(cwd, rel), 'utf8'));
    regenerateProjections(cwd);
    const after = PROJECTIONS.map((rel) => readFileSync(join(cwd, rel), 'utf8'));
    assert.deepEqual(after, before);
    const check = checkProjectionRoundtrip(cwd);
    assert.equal(check.fixedPoint, true, JSON.stringify(check.diffs));
  });

  test('hand-edit is detected by the roundtrip guard and overwritten by regen — no preserved sections', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    const registerPath = join(cwd, 'docs', 'judgment', 'REGISTER.md');
    const original = readFileSync(registerPath, 'utf8');
    writeFileSync(registerPath, original + '\n<!-- PRESERVED -->\nsneaky hand edit\n');
    const check = checkProjectionRoundtrip(cwd);
    assert.equal(check.fixedPoint, false);
    assert.ok(check.diffs.some((d) => d.includes('REGISTER.md')));
    regenerateProjections(cwd);
    const regenerated = readFileSync(registerPath, 'utf8');
    assert.equal(regenerated, original);
    assert.ok(!regenerated.includes('sneaky hand edit'));
  });

  test('note records render at their anchors', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    const register = readFileSync(join(cwd, 'docs', 'judgment', 'REGISTER.md'), 'utf8');
    assert.ok(register.includes('This register is generated from records.'));
    const jointIdx = register.indexOf('## guard-predicate');
    const noteIdx = register.indexOf('This joint is at its reading ceiling.');
    assert.ok(jointIdx >= 0 && noteIdx > jointIdx, 'joint note renders under its joint');
  });

  test('derived position status appears in projections, never in records', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    const oldTake = readFileSync(join(cwd, 'docs', 'judgment', 'positions', 'old-take.md'), 'utf8');
    assert.match(oldTake, /superseded/);
    const raw = JSON.parse(readFileSync(join(cwd, 'docs', 'judgment', 'records', 'positions', 'old-take', 'r1.json'), 'utf8'));
    assert.equal(raw.status, undefined);
  });
});

describe('OKF frontmatter', () => {
  test('per-item files carry fence, type, title, timestamp, smartmemory extension — no resource without a provider id', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    for (const rel of ['docs/judgment/positions/objective.md', 'docs/judgment/OBJECTIVE.md']) {
      const text = readFileSync(join(cwd, rel), 'utf8');
      assert.ok(text.startsWith('---\n'), `${rel}: opening fence`);
      const fm = text.split('---\n')[1];
      assert.match(fm, /^type: position$/m);
      assert.match(fm, /^title: /m);
      assert.match(fm, /^timestamp: /m);
      assert.match(fm, /reference: true/);
      assert.match(fm, /origin: compose-projection/);
      assert.ok(!/^resource:/m.test(fm), `${rel}: resource must be omitted without a provider id`);
      assert.ok(!/^okf_version:/m.test(fm), `${rel}: okf_version is reserved for the bundle root`);
    }
  });

  test('bundle root index.md carries okf_version and no type', () => {
    const cwd = seededCwd();
    regenerateProjections(cwd);
    const fm = readFileSync(join(cwd, 'docs', 'judgment', 'index.md'), 'utf8').split('---\n')[1];
    assert.match(fm, /^okf_version: "0\.1"$/m);
    assert.ok(!/^type:/m.test(fm), 'bundle root must not carry type');
  });

  test('resource emitted only when provider id + workspace exist; item id has no literal slash', () => {
    const cwd = seededCwd();
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    writeFileSync(
      join(cwd, '.compose', 'compose.json'),
      JSON.stringify({ judgment: { enrichment: { smartmemory: { team_id: 'team-xyz' } } } }),
    );
    const store = new RecordsStore(cwd);
    store.writePositionRevision({
      slug: 'enriched',
      claims: [{ id: 'c1', text: 't', grounding: 'INT', supports: [] }],
      conviction: { level: 'medium', source: 'inferred' },
      provider_ids: { smartmemory: 'mem_abc123' },
      provenance,
    });
    regenerateProjections(cwd);
    const fm = readFileSync(join(cwd, 'docs', 'judgment', 'positions', 'enriched.md'), 'utf8').split('---\n')[1];
    const m = /^resource: (.+)$/m.exec(fm);
    assert.ok(m, 'resource must be emitted when provider id + workspace exist');
    const uri = m[1].replace(/^"|"$/g, '');
    const parts = /^smartmemory:\/\/([^/]+)\/(.+)$/.exec(uri);
    assert.ok(parts, `resource must be a smartmemory:// URI, got ${uri}`);
    assert.equal(parts[1], 'team-xyz');
    assert.equal(parts[2], 'mem_abc123');
    assert.ok(!parts[2].includes('/'), 'item id must be a single path component');
  });
});
