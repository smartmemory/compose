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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { linkFeatures } from '../lib/feature-writer.js';
import { validateProject } from '../lib/feature-validator.js';
import { featureStatusToExternalExpect } from '../lib/status-projection.js';
import { tmpdir } from 'node:os';

import { planPush, planLabels, isGithubState, pushExternalRefs, defaultResolve, defaultWrite } from '../lib/xref-push.js';
import { writeFeature, readFeature } from '../lib/feature-json.js';
import { recordCompletion } from '../lib/completion-writer.js';

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'xref-push-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

function seed(cwd, code, links, status = 'PLANNED') {
  writeFeature(cwd, {
    code, description: 'd', status, phase: 'P', position: 1,
    created: '2026-06-07', updated: '2026-06-07', links,
  }, 'docs/features', { validate: false });
}

const ghLink = (over = {}) => ({ kind: 'external', provider: 'github', repo: 'o/r', issue: 7, ...over });
const forgejoLink = (over = {}) => ({ kind: 'external', provider: 'forgejo', repo: 'o/r', issue: 7, ...over });

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

const FORGEJO_AUTH = { token: 'forgejo-test-token' };

describe('pushExternalRefs — Forgejo', () => {
  test('golden flow: record_completion flips COMPLETE, then --apply derives closed and PATCHes Forgejo', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [forgejoLink({ derive_expect: true, push: true })], 'IN_PROGRESS');

    const completion = await recordCompletion(cwd, {
      feature_code: 'A-1', commit_sha: null, tests_pass: true, files_changed: [],
    });
    assert.deepEqual(completion.status_changed, { from: 'IN_PROGRESS', to: 'COMPLETE' });
    assert.equal(readFeature(cwd, 'A-1').status, 'COMPLETE');

    const calls = [];
    let liveState = 'open';
    const t = transport((method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'GET') return { status: 200, body: { state: liveState, labels: [] } };
      if (method === 'PATCH') {
        liveState = body.state;
        return { status: 200, body: { state: liveState } };
      }
      throw new Error(`unexpected ${method}`);
    });

    const res = await pushExternalRefs(cwd, {
      apply: true, forgejoTransport: t, forgejoAuth: FORGEJO_AUTH,
    });

    assert.equal(liveState, 'closed');
    assert.deepEqual(calls.map(({ method, body }) => ({ method, body })), [
      { method: 'GET', body: undefined },
      { method: 'PATCH', body: { state: 'closed' } },
    ]);
    assert.equal(res.skipped.length, 0);
    assert.equal(res.pushed.length, 1);
    assert.deepEqual(
      { statePushed: res.pushed[0].statePushed, labelsPushed: res.pushed[0].labelsPushed, errors: res.pushed[0].errors },
      { statePushed: true, labelsPushed: false, errors: [] },
    );
  });

  test('dry-run resolves drift but makes zero Forgejo write calls', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [forgejoLink({ expect: 'closed', push: true })]);
    const calls = [];
    const t = transport((method) => {
      calls.push(method);
      return { status: 200, body: { state: 'open', labels: [] } };
    });

    const res = await pushExternalRefs(cwd, {
      apply: false, forgejoTransport: t, forgejoAuth: FORGEJO_AUTH,
    });

    assert.deepEqual(calls, ['GET']);
    assert.equal(calls.filter((method) => method === 'PATCH' || method === 'POST').length, 0);
    assert.deepEqual(
      { statePushed: res.pushed[0].statePushed, labelsPushed: res.pushed[0].labelsPushed, errors: res.pushed[0].errors },
      { statePushed: false, labelsPushed: false, errors: [] },
    );
  });

  test('without push:true Forgejo is never touched, even under --apply', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [forgejoLink({ expect: 'closed' })]);
    const calls = [];
    const res = await pushExternalRefs(cwd, {
      apply: true,
      forgejoTransport: transport((method) => { calls.push(method); return { status: 200, body: {} }; }),
      forgejoAuth: FORGEJO_AUTH,
    });
    assert.equal(res.scanned, 0);
    assert.deepEqual(calls, []);
  });

  test('PARKED derive_expect freezes state but still adds missing labels', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [forgejoLink({ derive_expect: true, expect_labels: ['done'], push: true })], 'PARKED');
    const calls = [];
    const res = await pushExternalRefs(cwd, {
      apply: true,
      forgejoTransport: transport((method, path, body) => {
        calls.push({ method, body });
        if (method === 'GET') return { status: 200, body: { state: 'open', labels: [] } };
        if (method === 'POST') return { status: 201, body: {} };
        throw new Error(`unexpected ${method}`);
      }),
      forgejoAuth: FORGEJO_AUTH,
    });

    assert.deepEqual(calls, [
      { method: 'GET', body: undefined },
      { method: 'POST', body: { labels: ['done'] } },
    ]);
    assert.equal(res.scanned, 1);
    assert.equal(res.pushed.length, 1);
    assert.equal(res.pushed[0].state, undefined);
    assert.equal(res.pushed[0].statePushed, false);
    assert.equal(res.pushed[0].labelsPushed, true);
    assert.deepEqual(res.pushed[0].labelsAdded, ['done']);
  });

  test('PARKED derive_expect with no label intent still has nothing to do', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [forgejoLink({ derive_expect: true, push: true })], 'PARKED');
    const calls = [];
    const res = await pushExternalRefs(cwd, {
      apply: true,
      forgejoTransport: transport((method) => { calls.push(method); return { status: 200, body: {} }; }),
      forgejoAuth: FORGEJO_AUTH,
    });

    assert.equal(res.scanned, 0);
    assert.deepEqual(calls, []);
  });

  test('PR-backed issue is skipped before any write', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [forgejoLink({ expect: 'closed', push: true })]);
    const calls = [];
    const res = await pushExternalRefs(cwd, {
      apply: true,
      forgejoTransport: transport((method) => {
        calls.push(method);
        return { status: 200, body: { state: 'open', pull_request: { url: 'x' } } };
      }),
      forgejoAuth: FORGEJO_AUTH,
    });
    assert.deepEqual(calls, ['GET']);
    assert.equal(res.pushed.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0].reason, /pull request/);
  });

  test('partial success preserves a 2xx state write when the independent label call fails', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [forgejoLink({ expect: 'closed', expect_labels: ['done'], push: true })]);
    const calls = [];
    const t = transport((method, path, body) => {
      calls.push({ method, body });
      if (method === 'GET') return { status: 200, body: { state: 'open', labels: [] } };
      if (method === 'PATCH') return { status: 200, body: { state: 'closed' } };
      if (method === 'POST') return { status: 503, body: {} };
      throw new Error(`unexpected ${method}`);
    });

    const res = await pushExternalRefs(cwd, {
      apply: true, forgejoTransport: t, forgejoAuth: FORGEJO_AUTH,
    });

    assert.deepEqual(calls.map(({ method, body }) => ({ method, body })), [
      { method: 'GET', body: undefined },
      { method: 'PATCH', body: { state: 'closed' } },
      { method: 'POST', body: { labels: ['done'] } },
    ]);
    assert.equal(res.skipped.length, 0, 'the successful state write must never be relabeled skipped');
    assert.equal(res.pushed.length, 1);
    assert.equal(res.pushed[0].statePushed, true);
    assert.equal(res.pushed[0].labelsPushed, false);
    assert.equal(res.pushed[0].errors.length, 1);
    assert.match(res.pushed[0].errors[0], /label "done" write HTTP 503/);
  });

  test('state failure does not prevent the independent label call from succeeding', async () => {
    const cwd = freshCwd();
    seed(cwd, 'A-1', [forgejoLink({ expect: 'closed', expect_labels: ['done'], push: true })]);
    const calls = [];
    const t = transport((method) => {
      calls.push(method);
      if (method === 'GET') return { status: 200, body: { state: 'open', labels: [] } };
      if (method === 'PATCH') return { status: 503, body: {} };
      if (method === 'POST') return { status: 201, body: {} };
      throw new Error(`unexpected ${method}`);
    });

    const res = await pushExternalRefs(cwd, {
      apply: true, forgejoTransport: t, forgejoAuth: FORGEJO_AUTH,
    });

    assert.deepEqual(calls, ['GET', 'PATCH', 'POST']);
    assert.equal(res.skipped.length, 0, 'the successful label write must never be relabeled skipped');
    assert.equal(res.pushed[0].statePushed, false);
    assert.equal(res.pushed[0].labelsPushed, true);
    assert.deepEqual(res.pushed[0].errors, ['state write HTTP 503']);
  });
});


