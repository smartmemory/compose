/**
 * roadmap-graph.test.js (integration) — exercises the `compose roadmap graph`
 * CLI subcommand (spawned) and the roadmap_graph / roadmap_graph_check MCP tool
 * handlers end-to-end against a seeded fixture project (COMP-ROADMAP-GRAPH-1).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'compose.js');

function fixtureProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-int-'));
  fs.mkdirSync(path.join(dir, '.compose'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.compose', 'compose.json'),
    JSON.stringify({ workspaceId: 'fixtureproj', paths: { features: 'docs/features' } }, null, 2));
  const mk = (code, status, deps) => {
    const fdir = path.join(dir, 'docs', 'features', code);
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'feature.json'),
      JSON.stringify({ code, description: `${code} desc`, status, phase: 'Phase 0', position: 1 }, null, 2));
    if (deps) fs.writeFileSync(path.join(fdir, 'deps.yaml'), deps);
  };
  mk('RG-BASE-1', 'PLANNED');
  mk('RG-DEP-1', 'PLANNED', 'depends_on:\n  - RG-BASE-1\n');
  mk('RG-DONE-1', 'COMPLETE');
  return dir;
}

function runCli(dir, extra = []) {
  return spawnSync('node', [BIN, 'roadmap', 'graph', '--project', dir, ...extra],
    { encoding: 'utf-8' });
}

describe('CLI: compose roadmap graph', () => {
  test('generates HTML with nodes + edge; drops COMPLETE; exit 0', () => {
    const dir = fixtureProject();
    const r = runCli(dir);
    assert.equal(r.status, 0, r.stderr);
    const out = path.join(dir, 'roadmap-graph.html');
    assert.ok(fs.existsSync(out));
    const html = fs.readFileSync(out, 'utf-8');
    assert.ok(html.includes('"id": "RG-BASE-1"'));
    assert.ok(html.includes('"id": "RG-DEP-1"'));
    assert.ok(!html.includes('"id": "RG-DONE-1"'), 'COMPLETE node dropped');
    assert.ok(html.includes('"source": "RG-BASE-1"') && html.includes('"target": "RG-DEP-1"'));
    assert.match(r.stdout, /2 nodes, 1 edges/);
  });

  test('--check exits 0 when fresh, 1 after tamper', () => {
    const dir = fixtureProject();
    assert.equal(runCli(dir).status, 0);
    assert.equal(runCli(dir, ['--check']).status, 0);
    fs.appendFileSync(path.join(dir, 'roadmap-graph.html'), '\n<!-- x -->\n');
    const chk = runCli(dir, ['--check']);
    assert.equal(chk.status, 1);
    assert.match(chk.stderr, /stale/);
  });

  test('refuses (exit 1) on a dangling deps.yaml edge', () => {
    const dir = fixtureProject();
    fs.writeFileSync(path.join(dir, 'docs', 'features', 'RG-DEP-1', 'deps.yaml'),
      'depends_on:\n  - RG-BASE-1\n  - RG-GHOST-9\n');
    const r = runCli(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /dangling/i);
    assert.match(r.stderr, /RG-GHOST-9/);
  });

  test('--out honors a custom path', () => {
    const dir = fixtureProject();
    const r = runCli(dir, ['--out', 'docs/custom-graph.html']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'docs', 'custom-graph.html')));
  });
});

describe('MCP: roadmap_graph / roadmap_graph_check', () => {
  test('toolRoadmapGraph returns a small summary (no HTML body)', async () => {
    const { toolRoadmapGraph } = await import('../../server/compose-mcp-tools.js');
    const dir = fixtureProject();
    const res = await toolRoadmapGraph({ project: dir });
    assert.equal(res.nodeCount, 2);
    assert.equal(res.edgeCount, 1);
    assert.equal(res.droppedCount, 1);
    assert.ok(res.path.endsWith('roadmap-graph.html'));
    // summary must not carry the HTML body
    assert.ok(!('html' in res));
    assert.ok(JSON.stringify(res).length < 2000);
  });

  test('toolRoadmapGraphCheck reports matches after generate', async () => {
    const { toolRoadmapGraph, toolRoadmapGraphCheck } = await import('../../server/compose-mcp-tools.js');
    const dir = fixtureProject();
    await toolRoadmapGraph({ project: dir });
    const chk = await toolRoadmapGraphCheck({ project: dir });
    assert.equal(chk.matches, true);
    assert.equal(chk.exists, true);
  });

  test('toolRoadmapGraph throws DANGLING_EDGE on a bad edge', async () => {
    const { toolRoadmapGraph } = await import('../../server/compose-mcp-tools.js');
    const dir = fixtureProject();
    fs.writeFileSync(path.join(dir, 'docs', 'features', 'RG-DEP-1', 'deps.yaml'),
      'depends_on:\n  - RG-NOPE-1\n');
    await assert.rejects(() => toolRoadmapGraph({ project: dir }), (e) => e.code === 'DANGLING_EDGE');
  });
});
