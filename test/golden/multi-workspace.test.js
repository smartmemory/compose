/**
 * Golden flow for COMP-WORKSPACE-ID.
 *
 * Verifies that compose CLI correctly disambiguates parent vs child workspaces
 * via --workspace, COMPOSE_TARGET, and emits a structured ambiguity error
 * when neither is supplied.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_BIN = join(__dirname, '..', '..', 'bin', 'compose.js');

function makeWorkspace(root, { workspaceId } = {}) {
  mkdirSync(join(root, '.compose'), { recursive: true });
  if (workspaceId) {
    writeFileSync(
      join(root, '.compose', 'compose.json'),
      JSON.stringify({ version: 1, workspaceId }),
    );
  }
}

function runCompose(args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  // Strip COMPOSE_TARGET unless caller set it explicitly — we don't want host
  // env leaking into the fixture invocations.
  if (!opts.env || !('COMPOSE_TARGET' in opts.env)) delete env.COMPOSE_TARGET;
  const res = spawnSync('node', [COMPOSE_BIN, ...args], {
    cwd: opts.cwd,
    env,
    encoding: 'utf-8',
    timeout: 15000,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

describe('golden: multi-workspace disambiguation', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'compose-golden-ws-'));
    // Topology mirrors forge-top + compose: parent workspace + nested child
    makeWorkspace(dir, { workspaceId: 'parent-ws' });
    const child = join(dir, 'child');
    mkdirSync(child, { recursive: true });
    makeWorkspace(child, { workspaceId: 'child-ws' });
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('ambiguous tree without --workspace exits 1 with candidate list', () => {
    const r = runCompose(['roadmap'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Multiple workspaces match cwd/);
    assert.match(r.stderr, /--workspace=parent-ws/);
    assert.match(r.stderr, /--workspace=child-ws/);
  });

  test('--workspace=child-ws routes operations to child workspace', () => {
    // Use `compose feature` which writes into <root>/docs/features/<code>/
    const r = runCompose(['feature', 'COMP-GOLDEN-1', 'golden flow fixture', '--workspace=child-ws'], { cwd: dir });
    // Either exit 0 with success, or exit non-zero for unrelated reasons; what
    // we care about is that it NEVER touched parent-ws's docs/features/.
    const childFeature = join(dir, 'child', 'docs', 'features', 'COMP-GOLDEN-1');
    const parentFeature = join(dir, 'docs', 'features', 'COMP-GOLDEN-1');
    assert.ok(existsSync(childFeature), `expected ${childFeature} to exist after --workspace=child-ws (status=${r.status} stderr=${r.stderr})`);
    assert.ok(!existsSync(parentFeature), 'parent workspace should not have been touched');
  });

  test('COMPOSE_TARGET=<absolute path> bypasses discovery and routes correctly', () => {
    const child = join(dir, 'child');
    const r = runCompose(['feature', 'COMP-GOLDEN-2', 'golden flow fixture'], {
      cwd: dir,
      env: { COMPOSE_TARGET: child },
    });
    const childFeature = join(dir, 'child', 'docs', 'features', 'COMP-GOLDEN-2');
    assert.ok(existsSync(childFeature), `expected ${childFeature} after COMPOSE_TARGET (status=${r.status} stderr=${r.stderr})`);
  });
});
