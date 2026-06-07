/**
 * roadmap-graph-hook.test.js (integration) — executes the reusable pre-push
 * gate template (templates/hooks/roadmap-graph-pre-push.sh) against a fixture
 * project (COMP-ROADMAP-GRAPH-1-1).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'compose.js');
const HOOK = path.join(ROOT, 'templates', 'hooks', 'roadmap-graph-pre-push.sh');

function fixtureProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-hook-'));
  fs.mkdirSync(path.join(dir, '.compose'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.compose', 'compose.json'),
    JSON.stringify({ workspaceId: 'hookproj', paths: { features: 'docs/features' } }, null, 2));
  const mk = (code, deps) => {
    const fdir = path.join(dir, 'docs', 'features', code);
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'feature.json'),
      JSON.stringify({ code, description: `${code} desc`, status: 'PLANNED', phase: 'Phase 0', position: 1 }, null, 2));
    if (deps) fs.writeFileSync(path.join(fdir, 'deps.yaml'), deps);
  };
  mk('RG-BASE-1');
  mk('RG-DEP-1', 'depends_on:\n  - RG-BASE-1\n');
  return dir;
}

function runHook(dir) {
  return spawnSync('bash', [HOOK], {
    cwd: dir,
    env: { ...process.env, COMPOSE: `node ${BIN}` },
    encoding: 'utf-8',
  });
}

function gen(dir) {
  return spawnSync('node', [BIN, 'roadmap', 'graph', '--project', dir], { encoding: 'utf-8' });
}

describe('roadmap-graph pre-push hook', () => {
  test('opt-in: no graph file → no-op exit 0', () => {
    const dir = fixtureProject();
    const r = runHook(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  test('fresh graph → exit 0', () => {
    const dir = fixtureProject();
    assert.equal(gen(dir).status, 0);
    const r = runHook(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  test('stale graph (hand-edited) → blocks (exit 1)', () => {
    const dir = fixtureProject();
    gen(dir);
    fs.appendFileSync(path.join(dir, 'roadmap-graph.html'), '\n<!-- hand edit -->\n');
    const r = runHook(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /stale|aborted/i);
  });

  test('dangling edge with a graph present → blocks (exit 1)', () => {
    const dir = fixtureProject();
    gen(dir);
    fs.writeFileSync(path.join(dir, 'docs', 'features', 'RG-DEP-1', 'deps.yaml'),
      'depends_on:\n  - RG-BASE-1\n  - RG-GHOST-9\n');
    const r = runHook(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /dangling|aborted/i);
  });

  test('source-safe: sourcing defines the function without exiting the caller', () => {
    const dir = fixtureProject();
    gen(dir);
    // A caller that sources the hook, then keeps running and calls the gate.
    const script = `set -e\nsource "${HOOK}"\necho "AFTER_SOURCE"\nroadmap_graph_gate && echo "GATE_OK"\n`;
    const r = spawnSync('bash', ['-c', script], {
      cwd: dir, env: { ...process.env, COMPOSE: `node ${BIN}` }, encoding: 'utf-8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /AFTER_SOURCE/, 'sourcing did not terminate the caller shell');
    assert.match(r.stdout, /GATE_OK/);
  });
});
