/**
 * COMP-COCKPIT-13 U3: the loopback link and pointer page (export policy: only a 127.0.0.1 link leaves the Mac).
 * One row table per concern: URL checks, base URL, page, atomic write, route (real express on loopback), CLI exit codes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PublishRefused, cockpitBaseUrl, pointerUrl, renderPointerPage, writePointerPage,
} from '../lib/process-publish.js';
import { attachProcessRoutes, resolveProcessSources } from '../server/process-routes.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIX = join(ROOT, 'test/fixtures/process-publish/pointer.html');
const ENVELOPE = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/process/api-process.json'), 'utf8'));
const FIXED = { url: 'http://127.0.0.1:5195/?view=process', generatedAt: '2026-10-30T21:00:00.000Z' };

// [input, expected url or null (refused)]
const URL_ROWS = [
  ['http://127.0.0.1:5195', 'http://127.0.0.1:5195/?view=process'],
  ['http://localhost:4001', 'http://localhost:4001/?view=process'],
  ['http://[::1]:4001', 'http://[::1]:4001/?view=process'],
  ['http://127.0.0.1', 'http://127.0.0.1/?view=process'],
  ['http://127.0.0.1:5195/some/path?x=1#frag', 'http://127.0.0.1:5195/?view=process'],
  ['http://0.0.0.0:5195', null],
  ['http://192.168.1.5:5195', null],
  ['http://my-mac.local:5195', null],
  ['https://claude.ai', null],
  ['https://127.0.0.1:5195', null],
  ['http://127.0.0.1.evil.com', null],
  ['http://localhost@evil.com', null],
  ['http://user:pw@127.0.0.1:5195', null],
  ['http://evil.com#127.0.0.1', null],
  ['http://evil.com/?h=localhost', null],
  ['javascript:alert(1)', null],
  ['file:///', null],
  ['not a url', null],
  ['', null],
];

// [env, hasSourceCheckout, expected base]
const BASE_ROWS = [
  [{ COMPOSE_COCKPIT_URL: 'http://localhost:6000' }, true, 'http://localhost:6000'],
  [{ COMPOSE_COCKPIT_URL: 'http://localhost:6000', VITE_PORT: '5300' }, false, 'http://localhost:6000'],
  [{ VITE_PORT: '5300' }, true, 'http://127.0.0.1:5300'],
  [{}, true, 'http://127.0.0.1:5195'],
  [{ VITE_PORT: '99999' }, true, 'http://127.0.0.1:5195'],
  [{ VITE_PORT: 'evil.com' }, true, 'http://127.0.0.1:5195'],
  [{ PORT: '4100' }, false, 'http://127.0.0.1:4100'],
  [{ PORT: '4100', VITE_PORT: '5300' }, false, 'http://127.0.0.1:4100'],
  [{}, false, 'http://127.0.0.1:4001'],
];

const lanes = Object.keys(ENVELOPE.sources.stamps.value.lanes);
const pageNames = Object.keys(ENVELOPE.sources.builder.value.pages);
const labels = pageNames.map((n) => ENVELOPE.sources.builder.value.pages[n].value?.label).filter(Boolean);

describe('pointerUrl', () => {
  for (const [input, expected] of URL_ROWS) {
    it(`${JSON.stringify(input)} -> ${expected ?? 'refused'}`, () => {
      if (expected) assert.equal(pointerUrl(input), expected);
      else assert.throws(() => pointerUrl(input), PublishRefused);
    });
  }
});

describe('cockpitBaseUrl', () => {
  for (const [env, src, expected] of BASE_ROWS) {
    it(`${JSON.stringify(env)} source=${src} -> ${expected}`, () => {
      assert.equal(cockpitBaseUrl({ env, hasSourceCheckout: src }), expected);
    });
  }
});

describe('renderPointerPage', () => {
  it('fixed {url, generatedAt} is byte-identical to the recorded fixture', () => {
    const html = renderPointerPage(FIXED);
    if (process.env.RECORD_POINTER_PAGE === '1') writeFileSync(FIX, html);
    assert.equal(html, readFileSync(FIX, 'utf8'), 'stale fixture: rerun with RECORD_POINTER_PAGE=1');
  });
  it('one <a>, no script or fetch, the URL twice, the time, no Process data', () => {
    const html = renderPointerPage(FIXED);
    assert.equal((html.match(/<a[\s>]/g) ?? []).length, 1);
    assert.equal(/<script|fetch\(|<iframe|<img|<link|src=/i.test(html), false);
    assert.equal(html.split(FIXED.url).length - 1, 2);
    assert.ok(html.includes(FIXED.generatedAt));
    for (const word of [...lanes, ...pageNames, ...labels]) assert.equal(html.toLowerCase().includes(`>${word.toLowerCase()}<`), false, word);
    assert.equal(/\d+\s*%/.test(html), false);
  });
  it('escapes & < > " \' in the href and the text', () => {
    const html = renderPointerPage({ url: `http://127.0.0.1:1/?a=1&b="x"<y>'z'`, generatedAt: '<t>' });
    const esc = 'http://127.0.0.1:1/?a=1&amp;b=&quot;x&quot;&lt;y&gt;&#39;z&#39;';
    assert.ok(html.includes(`href="${esc}"`));
    assert.equal(html.split(esc).length - 1, 2); // href, code text
    assert.equal(html.includes('<y>'), false);
    assert.ok(html.includes('Generated &lt;t&gt;'));
  });
});

describe('writePointerPage', () => {
  it('writes atomically (no temp left), creates the directory, overwrites, refuses a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pointer-write-'));
    try {
      const target = join(dir, 'a', 'b', 'p.html');
      assert.equal(writePointerPage(target, 'one'), target);
      assert.equal(readFileSync(target, 'utf8'), 'one');
      writePointerPage(target, 'two');
      assert.equal(readFileSync(target, 'utf8'), 'two');
      assert.deepEqual(readdirSync(join(dir, 'a', 'b')), ['p.html']);
      mkdirSync(join(dir, 'd'));
      assert.throws(() => writePointerPage(join(dir, 'd'), 'x'), /is a directory/);
      assert.deepEqual(readdirSync(join(dir, 'd')), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

async function withApp({ env = {}, remote = false, hasSourceCheckout = true }, fn) {
  const root = mkdtempSync(join(tmpdir(), 'process-publish-'));
  const full = { COMPOSE_OPS_STATUS_DIR: join(root, 'none'), COMPOSE_PROCESS_QUEUES_DIR: join(root, 'none'), COMPOSE_PROCESS_EXTRA: '', ...env };
  const app = express();
  const warns = [];
  const mounted = attachProcessRoutes(app, { remote, env: full, sources: resolveProcessSources(full), hasSourceCheckout, now: () => 1_800_000_000_000, warn: (m) => warns.push(m), info: () => {} });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn({ base, mounted, warns, root }); } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
}
// node:http so a custom Host header is actually sent (fetch forbids it)
import http from 'node:http';
const rawGet = (base, path, headers = {}) => new Promise((resolve, reject) => {
  const u = new URL(base);
  http.get({ host: u.hostname, port: u.port, path, headers }, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
  }).on('error', reject);
});

// [name, options, path, headers, expected status, check(body)]
const ROUTE_ROWS = [
  ['env-derived loopback URL', { env: {} }, '/api/process/publish', {}, 200, (b) => { assert.equal(b.url, 'http://127.0.0.1:5195/?view=process'); assert.equal(b.generatedAt, '2027-01-15T08:00:00.000Z'); assert.deepEqual(Object.keys(b).sort(), ['generatedAt', 'url']); }],
  ['addition 1: ?url=http://evil and Host: evil.example still return the env URL', { env: { COMPOSE_COCKPIT_URL: 'http://localhost:6000' } }, '/api/process/publish?url=http://evil&host=evil&base=http://evil.example', { host: 'evil.example' }, 200, (b) => assert.equal(b.url, 'http://localhost:6000/?view=process')],
  ['packaged install uses PORT', { env: { PORT: '4100' }, hasSourceCheckout: false }, '/api/process/publish', {}, 200, (b) => assert.equal(b.url, 'http://127.0.0.1:4100/?view=process')],
  ['non-loopback COMPOSE_COCKPIT_URL is 409 with the reason, no url, one warn', { env: { COMPOSE_COCKPIT_URL: 'http://192.168.1.5:5195' } }, '/api/process/publish', {}, 409, (b, ctx) => { assert.match(b.error, /192\.168\.1\.5/); assert.equal('url' in b, false); assert.equal(ctx.warns.length, 1); }],
  ['response carries no Process data (no sources, no figures)', { env: {} }, '/api/process/publish', {}, 200, (b) => assert.equal(JSON.stringify(b).includes('sources'), false)],
];

describe('GET /api/process/publish', () => {
  for (const [name, options, path, headers, status, check] of ROUTE_ROWS) {
    it(name, async () => {
      await withApp(options, async (ctx) => {
        const res = await rawGet(ctx.base, path, headers);
        assert.equal(res.status, status);
        assert.equal(res.headers['cache-control'], 'no-store');
        check(JSON.parse(res.body), ctx);
      });
    });
  }
  it('addition 4: not mounted in remote mode (404), and attach reports false', async () => {
    await withApp({ remote: true }, async ({ base, mounted }) => {
      assert.equal(mounted, false);
      assert.equal((await rawGet(base, '/api/process/publish')).status, 404);
      assert.equal((await rawGet(base, '/api/process')).status, 404);
    });
  });
  it('writes nothing: the temp root is untouched by a request', async () => {
    await withApp({}, async ({ base, root }) => {
      const before = readdirSync(root);
      await rawGet(base, '/api/process/publish');
      assert.deepEqual(readdirSync(root), before);
    });
  });
});

const NODE = process.execPath;
const cli = (args, env, cwd) => spawnSync(NODE, [join(ROOT, 'bin/compose.js'), ...args], {
  cwd, encoding: 'utf8', timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, COMPOSE_TARGET: cwd, ...env },
});

// [name, args, env, expected status, check(result, dir)]
const CLI_ROWS = [
  ['--out writes the page, prints URL, time and path only', (d) => ['process', 'publish', '--out', join(d, 'p.html')], { COMPOSE_COCKPIT_URL: 'http://127.0.0.1:5195' }, 0, (r, d) => {
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], 'http://127.0.0.1:5195/?view=process');
    assert.match(lines[1], /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    assert.equal(lines[2], join(d, 'p.html'));
    assert.equal(renderPointerPage({ url: lines[0], generatedAt: lines[1] }), readFileSync(lines[2], 'utf8'));
  }],
  ['a LAN host is refused with exit 2 and no file', (d) => ['process', 'publish', '--out', join(d, 'p.html')], { COMPOSE_COCKPIT_URL: 'http://192.168.1.5:5195' }, 2, (r, d) => { assert.equal(existsSync(join(d, 'p.html')), false); assert.equal(r.stdout, ''); }],
  ['--out naming a directory exits 1', (d) => ['process', 'publish', '--out', d], { COMPOSE_COCKPIT_URL: '' }, 1, (r) => assert.match(r.stderr, /is a directory/)],
  ['--out without a value exits 1', () => ['process', 'publish', '--out'], {}, 1, () => {}],
  ['unknown subcommand exits 1', () => ['process', 'nope'], {}, 1, () => {}],
];

describe('compose process publish', () => {
  for (const [name, args, env, status, check] of CLI_ROWS) {
    it(name, () => {
      const dir = mkdtempSync(join(tmpdir(), 'process-cli-'));
      try {
        const r = cli(args(dir), env, dir);
        assert.equal(r.status, status, r.stderr);
        check(r, dir);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
