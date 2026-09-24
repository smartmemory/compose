import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { runBuildWithAgentFactory, runGsdWithAgentFactory } from './helpers/ts-agent-harness.js';

const execFileAsync = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Include the directory itself: a transient lock/tmp create+unlink changes its
// mtime even if no extra entry survives.
function snapshot(root) {
  if (!existsSync(root)) return null;
  const entries = {};
  function visit(relative) {
    const path = join(root, relative);
    const stat = lstatSync(path, { bigint: true });
    entries[relative] = {
      mode: String(stat.mode), size: String(stat.size),
      mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      ...(stat.isFile() ? { sha256: createHash('sha256').update(readFileSync(path)).digest('hex') } : {}),
    };
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(relative, name));
    }
  }
  visit('.');
  return entries;
}

test('GSD budget golden leaves decoy home and inherited flow store unchanged without preload', async () => {
  const decoy = mkdtempSync(join(tmpdir(), 'compose-inherited-flows-'));
  const decoyHome = mkdtempSync(join(tmpdir(), 'compose-decoy-home-'));
  const inheritedBefore = snapshot(decoy);
  const childEnv = {
    ...process.env, NODE_OPTIONS: '', STRATUM_STATE_ROOT: decoy,
    HOME: decoyHome, USERPROFILE: decoyHome,
  };
  // Start an independent runner, not a worker on the parent's binary IPC channel.
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    // Deliberately omit --import: the harness must isolate independently of the
    // process-wide safeguard. A decoy HOME catches a harness that ignores
    // STRATUM_STATE_ROOT: homedir() resolves to it instead of the real home.
    const { stdout } = await execFileAsync(process.execPath, [
      '--test', '--test-timeout=420000', 'test/gsd-budget-terminal-golden.test.js',
    ], {
      cwd: repo,
      env: childEnv,
      timeout: 420000, maxBuffer: 8 * 1024 * 1024,
    });
    assert.match(stdout, /# pass 1\b/, stdout);
    assert.match(stdout, /# fail 0\b/, stdout);
  } finally {
    try {
      assert.deepEqual(snapshot(decoy), inheritedBefore,
        'STRATUM STORE LEAK: harness wrote to the inherited root instead of its own store');
      assert.equal(existsSync(join(decoyHome, '.stratum')), false,
        'STRATUM STORE LEAK: harness wrote to the decoy home instead of its own store');
    } finally {
      rmSync(decoy, { recursive: true, force: true });
      rmSync(decoyHome, { recursive: true, force: true });
    }
  }
});

test('preload replaces inherited state root and removes its store on process exit', async () => {
  const inheritedRoot = join(tmpdir(), 'compose-unused-inherited-flows');
  const { stdout } = await execFileAsync(process.execPath, [
    '--import', './test/suppress-expected-drift.js', '--input-type=module', '-e',
    "console.log(process.env.STRATUM_STATE_ROOT)",
  ], { cwd: repo, env: { ...process.env, STRATUM_STATE_ROOT: inheritedRoot } });
  const root = stdout.trim();
  assert.ok(root.includes('compose-test-flows-'), root);
  assert.notEqual(root, inheritedRoot);
  assert.equal(existsSync(root), false, 'preload must clean up its own store');
});

for (const [name, harness] of [['build', runBuildWithAgentFactory], ['gsd', runGsdWithAgentFactory]]) {
  test(`${name} harness uses distinct stores and cleans up on success and failure`, async (t) => {
    const roots = [];
    const original = StratumMcpClient.prototype.connect;
    t.mock.method(StratumMcpClient.prototype, 'connect', async function (options) {
      roots.push(options.env.STRATUM_STATE_ROOT);
      assert.notEqual(roots.at(-1), process.env.STRATUM_STATE_ROOT);
      assert.ok(existsSync(roots.at(-1)));
      return original.call(this, options);
    });
    // Also cover the no-factory path; it must never fall back to a default store.
    assert.equal(await harness(async (_feature, { stratum }) => {
      assert.equal(await stratum.hasTool('stratum_plan'), true);
      return 'ok';
    }, 'ISOLATION', { cwd: repo }), 'ok');
    await assert.rejects(harness(async () => { throw new Error('fixture failure'); },
      'ISOLATION', { cwd: repo, connectorFactory: () => ({}) }), /fixture failure/);
    assert.equal(new Set(roots).size, 2);
    for (const root of roots) assert.equal(existsSync(root), false, `store not cleaned: ${root}`);
  });
}
