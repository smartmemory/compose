/**
 * COMP-MCP-ENFORCE Slice 3 — evidence-bound completion. Under the guard,
 * ship→complete requires REAL evidence: the commit_sha must exist in the repo
 * (server-read git, not a syntax check) and tests must be attested (a configured
 * test command exits 0, or tests_pass is explicitly true — never a silent
 * default-to-true). Uses a real temp git repo (real backend).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { verifyCompletionEvidence } = await import(`${REPO_ROOT}/server/lifecycle-guard.js`);

function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'evid-'));
  const g = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(cwd, 'f.txt'), 'x');
  g('add', '.'); g('commit', '-q', '-m', 'init');
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
  return { cwd, sha };
}

test('verifyCompletionEvidence: real commit + explicit tests_pass true → ok', async () => {
  const { cwd, sha } = makeRepo();
  const r = await verifyCompletionEvidence({ commitSha: sha, cwd, testsPassClaim: true });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
});

test('verifyCompletionEvidence: missing commit_sha → not ok', async () => {
  const { cwd } = makeRepo();
  const r = await verifyCompletionEvidence({ commitSha: undefined, cwd, testsPassClaim: true });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /commit_sha/.test(x)));
});

test('verifyCompletionEvidence: nonexistent commit → not ok (server-read git, not syntax)', async () => {
  const { cwd } = makeRepo();
  const fakeSha = 'a'.repeat(40);
  const r = await verifyCompletionEvidence({ commitSha: fakeSha, cwd, testsPassClaim: true });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /not found|does not exist/i.test(x)));
});

test('verifyCompletionEvidence: no test command + tests_pass not true → not ok (no silent default)', async () => {
  const { cwd, sha } = makeRepo();
  const r = await verifyCompletionEvidence({ commitSha: sha, cwd, testsPassClaim: undefined });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /tests_pass/.test(x)));
});

test('verifyCompletionEvidence: configured test command exit 0 → ok regardless of claim', async () => {
  const { cwd, sha } = makeRepo();
  const r = await verifyCompletionEvidence({ commitSha: sha, cwd, testCommand: ['true'], testsPassClaim: false });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.testsAttested, true);
});

test('verifyCompletionEvidence: configured test command non-zero → not ok', async () => {
  const { cwd, sha } = makeRepo();
  const r = await verifyCompletionEvidence({ commitSha: sha, cwd, testCommand: ['false'], testsPassClaim: true });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some(x => /test command/i.test(x)));
});

// --- record_completion MCP-boundary evidence gate (closes the bypass) ---

const { assertCompletionEvidence } = await import(`${REPO_ROOT}/server/compose-mcp-tools.js`);

test('assertCompletionEvidence: guard off → no-op (legacy)', async () => {
  const { cwd } = makeRepo();
  await assertCompletionEvidence({ commit_sha: 'whatever', tests_pass: true }, { guard: false }, cwd);
});

test('assertCompletionEvidence: guard on + real commit + tests_pass true → passes', async () => {
  const { cwd, sha } = makeRepo();
  await assertCompletionEvidence({ commit_sha: sha, tests_pass: true }, { guard: true }, cwd);
});

test('assertCompletionEvidence: guard on + nonexistent commit → throws (bypass closed)', async () => {
  const { cwd } = makeRepo();
  await assert.rejects(
    () => assertCompletionEvidence({ commit_sha: 'b'.repeat(40), tests_pass: true }, { guard: true }, cwd),
    /COMPLETION_EVIDENCE_REQUIRED|not found|evidence not satisfied/i,
  );
});

test('assertCompletionEvidence: guard on + no tests_pass → throws (no silent claim)', async () => {
  const { cwd, sha } = makeRepo();
  await assert.rejects(
    () => assertCompletionEvidence({ commit_sha: sha }, { guard: true }, cwd),
    /tests_pass|evidence not satisfied/i,
  );
});
