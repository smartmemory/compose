import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { promoteIssue, ACCEPTANCE_LABEL } from '../lib/xref-promote.js';
import { LocalFileProvider } from '../lib/tracker/local-provider.js';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'xref-promote-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'docs/features'), { recursive: true });
  const file = join(cwd, 'docs/features/NEW-1/feature.json');
  const source = { title: 'Fix\r\nthis\u0000 | safely\u2028please', body: '# Contributor\n\n| full | body |\n\u0000', labels: [{ name: 'human' }], state: 'open' };
  const comments = [];
  const calls = [];
  const f = { cwd, file, source, comments, calls, fail: null, committedFailure: false };
  const transport = { async request(method, url, body) {
    const path = new URL(url).pathname;
    calls.push({ method, path, body });
    const op = path.endsWith('/comments') ? 'comment' : path.endsWith('/labels') ? 'label' : 'issue';
    if (f.override) {
      const response = f.override(method, url, body);
      if (response) return response;
    }
    if (method === 'GET') return { status: 200, body: structuredClone(op === 'comment' ? comments : source) };
    // Both local phases must already be committed before any remote write.
    const feature = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(feature.promoted_from, { provider: 'forgejo', repo: 'owner/repo', issue: 7 });
    assert.equal(feature.notes, source.body);
    assert.equal(feature.links.length, 1);
    if (f.fail === op && !f.committedFailure) return { status: 503, body: {} };
    if (op === 'label') source.labels.push({ name: body.labels[0] });
    if (op === 'comment') comments.push({ body: body.body });
    if (f.fail === op) throw new Error('connection lost after commit');
    return { status: 201, body: {} };
  } };
  f.opts = { provider: 'forgejo', repo: 'owner/repo', issue: 7, code: 'NEW-1', phase: 'Community', forgejoAuth: { token: 'fake' }, forgejoTransport: transport };
  f.run = extra => promoteIssue(cwd, { ...f.opts, ...extra });
  f.feature = () => JSON.parse(readFileSync(file, 'utf8'));
  f.writes = () => calls.filter(c => c.method !== 'GET');
  return f;
}
function snapshot(dir) {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? Object.entries(snapshot(p)).map(([k, v]) => [`${e.name}/${k}`, v]) : [[e.name, readFileSync(p, 'utf8')]];
  }));
}

test('golden flow: zero-write dry-run, ordered apply, all-phase no-op retry, collision and PR refusal', async t => {
  const f = fixture(t);
  const before = snapshot(f.cwd);
  const dry = await f.run();
  assert.equal(dry.ok, true);
  assert.deepEqual(dry.phases.map(p => p.status), Array(4).fill('planned'));
  assert.deepEqual(snapshot(f.cwd), before);
  assert.deepEqual(f.writes(), []);
  const events = [];
  for (const method of ['createFeature', 'putFeature']) {
    const original = LocalFileProvider.prototype[method];
    t.mock.method(LocalFileProvider.prototype, method, async function(code, obj, ...rest) {
      events.push(method === 'createFeature' ? 'feature' : obj.links?.length ? 'link' : 'notes');
      return original.call(this, code, obj, ...rest);
    });
  }
  f.calls.length = 0;
  const applied = await f.run({ apply: true });
  assert.deepEqual(events, ['feature', 'notes', 'link']);
  assert.deepEqual(applied.phases, ['feature', 'link', 'label', 'comment'].map(phase => ({ phase, status: 'written' })));
  assert.deepEqual(f.calls.map(c => `${c.method} ${c.path.split('/').at(-1)}`), ['GET 7', 'GET 7', 'POST labels', 'GET comments', 'POST comments']);
  assert.equal(f.feature().description, 'Fix this | safely please');
  assert.equal(f.feature().notes, f.source.body);
  assert.deepEqual(f.feature().links, [applied.plan.link]);
  assert.deepEqual(f.source.labels.map(l => l.name), ['human', ACCEPTANCE_LABEL]);
  assert.match(f.comments[0].body, /<!-- compose-promotion:NEW-1 -->/);
  assert.match(f.comments[0].body, /ROADMAP.md/);
  assert.ok(!readFileSync(join(f.cwd, 'ROADMAP.md'), 'utf8').includes('# Contributor'));
  const after = snapshot(f.cwd);
  events.length = 0;
  f.calls.length = 0;
  const retry = await f.run({ apply: true });
  assert.deepEqual(retry.phases.map(p => p.status), Array(4).fill('unchanged'));
  assert.deepEqual(events, []);
  assert.deepEqual(f.writes(), []);
  assert.deepEqual(snapshot(f.cwd), after);
  await assert.rejects(f.run({ issue: 8, apply: true }), /collision.*promoted_from/);
  f.source.pull_request = {};
  await assert.rejects(f.run({ apply: true }), /pull request/);
  assert.deepEqual(snapshot(f.cwd), after);
  assert.deepEqual(f.writes(), []);
});

