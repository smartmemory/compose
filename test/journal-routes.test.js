/**
 * journal-routes.test.js — GET /api/journal, GET /api/changelog, POST /api/journal.
 *
 * Run: node --test test/journal-routes.test.js
 *
 * Coverage (COMP-COCKPIT-9):
 *   - GET /api/journal returns {entries, count} from a seeded tmp project
 *   - GET /api/journal?limit=1 honors a STRING limit (numeric parse + clamp)
 *   - GET /api/changelog?feature=<code> filters via the `code` key
 *   - POST /api/journal requires the sensitive token (401)
 *   - POST happy path writes an entry and returns its path
 *   - POST with colliding (date, slug) retries with -2 suffix (two distinct files)
 *   - 400 on missing summary / sections
 *   - writer INVALID_INPUT (bad feature_code) → 400, not 500
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { attachJournalRoutes } = await import(`${REPO_ROOT}/server/journal-routes.js`);
const { requireSensitiveToken } = await import(`${REPO_ROOT}/server/security.js`);
const { writeJournalEntry } = await import(`${REPO_ROOT}/lib/journal-writer.js`);

const TOKEN = 'test-journal-token';

const SECTIONS = {
  what_happened: 'Things happened.',
  what_we_built: 'We built things.',
  what_we_learned: 'We learned things.',
  open_threads: '- [ ] nothing',
};

function seedProject(root) {
  mkdirSync(join(root, 'docs', 'journal'), { recursive: true });
  writeFileSync(join(root, 'docs', 'journal', 'README.md'), [
    '# Developer Journal',
    '',
    '## Entries',
    '',
    '| Date | Entry | Summary |',
    '|------|-------|---------|',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'CHANGELOG.md'), [
    '# Changelog',
    '',
    '## 2026-06-01',
    '',
    '### AA-1 — first thing',
    '',
    '### BB-2 — second thing',
    '',
  ].join('\n'));
}

function makeApp(projectRoot) {
  const app = express();
  app.use(express.json());
  attachJournalRoutes(app, { projectRoot, requireSensitiveToken });
  return app;
}

function listen(app) {
  return new Promise((res) => {
    const server = http.createServer(app);
    server.listen(0, () => res(server));
  });
}

function request(server, urlPath, { method = 'GET', body, headers = {} } = {}) {
  const port = server.address().port;
  const data = body ? JSON.stringify(body) : null;
  const opts = {
    hostname: '127.0.0.1',
    port,
    path: urlPath,
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...headers,
    },
  };
  return new Promise((res, rej) => {
    const req = http.request(opts, (response) => {
      let buf = '';
      response.on('data', d => buf += d);
      response.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch { /* leave raw */ }
        res({ status: response.statusCode, body: parsed });
      });
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

describe('Journal routes', () => {
  let _origToken;

  before(() => {
    _origToken = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = TOKEN;
  });

  after(() => {
    if (_origToken === undefined) delete process.env.COMPOSE_API_TOKEN;
    else process.env.COMPOSE_API_TOKEN = _origToken;
  });

  let root;
  let server;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'journal-routes-'));
    seedProject(root);
    server = await listen(makeApp(root));
  });

  afterEach(() => {
    server?.close();
    server = null;
    rmSync(root, { recursive: true, force: true });
  });

  test('GET /api/journal returns {entries, count} from seeded project', async () => {
    await writeJournalEntry(root, {
      date: '2026-06-01', slug: 'first-entry',
      sections: SECTIONS, summary_for_index: 'First entry',
    });
    const res = await request(server, '/api/journal');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 1);
    assert.equal(res.body.entries.length, 1);
    assert.equal(res.body.entries[0].slug, 'first-entry');
    assert.equal(res.body.entries[0].sections.what_happened, 'Things happened.');
  });

  test('GET /api/journal?limit=1 honors string limit (numeric parse + clamp)', async () => {
    await writeJournalEntry(root, {
      date: '2026-06-01', slug: 'older-entry',
      sections: SECTIONS, summary_for_index: 'Older entry',
    });
    await writeJournalEntry(root, {
      date: '2026-06-02', slug: 'newer-entry',
      sections: SECTIONS, summary_for_index: 'Newer entry',
    });
    const res = await request(server, '/api/journal?limit=1');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 1);
    assert.equal(res.body.entries.length, 1);
    // newest-first
    assert.equal(res.body.entries[0].slug, 'newer-entry');
  });

  test('GET /api/changelog?feature=<code> filters via the code key', async () => {
    const res = await request(server, '/api/changelog?feature=BB-2');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 1);
    assert.equal(res.body.entries[0].code, 'BB-2');
  });

  test('POST /api/journal without token returns 401', async () => {
    const res = await request(server, '/api/journal', {
      method: 'POST',
      body: { summary: 'No token', sections: SECTIONS },
    });
    assert.equal(res.status, 401);
  });

  test('POST /api/journal happy path writes an entry and returns its path', async () => {
    const res = await request(server, '/api/journal', {
      method: 'POST',
      headers: { 'x-compose-token': TOKEN },
      body: { summary: 'Shipped The Thing', sections: SECTIONS },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.path, 'response includes path');
    assert.match(res.body.path, /shipped-the-thing\.md$/);
    const list = await request(server, '/api/journal');
    assert.equal(list.body.count, 1);
  });

  test('POST /api/journal with colliding (date, slug) retries with -2 suffix', async () => {
    const first = await request(server, '/api/journal', {
      method: 'POST',
      headers: { 'x-compose-token': TOKEN },
      body: { summary: 'Same Summary', sections: SECTIONS },
    });
    assert.equal(first.status, 200);
    const second = await request(server, '/api/journal', {
      method: 'POST',
      headers: { 'x-compose-token': TOKEN },
      body: { summary: 'Same Summary', sections: SECTIONS },
    });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.path, first.body.path);
    assert.match(second.body.path, /same-summary-2\.md$/);
    const files = readdirSync(join(root, 'docs', 'journal')).filter(f => f.includes('same-summary'));
    assert.equal(files.length, 2);
  });

  test('POST /api/journal 400 on missing summary', async () => {
    const res = await request(server, '/api/journal', {
      method: 'POST',
      headers: { 'x-compose-token': TOKEN },
      body: { sections: SECTIONS },
    });
    assert.equal(res.status, 400);
  });

  test('POST /api/journal 400 on missing sections', async () => {
    const res = await request(server, '/api/journal', {
      method: 'POST',
      headers: { 'x-compose-token': TOKEN },
      body: { summary: 'No sections' },
    });
    assert.equal(res.status, 400);
  });

  test('POST /api/journal 400 on incomplete section keys', async () => {
    const res = await request(server, '/api/journal', {
      method: 'POST',
      headers: { 'x-compose-token': TOKEN },
      body: { summary: 'Partial', sections: { what_happened: 'x' } },
    });
    assert.equal(res.status, 400);
  });

  test('POST /api/journal maps writer INVALID_INPUT (bad feature_code) to 400, not 500', async () => {
    const res = await request(server, '/api/journal', {
      method: 'POST',
      headers: { 'x-compose-token': TOKEN },
      body: { summary: 'Bad code', feature_code: 'not-a-valid-code!', sections: SECTIONS },
    });
    assert.equal(res.status, 400);
  });
});
