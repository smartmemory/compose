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
    assert.deepEqual(result.counts, { existing: 5, new: 2, unmarked_new: 3, unknown: 0 });

    const lineRef = result.mentions.find((m) => m.token === 'compose/lib/idempotency.js:144');
    assert.equal(lineRef.lineOwner, 'checkOrInsert');
    assert.equal(result.mentions.find((m) => m.token === 'validateSpec:348').lineInSpan, true);
    assert.equal(result.boundaryMap.ok, true);

    const report = formatRealityReport(result, { artifact: 'plan-fixture.md' });
    assert.match(report, /5 existing, 2 new, 3 unmarked-new, 0 unknown — warn-only$/m);
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

function tinyRaw(overrides = {}) {
  const entity = (name, file, line, extra = {}) => ({
    item_id: `code::t::${file}::${name}`, name, qualified_name: name, entity_type: 'function', file_path: file,
    line_number: line, end_line_number: line + 3, is_exported: true, call_evidence: [], ...extra,
  });
  const raw = {
    schema_version: '1', repo: 't', complete: true, relations: [
      { source_id: 'code::t::lib/a.js::walk', target_id: 'code::t::lib/a.js::walk', relation_type: 'CALLS', properties: { line: 3, callee: 'walk', resolution: 'name_only', confidence: 0.5, unresolved: false, edge_state: 'resolved' } },
    ],
    files_skipped: 0, skipped_paths: [], budget_exhausted: false,
    entities: [
      entity('walk', 'lib/a.js', 1),
      entity('parse', 'lib/p.js', 10),
      entity('Widget', 'lib/w.js', 1, { entity_type: 'class' }),
      entity('saveThing', 'lib/s.js', 1),
      entity('run', 'lib/r.js', 1, { call_evidence: [{ relation_type: 'CALLS', properties: { callee: 'api.saveThing(x)', line: 2, resolution: 'name_only', unresolved: true, edge_state: 'unresolved' } }] }),
    ],
  };
  return { ...raw, ...overrides };
}