test('PR refused before feature creation or collision checks', async t => {
  const f = fixture(t);
  f.source.pull_request = { url: 'pr' };
  const before = snapshot(f.cwd);
  await assert.rejects(f.run({ apply: true }), /pull request/);
  assert.deepEqual(snapshot(f.cwd), before);
  assert.equal(f.calls.length, 1);
});

for (const provenance of [undefined, { provider: 'github', repo: 'owner/repo', issue: 7 }, { provider: 'forgejo', repo: 'other/repo', issue: 7 }]) {
  test(`existing feature refuses provenance ${JSON.stringify(provenance)}`, async t => {
    const f = fixture(t);
    mkdirSync(join(f.cwd, 'docs/features/NEW-1'));
    writeFileSync(f.file, JSON.stringify({ code: 'NEW-1', promoted_from: provenance }));
    const before = snapshot(f.cwd);
    await assert.rejects(f.run({ apply: true }), /collision/);
    assert.deepEqual(snapshot(f.cwd), before);
    assert.deepEqual(f.writes(), []);
  });
}

for (const failure of ['notes', 'link']) {
  test(`resumes after local ${failure} write failure`, async t => {
    const f = fixture(t);
    const original = LocalFileProvider.prototype.putFeature;
    const mock = t.mock.method(LocalFileProvider.prototype, 'putFeature', async function(code, obj, ...rest) {
      if ((failure === 'link') === Boolean(obj.links?.length)) throw new Error(`injected ${failure} failure`);
      return original.call(this, code, obj, ...rest);
    });
    await assert.rejects(f.run({ apply: true }), new RegExp(`injected ${failure}`));
    assert.deepEqual(f.feature().promoted_from, { provider: 'forgejo', repo: 'owner/repo', issue: 7 });
    assert.deepEqual(f.writes(), []);
    mock.mock.restore();
    assert.equal((await f.run({ apply: true })).ok, true);
    assert.deepEqual((await f.run({ apply: true })).phases.map(p => p.status), Array(4).fill('unchanged'));
  });
}

for (const failure of ['label', 'comment']) {
  for (const committed of [false, true]) {
    test(`retry ${failure} failure (remote committed=${committed}) without duplicate writes`, async t => {
      const f = fixture(t);
      f.fail = failure;
      f.committedFailure = committed;
      const first = await f.run({ apply: true });
      assert.equal(first.ok, false);
      assert.equal(first.errors[0].phase, failure);
      assert.deepEqual(first.phases.slice(0, 2).map(p => p.status), ['written', 'written']);
      f.fail = null;
      f.calls.length = 0;
      const retry = await f.run({ apply: true });
      assert.equal(retry.ok, true);
      assert.equal(f.writes().length, committed ? 0 : 1);
      assert.equal(f.comments.length, 1);
      assert.equal(f.source.labels.filter(l => l.name === ACCEPTANCE_LABEL).length, 1);
    });
  }
}

test('comment marker on a later page prevents duplicate posting', async t => {
  const f = fixture(t);
  f.override = (method, url) => {
    if (method !== 'GET' || !url.includes('/comments')) return;
    if (url.includes('page=2')) return { status: 200, body: [{ body: '<!-- compose-promotion:NEW-1 -->' }] };
    return { status: 200, body: [{ body: 'unrelated' }], headers: new Headers({ link: '<https://git.smartmemory.ai/api/v1/repos/owner/repo/issues/7/comments?page=2>; rel="next"' }) };
  };
  const result = await f.run({ apply: true });
  assert.equal(result.ok, true);
  assert.equal(result.phases.at(-1).status, 'unchanged');
  assert.equal(f.comments.length, 0);
});

for (const response of [{ status: 503, body: [] }, { status: 200, body: {} }, { status: 200, body: [], headers: { link: '<https://evil.test/comments?page=2>; rel="next"' } }]) {
  test(`uncertain comments fail closed: ${JSON.stringify(response)}`, async t => {
    const f = fixture(t);
    f.override = (method, url) => method === 'GET' && url.includes('/comments') ? response : undefined;
    const result = await f.run({ apply: true });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].phase, 'comment');
    assert.equal(f.comments.length, 0);
  });
}

