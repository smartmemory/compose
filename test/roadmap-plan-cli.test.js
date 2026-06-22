/**
 * roadmap-plan-cli.test.js — COMP-ROADMAP-PLAN T15 (coverage sweep).
 *
 * Exercises the `compose plan` verb's guard/error paths via the real CLI. Each
 * case short-circuits BEFORE a lifecycle starts (usage, resume-with-no-active,
 * abort-with-no-active, abort-wrong-mode), so no agent/stratum run is needed —
 * fast and deterministic. Covers the resume/abort control flow that took two
 * Codex rounds to get right.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const BIN = join(REPO, 'bin', 'compose.js');

function makeProject() {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-cli-'));
  mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'),
    JSON.stringify({ version: 1, capabilities: { stratum: true } }));
  mkdirSync(join(cwd, 'pipelines'), { recursive: true });
  // copy the real pipeline so the auto-init check is satisfied (no runInit).
  copyFileSync(join(REPO, 'pipelines', 'plan.stratum.yaml'), join(cwd, 'pipelines', 'plan.stratum.yaml'));
  return cwd;
}

function runPlan(cwd, args) {
  return spawnSync('node', [BIN, 'plan', ...args], { cwd, encoding: 'utf-8', timeout: 60000 });
}

describe('compose plan CLI guard paths (T15)', () => {
  test('no intent → usage, exit 1', () => {
    const r = runPlan(makeProject(), []);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage: compose plan/);
  });

  test('--resume with no active build → error, exit 1 (does not derive a fresh code)', () => {
    const r = runPlan(makeProject(), ['--resume']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No active plan build to resume/);
  });

  test('--abort with no active build → clean no-op, exit 0', () => {
    const r = runPlan(makeProject(), ['--abort']);
    assert.equal(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /No active build to abort/);
  });

  test('--abort refuses a non-plan active build (round-2 fix)', () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, '.compose', 'data', 'active-build.json'),
      JSON.stringify({ featureCode: 'FEAT-1', flowId: 'flow-x', mode: 'feature', pid: 999999 }));
    const r = runPlan(cwd, ['--abort']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Cannot --abort as plan/);
  });
});

describe('compose roadmap add — CLI build-ready write (COMP-ROADMAP-PLAN spec-step path)', () => {
  test('writes a build-ready feature.json (plan handshake) + regenerates ROADMAP', () => {
    const cwd = makeProject();
    const fdir = join(cwd, 'docs', 'features', 'PLAN-WIDGET-1');
    mkdirSync(fdir, { recursive: true });
    // the plan spec step writes design.md first, THEN runs `roadmap add`
    writeFileSync(join(fdir, 'design.md'), '# PLAN-WIDGET-1\n\nthe plan-authored design\n');
    const profile = { needs_prd: false, needs_architecture: false, needs_verification: true, needs_report: false };
    const r = spawnSync('node', [BIN, 'roadmap', 'add', 'PLAN-WIDGET-1',
      '--description', 'a widget the plan produced', '--phase', 'Phase 1',
      '--status', 'PLANNED', '--complexity', 'M',
      '--profile', JSON.stringify(profile),
      '--planned-by', 'PLAN-A-WIDGET', '--impact', 'high'],
      { cwd, encoding: 'utf-8', timeout: 60000 });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const feature = JSON.parse(readFileSync(join(fdir, 'feature.json'), 'utf-8'));
    assert.equal(feature.status, 'PLANNED');
    assert.equal(feature.complexity, 'M');
    assert.equal(feature.plannedBy, 'PLAN-A-WIDGET');
    assert.equal(feature.impact, 'high');
    assert.deepEqual(feature.profile, profile);
    assert.ok(feature.triageTimestamp, 'triageTimestamp auto-set for a plan handshake');
    assert.match(readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8'), /PLAN-WIDGET-1/);
  });

  test('errors without required --description/--phase', () => {
    const cwd = makeProject();
    const r = spawnSync('node', [BIN, 'roadmap', 'add', 'X-1'], { cwd, encoding: 'utf-8', timeout: 60000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage: compose roadmap add/);
  });

  test('rejects invalid --profile JSON', () => {
    const cwd = makeProject();
    const r = spawnSync('node', [BIN, 'roadmap', 'add', 'X-1', '--description', 'd', '--phase', 'P', '--profile', '{bad'],
      { cwd, encoding: 'utf-8', timeout: 60000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--profile must be valid JSON/);
  });

  test('rejects a --profile missing the needs_* gating booleans', () => {
    const cwd = makeProject();
    const r = spawnSync('node', [BIN, 'roadmap', 'add', 'X-1', '--description', 'd', '--phase', 'P',
      '--profile', JSON.stringify({ foo: 1 })], { cwd, encoding: 'utf-8', timeout: 60000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must include boolean fields/);
  });

  test('does not capture a following flag as a value (--description --phase X)', () => {
    const cwd = makeProject();
    // --description has no real value (next token is --phase) → required-field error, not a malformed write
    const r = spawnSync('node', [BIN, 'roadmap', 'add', 'X-1', '--description', '--phase', 'Phase 1'],
      { cwd, encoding: 'utf-8', timeout: 60000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage: compose roadmap add/);
  });

  test('--planned-by requires --profile (no half-handshake)', () => {
    const cwd = makeProject();
    const r = spawnSync('node', [BIN, 'roadmap', 'add', 'FEAT-1', '--description', 'd', '--phase', 'P', '--planned-by', 'PLAN-X'],
      { cwd, encoding: 'utf-8', timeout: 60000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--planned-by requires --profile/);
  });

  test('rejects an invalid --triage-timestamp', () => {
    const cwd = makeProject();
    const fdir = join(cwd, 'docs', 'features', 'FEAT-1');
    mkdirSync(fdir, { recursive: true });
    writeFileSync(join(fdir, 'design.md'), '# FEAT-1\n');
    const r = spawnSync('node', [BIN, 'roadmap', 'add', 'FEAT-1', '--description', 'd', '--phase', 'P', '--complexity', 'M',
      '--profile', JSON.stringify({ needs_prd: false, needs_architecture: false, needs_verification: false, needs_report: false }),
      '--planned-by', 'PLAN-X', '--triage-timestamp', 'nope'], { cwd, encoding: 'utf-8', timeout: 60000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be a valid ISO 8601 date/);
  });

  test('--planned-by refuses to write when design.md is missing (design-first contract)', () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
    const r = spawnSync('node', [BIN, 'roadmap', 'add', 'NODESIGN-1', '--description', 'd', '--phase', 'P', '--complexity', 'M',
      '--profile', JSON.stringify({ needs_prd: false, needs_architecture: false, needs_verification: false, needs_report: false }),
      '--planned-by', 'PLAN-X'], { cwd, encoding: 'utf-8', timeout: 60000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /design\.md not found/);
  });

  test('--planned-by with no value errors (no silent non-handshake write)', () => {
    const cwd = makeProject();
    const r = spawnSync('node', [BIN, 'roadmap', 'add', 'FEAT-1', '--description', 'd', '--phase', 'P',
      '--complexity', 'M', '--planned-by'], { cwd, encoding: 'utf-8', timeout: 60000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--planned-by requires a value/);
  });

  test('--planned-by requires --complexity', () => {
    const cwd = makeProject();
    const r = spawnSync('node', [BIN, 'roadmap', 'add', 'FEAT-1', '--description', 'd', '--phase', 'P',
      '--profile', JSON.stringify({ needs_prd: false, needs_architecture: false, needs_verification: false, needs_report: false }),
      '--planned-by', 'PLAN-X'], { cwd, encoding: 'utf-8', timeout: 60000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires --complexity/);
  });

  test('--planned-by must be PLANNED (rejects a non-PLANNED handshake)', () => {
    const cwd = makeProject();
    const r = spawnSync('node', [BIN, 'roadmap', 'add', 'FEAT-1', '--description', 'd', '--phase', 'P',
      '--complexity', 'M', '--status', 'COMPLETE',
      '--profile', JSON.stringify({ needs_prd: false, needs_architecture: false, needs_verification: false, needs_report: false }),
      '--planned-by', 'PLAN-X'], { cwd, encoding: 'utf-8', timeout: 60000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be PLANNED/);
  });

  test('--planned-by rejects a backdated --triage-timestamp (older than design.md)', () => {
    const cwd = makeProject();
    const fdir = join(cwd, 'docs', 'features', 'BACKDATE-1');
    mkdirSync(fdir, { recursive: true });
    writeFileSync(join(fdir, 'design.md'), '# BACKDATE-1\n');
    const r = spawnSync('node', [BIN, 'roadmap', 'add', 'BACKDATE-1', '--description', 'd', '--phase', 'P', '--complexity', 'M',
      '--profile', JSON.stringify({ needs_prd: false, needs_architecture: false, needs_verification: false, needs_report: false }),
      '--planned-by', 'PLAN-X', '--triage-timestamp', '2000-01-01T00:00:00.000Z'],
      { cwd, encoding: 'utf-8', timeout: 60000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /older than design\.md/);
  });

  test('resolves the positional code past a value-taking flag (--planned-by PLAN-X REAL-1)', () => {
    const cwd = makeProject();
    const fdir = join(cwd, 'docs', 'features', 'REAL-1');
    mkdirSync(fdir, { recursive: true });
    writeFileSync(join(fdir, 'design.md'), '# REAL-1\n');
    const r = spawnSync('node', [BIN, 'roadmap', 'add', '--planned-by', 'PLAN-X', 'REAL-1',
      '--description', 'd', '--phase', 'P', '--complexity', 'S',
      '--profile', JSON.stringify({ needs_prd: false, needs_architecture: false, needs_verification: false, needs_report: false })],
      { cwd, encoding: 'utf-8', timeout: 60000 });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // the code is REAL-1, not the --planned-by value PLAN-X
    assert.ok(JSON.parse(readFileSync(join(fdir, 'feature.json'), 'utf-8')));
    assert.equal(JSON.parse(readFileSync(join(fdir, 'feature.json'), 'utf-8')).plannedBy, 'PLAN-X');
  });
});