function tinyModel(overrides = {}) {
  return buildModel([{ repo: { name: 't', prefix: '' }, snapshot: normalizeBundle(tinyRaw(overrides)) }]);
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

// ---- Fix round 1 (scratch/2026-10-08-codegraph/build/fix-r1-brief.md) ----

test('fix-r1 #3: the recorded bundles carry edge_state and the model exposes it on callers', () => {
  // 1.5.26 contract: properties.edge_state on every relation carrying resolution or candidates (CALLS, REFERENCES).
  for (const name of ['compose', 'stratum']) {
    const raw = rawBundle(name);
    const resolving = raw.relations.filter((r) => 'resolution' in (r.properties ?? {}) || 'candidates' in (r.properties ?? {}));
    assert.ok(resolving.length > 0, name);
    assert.ok(resolving.every((r) => ['resolved', 'ambiguous'].includes(r.properties.edge_state)), name);
  }
  const { resolved } = model.callersOf('checkOrInsert');
  assert.ok(resolved.length > 0);
  assert.ok(resolved.every((c) => c.edgeState === 'resolved' || c.edgeState === 'ambiguous'));
});

test('fix-r1 #3: callersOf decides by edge_state: ambiguous is labelled, unresolved and unsupported are not callers', () => {
  const edge = (from, state, extra = {}) => ({
    source_id: `code::t::lib/${from}.js::${from}`, target_id: 'code::t::lib/p.js::parse', relation_type: 'CALLS',
    properties: { line: 2, callee: 'parse', resolution: 'name_only', confidence: 0.5, unresolved: false, edge_state: state, ...extra },
  });
  const base = tinyRaw();
  const entity = (name) => ({ item_id: `code::t::lib/${name}.js::${name}`, name, qualified_name: name, entity_type: 'function',
    file_path: `lib/${name}.js`, line_number: 1, end_line_number: 4, is_exported: true, call_evidence: [] });
  const raw = {
    ...base,
    entities: [...base.entities, entity('amb'), entity('unres'), entity('unsup')],
    relations: [...base.relations, edge('amb', 'ambiguous', { candidates: ['a', 'b'] }), edge('unres', 'unresolved'), edge('unsup', 'unsupported')],
  };
  const m = buildModel([{ repo: { name: 't', prefix: '' }, snapshot: normalizeBundle(raw) }]);
  const { resolved } = m.callersOf('parse');
  assert.deepEqual(resolved.map((c) => [c.caller, c.edgeState]), [['amb', 'ambiguous']],
    'raw unresolved:false does not override edge_state unresolved/unsupported');
  const { spelling } = tinyModel().callersOf('saveThing');
  assert.equal(spelling[0].edgeState, 'unresolved');
});

test('fix-r1 #3/#4: normalizeBundle rejects a missing or invalid edge_state and missing skip fields', () => {
  const raw = tinyRaw();
  const withEdge = (state) => ({ ...raw, relations: raw.relations.map((r) => ({ ...r, properties: { ...r.properties, edge_state: state } })) });
  assert.throws(() => normalizeBundle(withEdge(undefined)), /edge_state/);
  assert.throws(() => normalizeBundle(withEdge('exact')), /edge_state/);
  // A top-level edge_state (the pre-1.5.26 shape) does not satisfy the contract.
  assert.throws(() => normalizeBundle({ ...withEdge(undefined), relations: withEdge(undefined).relations.map((r) => ({ ...r, edge_state: 'resolved' })) }), /edge_state/);
  // A relation with no resolution or candidates (IMPORTS, DEFINES) carries none, and gets null.
  const imports = { source_id: 'code::t::lib/a.js::walk', target_id: 'code::t::lib/p.js::parse', relation_type: 'IMPORTS', properties: { line: 1 } };
  const withImport = normalizeBundle({ ...raw, relations: [...raw.relations, imports] });
  assert.deepEqual(withImport.relations.map((r) => [r.type, r.edgeState]), [['CALLS', 'resolved'], ['IMPORTS', null]]);
  assert.throws(() => normalizeBundle({ ...raw, files_skipped: undefined }), /files_skipped/);
  assert.throws(() => normalizeBundle({ ...raw, files_skipped: -1 }), /files_skipped/);
  assert.throws(() => normalizeBundle({ ...raw, skipped_paths: [{ path: '', reason: 'x' }] }), /skipped_paths/);
  assert.throws(() => normalizeBundle({ ...raw, budget_exhausted: 'no' }), /budget_exhausted/);
  assert.doesNotThrow(() => normalizeBundle(raw));
});

test('fix-r1 #4: a path token whose file the producer skipped is unknown (file skipped: reason), never missing', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'codegraph-skip-'));
  try {
    mkdirSync(join(projectRoot, 'lib'), { recursive: true });
    writeFileSync(join(projectRoot, 'lib', 'big.ts'), 'export const x = 1;\n');
    const m = tinyModel({ files_skipped: 1, skipped_paths: [{ path: 'lib/big.ts', reason: 'grammar_unavailable' }] });
    const text = '- `lib/big.ts`\n- `big.ts`\n';
    const result = runRealityCheck({ text, projectRoot, model: m, repos: [], fileList: new Set() });
    const label = Object.fromEntries(result.labels.map((n) => [n.name, n]));
    for (const name of ['lib/big.ts', 'big.ts']) {
      assert.equal(label[name].label, 'unknown', `${name}: skipped files are checked before the disk (it exists on disk)`);
      assert.equal(label[name].hint, 'file skipped: grammar_unavailable: tree-sitter-typescript/javascript not installed');
    }
    assert.equal(result.counts.unknown, 2);
    assert.match(formatRealityReport(result), /L1 unknown `lib\/big\.ts` — file skipped: grammar_unavailable/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('fix-r1 R1-2: a skipped file is unknown under every path spelling the disk check accepts (two repos)', () => {
  // Layout of the tracked config: compose at the project root, stratum/ts as a sibling repo with prefix ../stratum/ts/.
  const ws = mkdtempSync(join(tmpdir(), 'codegraph-skip-ws-'));
  try {
    const projectRoot = join(ws, 'compose');
    const stratumRoot = join(ws, 'stratum', 'ts');
    for (const [root, file] of [[projectRoot, 'lib/big.ts'], [stratumRoot, 'src/policy/bundle.ts'], [stratumRoot, 'src/policy/other.ts']]) {
      mkdirSync(join(root, dirname(file)), { recursive: true });
      writeFileSync(join(root, file), 'export const x = 1;\n');
    }
    const repos = [{ name: 'compose', root: projectRoot, prefix: '' }, { name: 'stratum', root: stratumRoot, prefix: '../stratum/ts/' }];
    const snap = (overrides) => normalizeBundle(tinyRaw(overrides));
    const model = buildModel([
      { repo: repos[0], snapshot: snap({ repo: 'compose', files_skipped: 1, skipped_paths: [{ path: 'lib/big.ts', reason: 'grammar_unavailable' }] }) },
      { repo: repos[1], snapshot: snap({ repo: 'stratum', files_skipped: 1, skipped_paths: [{ path: 'src/policy/bundle.ts', reason: 'oversize' }] }) },
    ]);
    const cases = [
      // [spelling, expected label, expected hint suffix]
      ['../stratum/ts/src/policy/bundle.ts', 'unknown', 'oversize'], // display path
      ['src/policy/bundle.ts', 'unknown', 'oversize'], // repo-relative
      ['stratum/ts/src/policy/bundle.ts', 'unknown', 'oversize'], // workspace-relative (the review's failing input)
      ['bundle.ts', 'unknown', 'oversize'], // bare basename
      ['lib/big.ts', 'unknown', 'grammar_unavailable'], // project-relative
      ['compose/lib/big.ts', 'unknown', 'grammar_unavailable'], // <project>/-prefixed and workspace-relative
      ['compose/big.ts', 'unknown', 'grammar_unavailable'], // <project>/-prefixed bare basename (round 2)
      ['stratum/ts/src/policy/other.ts', 'existing', null], // a sibling file that was not skipped
    ];
    const text = cases.map(([name]) => `- \`${name}\``).join('\n') + '\n';
    const result = runRealityCheck({ text, projectRoot, model, repos, fileList: new Set() });
    const label = Object.fromEntries(result.labels.map((n) => [n.name, n]));
    for (const [name, expected, reason] of cases) {
      assert.ok(label[name], `${name} was extracted`);
      assert.equal(label[name].label, expected, name);
      if (reason) assert.match(label[name].hint, new RegExp(`^file skipped: ${reason}`), name);
    }
    // One repo (no workspace root): the project spellings still reach the skip record.
    const solo = buildModel([{ repo: repos[0], snapshot: snap({ repo: 'compose', files_skipped: 1, skipped_paths: [{ path: 'lib/big.ts', reason: 'grammar_unavailable' }] }) }]);
    const soloNames = ['lib/big.ts', 'big.ts', 'compose/lib/big.ts', 'compose/big.ts'];
    const soloResult = runRealityCheck({ text: soloNames.map((n) => `- \`${n}\``).join('\n'), projectRoot, model: solo, repos: [repos[0]], fileList: new Set() });
    for (const n of soloResult.labels) assert.equal(n.label, 'unknown', `one repo: ${n.name}`);
    assert.equal(soloResult.labels.length, soloNames.length);
    // Review round 3: a fallback spelling never borrows another file's skip record. `compose/snapshot.js` is a real
    // file under the project, so it is existing even though stripping `compose/` would basename-match a skipped file.
    mkdirSync(join(projectRoot, 'compose'), { recursive: true });
    writeFileSync(join(projectRoot, 'compose', 'snapshot.js'), 'export const s = 1;\n');
    const sibling = buildModel([{ repo: repos[0], snapshot: snap({ repo: 'compose', files_skipped: 1, skipped_paths: [{ path: 'lib/codegraph/snapshot.js', reason: 'oversize' }] }) }]);
    const siblingResult = runRealityCheck({ text: '- `compose/snapshot.js`\n- `compose/lib/codegraph/snapshot.js`\n', projectRoot, model: sibling, repos: [repos[0]], fileList: new Set() });
    const siblingLabel = Object.fromEntries(siblingResult.labels.map((n) => [n.name, n.label]));
    assert.deepEqual(siblingLabel, { 'compose/snapshot.js': 'existing', 'compose/lib/codegraph/snapshot.js': 'unknown' });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('fix-r1 #4: a symbol that resolves nowhere while files were skipped notes "may be in N skipped file(s)"', () => {
  const m = tinyModel({ files_skipped: 2, skipped_paths: [{ path: 'lib/x.ts', reason: 'oversize' }, { path: 'lib/y.ts', reason: 'oversize' }] });
  const result = runRealityCheck({ text: 'call `missingThing()` and `lib/nope.js`\n', projectRoot: tmpdir(), model: m, repos: [], fileList: new Set() });
  const label = Object.fromEntries(result.labels.map((n) => [n.name, n]));
  assert.equal(label.missingThing.label, 'unmarked-new');
  assert.equal(label.missingThing.note, 'may be in 2 skipped file(s)');
  assert.equal(label['lib/nope.js'].note, null, 'a path is checked on disk, so the skip note does not apply');
  assert.match(formatRealityReport(result), /2 file\(s\) skipped by the indexer/);
});

test('fix-r1 #4: an exhausted entity budget makes the check PARTIAL COVERAGE and reports no name missing', async () => {
  const m = tinyModel({ files_skipped: 40, budget_exhausted: true });
  const text = '- `missingThing()`\n- `lib/nope.js`\n- `walk()`\n- `brandNew()` (new)\n';
  const result = runRealityCheck({ text, projectRoot: tmpdir(), model: m, repos: [], fileList: new Set() });
  const label = Object.fromEntries(result.labels.map((n) => [n.name, n]));
  assert.equal(label.walk.label, 'existing');
  assert.equal(label.brandNew.label, 'new');
  for (const name of ['missingThing', 'lib/nope.js']) {
    assert.equal(label[name].label, 'unknown', name);
    assert.match(label[name].note, /partial coverage: the entity budget ran out in t/);
  }
  assert.equal(result.counts.unmarked_new, 0);
  assert.match(formatRealityReport(result), /PARTIAL COVERAGE \(entity budget ran out in t; no name is reported missing\)/);

  const cwd = mkdtempSync(join(tmpdir(), 'codegraph-partial-'));
  try {
    writeFileSync(join(cwd, 'plan.md'), text);
    const snapshot = normalizeBundle(tinyRaw({ files_skipped: 40, budget_exhausted: true }));
    const loader = async () => ({ skipped: null, snapshots: [{ repo: { name: 't', prefix: '' }, snapshot, cached: false, timing: {} }], errors: [] });
    const out = await planGateRealityCheck({ cwd, artifact: 'plan.md', featureCode: 'FX-P', loader });
    const record = JSON.parse(readFileSync(out.recordPath, 'utf8'));
    assert.equal(record.coverage.partial, true);
    assert.deepEqual(record.coverage.budgetExhaustedRepos, ['t']);
    assert.equal(record.counts.unknown, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
