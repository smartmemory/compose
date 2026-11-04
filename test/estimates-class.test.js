/**
 * estimates-class.test.js — COMP-DOGFOOD-ESTIMATES-1 (row G of COMP-DOGFOOD-1).
 * Features carry a class, lib/completions-cli.js joins completions with launch events,
 * and a typed duration in a feature.json fails validate_feature (TYPED_DURATION).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { addRoadmapEntry, validateFeatureFields } from '../lib/feature-writer.js';
import { readFeature, updateFeature } from '../lib/feature-json.js';
import { validateFeature } from '../lib/feature-validator.js';
import { TOOLS } from '../server/mcp-tool-defs.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'lib', 'completions-cli.js');
const CLASSES = ['code', 'plan/doc', 'fix', 'review', 'merge'];
const SHA = 'c'.repeat(40);

const dirs = [];
function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'estimates-class-'));
  dirs.push(cwd);
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function completion(code, id, at) {
  return { completion_id: id, feature_code: code, commit_sha: SHA, recorded_at: at, recorded_by: 'test' };
}
function launchRow(unit, launchedAt) {
  return { tool: 'launch.requested', ts: launchedAt, unit, launched_at: launchedAt, source: 'detach_job', idempotency_key: `k-${unit}-${launchedAt}` };
}
function writeEvents(cwd, rows) {
  mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'data', 'feature-events.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const kinds = (r) => r.findings.map((f) => f.kind);

describe('feature class', () => {
  test('the schema enum is exactly the five classes', () => {
    const schema = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', 'feature-json.schema.json'), 'utf8'));
    assert.deepEqual(schema.properties.class.enum, CLASSES);
  });

  test('validateFeatureFields refuses a class outside the enum and accepts each of the five', () => {
    assert.throws(() => validateFeatureFields({ class: 'epic' }), /invalid class "epic"/);
    for (const c of CLASSES) assert.doesNotThrow(() => validateFeatureFields({ class: c }));
  });

  test('add_roadmap_entry stores class, and its tool def carries the same enum', async () => {
    const cwd = workspace();
    await addRoadmapEntry(cwd, { code: 'EC-1', description: 'd', phase: 'P', class: 'plan/doc' });
    assert.equal(readFeature(cwd, 'EC-1').class, 'plan/doc');
    await assert.rejects(addRoadmapEntry(cwd, { code: 'EC-2', description: 'd', phase: 'P', class: 'huge' }), /invalid class/);
    const def = TOOLS.find((t) => t.name === 'add_roadmap_entry');
    assert.deepEqual(def.inputSchema.properties.class.enum, CLASSES);
  });

  test('a feature with no class stores none', async () => {
    const cwd = workspace();
    await addRoadmapEntry(cwd, { code: 'EC-3', description: 'd', phase: 'P' });
    assert.equal('class' in readFeature(cwd, 'EC-3'), false);
  });
});

describe('completions-cli', () => {
  test('joins completions with class and the FIRST launch.requested; a unit with no launch gets null', async () => {
    const cwd = workspace();
    await addRoadmapEntry(cwd, { code: 'EC-10', description: 'd', phase: 'P', class: 'code' });
    await addRoadmapEntry(cwd, { code: 'EC-11', description: 'd', phase: 'P' });
    updateFeature(cwd, 'EC-10', { completions: [completion('EC-10', 'c-10', new Date().toISOString())] });
    updateFeature(cwd, 'EC-11', { completions: [completion('EC-11', 'c-11', new Date().toISOString())] });
    writeEvents(cwd, [
      launchRow('EC-10', '2026-11-01T01:00:00.000Z'),
      launchRow('EC-10', '2026-11-01T05:00:00.000Z'),
      { tool: 'launch.running', unit: 'EC-11', ts: '2026-11-01T01:00:00.000Z' },
    ]);
    const r = spawnSync(process.execPath, [CLI, '--root', cwd], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const rows = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const by = Object.fromEntries(rows.map((x) => [x.feature_code, x]));
    assert.deepEqual(Object.keys(by[ 'EC-10' ]).sort(), ['class', 'completion_id', 'feature_code', 'launched_at', 'recorded_at']);
    assert.equal(by['EC-10'].class, 'code');
    assert.equal(by['EC-10'].launched_at, '2026-11-01T01:00:00.000Z');
    assert.equal(by['EC-10'].completion_id, 'c-10');
    assert.equal(by['EC-11'].class, null);
    assert.equal(by['EC-11'].launched_at, null);
  });

  test('--since drops older completions, and the CLI never writes', async () => {
    const cwd = workspace();
    await addRoadmapEntry(cwd, { code: 'EC-12', description: 'd', phase: 'P' });
    updateFeature(cwd, 'EC-12', { completions: [completion('EC-12', 'c-12', '2020-01-01T00:00:00.000Z')] });
    writeEvents(cwd, [launchRow('EC-12', '2020-01-01T00:00:00.000Z')]);
    const before = readFileSync(join(cwd, '.compose', 'data', 'feature-events.jsonl'), 'utf8');
    const r = spawnSync(process.execPath, [CLI, '--root', cwd, '--since', '30d'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
    assert.equal(readFileSync(join(cwd, '.compose', 'data', 'feature-events.jsonl'), 'utf8'), before);
  });

  test('no --root exits non-zero with a message', () => {
    const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--root/);
  });
});

describe('TYPED_DURATION', () => {
  for (const key of ['eta', 'due', 'estimate', 'duration', 'estimated_hours', 'est_hours']) {
    test(`${key}: "2h" is an error quoting the rule`, async () => {
      const cwd = workspace();
      await addRoadmapEntry(cwd, { code: 'TD-1', description: 'd', phase: 'P' });
      updateFeature(cwd, 'TD-1', { [key]: '2h' });
      const r = await validateFeature(cwd, 'TD-1');
      const f = r.findings.find((x) => x.kind === 'TYPED_DURATION');
      assert.ok(f, `expected TYPED_DURATION for ${key}, got ${kinds(r)}`);
      assert.equal(f.severity, 'error');
      assert.match(f.detail, /Estimates come from estimate\.py, quoted with as_of, or NO DATA\./);
      assert.match(f.detail, new RegExp(key));
    });
  }

  test('a numeric duration is refused too', async () => {
    const cwd = workspace();
    await addRoadmapEntry(cwd, { code: 'TD-2', description: 'd', phase: 'P' });
    updateFeature(cwd, 'TD-2', { est_hours: 3 });
    assert.ok(kinds(await validateFeature(cwd, 'TD-2')).includes('TYPED_DURATION'));
  });

  test('a script line passes (ESTIMATE, EST, DUE prefixes with as_of 20..)', async () => {
    const cwd = workspace();
    await addRoadmapEntry(cwd, { code: 'TD-3', description: 'd', phase: 'P' });
    for (const [key, v] of [
      ['estimate', 'ESTIMATE TD-3 p50 0.8h (method: x) n=50 as_of 2026-11-04T02:04'],
      ['eta', 'EST TD-3 0.8h as_of 2026-11-04T02:04'],
      ['due', 'DUE TD-3 2026-11-04T10:00 = launch 2026-11-04T09:00 + p50 1.0h (class code, n=50, as_of 2026-11-04T02:04)'],
    ]) {
      updateFeature(cwd, 'TD-3', { [key]: v });
      assert.ok(!kinds(await validateFeature(cwd, 'TD-3')).includes('TYPED_DURATION'), key);
      updateFeature(cwd, 'TD-3', { [key]: undefined });
    }
  });

  test('a prefix without as_of fails; complexity, triageTier, estimateSource stay untouched', async () => {
    const cwd = workspace();
    await addRoadmapEntry(cwd, { code: 'TD-4', description: 'd', phase: 'P', complexity: 'M', triageTier: 2, estimateSource: 'front' });
    assert.ok(!kinds(await validateFeature(cwd, 'TD-4')).includes('TYPED_DURATION'));
    updateFeature(cwd, 'TD-4', { due: 'DUE TD-4 soon' });
    assert.ok(kinds(await validateFeature(cwd, 'TD-4')).includes('TYPED_DURATION'));
  });
});