test('bad issue response and corrupt local feature never write', async t => {
  const f = fixture(t);
  f.override = () => ({ status: 404, body: {} });
  await assert.rejects(f.run({ apply: true }), /HTTP 404/);
  f.override = null;
  mkdirSync(join(f.cwd, 'docs/features/NEW-1'));
  writeFileSync(f.file, '{');
  await assert.rejects(f.run({ apply: true }), SyntaxError);
  assert.equal(readFileSync(f.file, 'utf8'), '{');
  assert.deepEqual(f.writes(), []);
});

test('CLI dispatch validates input and prints failure with nonzero exit', t => {
  const f = fixture(t);
  const run = spawnSync(process.execPath, [resolve('bin/compose.js'), 'roadmap', 'promote-issue', '--provider', 'forgejo', '--repo', 'owner/repo', '--issue', '7oops', '--code', 'NEW-1', '--phase', 'Community'], { encoding: 'utf8', cwd: f.cwd, env: { ...process.env, COMPOSE_TARGET: f.cwd } });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /promote-issue failed: --issue must be a positive integer/);
});

test('CLI dry-run, apply and retry run the real orchestrator with a fake HTTP boundary', t => {
  const f = fixture(t);
  const preload = join(f.cwd, 'fake-fetch.mjs');
  const remote = join(f.cwd, 'remote.json');
  writeFileSync(remote, JSON.stringify({ title: 'CLI title', body: 'Full\nbody', labels: [], comments: [] }));
  writeFileSync(preload, `
    import { readFileSync, writeFileSync } from 'node:fs';
    const path = ${JSON.stringify(remote)};
    globalThis.fetch = async (url, opts) => {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      let body = data;
      if (opts.method === 'GET' && url.pathname.endsWith('/comments')) body = data.comments;
      if (opts.method === 'POST') {
        const input = JSON.parse(opts.body);
        if (url.pathname.endsWith('/labels')) data.labels.push({ name: input.labels[0] });
        else data.comments.push({ body: input.body });
        writeFileSync(path, JSON.stringify(data));
        body = {};
      }
      return { status: 200, json: async () => body, headers: new Headers() };
    };
  `);
  const command = ['--import', preload, resolve('bin/compose.js'), 'roadmap', 'promote-issue', '--provider', 'forgejo', '--repo', 'owner/repo', '--issue', '7', '--code', 'NEW-1', '--phase', 'Community'];
  const run = extra => spawnSync(process.execPath, [...command, ...extra], { encoding: 'utf8', cwd: f.cwd, env: { ...process.env, COMPOSE_FORGEJO_TOKEN: 'fake', COMPOSE_TARGET: f.cwd } });
  const before = snapshot(f.cwd);
  const dry = run([]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Dry-run/);
  assert.deepEqual(snapshot(f.cwd), before);
  const applied = run(['--apply']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(JSON.parse(applied.stdout).phases.map(p => p.status), Array(4).fill('written'));
  assert.equal(f.feature().description, 'CLI title');
  const after = snapshot(f.cwd);
  const retry = run(['--apply']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(JSON.parse(retry.stdout).phases.map(p => p.status), Array(4).fill('unchanged'));
  assert.deepEqual(snapshot(f.cwd), after);
});

test('retry repairs roadmap when creation committed before rendering failed', async t => {
  const f = fixture(t);
  const mock = t.mock.method(LocalFileProvider.prototype, 'renderRoadmap', async () => { throw new Error('render failed'); });
  await assert.rejects(f.run({ apply: true }), error => {
    assert.equal(error.promotion.ok, false);
    assert.equal(error.promotion.phases[0].featurePersisted, true);
    return /regeneration failed/.test(error.message);
  });
  assert.deepEqual(f.writes(), []);
  mock.mock.restore();
  const result = await f.run({ apply: true });
  assert.equal(result.ok, true);
  assert.match(readFileSync(join(f.cwd, 'ROADMAP.md'), 'utf8'), /NEW-1/);
  const before = snapshot(f.cwd);
  assert.deepEqual((await f.run({ apply: true })).phases.map(p => p.status), Array(4).fill('unchanged'));
  assert.deepEqual(snapshot(f.cwd), before);
});
