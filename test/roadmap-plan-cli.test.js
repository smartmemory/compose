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
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
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