describe('Forgejo review regressions', () => {
  for (const mode of ['none', 'partial', 'all', 'throw']) {
    test(`per-label evidence and summary: ${mode}`, async (t) => {
      const cwd = freshCwd();
      t.after(() => rmSync(cwd, { recursive: true, force: true }));
      seed(cwd, 'A-1', [forgejoLink({ expect: 'closed', expect_labels: ['first', 'second'], push: true })]);
      const res = await pushExternalRefs(cwd, {
        apply: true, forgejoAuth: FORGEJO_AUTH,
        forgejoTransport: transport((method, path, body) => {
          if (method === 'GET') return { status: 200, body: { state: 'open', labels: [] } };
          if (method === 'PATCH') return { status: 503, body: {} };
          if (mode === 'throw' && body.labels[0] === 'second') throw new Error('offline');
          return { status: mode === 'all' || (mode !== 'none' && body.labels[0] === 'first') ? 200 : 503, body: {} };
        }),
      });
      const row = res.pushed[0];
      const added = mode === 'all' ? ['first', 'second'] : mode === 'none' ? [] : ['first'];
      assert.deepEqual(row.labelsAdded, added);
      assert.deepEqual(row.labels.added, added);
      assert.equal(row.labelsPushed, mode === 'all');
      assert.equal(res.skipped.length, 0);
      assert.match(row.summary, /state open → closed \(FAILED\)/);
      assert.match(row.summary, new RegExp(`${added.length}/2 written`));
      assert.match(row.summary, /FAILED: state write HTTP 503/);
      if (mode !== 'all') assert.match(row.summary, /not written: \+.*second/);
    });
  }

  for (const mode of ['failed', 'partial', 'success', 'dry-run']) {
    test(`CLI reports ${mode} writes and exit status`, (t) => {
      const cwd = freshCwd();
      t.after(() => rmSync(cwd, { recursive: true, force: true }));
      seed(cwd, 'A-1', [forgejoLink({ expect: 'closed', expect_labels: ['first', 'second'], push: true })]);
      const preload = join(cwd, 'forgejo-stub.mjs');
      writeFileSync(preload, `
        import { ForgejoApi } from ${JSON.stringify(new URL('../lib/tracker/forgejo-api.js', import.meta.url).href)};
        ForgejoApi.prototype.getIssueResult = async () => ({ status: 200, body: { state: 'open', labels: [] } });
        ForgejoApi.prototype.updateStateResult = async () => ({ status: ${mode === 'success' ? 200 : 503} });
        ForgejoApi.prototype.addLabelResult = async (_, label) => ({ status: ${JSON.stringify(mode)} === 'success' || (${JSON.stringify(mode)} === 'partial' && label === 'first') ? 200 : 503 });
      `);
      const result = spawnSync(process.execPath, ['--import', preload,
        fileURLToPath(new URL('../bin/compose.js', import.meta.url)), 'roadmap', 'xref-push',
        ...(mode === 'dry-run' ? [] : ['--apply'])], {
        cwd, encoding: 'utf8', env: { ...process.env, COMPOSE_FORGEJO_TOKEN: 'test', COMPOSE_TARGET: cwd },
      });
      assert.equal(result.status, ['failed', 'partial'].includes(mode) ? 1 : 0, result.stdout + result.stderr);
      if (mode === 'failed' || mode === 'partial') {
        assert.match(result.stdout, /FAILED: state write HTTP 503/);
        assert.match(result.stdout, new RegExp(`${mode === 'partial' ? 1 : 0}/2 written`));
        assert.doesNotMatch(result.stdout, /\(wrote\)/);
        assert.doesNotMatch(result.stdout, /^Pushed /m);
      } else if (mode === 'success') {
        assert.match(result.stdout, /Pushed 1 external target/);
        assert.match(result.stdout, /\(wrote\)/);
        assert.doesNotMatch(result.stdout, /FAILED/);
      } else {
        assert.match(result.stdout, /Would push 1 external target/);
        assert.match(result.stdout, /labels \+first,second \(would write\)/);
        assert.doesNotMatch(result.stdout, /FAILED|not written/);
      }
    });
  }

  test('MCP link writer persists derive_expect and both consumers agree across lifecycle statuses', async (t) => {
    const cwd = freshCwd();
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    seed(cwd, 'A-1', [], 'IN_PROGRESS');
    // The real implementation called by the MCP link_features handler.
    await linkFeatures(cwd, { from_code: 'A-1', ...forgejoLink({ derive_expect: true, push: true }) });
    const path = join(cwd, 'docs', 'features', 'A-1', 'feature.json');
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(persisted.links[0].derive_expect, true);
    assert.equal(persisted.links[0].push, true);
    assert.equal(persisted.links[0].provider, 'forgejo');
    assert.equal(persisted.links[0].expect, undefined);
    for (const status of ['IN_PROGRESS', 'COMPLETE', 'KILLED']) {
      writeFileSync(path, JSON.stringify({ ...persisted, status }));
      const before = readFileSync(path, 'utf8');
      const expected = featureStatusToExternalExpect(status);
      let live = expected === 'open' ? 'closed' : 'open';
      const opts = {
        forgejoAuth: FORGEJO_AUTH,
        forgejoTransport: transport((method) => {
          assert.equal(method, 'GET');
          return { status: 200, body: { state: live, labels: [] } };
        }),
      };
      const validation = await validateProject(cwd, { ...opts, external: true });
      const drift = validation.findings.filter(f => f.kind === 'XREF_DRIFT');
      assert.equal(drift.length, 1, status);
      const push = await pushExternalRefs(cwd, opts);
      assert.equal(push.pushed.length, 1, status);
      assert.equal(push.pushed[0].to, expected);
      assert.ok(drift[0].detail.includes(`expected o/r#7 to be ${push.pushed[0].to} but it is ${live}`));
      live = expected;
      assert.equal((await validateProject(cwd, { ...opts, external: true })).findings.filter(f => f.kind === 'XREF_DRIFT').length, 0);
      assert.equal((await pushExternalRefs(cwd, opts)).unchanged, 1);
      assert.equal(readFileSync(path, 'utf8'), before);
    }
  });
});
