/**
 * COMP-DOGFOOD-LAND-1 — complete_feature lands on a real commit. Real git repos
 * (a scratch repo with real branches), no mocks: the rule shells out to git.
 */
import './helpers/git-env-scrub.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = mkdtempSync(join(tmpdir(), 'landsha-'));
process.env.COMPOSE_EVIDENCE_STORE = join(SCRATCH, 'evidence.jsonl');
const GIT_TARGET = mkdtempSync(join(SCRATCH, 'target-'));
for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't']]) spawnSync('git', a, { cwd: GIT_TARGET });
process.env.COMPOSE_TARGET = GIT_TARGET;
const { resolveLandSha, LAND_SHA_CODES } = await import(`${REPO_ROOT}/lib/land-sha.js`);
const { toolCompleteFeature } = await import(`${REPO_ROOT}/server/compose-mcp-tools.js`);

after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const CODE = 'COMP-FOO-1';
const g = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
function commit(cwd, name) { writeFileSync(join(cwd, name), name); g(cwd, 'add', '.'); g(cwd, 'commit', '-q', '-m', name); return g(cwd, 'rev-parse', 'HEAD'); }

/** main with one commit; `wk/COMP-FOO-1` one commit ahead; `other` diverged. */
function makeRepo() {
  const cwd = mkdtempSync(join(SCRATCH, 'repo-'));
  g(cwd, 'init', '-q', '-b', 'main'); g(cwd, 'config', 'user.email', 't@t'); g(cwd, 'config', 'user.name', 't');
  const base = commit(cwd, 'base');
  g(cwd, 'checkout', '-q', '-b', 'other'); const off = commit(cwd, 'off-branch');
  g(cwd, 'checkout', '-q', 'main');
  g(cwd, 'checkout', '-q', '-b', `wk/${CODE}`); const tip = commit(cwd, 'work');
  g(cwd, 'checkout', '-q', 'main');
  return { cwd, base, off, tip };
}
const refusal = (fn, code) => assert.throws(fn, (e) => { assert.equal(e.code, code); return true; });

describe('complete_feature sha rule', () => {
  test('a given sha on the branch passes; the source is `given`', () => {
    const r = makeRepo();
    const out = resolveLandSha({ code: CODE, commit_sha: r.base, branch: `wk/${CODE}` }, { root: r.cwd });
    assert.equal(out.commit_sha, r.base);
    assert.equal(out.sha_source, 'given');
  });

  test('a given sha off the branch is refused SHA_NOT_ON_BRANCH', () => {
    const r = makeRepo();
    refusal(() => resolveLandSha({ code: CODE, commit_sha: r.off, branch: `wk/${CODE}` }, { root: r.cwd }), 'SHA_NOT_ON_BRANCH');
  });

  test('a sha that is no commit is refused', () => {
    const r = makeRepo();
    refusal(() => resolveLandSha({ code: CODE, commit_sha: 'deadbeef00' }, { root: r.cwd }), LAND_SHA_CODES.SHA_UNKNOWN);
  });

  test('no sha, a branch: its tip', () => {
    const r = makeRepo();
    const out = resolveLandSha({ code: CODE, branch: `wk/${CODE}` }, { root: r.cwd });
    assert.equal(out.commit_sha, r.tip);
    assert.equal(out.sha_source, 'branch-tip');
  });

  test('no sha, no branch, one branch named wk/<CODE>: that tip (case-insensitive)', () => {
    const r = makeRepo();
    const out = resolveLandSha({ code: CODE.toLowerCase(), }, { root: r.cwd });
    assert.equal(out.commit_sha, r.tip);
    assert.equal(out.sha_source, 'feature-branch');
  });

  test('two branches ending with the code are refused SHA_AMBIGUOUS, naming both', () => {
    const r = makeRepo();
    g(r.cwd, 'branch', `fix/${CODE}`, r.base);
    assert.throws(() => resolveLandSha({ code: CODE }, { root: r.cwd }), (e) => {
      assert.equal(e.code, 'SHA_AMBIGUOUS');
      assert.match(e.message, new RegExp(`wk/${CODE}`));
      assert.match(e.message, new RegExp(`fix/${CODE}`));
      return true;
    });
  });

  test('no sha, no branch, no matching branch: SHA_REQUIRED', () => {
    const r = makeRepo();
    refusal(() => resolveLandSha({ code: 'COMP-NOPE-9' }, { root: r.cwd }), 'SHA_REQUIRED');
  });

  test('a sha receipt for another sha is refused EVIDENCE_SHA_MISMATCH; the matching one passes (short sha ok)', () => {
    const r = makeRepo();
    const ev = (sha, repo = r.cwd) => ({ kind: 'sha', repo, sha, at: new Date().toISOString(), by: 't' });
    refusal(() => resolveLandSha({ code: CODE, evidence: ev(r.base) }, { root: r.cwd }), 'EVIDENCE_SHA_MISMATCH');
    refusal(() => resolveLandSha({ code: CODE, evidence: ev(r.tip, SCRATCH) }, { root: r.cwd }), 'EVIDENCE_SHA_MISMATCH');
    const ok = resolveLandSha({ code: CODE, evidence: ev(r.tip.slice(0, 9)) }, { root: r.cwd });
    assert.equal(ok.commit_sha, r.tip);
  });

  test('a non-git workspace keeps the commit-less path and warns once', () => {
    const dir = mkdtempSync(join(SCRATCH, 'plain-'));
    const warns = [];
    const orig = console.warn;
    console.warn = (m) => warns.push(String(m));
    try {
      const a = resolveLandSha({ code: CODE }, { root: dir });
      const b = resolveLandSha({ code: CODE }, { root: dir });
      assert.equal(a.commit_sha, undefined);
      assert.equal(a.sha_source, 'none');
      assert.equal(b.sha_source, 'none');
    } finally { console.warn = orig; }
    assert.equal(warns.length, 1);
    assert.match(warns[0], /WARNING/);
    assert.ok(warns[0].includes(dir));
  });

  test('the tool refuses a commit-less completion in a git workspace with no guard, before any write', async () => {
    const ev = { kind: 'sha', repo: GIT_TARGET, sha: 'abcdef1', at: new Date().toISOString(), by: 't' };
    await assert.rejects(() => toolCompleteFeature({ id: 'COMP-NOPE-9', evidence: ev }), (e) => e.code === 'SHA_REQUIRED');
  });
});
