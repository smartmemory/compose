/**
 * control-incident.test.js — COMP-DOGFOOD-CONTROL-INCIDENT-1 (row H of COMP-DOGFOOD-1).
 * A kind:"control" feature needs a linked incident (a ledger line) or
 * validate_feature fails CONTROL_NO_INCIDENT with the FILING BAR text.
 * The incident line below is smart-memory-ops/coordination/ledger.md:25718
 * (the D-0068 hop that left no open seat), copied verbatim; the live ledger is never read.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { addRoadmapEntry, linkArtifact } from '../lib/feature-writer.js';
import { readFeature, updateFeature } from '../lib/feature-json.js';
import { validateFeature } from '../lib/feature-validator.js';
import { FILING_BAR, filingBarText } from '../lib/filing-bar.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPS_REVIEW_LOOP = '/Users/ruze/reg/my/SmartMemory/smart-memory-ops/claude/rules/review-loop.md';
const LEDGER_LINE = "- 21:06 s2-coord: s1-chat hop (OWNER hop NOW): session_hop --force --restart PARTIAL seat1->seat1 (restart keeps account; no open seat on overall meter). New s1-chat tab 79C9105C = socket 76305; old FF4B6D5C (19153) left open busy. OWNER 'dropbox delete yes' -> ops-main enumerated delete in-session (OPS-LOST-LAPTOP-RECOVERY-1). D-0068 unit OPS-SEAT-EQUALIZE-HOP-1 -> ops-main.";
const LEDGER_REL = 'ops/coordination/ledger.md';
const INCIDENT_LINE_NO = 3;

const dirs = [];
function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'control-incident-'));
  dirs.push(cwd);
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  mkdirSync(join(cwd, 'ops', 'coordination'), { recursive: true });
  writeFileSync(join(cwd, LEDGER_REL), ['# ledger', '', LEDGER_LINE, 'not a ledger line', ''].join('\n'));
  return cwd;
}
const codes = (r) => r.findings.map((f) => f.kind);
async function feature(cwd, code, kind) {
  await addRoadmapEntry(cwd, { code, description: code, phase: 'P' });
  if (kind) updateFeature(cwd, code, { kind });
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('CONTROL_NO_INCIDENT', () => {
  test('a control feature with no incident fails, with the FILING BAR text', async () => {
    const cwd = workspace();
    await feature(cwd, 'CI-1', 'control');
    const r = await validateFeature(cwd, 'CI-1');
    const f = r.findings.find((x) => x.kind === 'CONTROL_NO_INCIDENT');
    assert.ok(f, `expected CONTROL_NO_INCIDENT, got ${codes(r)}`);
    assert.equal(f.severity, 'error');
    assert.match(f.detail, /needs a PRIOR INCIDENT/);
    assert.ok(codes(r).includes('FILING_BAR_FALLBACK'), 'no rules dir configured: the built-in copy warns');
  });

  test('after link_artifact to the incident line it passes, and the link stores path, line, text', async () => {
    const cwd = workspace();
    await feature(cwd, 'CI-2', 'control');
    const r = await linkArtifact(cwd, { feature_code: 'CI-2', artifact_type: 'incident', path: LEDGER_REL, line: INCIDENT_LINE_NO });
    assert.equal(r.line, INCIDENT_LINE_NO);
    const a = readFeature(cwd, 'CI-2').artifacts[0];
    assert.deepEqual(a, { type: 'incident', path: LEDGER_REL, line: INCIDENT_LINE_NO, text: LEDGER_LINE.slice(0, 200) });
    const v = await validateFeature(cwd, 'CI-2');
    assert.deepEqual(v.findings.filter((x) => x.severity === 'error' && /CONTROL|INCIDENT|ARTIFACT|SCHEMA/.test(x.kind)), []);
    assert.ok(!codes(v).includes('CONTROL_NO_INCIDENT'));
  });

  test('a ledger rewrite under a linked incident is a WARNING, not an error', async () => {
    const cwd = workspace();
    await feature(cwd, 'CI-3', 'control');
    await linkArtifact(cwd, { feature_code: 'CI-3', artifact_type: 'incident', path: LEDGER_REL, line: INCIDENT_LINE_NO });
    writeFileSync(join(cwd, LEDGER_REL), '# ledger\n\n- 2026-11-04 something else entirely\n');
    const v = await validateFeature(cwd, 'CI-3');
    const f = v.findings.find((x) => x.kind === 'INCIDENT_LINE_CHANGED');
    assert.ok(f, `got ${codes(v)}`);
    assert.equal(f.severity, 'warning');
    assert.ok(!codes(v).includes('CONTROL_NO_INCIDENT'));
  });

  test('a non-control feature is unchanged', async () => {
    const cwd = workspace();
    await feature(cwd, 'CI-4');
    const v = await validateFeature(cwd, 'CI-4');
    assert.ok(!codes(v).some((c) => /CONTROL_NO_INCIDENT|INCIDENT_LINE|FILING_BAR/.test(c)), codes(v).join());
  });
});

describe('link_artifact type=incident', () => {
  for (const [name, line] of [['a line past the end of the file', 99], ['a line that does not start with "- "', 4], ['a heading line', 1], ['no line at all', undefined]]) {
    test(`refuses ${name}: INCIDENT_LINE_INVALID`, async () => {
      const cwd = workspace();
      await feature(cwd, 'CI-5', 'control');
      await assert.rejects(
        linkArtifact(cwd, { feature_code: 'CI-5', artifact_type: 'incident', path: LEDGER_REL, line }),
        (e) => e.code === 'INCIDENT_LINE_INVALID' && /INCIDENT_LINE_INVALID/.test(e.message));
      assert.equal(readFeature(cwd, 'CI-5').artifacts, undefined, 'nothing stored');
    });
  }

  test('two incident lines in one file are two links, not one', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, LEDGER_REL), '- a\n- b\n');
    await feature(cwd, 'CI-6', 'control');
    await linkArtifact(cwd, { feature_code: 'CI-6', artifact_type: 'incident', path: LEDGER_REL, line: 1 });
    await linkArtifact(cwd, { feature_code: 'CI-6', artifact_type: 'incident', path: LEDGER_REL, line: 2 });
    assert.equal(readFeature(cwd, 'CI-6').artifacts.length, 2);
  });
});

describe('scaffold_feature kind=control', () => {
  // toolScaffoldFeature reads the target root at call time, so run it in a child
  // process aimed at the scratch workspace (same shape as test/config-paths.test.js).
  function scaffold(cwd, args) {
    const script = `
      import { toolScaffoldFeature } from './server/compose-mcp-tools.js';
      try { console.log(JSON.stringify({ ok: toolScaffoldFeature(${JSON.stringify(args)}) })); }
      catch (e) { console.log(JSON.stringify({ err: e.message })); }`;
    const out = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO_ROOT, env: { ...process.env, COMPOSE_TARGET: cwd }, encoding: 'utf-8',
    });
    return JSON.parse(out.trim().split('\n').pop());
  }

  test('with no feature.json it refuses FEATURE_JSON_REQUIRED and makes no folder', () => {
    const cwd = workspace();
    const r = scaffold(cwd, { featureCode: 'CI-7', kind: 'control' });
    assert.match(r.err, /FEATURE_JSON_REQUIRED/);
    assert.ok(!existsSync(join(cwd, 'docs', 'features', 'CI-7')), 'no folder');
  });

  test('with a feature.json it sets kind, and the feature then needs an incident', async () => {
    const cwd = workspace();
    await feature(cwd, 'CI-8');
    const r = scaffold(cwd, { featureCode: 'CI-8', kind: 'control', only: ['design.md'] });
    assert.equal(r.ok.kind, 'control');
    assert.equal(readFeature(cwd, 'CI-8').kind, 'control');
    assert.ok(codes(await validateFeature(cwd, 'CI-8')).includes('CONTROL_NO_INCIDENT'));
  });

  test('an unknown kind is refused', async () => {
    const cwd = workspace();
    await feature(cwd, 'CI-9');
    assert.match(scaffold(cwd, { featureCode: 'CI-9', kind: 'guard' }).err, /INVALID_KIND/);
    assert.equal(readFeature(cwd, 'CI-9').kind, undefined);
  });

  test("without kind, today's behavior: templates made, feature.json untouched", async () => {
    const cwd = workspace();
    await feature(cwd, 'CI-10');
    const file = join(cwd, 'docs', 'features', 'CI-10', 'feature.json');
    const before = readFileSync(file, 'utf8');
    const r = scaffold(cwd, { featureCode: 'CI-10', only: ['design.md'] });
    assert.ok(r.ok && !('kind' in r.ok));
    assert.equal(readFileSync(file, 'utf8'), before);
  });
});

describe('the FILING BAR text', () => {
  test('the built-in constant equals review-loop.md:11 in smart-memory-ops', (t) => {
    if (!existsSync(OPS_REVIEW_LOOP)) { t.skip(`ops file not present: ${OPS_REVIEW_LOOP}`); return; }
    assert.equal(FILING_BAR, readFileSync(OPS_REVIEW_LOOP, 'utf8').split('\n')[10]);
  });

  test('a configured rules dir is read fresh, with no fallback warning', () => {
    const cwd = workspace();
    mkdirSync(join(cwd, 'rules'), { recursive: true });
    mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'data', 'live-state.json'),
      JSON.stringify({ version: 1, rules_dir: 'rules', next_seq: 1, live_orders: [] }));
    writeFileSync(join(cwd, 'rules', 'review-loop.md'), '# Review Loop (all projects; core)\n\n- **FILING BAR** fresh copy, needs a PRIOR INCIDENT.\n');
    const bar = filingBarText(cwd);
    assert.equal(bar.text, '- **FILING BAR** fresh copy, needs a PRIOR INCIDENT.');
    assert.equal(bar.warning, null);
  });

  test('no rules dir: the constant plus one WARNING saying why', () => {
    const bar = filingBarText(workspace());
    assert.equal(bar.text, FILING_BAR);
    assert.match(bar.warning, /^WARNING filing bar: fresh copy not found/);
  });
});
