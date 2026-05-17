/**
 * xref-golden-flow.test.js — COMP-MCP-XREF-VALIDATE #16 (T010/T018).
 * Golden flow per spec §7 against the REAL validateProject; GitHub via an
 * injectable transport stub (deterministic, no live network/token).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { validateProject } from '../lib/feature-validator.js';

function roadmapFixture(rows) {
  return [
    '# Roadmap', '', '## Phase 1: X', '',
    '| # | Feature | Description | Status |',
    '|---|---------|-------------|--------|',
    ...rows,
  ].join('\n');
}

function cwdWith(roadmap) {
  const cwd = mkdtempSync(join(tmpdir(), 'xref-gf-'));
  mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
  writeFileSync(join(cwd, 'ROADMAP.md'), roadmap);
  return cwd;
}

const stubTransport = (status, body) => ({
  async request() { return { status, body, headers: new Map() }; },
});
const xrefFindings = (r) => r.findings.filter((f) => f.kind && f.kind.startsWith('XREF_'));
const auth = { token: 'test-token' };

describe('xref golden flow (spec §7)', () => {
  test('aligned: issue closed, expect=closed → no XREF_DRIFT', async () => {
    const cwd = cwdWith(roadmapFixture([
      '| 1 | XR-GF-1 | ships it <!-- xref: github smartmemory/compose#7 expect=closed --> | COMPLETE |',
    ]));
    const r = await validateProject(cwd, {
      external: true, githubAuth: auth, githubTransport: stubTransport(200, { state: 'closed' }),
    });
    assert.equal(xrefFindings(r).filter((f) => f.kind === 'XREF_DRIFT').length, 0);
    rmSync(cwd, { recursive: true, force: true });
  });

  test('flipped: issue open, expect=closed → exactly one XREF_DRIFT (warning)', async () => {
    const cwd = cwdWith(roadmapFixture([
      '| 1 | XR-GF-1 | ships it <!-- xref: github smartmemory/compose#7 expect=closed --> | COMPLETE |',
    ]));
    const r = await validateProject(cwd, {
      external: true, githubAuth: auth, githubTransport: stubTransport(200, { state: 'open' }),
    });
    const drift = xrefFindings(r).filter((f) => f.kind === 'XREF_DRIFT');
    assert.equal(drift.length, 1);
    assert.equal(drift[0].severity, 'warning');
    assert.ok(/XR-GF-1|smartmemory\/compose#7/.test(drift[0].detail));
    rmSync(cwd, { recursive: true, force: true });
  });

  test('degrade: no token → XREF_RESOLUTION_SKIPPED (warning), no error-severity xref', async () => {
    const prev = process.env.GITHUB_TOKEN; delete process.env.GITHUB_TOKEN;
    const cwd = cwdWith(roadmapFixture([
      '| 1 | XR-GF-1 | x <!-- xref: github smartmemory/compose#7 expect=closed --> | COMPLETE |',
    ]));
    const r = await validateProject(cwd, { external: true, githubAuth: { tokenEnv: 'GITHUB_TOKEN', _noGhFallback: true } });
    const xr = xrefFindings(r);
    assert.ok(xr.some((f) => f.kind === 'XREF_RESOLUTION_SKIPPED' && f.severity === 'warning'));
    assert.equal(xr.filter((f) => f.severity === 'error').length, 0);
    if (prev !== undefined) process.env.GITHUB_TOKEN = prev;
    rmSync(cwd, { recursive: true, force: true });
  });

  test('anonymous row: no feature code → finding located by row position + excerpt', async () => {
    const cwd = cwdWith(roadmapFixture([
      '| — | — | strategic note <!-- xref: github smartmemory/compose#7 expect=closed --> | PLANNED |',
    ]));
    const r = await validateProject(cwd, {
      external: true, githubAuth: auth, githubTransport: stubTransport(200, { state: 'open' }),
    });
    const drift = xrefFindings(r).filter((f) => f.kind === 'XREF_DRIFT');
    assert.equal(drift.length, 1);
    assert.equal(drift[0].feature_code, undefined);
    assert.ok(/row #\d+/.test(drift[0].detail));
    assert.ok(/strategic note/.test(drift[0].detail), 'locator includes the row description excerpt');
    rmSync(cwd, { recursive: true, force: true });
  });

  test('#15-independence: gate OFF → github ref emits only XREF_RESOLUTION_SKIPPED, no network', async () => {
    let called = false;
    const cwd = cwdWith(roadmapFixture([
      '| 1 | XR-GF-1 | x <!-- xref: github smartmemory/compose#7 expect=closed --> | COMPLETE |',
    ]));
    const r = await validateProject(cwd, {
      external: false, githubAuth: auth,
      githubTransport: { async request() { called = true; return { status: 200, body: {} }; } },
    });
    const xr = xrefFindings(r);
    assert.equal(called, false, 'no network call when gate off');
    assert.ok(xr.some((f) => f.kind === 'XREF_RESOLUTION_SKIPPED'));
    assert.equal(xr.filter((f) => f.kind === 'XREF_DRIFT').length, 0);
    rmSync(cwd, { recursive: true, force: true });
  });
});
