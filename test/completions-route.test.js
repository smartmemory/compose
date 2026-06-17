/**
 * completions-route.test.js — GET /api/completions (PARITY-5).
 *
 * Run: node --test test/completions-route.test.js
 *
 * The route is a thin read-only wrapper over lib/completion-writer#getCompletions
 * bound to getTargetRoot(). We point COMPOSE_TARGET at a seeded fixture BEFORE
 * importing vision-routes (project-root caches the target at module load) so the
 * route reads our fixture, then assert:
 *   - golden: returns recorded completions, newest first, with a count
 *   - feature filter: featureCode scopes to one feature
 *   - empty: a feature with no completions → { completions: [], count: 0 }
 *   - unknown: an unknown featureCode → empty, not an error
 *   - limit: ?limit caps the returned rows
 *   - read-is-open: no token required (reads are not guardAuth-wrapped)
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Seed a fixture project and bind COMPOSE_TARGET to it *before* importing
// vision-routes / project-root, which snapshot the target root at load time.
const FIXTURE = mkdtempSync(join(tmpdir(), 'completions-route-'));
mkdirSync(join(FIXTURE, 'docs', 'features'), { recursive: true });
process.env.COMPOSE_TARGET = FIXTURE;

const { writeFeature } = await import(`${REPO_ROOT}/lib/feature-json.js`);
const { VisionStore } = await import(`${REPO_ROOT}/server/vision-store.js`);
const { attachVisionRoutes } = await import(`${REPO_ROOT}/server/vision-routes.js`);

function seed() {
  // FEAT-A: two completions (out of order on disk → route must sort desc).
  writeFeature(FIXTURE, {
    code: 'FEAT-A', created: '2026-05-01', phase: 'Phase 1', position: 1,
    description: 'feature a',
    completions: [
      { completion_id: 'a-old', commit_sha: 'a'.repeat(40), commit_sha_short: 'aaaaaaa',
        recorded_at: '2026-06-01T00:00:00.000Z', tests_pass: true, files_changed: ['x.js'] },
      { completion_id: 'a-new', commit_sha: 'b'.repeat(40), commit_sha_short: 'bbbbbbb',
        recorded_at: '2026-06-10T00:00:00.000Z', tests_pass: true, files_changed: ['y.js'] },
    ],
  }, 'docs/features', { validate: false });

  // FEAT-B: one completion.
  writeFeature(FIXTURE, {
    code: 'FEAT-B', created: '2026-05-01', phase: 'Phase 1', position: 2,
    description: 'feature b',
    completions: [
      { completion_id: 'b-1', commit_sha: 'c'.repeat(40), commit_sha_short: 'ccccccc',
        recorded_at: '2026-06-05T00:00:00.000Z', tests_pass: true, files_changed: ['z.js'] },
    ],
  }, 'docs/features', { validate: false });

  // FEAT-EMPTY: no completions.
  writeFeature(FIXTURE, {
    code: 'FEAT-EMPTY', created: '2026-05-01', phase: 'Phase 1', position: 3,
    description: 'feature empty', completions: [],
  }, 'docs/features', { validate: false });
}

function get(server, urlPath) {
  const port = server.address().port;
  return new Promise((res, rej) => {
    http.get({ hostname: '127.0.0.1', port, path: urlPath }, (response) => {
      let buf = '';
      response.on('data', d => buf += d);
      response.on('end', () => {
        let parsed = buf;
        try { parsed = JSON.parse(buf); } catch {}
        res({ status: response.statusCode, body: parsed });
      });
    }).on('error', rej);
  });
}

describe('GET /api/completions (PARITY-5)', () => {
  let server;

  before(() => {
    seed();
    const dataDir = join(FIXTURE, '.compose', 'data');
    mkdirSync(dataDir, { recursive: true });
    const store = new VisionStore(dataDir);
    const app = express();
    app.use(express.json());
    attachVisionRoutes(app, {
      store, scheduleBroadcast: () => {}, broadcastMessage: () => {},
      projectRoot: FIXTURE,
    });
    return new Promise(res => {
      server = http.createServer(app);
      server.listen(0, () => res());
    });
  });

  after(() => {
    server?.close();
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  test('golden: returns all completions newest-first with a count', async () => {
    const res = await get(server, '/api/completions');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 3);
    assert.equal(res.body.completions.length, 3);
    // Newest recorded_at first across all features.
    assert.equal(res.body.completions[0].completion_id, 'a-new');
    const ts = res.body.completions.map(c => Date.parse(c.recorded_at));
    assert.deepEqual(ts, [...ts].sort((a, b) => b - a));
  });

  test('feature filter scopes to one feature', async () => {
    const res = await get(server, '/api/completions?featureCode=FEAT-A');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 2);
    assert.ok(res.body.completions.every(c => c.completion_id.startsWith('a-')));
  });

  test('empty: a feature with no completions returns an empty list', async () => {
    const res = await get(server, '/api/completions?featureCode=FEAT-EMPTY');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 0);
    assert.deepEqual(res.body.completions, []);
  });

  test('unknown featureCode returns empty, not an error', async () => {
    const res = await get(server, '/api/completions?featureCode=NOPE-1');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 0);
  });

  test('limit caps the returned rows', async () => {
    const res = await get(server, '/api/completions?limit=1');
    assert.equal(res.status, 200);
    assert.equal(res.body.completions.length, 1);
    // Still the newest one.
    assert.equal(res.body.completions[0].completion_id, 'a-new');
  });

  test('rejects a path-traversal featureCode with 400', async () => {
    const res = await get(server, '/api/completions?featureCode=' + encodeURIComponent('../../../../etc'));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /invalid featureCode/i);
  });

  test('read is open: no token required', async () => {
    const prev = process.env.COMPOSE_API_TOKEN;
    process.env.COMPOSE_API_TOKEN = 'some-token';
    try {
      const res = await get(server, '/api/completions');
      assert.equal(res.status, 200);
    } finally {
      if (prev === undefined) delete process.env.COMPOSE_API_TOKEN;
      else process.env.COMPOSE_API_TOKEN = prev;
    }
  });
});
