/**
 * COMP-INBOX-LOCAL-FILE-LINKS-1: POST /api/fleet/open-path and the `localfile` token behind the inbox's file links.
 * The opener is never run: every case injects a spawner stub that records its argv. Files are made in a scratch dir that
 * stands in for the home folder; the real home is only read (realpath/stat), never written.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalPath, OPEN_PATH_ROUTE } from '../server/open-path.js';
import { attachFleetRoutes } from '../server/fleet-routes.js';
import { entityParts, isSafeLocalPath, localPathOf } from '../src/lib/entityParts.js';
import { entityLinkParts } from '../src/components/cockpit/notify/inboxLogic.js';

const OWNER_CARD = 'Report: /Users/ruze/reg/my/SmartMemory/smart-memory-ops/units/REL-2.0-LOCAL-ACCEPT-1/report-final-sdk-e2e.md';

describe('entityParts: localfile', () => {
  it('the owner card path is ONE localfile part (the unit code inside it does not split it)', () => {
    assert.deepEqual(entityParts(OWNER_CARD), [
      { kind: 'text', value: 'Report: ' },
      { kind: 'localfile', value: OWNER_CARD.slice('Report: '.length) },
    ]);
  });
  it('a ~/ path, a :line suffix, and sentence punctuation after it', () => {
    assert.deepEqual(entityParts('see ~/notes/a.md:12.'), [
      { kind: 'text', value: 'see ' }, { kind: 'localfile', value: '~/notes/a.md:12' }, { kind: 'text', value: '.' },
    ]);
    assert.equal(localPathOf('~/notes/a.md:12'), '~/notes/a.md');
    assert.deepEqual(entityParts('/home/kim/x.log, then').map((p) => p.kind), ['localfile', 'text']);
  });
  for (const bad of ['/Users/a/../etc/passwd', '~/../x.md', '/Users/a/./b', '/etc/passwd', '/tmp/x.md']) {
    it(`${bad} stays text`, () => {
      assert.ok(entityParts(`open ${bad} now`).every((p) => p.kind === 'text'), JSON.stringify(entityParts(`open ${bad} now`)));
      assert.equal(entityParts(`open ${bad} now`).map((p) => p.value).join(''), `open ${bad} now`);
    });
  }
  it('whitespace, quotes, <>, % and backslash end a path (they are never inside one)', () => {
    for (const ch of [' ', '"', "'", '<', '>', '%', '\\']) {
      const parts = entityParts(`/Users/a/b${ch}c`);
      assert.equal(parts[0].kind, 'localfile');
      assert.equal(parts[0].value, '/Users/a/b');
    }
    assert.equal(isSafeLocalPath('/Users/a/b c'), false);
    assert.equal(isSafeLocalPath('/Users/a/b\0c'), false);
  });
  it('a URL is untouched and a repo path is still a file', () => {
    assert.deepEqual(entityLinkParts('https://h.test/Users/a/b.md and docs/a/x.md'), [
      { href: 'https://h.test/Users/a/b.md', text: 'https://h.test/Users/a/b.md' },
      { text: ' and ' },
      { entity: 'file', text: 'docs/a/x.md' },
    ]);
    assert.deepEqual(entityParts('file:///Users/a/b.md').map((p) => p.kind), ['text']);
  });
  it('the inbox parts carry the localfile entity', () => {
    assert.deepEqual(entityLinkParts(OWNER_CARD)[1], { entity: 'localfile', text: OWNER_CARD.slice('Report: '.length) });
  });
});

describe('openLocalPath', () => {
  let home;
  let realHome;
  let outside;
  const run = (path, extra = {}) => {
    const calls = [];
    const warns = [];
    return openLocalPath({ path }, { home, platform: 'darwin', spawner: (argv, opts) => calls.push({ argv, opts }), warn: (l) => warns.push(l), ...extra })
      .then((reply) => ({ reply, calls, warns }));
  };
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'open-path-home-'));
    realHome = realpathSync(home);
    outside = mkdtempSync(join(tmpdir(), 'open-path-outside-'));
    mkdirSync(join(home, 'docs'));
    writeFileSync(join(home, 'docs', 'report.md'), '# r\n');
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(join(outside, 'secret.txt'), join(home, 'docs', 'escape.txt'));
    symlinkSync(outside, join(home, 'outdir'));
    symlinkSync(join(home, 'docs', 'report.md'), join(home, 'inside-link.md'));
    mkdirSync(join(home, 'Evil.app'));
    writeFileSync(join(home, 'run.command'), 'echo hi\n');
    writeFileSync(join(home, 'binary'), '#!/bin/sh\n');
    chmodSync(join(home, 'binary'), 0o755);
    writeFileSync(join(home, 'tool.py'), 'print(1)\n');
    chmodSync(join(home, 'tool.py'), 0o755);
  });
  after(() => { rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

  it('a real file under home is accepted; the spawner gets argv [open, <realpath>]', async () => {
    const { reply, calls, warns } = await run(join(home, 'docs', 'report.md'));
    const real = join(realHome, 'docs', 'report.md');
    assert.deepEqual(reply, { status: 'accepted', path: real });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ['open', real]);
    assert.deepEqual(warns, []);
  });
  it('a folder under home is accepted; xdg-open off darwin', async () => {
    const { reply, calls } = await run(join(home, 'docs'), { platform: 'linux' });
    assert.equal(reply.status, 'accepted');
    assert.deepEqual(calls[0].argv, ['xdg-open', join(realHome, 'docs')]);
  });
  it('~/ expands to home; a symlink that stays inside home opens its target', async () => {
    assert.deepEqual((await run('~/docs/report.md')).calls[0].argv, ['open', join(realHome, 'docs', 'report.md')]);
    assert.deepEqual((await run('~/inside-link.md')).calls[0].argv, ['open', join(realHome, 'docs', 'report.md')]);
  });

  const refusals = [
    ['/etc/passwd with the real home', () => ({ path: '/etc/passwd', extra: { home: homedir() } }), /not under the home folder/, 'outside-home'],
    ['~/nonexistent with the real home', () => ({ path: `~/nonexistent-${process.pid}-${Date.now()}`, extra: { home: homedir() } }), /no such file/, 'missing'],
    ['a missing file under home', () => ({ path: join(home, 'nope.md') }), /no such file/, 'missing'],
    ['a symlink escaping home (file)', () => ({ path: join(home, 'docs', 'escape.txt') }), /not under the home folder/, 'outside-home'],
    ['a symlink escaping home (folder)', () => ({ path: join(home, 'outdir', 'secret.txt') }), /not under the home folder/, 'outside-home'],
    ['home itself', () => ({ path: home }), /not under the home folder/, 'outside-home'],
    ['a .. segment (even one that lands inside home)', () => ({ path: join(home, 'docs') + '/../docs/report.md' }), /\.\. segment/, 'dotdot'],
    ['a NUL byte', () => ({ path: join(home, 'docs', 'report.md') + '\0x' }), /NUL/, 'nul'],
    ['a relative path', () => ({ path: 'docs/report.md' }), /absolute/, 'relative'],
    ['~user', () => ({ path: '~root/x' }), /~user/, 'tilde'],
    ['a non-string', () => ({ path: 42 }), /non-empty string/, 'shape'],
    ['an empty string', () => ({ path: '' }), /non-empty string/, 'shape'],
    ['an over-long path', () => ({ path: '/' + 'a'.repeat(5000) }), /at most/, 'shape'],
    ['an app bundle', () => ({ path: join(home, 'Evil.app') }), /apps, scripts and launchers/, 'launcher'],
    ['a .command launcher', () => ({ path: join(home, 'run.command') }), /apps, scripts and launchers/, 'launcher'],
    ['an executable with no extension', () => ({ path: join(home, 'binary') }), /executable/, 'executable'],
  ];
  for (const [name, input, reason, cls] of refusals) {
    it(`refused: ${name}`, async () => {
      const { path, extra } = input();
      const { reply, calls, warns } = await run(path, extra);
      assert.equal(reply.status, 'rejected');
      assert.match(reply.reason, reason);
      assert.equal(calls.length, 0, 'the spawner never runs on a refusal');
      assert.equal(warns.length, 1);
      assert.match(warns[0], new RegExp(`^\\[fleet\\] open-path rejected \\(${cls}\\): `));
    });
  }
  it('an executable WITH an extension (a .py) is opened, as the default app decides', async () => {
    assert.equal((await run(join(home, 'tool.py'))).reply.status, 'accepted');
  });
  it('a throwing spawner is a rejected reply, never a crash', async () => {
    const { reply } = await run(join(home, 'docs', 'report.md'), { spawner: () => { throw new Error('ENOENT'); } });
    assert.equal(reply.status, 'rejected');
    assert.match(reply.reason, /could not start/);
  });
  it('no shell anywhere in the route source', () => {
    const src = readFileSync(fileURLToPath(new URL('../server/open-path.js', import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /\bexec(Sync)?\(|execFile|shell:\s*true/);
    assert.match(src, /shell: false/);
  });
});

describe(`POST ${OPEN_PATH_ROUTE} (mounted, auth guard)`, () => {
  const TOKEN = 'open-path-test-token';
  let server;
  let base;
  let home;
  let prev;
  const calls = [];
  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'open-path-http-'));
    writeFileSync(join(home, 'a.md'), 'a');
    prev = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = TOKEN;
    const app = express();
    app.use(express.json());
    attachFleetRoutes(app, { env: {}, warn: () => {}, info: () => {}, openPath: { home, platform: 'darwin', spawner: (argv) => calls.push(argv) } });
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server?.close();
    rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.COMPOSE_API_TOKEN; else process.env.COMPOSE_API_TOKEN = prev;
  });
  const post = (body, token) => fetch(`${base}${OPEN_PATH_ROUTE}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-compose-token': token } : {}) }, body: JSON.stringify(body) });

  it('no token or a wrong one: 401 and nothing spawned', async () => {
    assert.equal((await post({ path: join(home, 'a.md') })).status, 401);
    assert.equal((await post({ path: join(home, 'a.md') }, 'wrong')).status, 401);
    assert.equal(calls.length, 0);
  });
  it('with the token: accepted, argv [open, realpath], no-store', async () => {
    const res = await post({ path: join(home, 'a.md') }, TOKEN);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const real = join(realpathSync(home), 'a.md');
    assert.deepEqual(await res.json(), { status: 'accepted', path: real });
    assert.deepEqual(calls, [['open', real]]);
  });
  it('with the token, outside home: rejected', async () => {
    assert.equal((await (await post({ path: '/etc/passwd' }, TOKEN)).json()).status, 'rejected');
    assert.equal(calls.length, 1);
  });
});
