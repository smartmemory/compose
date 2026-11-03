/**
 * COMP-DOGFOOD-EVIDENCE-BRANCH-1 — a `sha` receipt may name a declared land
 * branch (contracts/evidence-words.json `land_branches`, starting at 2.0), so
 * a 2.0 land passes the gate while a feature branch still cannot back a LANDED.
 * Real git repos, real `merge-base`; nothing is stubbed.
 */
import './helpers/git-env-scrub.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = mkdtempSync(join(tmpdir(), 'evbranch-'));
process.env.COMPOSE_EVIDENCE_STORE = join(SCRATCH, 'store', 'evidence.jsonl');
const ev = await import(`${REPO_ROOT}/lib/evidence.js`);

after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const AT = () => new Date().toISOString();
const BY = 'test-runner';

/** main: A. 2.0: A + B (pushed: origin/2.0 = B). feature-x: A + C. Returns the three shas. */
function makeRepo() {
  const cwd = mkdtempSync(join(SCRATCH, 'repo-'));
  const g = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  const commit = (f) => { writeFileSync(join(cwd, f), f); g('add', '.'); g('commit', '-q', '-m', f); return g('rev-parse', 'HEAD').stdout.trim(); };
  const a = commit('a');
  g('checkout', '-q', '-b', '2.0'); const b = commit('b');
  g('checkout', '-q', 'main'); g('checkout', '-q', '-b', 'feature-x'); const c = commit('c');
  g('checkout', '-q', 'main');
  g('update-ref', 'refs/remotes/origin/2.0', b);
  return { cwd, a, b, c };
}
const rec = (cwd, sha, branch) => ({ kind: 'sha', repo: cwd, sha, at: AT(), by: BY, ...(branch ? { branch } : {}) });

describe('sha receipt with a declared land branch', () => {
  const { cwd, a, b, c } = makeRepo();

  test('a commit only on 2.0 passes with branch 2.0, and the success line names the branch', () => {
    const r = ev.verifyEvidence(rec(cwd, b, '2.0'));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.checks.join('\n'), /is on 2\.0 in /);
  });
  test('an ancestor of 2.0 passes with branch 2.0', () => {
    assert.equal(ev.verifyEvidence(rec(cwd, a, '2.0')).ok, true);
  });
  test('a commit not on 2.0 is refused, naming the branch', () => {
    const r = ev.verifyEvidence(rec(cwd, c, '2.0'));
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /not on the land branch \(2\.0\)/);
  });
  test('with no branch the default-branch behaviour is unchanged', () => {
    const r = ev.verifyEvidence(rec(cwd, b));
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /not on the default branch \(main\)/);
    assert.equal(ev.verifyEvidence(rec(cwd, a)).ok, true);
  });
  test('an undeclared branch is refused naming the branch and the declared list', () => {
    const r = ev.verifyEvidence(rec(cwd, c, 'feature-x'));
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /feature-x/);
    assert.match(r.reasons[0], /land_branches/);
    assert.match(r.reasons[0], /2\.0/);
  });
  test('a declared branch that does not exist in the repo is refused', () => {
    const other = mkdtempSync(join(SCRATCH, 'norepo-'));
    const g = (...x) => spawnSync('git', x, { cwd: other, encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    writeFileSync(join(other, 'f'), 'f'); g('add', '.'); g('commit', '-q', '-m', 'f');
    const sha = g('rev-parse', 'HEAD').stdout.trim();
    const r = ev.verifyEvidence(rec(other, sha, '2.0'));
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /no branch 2\.0/);
  });
  test('a commit only on a local 2.0, not on origin/2.0, is refused: a land is a push', () => {
    const r2 = makeRepo();
    const g = (...x) => spawnSync('git', x, { cwd: r2.cwd, encoding: 'utf8' });
    g('update-ref', 'refs/remotes/origin/2.0', r2.a); // origin lags: B is local-only
    const r = ev.verifyEvidence(rec(r2.cwd, r2.b, '2.0'));
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.reasons[0], /not on the land branch \(2\.0\)/);
    g('update-ref', 'refs/remotes/origin/2.0', r2.b); // pushed
    assert.equal(ev.verifyEvidence(rec(r2.cwd, r2.b, '2.0')).ok, true);
  });
  test('a repo with a local 2.0 but no origin/2.0 keeps the has-no-branch refusal', () => {
    const r2 = makeRepo();
    spawnSync('git', ['update-ref', '-d', 'refs/remotes/origin/2.0'], { cwd: r2.cwd });
    const r = ev.verifyEvidence(rec(r2.cwd, r2.b, '2.0'));
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /no branch 2\.0/);
  });
  test('the schema takes an optional branch string and nothing else new', () => {
    assert.equal(ev.validateEvidence(rec('/r', 'abc1234', '2.0')).ok, true);
    assert.equal(ev.validateEvidence({ ...rec('/r', 'abc1234'), branch: 5 }).ok, false);
    assert.equal(ev.validateEvidence(rec('/r', 'abc1234')).ok, true);
  });
  test('the words table declares land_branches starting at 2.0 and still takes only sha for LANDED', () => {
    assert.deepEqual(ev.loadEvidenceWords().land_branches, ['2.0']);
    assert.deepEqual(ev.claimRule('LANDED').kinds, ['sha']);
  });
});

describe('the stale-file refusal carries a hint', () => {
  test('older than the claimed at: the reason says to record a fresh grep -H command receipt', () => {
    const old = join(SCRATCH, 'old.log');
    writeFileSync(old, 'x\n');
    const t = (Date.now() - 3_600_000) / 1000;
    utimesSync(old, t, t);
    const r = ev.verifyEvidence({ kind: 'file', path: old, at: AT(), by: BY });
    assert.equal(r.ok, false);
    assert.match(r.reasons[0], /older than the claimed at/);
    assert.match(r.reasons[0], /record a command receipt of a fresh grep -H <pattern> <file>/);
  });
});
