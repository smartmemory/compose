// STRAT-CODEGRAPH-1 golden: recorded SmartMemory bundles (test/fixtures/codegraph/) →
// normalizeBundle → model → callers / reality check / prior art, checked against
// docs/features/STRAT-CODEGRAPH-1/fixtures/ground-truth.json (15 grep-verified edges).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeBundle, BundleFormatError } from '../lib/codegraph/snapshot.js';
import { buildModel, spelledName } from '../lib/codegraph/model.js';
import { extractPlanNames, runRealityCheck, formatRealityReport, planGateRealityCheck } from '../lib/codegraph/reality-check.js';
import { findPriorArt, priorArtForDesign } from '../lib/codegraph/prior-art.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'codegraph');
const GROUND_TRUTH = join(HERE, '..', 'docs', 'features', 'STRAT-CODEGRAPH-1', 'fixtures', 'ground-truth.json');

function rawBundle(name) {
  return JSON.parse(gunzipSync(readFileSync(join(FIXTURES, `${name}.bundle.json.gz`))).toString('utf8'));
}

const REPOS = [
  { name: 'compose', prefix: 'compose/', root: '/nonexistent/compose', exclude: [] },
  { name: 'stratum', prefix: 'stratum/ts/', root: '/nonexistent/stratum/ts', exclude: [] },
];

function fixtureSnapshots() {
  return REPOS.map((repo) => ({ repo, snapshot: normalizeBundle(rawBundle(repo.name)), cached: true, timing: {} }));
}

const model = buildModel(fixtureSnapshots());

test('normalizeBundle reads the recorded envelope', () => {
  const snap = normalizeBundle(rawBundle('compose'));
  assert.equal(snap.schema_version, '1');
  assert.equal(snap.repo, 'compose');
  assert.equal(snap.complete, true);
  assert.ok(snap.entities.length > 100);
  assert.ok(snap.entities.every((e) => typeof e.id === 'string' && e.id));
  assert.ok(snap.relations.every((r) => ['CALLS', 'REFERENCES', 'TESTS', 'IMPORTS'].includes(r.type)));
});

test('normalizeBundle rejects an unsupported schema_version and malformed entities', () => {
  const raw = rawBundle('stratum');
  assert.throws(() => normalizeBundle({ ...raw, schema_version: '2' }), BundleFormatError);
  assert.throws(() => normalizeBundle({ ...raw, schema_version: undefined }), BundleFormatError);
  assert.throws(() => normalizeBundle({ ...raw, complete: 'yes' }), BundleFormatError);
  const noId = { ...raw, entities: raw.entities.map((e, i) => (i === 0 ? { ...e, item_id: undefined } : e)) };
  assert.throws(() => normalizeBundle(noId), /item_id/);
});

test('all 15 ground-truth cross-file edges are callers in the model, at the caller file:line', () => {
  const rows = JSON.parse(readFileSync(GROUND_TRUTH, 'utf8'));
  assert.equal(rows.length, 15);
  for (const row of rows) {
    const line = Number(row.caller.split(':').pop());
    const path = row.caller.replace(/:\d+$/, '');
    const callers = model.callersOf(row.symbol);
    assert.ok(callers.definitions.includes(row.callee), `${row.symbol}: definition ${row.callee} in ${callers.definitions}`);
    const hit = callers.resolved.find((c) => c.path === path && c.line === line && c.target === row.callee);
    assert.ok(hit, `${row.caller} → ${row.symbol} not found among ${callers.resolved.length} resolved callers`);
    assert.equal(typeof hit.resolution, 'string');
    assert.equal(typeof hit.confidence, 'number');
  }
});

test('callers keep unresolved spellings separate from graph edges', () => {
  const callers = model.callersOf('checkOrInsert');
  assert.equal(callers.resolved.length, 6);
  // `checkOrInsert(...).then(...)` is a call of `then` on the result, not a second call of checkOrInsert.
  assert.equal(spelledName('checkOrInsert(args.cwd, f(x)).then'), 'checkOrInsert.then');
  assert.ok(callers.spelling.every((c) => /(^|\.)checkOrInsert$/.test(spelledName(c.callee))), JSON.stringify(callers.spelling));
  assert.ok(model.callersOf('then').spelling.some((c) => c.path === 'compose/lib/journal-writer.js' && c.line === 540));
});

const PLAN = readFileSync(join(FIXTURES, 'plan-fixture.md'), 'utf8');

test('extractPlanNames skips prose words and fenced code, marks (new) and File Plan new rows', () => {
  const names = extractPlanNames(PLAN);
  const tokens = names.map((n) => n.token);
  assert.ok(!tokens.includes('complete') && !tokens.includes('gate'), 'plain words are not names');
  assert.ok(!tokens.some((t) => t.includes('notCounted')), 'fenced code is skipped');
  assert.ok(names.find((n) => n.token === 'runGsd').markedNew);
  const row = names.filter((n) => n.token === 'compose/lib/codegraph/new-thing.js');
  assert.equal(row.length, 2);
  assert.equal(row.some((n) => n.markedNew), true, 'File Plan row with action new marks its own path');
  assert.equal(names.filter((n) => n.token === 'compose/lib/idempotency.js').every((n) => !n.markedNew), true,
    'an edit row does not mark its path new');
});

