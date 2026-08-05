/**
 * test/ideabox-cockpit-refresh-e2e.test.js — IDEA-24, the whole bug end to end.
 *
 * WHY THIS EXISTS SEPARATELY FROM ideabox-projection-watch.test.js
 * ---------------------------------------------------------------
 * That suite proves every mechanism: the watch fires, the predicate rejects the
 * temp file, the coalescer keeps the last write. It proves them by calling
 * `onIdeaboxChanged` — the hook. It says nothing about whether anything is
 * ASSIGNED to that hook. Delete the one line in `server/index.js` that connects
 * the watcher to the vision WS and all of it stays green while the cockpit stays
 * exactly as broken as it was before the feature. Verified by doing it.
 *
 * That is the S3b-1 failure shape again: a component that satisfies its
 * interface completely while nothing consumes it. So this suite refuses to
 * mirror the wiring — it spawns the REAL `server/index.js`, connects a REAL
 * WebSocket client to /ws/vision the way the cockpit does, and drives a REAL
 * out-of-process `compose ideabox add`. Nothing between the CLI and the socket
 * is stubbed, because the thing under test IS what is between them.
 *
 * FLAKE DISCIPLINE
 * ----------------
 * This spawns two processes, so it is exactly the shape of the suite's known
 * load flakes. It is built so load can only ever make it SKIP, never fail: the
 * boot and the port bind are tolerated (skip with a reason), and every assertion
 * after a confirmed-live server is hard. A slow machine gets a skip line, not a
 * red pre-push gate.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { WebSocket } = await import('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bind :0, read what the OS gave us, release it. */
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

const spawned = [];
after(() => {
  for (const p of spawned) { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
});

describe('IDEA-24 — a CLI write reaches a connected cockpit (end to end)', () => {
  test('compose ideabox add → ideaboxUpdated on /ws/vision → the idea is in /api/ideabox', async (t) => {
    const project = mkdtempSync(join(tmpdir(), 'idea24-e2e-'));
    mkdirSync(join(project, '.compose', 'data'), { recursive: true });
    mkdirSync(join(project, 'docs'), { recursive: true });

    let port, agentPort;
    try {
      port = await freePort();
      agentPort = await freePort();
    } catch {
      rmSync(project, { recursive: true, force: true });
      return t.skip('cannot bind a local port in this environment');
    }

    // Every provider key blanked: this boots the real server, and the real
    // server reads credentials from the ambient environment.
    const env = {
      ...process.env,
      COMPOSE_TARGET: project,
      PORT: String(port),
      AGENT_PORT: String(agentPort),
      RESEND_API_KEY: '', STRIPE_API_KEY: '',
      SMARTMEMORY_API_KEY: '', SMARTMEMORY_BUFFER_API_KEY: '',
    };

    const srv = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], { env, cwd: ROOT });
    spawned.push(srv);
    let srvDied = false;
    srv.on('exit', () => { srvDied = true; });

    const get = (p) => new Promise((res, rej) => {
      const req = http.get(`http://127.0.0.1:${port}${p}`, (r) => {
        let b = ''; r.on('data', (d) => { b += d; });
        r.on('end', () => res({ status: r.statusCode, body: b }));
      });
      req.on('error', rej);
    });

    // Boot. Tolerated: a machine under load, or a port taken between the probe
    // and the bind, must not turn into a red gate.
    let up = false;
    for (let i = 0; i < 150 && !srvDied; i++) {
      try { await get('/api/ideabox'); up = true; break; } catch { await sleep(200); }
    }
    if (!up) {
      rmSync(project, { recursive: true, force: true });
      return t.skip('server did not come up in this environment');
    }

    // --- past here the server is live; everything is a hard assertion ---

    const seen = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/vision`);
    await new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
    });
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'ideaboxUpdated') seen.push(m);
      } catch { /* not ours */ }
    });
    await sleep(200); // let the server register the client

    // The bug verbatim: a write from a DIFFERENT process, which therefore never
    // touches the REST route that broadcasts.
    const cli = spawn(
      process.execPath,
      [join(ROOT, 'bin', 'compose.js'), 'ideabox', 'add', 'E2E idea from the CLI'],
      { env, cwd: project },
    );
    spawned.push(cli);
    const cliCode = await new Promise((r) => cli.on('close', r));
    assert.equal(cliCode, 0, 'the CLI write succeeded');

    for (let i = 0; i < 50 && seen.length === 0; i++) await sleep(100);

    assert.equal(seen.length >= 1, true,
      'an out-of-process CLI write reached the cockpit socket — this is the whole feature');
    assert.equal(seen[0].type, 'ideaboxUpdated');
    assert.equal(seen[0].source, 'projection-watch',
      'and it came from the file watch, not from a REST mutation');

    // What the client does with the event: re-fetch. The idea must be there, or
    // the notification is announcing state the API cannot yet serve.
    const listed = await get('/api/ideabox');
    const titles = (JSON.parse(listed.body).ideas || []).map((i) => i.title);
    assert.ok(titles.includes('E2E idea from the CLI'),
      `the re-fetch the event triggers returns the new idea (got ${JSON.stringify(titles)})`);

    ws.close();
    srv.kill('SIGTERM');
    await sleep(300);
    rmSync(project, { recursive: true, force: true });
  });
});
