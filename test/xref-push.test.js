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

import { planPush, planLabels, isGithubState, pushExternalRefs, defaultResolve, defaultWrite } from '../lib/xref-push.js';
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

describe('planLabels (pure, additive)', () => {
  test('adds missing labels, union as the PATCH set', () => {
    assert.deepEqual(planLabels(['keep'], ['done', 'keep']), { action: 'add', add: ['done'], to: ['keep', 'done'] });
  });
  test('no-op when all expected labels already present', () => {
    assert.deepEqual(planLabels(['a', 'b'], ['a']), { action: 'none' });
  });
  test('no-op on empty/absent expect', () => {
    assert.deepEqual(planLabels(['a'], []), { action: 'none' });
    assert.deepEqual(planLabels(['a'], undefined), { action: 'none' });
  });
  test('case-sensitive (Bug ≠ bug → adds)', () => {
    assert.deepEqual(planLabels(['bug'], ['Bug']), { action: 'add', add: ['Bug'], to: ['bug', 'Bug'] });
  });
  test('never removes a human-added label (union preserves current)', () => {
    const r = planLabels(['human', 'keep'], ['new']);
    assert.deepEqual(r.to, ['human', 'keep', 'new']);
  });
});

describe('pushExternalRefs — github labels (additive)', () => {
  const labelLink = (over) => ghLink({ push: true, ...over });
  test('dry-run reports label add, performs no write', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [labelLink({ expect_labels: ['done'] })]);
    const writes = [];
    const res = await pushExternalRefs(cwd, {
      apply: false,
      resolve: async () => ({ state: 'open', labels: ['keep'] }),
      write: async (l, p) => { writes.push(p); return { ok: true }; },
    });
    assert.equal(res.pushed.length, 1);
    assert.deepEqual(res.pushed[0].labels, { added: ['done'] });
    assert.equal(writes.length, 0);
  });
  test('--apply PATCHes labels: full union (never the subset)', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [labelLink({ expect_labels: ['done'] })]);
    const writes = [];
    const res = await pushExternalRefs(cwd, {
      apply: true,
      resolve: async () => ({ state: 'open', labels: ['keep'] }),
      write: async (l, p) => { writes.push(p); return { ok: true }; },
    });
    assert.equal(res.pushed.length, 1);
    assert.deepEqual(writes, [{ labels: ['keep', 'done'] }]); // union, not ['done']
  });
  test('idempotent: all expected labels already present → no write', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [labelLink({ expect_labels: ['done'] })]);
    const writes = [];
    const res = await pushExternalRefs(cwd, {
      apply: true,
      resolve: async () => ({ state: 'open', labels: ['done', 'extra'] }),
      write: async (l, p) => { writes.push(p); return { ok: true }; },
    });
    assert.equal(res.pushed.length, 0);
    assert.equal(res.unchanged, 1);
    assert.equal(writes.length, 0);
  });
  test('combined state+labels → ONE PATCH carrying both', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [labelLink({ expect: 'closed', expect_labels: ['done'] })]);
    const writes = [];
    const res = await pushExternalRefs(cwd, {
      apply: true,
      resolve: async () => ({ state: 'open', labels: ['keep'] }),
      write: async (l, p) => { writes.push(p); return { ok: true }; },
    });
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], { state: 'closed', labels: ['keep', 'done'] });
    assert.deepEqual(res.pushed[0].state, { from: 'open', to: 'closed' });
    assert.deepEqual(res.pushed[0].labels, { added: ['done'] });
  });
  test('labels-only link (no expect) is eligible, not mis-skipped as malformed', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [labelLink({ expect_labels: ['done'] })]);
    const res = await pushExternalRefs(cwd, {
      apply: false,
      resolve: async () => ({ state: 'open', labels: [] }),
      write: async () => ({ ok: true }),
    });
    assert.equal(res.scanned, 1);
    assert.equal(res.skipped.length, 0);
    assert.equal(res.pushed.length, 1);
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
    const resolve = async () => ({ state: 'open', labels: [] });
    const write = async (l, patch) => { writes.push({ issue: l.issue, patch }); return { ok: true }; };

    const res = await pushExternalRefs(cwd, { apply: true, resolve, write });
    assert.equal(res.pushed.length, 1);
    assert.deepEqual(writes, [{ issue: 7, patch: { state: 'closed' } }]);
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

  test('url/reserved push-opted links are ignored (not pushable)', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [{ kind: 'external', provider: 'url', url: 'https://x.example/a', push: true }]);
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
  test('returns live state + normalized labels on a 200 issue', async () => {
    const r = await defaultResolve(ghLink(), { transport: transport(() => ({ status: 200, body: { state: 'open', labels: [{ name: 'bug' }, { name: 'p1' }] } })), auth: AUTH });
    assert.deepEqual(r, { state: 'open', labels: ['bug', 'p1'] });
  });
  test('normalizes a label-less issue to []', async () => {
    const r = await defaultResolve(ghLink(), { transport: transport(() => ({ status: 200, body: { state: 'open' } })), auth: AUTH });
    assert.deepEqual(r, { state: 'open', labels: [] });
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
  test('ok on 2xx PATCH (passes the patch through verbatim)', async () => {
    let seen;
    const r = await defaultWrite(ghLink(), { state: 'closed' }, { transport: transport((m, p, b) => { seen = { m, b }; return { status: 200, body: {} }; }), auth: AUTH });
    assert.deepEqual(r, { ok: true });
    assert.equal(seen.m, 'PATCH');
    assert.deepEqual(seen.b, { state: 'closed' });
  });
  test('PATCHes a combined state+labels patch', async () => {
    let seen;
    const r = await defaultWrite(ghLink(), { state: 'closed', labels: ['bug', 'done'] }, { transport: transport((m, p, b) => { seen = b; return { status: 200, body: {} }; }), auth: AUTH });
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(seen, { state: 'closed', labels: ['bug', 'done'] });
  });
  test('skips on non-2xx PATCH (surfaced via updateIssueResult status)', async () => {
    const r = await defaultWrite(ghLink(), { state: 'closed' }, { transport: transport(() => ({ status: 403, body: {} })), auth: AUTH });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /403/);
  });
  test('degrades on an incomplete ref instead of PATCHing /issues/null', async () => {
    let called = false;
    const r = await defaultWrite({ provider: 'github', repo: 'o/r' }, { state: 'closed' }, { transport: transport(() => { called = true; return { status: 200, body: {} }; }), auth: AUTH });
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