test('reality check labels the plan fixture: existing / new / unmarked-new', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'codegraph-golden-'));
  try {
    const result = runRealityCheck({ text: PLAN, artifactPath: 'plan-fixture.md', projectRoot, model, repos: REPOS });
    const label = Object.fromEntries(result.labels.map((n) => [n.name, n]));
    assert.equal(label.checkOrInsert.label, 'existing');
    assert.equal(label.checkOrInsert.evidence, 'index');
    assert.equal(label['compose/lib/idempotency.js'].label, 'existing');
    assert.equal(label.validateIdempotencyKey.label, 'existing');
    assert.equal(label.validateSpec.label, 'existing');
    assert.equal(label.runGsd.label, 'new');
    assert.equal(label['compose/lib/codegraph/new-thing.js'].label, 'new', 'declared new by its File Plan row, all mentions');
    assert.equal(label.buildTaskPrompt.label, 'unmarked-new');
    assert.equal(label['compose/lib/active-build.js'].label, 'unmarked-new', 'the S3 incident path');
    assert.equal(label.sanitizeWriterResult.label, 'existing');
    assert.equal(label.sanitizeWriterResult.note, 'marked (new) but exists');
    assert.equal(label.fooBarMissing.label, 'unmarked-new');
    assert.equal(label.fooBarMissing.note, 'marked (existing) but not found');
    assert.deepEqual(result.counts, { existing: 5, new: 2, unmarked_new: 3 });

    const lineRef = result.mentions.find((m) => m.token === 'compose/lib/idempotency.js:144');
    assert.equal(lineRef.lineOwner, 'checkOrInsert');
    assert.equal(result.mentions.find((m) => m.token === 'validateSpec:348').lineInSpan, true);
    assert.equal(result.boundaryMap.ok, true);

    const report = formatRealityReport(result, { artifact: 'plan-fixture.md' });
    assert.match(report, /5 existing, 2 new, 3 unmarked-new — warn-only/);
    const activeLine = PLAN.split('\n').findIndex((l) => l.includes('active-build.js')) + 1;
    assert.match(report, new RegExp(`L${activeLine} unmarked-new \`compose/lib/active-build.js\``));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('planGateRealityCheck records the result under .compose/codegraph/reality and returns the report', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'codegraph-gate-'));
  try {
    const featureDir = join(cwd, 'docs', 'features', 'FX-1');
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'plan.md'), PLAN);
    const loader = async () => ({ skipped: null, snapshots: fixtureSnapshots(), errors: [] });
    const out = await planGateRealityCheck({ cwd, artifact: 'docs/features/FX-1/plan.md', featureCode: 'FX-1', loader });
    assert.equal(out.skipped, undefined);
    assert.equal(out.counts.unmarked_new >= 3, true);
    assert.ok(existsSync(out.recordPath));
    const record = JSON.parse(readFileSync(out.recordPath, 'utf8'));
    assert.equal(record.featureCode, 'FX-1');
    assert.equal(record.artifact, join('docs', 'features', 'FX-1', 'plan.md'));
    assert.match(out.text, /unmarked-new/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('prior art finds the existing implementation by concept, with file:line', async () => {
  const matches = findPriorArt({ text: 'idempotency key: check or insert a cached writer result', model });
  const hit = matches.find((m) => m.name === 'checkOrInsert');
  assert.ok(hit, `checkOrInsert not in ${matches.map((m) => m.name)}`);
  assert.equal(hit.at, 'compose/lib/idempotency.js:144');

  const cwd = mkdtempSync(join(tmpdir(), 'codegraph-prior-'));
  try {
    const loader = async () => ({ skipped: null, snapshots: fixtureSnapshots(), errors: [] });
    const out = await priorArtForDesign({ cwd, featureCode: 'FX-2', description: 'run lock acquire for a flow run id', loader });
    assert.match(out.text, /## Possible Prior Art/);
    assert.match(out.text, /`stratum\/ts\/src\/engine\/run_lock\.ts:\d+` acquireRunLock/);
    assert.ok(existsSync(out.recordPath));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---- Review round 1 regressions (scratch/2026-10-08-codegraph/build/REPORT.md) ----

function tinyModel() {
  const entity = (name, file, line, extra = {}) => ({
    item_id: `code::t::${file}::${name}`, name, qualified_name: name, entity_type: 'function', file_path: file,
    line_number: line, end_line_number: line + 3, is_exported: true, call_evidence: [], ...extra,
  });
  const raw = {
    schema_version: '1', repo: 't', complete: true, relations: [
      { source_id: 'code::t::lib/a.js::walk', target_id: 'code::t::lib/a.js::walk', relation_type: 'CALLS', properties: { line: 3, callee: 'walk', resolution: 'name_only', confidence: 0.5, unresolved: false } },
    ],
    entities: [
      entity('walk', 'lib/a.js', 1),
      entity('parse', 'lib/p.js', 10),
      entity('Widget', 'lib/w.js', 1, { entity_type: 'class' }),
      entity('saveThing', 'lib/s.js', 1),
      entity('run', 'lib/r.js', 1, { call_evidence: [{ relation_type: 'CALLS', properties: { callee: 'api.saveThing(x)', line: 2, resolution: 'name_only', unresolved: true } }] }),
    ],
  };
  return buildModel([{ repo: { name: 't', prefix: '' }, snapshot: normalizeBundle(raw) }]);
}

test('R1-5: a (new) path does not make a different path with the same basename new', () => {
  const m = tinyModel();
  const text = '- `lib/a/new-widget.js` (new)\n- `lib/b/new-widget.js` (existing)\n- also `new-widget.js`\n';
  const label = Object.fromEntries(runRealityCheck({ text, projectRoot: tmpdir(), model: m, repos: [] }).labels.map((n) => [n.name, n]));
  assert.equal(label['lib/a/new-widget.js'].label, 'new');
  assert.equal(label['lib/b/new-widget.js'].label, 'unmarked-new');
  assert.equal(label['lib/b/new-widget.js'].note, 'marked (existing) but not found');
  assert.equal(label['new-widget.js'].label, 'new', 'a bare basename mention still inherits the declaration');
});

test('R1-6: simple class names are checked', () => {
  const m = tinyModel();
  const text = '- `Widget` (new)\n- `Gadget` (existing)\n';
  const label = Object.fromEntries(runRealityCheck({ text, projectRoot: tmpdir(), model: m, repos: [] }).labels.map((n) => [n.name, n]));
  assert.equal(label.Widget.note, 'marked (new) but exists');
  assert.equal(label.Gadget.label, 'unmarked-new');
});

test('R1-7: only a File Plan table declares names new', () => {
  const m = tinyModel();
  const text = '## API\n| Name | Action |\n|---|---|\n| `phantomThing` | add |\n\n## File Plan\n| File | Action |\n|---|---|\n| `lib/fresh.js` | new |\n';
  const label = Object.fromEntries(runRealityCheck({ text, projectRoot: tmpdir(), model: m, repos: [] }).labels.map((n) => [n.name, n]));
  assert.equal(label.phantomThing.label, 'unmarked-new');
  assert.equal(label['lib/fresh.js'].label, 'new');
});

test('R1-8: a later conflicting mark survives aggregation', () => {
  const m = tinyModel();
  const out = runRealityCheck({ text: '- use `saveThing`\n- add `saveThing` (new)\n', projectRoot: tmpdir(), model: m, repos: [] });
  const row = out.labels.find((n) => n.name === 'saveThing');
  assert.equal(row.note, 'marked (new) but exists');
  assert.match(formatRealityReport(out), /saveThing.*marked \(new\) but exists/);
});

test('R1-9/10: recursive callers are kept; qualified spelling queries match', () => {
  const m = tinyModel();
  assert.deepEqual(m.callersOf('walk').resolved.map((c) => `${c.path}:${c.line}`), ['lib/a.js:3']);
  assert.equal(m.callersOf('saveThing').spelling.length, 1);
  assert.equal(m.callersOf('api.saveThing').spelling.length, 1);
});

test('R1-11: a backticked lowercase name is an exact prior-art hit; prose words are not', () => {
  const m = tinyModel();
  assert.deepEqual(findPriorArt({ text: 'improve `parse`', model: m }).map((x) => x.name), ['parse']);
  assert.deepEqual(findPriorArt({ text: 'parse', model: m }), []);
});

// ---- Review round 2 regressions ----

test('R2-1: indented File Plan headings count; any heading ends the section', () => {
  const m = tinyModel();
  const text = '  ## File Plan\n| File | Action |\n|---|---|\n| `lib/fresh.js` | new |\n# API\n| Name | Action |\n|---|---|\n| `phantomApi` | add |\n';
  const label = Object.fromEntries(runRealityCheck({ text, projectRoot: tmpdir(), model: m, repos: [] }).labels.map((n) => [n.name, n]));
  assert.equal(label['lib/fresh.js'].label, 'new');
  assert.equal(label.phantomApi.label, 'unmarked-new');
});

test('R3-1: an empty ATX heading (`#`) also ends the File Plan section', () => {
  const m = tinyModel();
  const text = '## File Plan\n| File | Action |\n|---|---|\n| `lib/fresh.js` | new |\n\n#\n\n| Name | Action |\n|---|---|\n| `phantomApi` | add |\n';
  const label = Object.fromEntries(runRealityCheck({ text, projectRoot: tmpdir(), model: m, repos: [] }).labels.map((n) => [n.name, n]));
  assert.equal(label['lib/fresh.js'].label, 'new');
  assert.equal(label.phantomApi.label, 'unmarked-new');
});

test('R2-2: two-letter PascalCase names are checked', () => {
  const m = tinyModel();
  const label = Object.fromEntries(runRealityCheck({ text: '- `Db` (existing)\n- `Io` (new)\n', projectRoot: tmpdir(), model: m, repos: [] }).labels.map((n) => [n.name, n]));
  assert.equal(label.Db.label, 'unmarked-new');
  assert.equal(label.Io.label, 'new');
});
