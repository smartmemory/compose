/**
 * xref-push.test.js — COMP-ROADMAP-XREF-PUSH v1 (push reconciliation).
 *
 * Verifies the write-side counterpart to xref-sync: an eligible (github,
 * push:true) external link whose declared `expect=` differs from live state
 * triggers a write to make the external match. Dry-run records intent but never
 * writes; --apply writes exactly once and is idempotent on the next run. Resolve
 * and write are injected — no network. Degrade (no-opt-in / no-token / 404 / PR /
 * non-2xx write) never writes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { planPush, isGithubState, pushExternalRefs, defaultResolve, defaultWrite } from '../lib/xref-push.js';
import { writeFeature } from '../lib/feature-json.js';

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'xref-push-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

function seed(cwd, code, links) {
  writeFeature(cwd, {
    code, description: 'd', status: 'PLANNED', phase: 'P', position: 1,
    created: '2026-06-07', updated: '2026-06-07', links,
  }, 'docs/features', { validate: false });
}

const ghLink = (over = {}) => ({ kind: 'external', provider: 'github', repo: 'o/r', issue: 7, ...over });

describe('planPush (pure)', () => {
  test('writes external when expect contradicts live state', () => {
    assert.deepEqual(planPush({ expect: 'closed' }, 'open'), { action: 'write', from: 'open', to: 'closed' });
    assert.deepEqual(planPush({ expect: 'open' }, 'closed'), { action: 'write', from: 'closed', to: 'open' });
  });
  test('no-op when expect already matches (idempotent)', () => {
    assert.deepEqual(planPush({ expect: 'closed' }, 'closed'), { action: 'none' });
  });
  test('no-op when no expect declared', () => {
    assert.deepEqual(planPush({ expect: null }, 'open'), { action: 'none' });
  });
  test('no-op when live state unresolved (null)', () => {
    assert.deepEqual(planPush({ expect: 'closed' }, null), { action: 'none' });
  });
});

describe('isGithubState', () => {
  test('accepts open/closed, rejects others', () => {
    assert.equal(isGithubState('open'), true);
    assert.equal(isGithubState('closed'), true);
    assert.equal(isGithubState('COMPLETE'), false);
    assert.equal(isGithubState(undefined), false);
  });
});

describe('pushExternalRefs (golden flow)', () => {
  test('dry-run records intent but performs NO write', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [ghLink({ expect: 'closed', push: true })]);
    const writes = [];
    const resolve = async () => ({ state: 'open' });
    const write = async (l, to) => { writes.push({ l, to }); return { ok: true }; };

    const res = await pushExternalRefs(cwd, { apply: false, resolve, write });
    assert.equal(res.pushed.length, 1);
    assert.deepEqual({ from: res.pushed[0].from, to: res.pushed[0].to }, { from: 'open', to: 'closed' });
    assert.equal(writes.length, 0, 'dry-run must not write');
    assert.equal(res.scanned, 1);
  });

  test('--apply writes exactly once with the target state', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [ghLink({ expect: 'closed', push: true })]);
    const writes = [];
    const resolve = async () => ({ state: 'open' });
    const write = async (l, to) => { writes.push({ issue: l.issue, to }); return { ok: true }; };

    const res = await pushExternalRefs(cwd, { apply: true, resolve, write });
    assert.equal(res.pushed.length, 1);
    assert.deepEqual(writes, [{ issue: 7, to: 'closed' }]);
  });

  test('idempotent: second run (live now matches expect) writes nothing', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [ghLink({ expect: 'closed', push: true })]);
    const writes = [];
    const resolve = async () => ({ state: 'closed' }); // already closed
    const write = async (l, to) => { writes.push({ to }); return { ok: true }; };

    const res = await pushExternalRefs(cwd, { apply: true, resolve, write });
    assert.equal(res.pushed.length, 0);
    assert.equal(res.unchanged, 1);
    assert.equal(writes.length, 0);
  });

  test('never mutates feature.json', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [ghLink({ expect: 'closed', push: true })]);
    const before = JSON.stringify(
      JSON.parse(readFileSync(join(cwd, 'docs/features/A-1/feature.json'), 'utf8')).links);
    await pushExternalRefs(cwd, { apply: true, resolve: async () => ({ state: 'open' }), write: async () => ({ ok: true }) });
    const after = JSON.stringify(
      JSON.parse(readFileSync(join(cwd, 'docs/features/A-1/feature.json'), 'utf8')).links);
    assert.equal(before, after, 'push must not rewrite feature.json');
  });
});

describe('pushExternalRefs (safety / degrade)', () => {
  test('a github link without push:true is NEVER scanned, even under --apply', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [ghLink({ expect: 'closed' })]); // no push:true
    const writes = [];
    const res = await pushExternalRefs(cwd, {
      apply: true,
      resolve: async () => ({ state: 'open' }),
      write: async () => { writes.push(1); return { ok: true }; },
    });
    assert.equal(res.scanned, 0);
    assert.equal(res.pushed.length, 0);
    assert.equal(writes.length, 0);
  });

  test('non-github push-opted links are ignored (v1 github-only)', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [{ kind: 'external', provider: 'local', repo: 'sib', to_code: 'X-1', expect: 'COMPLETE', push: true }]);
    const res = await pushExternalRefs(cwd, { apply: true, resolve: async () => ({ state: 'open' }), write: async () => ({ ok: true }) });
    assert.equal(res.scanned, 0);
  });

  test('malformed expect is skipped, not written', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [ghLink({ expect: 'COMPLETE', push: true })]);
    const writes = [];
    const res = await pushExternalRefs(cwd, { apply: true, resolve: async () => ({ state: 'open' }), write: async () => { writes.push(1); return { ok: true }; } });
    assert.equal(res.pushed.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0].reason, /malformed expect/);
    assert.equal(writes.length, 0);
  });

  test('resolve degrade (e.g. 404 / no-token) is skipped, never written', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [ghLink({ expect: 'closed', push: true })]);
    const writes = [];
    const res = await pushExternalRefs(cwd, {
      apply: true,
      resolve: async () => ({ skipped: true, reason: 'target o/r#7 missing (404)' }),
      write: async () => { writes.push(1); return { ok: true }; },
    });
    assert.equal(res.pushed.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0].reason, /404/);
    assert.equal(writes.length, 0);
  });

  test('write returning non-2xx is reported skipped, not pushed', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [ghLink({ expect: 'closed', push: true })]);
    const res = await pushExternalRefs(cwd, {
      apply: true,
      resolve: async () => ({ state: 'open' }),
      write: async () => ({ skipped: true, reason: 'write HTTP 403' }),
    });
    assert.equal(res.pushed.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0].reason, /403/);
  });
});

// Exercise the REAL github resolve/write paths (not injected mocks) via a stubbed
// transport, so the production degrade guards are actually covered.
const AUTH = { token: 'test-token', _noGhFallback: true };
const transport = (handler) => ({ async request(method, path, body) { return handler(method, path, body); } });

describe('defaultResolve (real path, stubbed transport)', () => {
  test('returns live state on a 200 issue', async () => {
    const r = await defaultResolve(ghLink(), { transport: transport(() => ({ status: 200, body: { state: 'open' } })), auth: AUTH });
    assert.deepEqual(r, { state: 'open' });
  });
  test('skips a pull-request-backed ref (never writes a PR)', async () => {
    const r = await defaultResolve(ghLink(), { transport: transport(() => ({ status: 200, body: { state: 'open', pull_request: { url: 'x' } } })), auth: AUTH });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /pull request/);
  });
  test('skips on 404', async () => {
    const r = await defaultResolve(ghLink(), { transport: transport(() => ({ status: 404, body: {} })), auth: AUTH });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /404/);
  });
  test('skips on unparseable state', async () => {
    const r = await defaultResolve(ghLink(), { transport: transport(() => ({ status: 200, body: { state: 'weird' } })), auth: AUTH });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /parseable/);
  });
  test('skips when no token (degrade, never guess)', async () => {
    const r = await defaultResolve(ghLink(), { auth: { _noGhFallback: true } });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /token/i);
  });
});

describe('defaultWrite (real path, stubbed transport)', () => {
  test('ok on 2xx PATCH', async () => {
    let seen;
    const r = await defaultWrite(ghLink(), 'closed', { transport: transport((m, p, b) => { seen = { m, b }; return { status: 200, body: {} }; }), auth: AUTH });
    assert.deepEqual(r, { ok: true });
    assert.equal(seen.m, 'PATCH');
    assert.deepEqual(seen.b, { state: 'closed' });
  });
  test('skips on non-2xx PATCH (surfaced via updateIssueResult status)', async () => {
    const r = await defaultWrite(ghLink(), 'closed', { transport: transport(() => ({ status: 403, body: {} })), auth: AUTH });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /403/);
  });
  test('degrades on an incomplete ref instead of PATCHing /issues/null', async () => {
    let called = false;
    const r = await defaultWrite({ provider: 'github', repo: 'o/r' }, 'closed', { transport: transport(() => { called = true; return { status: 200, body: {} }; }), auth: AUTH });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /incomplete/);
    assert.equal(called, false, 'must not call the transport for an incomplete ref');
  });
});

describe('pushExternalRefs end-to-end via real default resolve+write (stubbed transport)', () => {
  test('--apply resolves (GET) then writes (PATCH) through the default github path', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [ghLink({ expect: 'closed', push: true })]);
    const calls = [];
    const t = transport((method) => {
      calls.push(method);
      if (method === 'GET') return { status: 200, body: { state: 'open' } };
      return { status: 200, body: { state: 'closed' } }; // PATCH
    });
    const res = await pushExternalRefs(cwd, { apply: true, githubTransport: t, githubAuth: AUTH });
    assert.equal(res.pushed.length, 1);
    assert.deepEqual(calls, ['GET', 'PATCH']);
  });
});
