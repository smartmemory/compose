/**
 * COMP-MCP-FOLLOWUP-1-1 — eager boot-time preload of the propose_followup
 * deferred-import path.
 *
 * COMP-MCP-FOLLOWUP-1 added a runtime stale-server hint + a CI import-graph test,
 * but a genuinely-broken on-disk export still surfaced only on the *first*
 * propose_followup call (the writer is lazily imported). These tests cover the
 * complementary hardening: the MCP server eager-imports that module at boot and
 * fails fast (stderr + exit 1) if it is missing or its export is gone.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { preloadEagerModules, EAGER_PRELOAD_MODULES } from '../server/compose-mcp-tools.js';

const ROOT       = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SERVER = join(ROOT, 'server', 'compose-mcp.js');

describe('eager preload helper (COMP-MCP-FOLLOWUP-1-1)', () => {
  test('default preloadEagerModules() resolves and loads followup-writer with proposeFollowup', async () => {
    const loaded = await preloadEagerModules();
    const mod = loaded['../lib/followup-writer.js'];
    assert.ok(mod, 'followup-writer module returned');
    assert.equal(typeof mod.proposeFollowup, 'function');
  });

  test('default preload set is exactly the genuinely-deferred module', () => {
    assert.deepEqual(
      EAGER_PRELOAD_MODULES.map((m) => m.specifier),
      ['../lib/followup-writer.js'],
    );
  });

  test('rejects, naming the offender, when a module is missing', async () => {
    await assert.rejects(
      () => preloadEagerModules([{ specifier: '../lib/__nope_preload__.js' }]),
      /__nope_preload__\.js/,
    );
  });

  test('rejects, naming the offender, when the expected export is absent', async () => {
    // project-paths.js loads fine but does not export `proposeFollowup`.
    // `await import()` would NOT throw here (yields undefined) — the binding
    // assertion is what makes a missing export fail fast.
    await assert.rejects(
      () => preloadEagerModules([{ specifier: '../lib/project-paths.js', expect: 'proposeFollowup' }]),
      /project-paths\.js[\s\S]*proposeFollowup/,
    );
  });
});

function spawnServer(extraEnv) {
  return spawn('node', [MCP_SERVER], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('eager preload boot wiring (COMP-MCP-FOLLOWUP-1-1)', () => {
  test('negative: a bogus COMPOSE_PRELOAD_PROBE aborts boot with stderr + exit 1', async () => {
    const proc = spawnServer({ COMPOSE_PRELOAD_PROBE: '../lib/__nope_boot_probe__.js' });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    const code = await new Promise((res) => proc.on('exit', (c) => res(c)));
    assert.equal(code, 1, 'server exits non-zero when boot preload fails');
    assert.match(stderr, /boot aborted/i);
    assert.match(stderr, /__nope_boot_probe__\.js/);
  });

  test('negative: a COMPOSE_PRELOAD_PROBE with a missing export aborts boot (proves boot applies the export assertion)', async () => {
    const proc = spawnServer({ COMPOSE_PRELOAD_PROBE: '../lib/project-paths.js#proposeFollowup' });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    const code = await new Promise((res) => proc.on('exit', (c) => res(c)));
    assert.equal(code, 1, 'server exits non-zero when a boot-preloaded export is absent');
    assert.match(stderr, /boot aborted/i);
    assert.match(stderr, /project-paths\.js/);
    assert.match(stderr, /proposeFollowup/);
  });

  test('positive: a healthy server boots past preload and answers initialize', async () => {
    const proc = spawnServer({});
    const exited = new Promise((res) => proc.on('exit', () => res('exited')));
    const responded = new Promise((res) => proc.stdout.once('data', () => res('responded')));
    const timedOut = new Promise((res) => setTimeout(() => res('timeout'), 8000));
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    }) + '\n');
    const winner = await Promise.race([responded, exited, timedOut]);
    proc.kill();
    assert.equal(winner, 'responded', 'server stayed up past preload and answered initialize');
  });
});
