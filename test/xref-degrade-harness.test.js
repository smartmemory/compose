/**
 * xref-degrade-harness.test.js — COMP-MCP-XREF-VALIDATE #16 (T009/T019).
 * Table-driven harness over the spec §6 degrade matrix against the REAL
 * validateProject. Asserts XREF_RESOLUTION_SKIPPED is never error / never
 * aborts, per-ref isolation, and rate-limit short-circuit.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { validateProject } from '../lib/feature-validator.js';

function cwdWith(rows) {
  const cwd = mkdtempSync(join(tmpdir(), 'xref-dh-'));
  mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
  writeFileSync(join(cwd, 'ROADMAP.md'), [
    '# R', '', '## Phase 1: X', '',
    '| # | Feature | Description | Status |',
    '|---|---------|-------------|--------|',
    ...rows,
  ].join('\n'));
  return cwd;
}
const xr = (r) => r.findings.filter((f) => f.kind && f.kind.startsWith('XREF_'));
const auth = { token: 't' };
const ONE = ['| 1 | XR-DH-1 | a <!-- xref: github smartmemory/compose#7 expect=closed --> | COMPLETE |'];

describe('xref degrade matrix (spec §6)', () => {
  test('offline / fetch reject → per-ref XREF_RESOLUTION_SKIPPED (warning), run continues', async () => {
    const cwd = cwdWith(ONE);
    const r = await validateProject(cwd, {
      external: true, githubAuth: auth,
      githubTransport: { async request() { throw new Error('ENOTFOUND api.github.com'); } },
    });
    const f = xr(r);
    assert.ok(f.some((x) => x.kind === 'XREF_RESOLUTION_SKIPPED' && x.severity === 'warning'));
    assert.equal(f.filter((x) => x.severity === 'error').length, 0);
    assert.equal(r.scope, 'project'); // run completed, did not abort
    rmSync(cwd, { recursive: true, force: true });
  });

  test('HTTP ≥500 → per-ref XREF_RESOLUTION_SKIPPED (warning), continue', async () => {
    const cwd = cwdWith(ONE);
    const r = await validateProject(cwd, {
      external: true, githubAuth: auth,
      githubTransport: { async request() { return { status: 503, body: {}, headers: new Map() }; } },
    });
    const f = xr(r);
    assert.ok(f.some((x) => x.kind === 'XREF_RESOLUTION_SKIPPED' && x.severity === 'warning'));
    assert.equal(f.filter((x) => x.severity === 'error').length, 0);
    rmSync(cwd, { recursive: true, force: true });
  });

  test('HTTP 404 → XREF_TARGET_MISSING (error) — real drift, not a degrade', async () => {
    const cwd = cwdWith(ONE);
    const r = await validateProject(cwd, {
      external: true, githubAuth: auth,
      githubTransport: { async request() { return { status: 404, body: { message: 'Not Found' }, headers: new Map() }; } },
    });
    const tm = xr(r).filter((x) => x.kind === 'XREF_TARGET_MISSING');
    assert.equal(tm.length, 1);
    assert.equal(tm[0].severity, 'error');
    rmSync(cwd, { recursive: true, force: true });
  });

  test('no token → ONE aggregate XREF_RESOLUTION_SKIPPED (warning), never error', async () => {
    const prev = process.env.GITHUB_TOKEN; delete process.env.GITHUB_TOKEN;
    const cwd = cwdWith([
      '| 1 | XR-DH-1 | a <!-- xref: github o/n#1 expect=closed --> | COMPLETE |',
      '| 2 | XR-DH-2 | b <!-- xref: github o/n#2 expect=closed --> | COMPLETE |',
    ]);
    const r = await validateProject(cwd, { external: true, githubAuth: { tokenEnv: 'GITHUB_TOKEN', _noGhFallback: true } });
    const skipped = xr(r).filter((x) => x.kind === 'XREF_RESOLUTION_SKIPPED');
    // Exactly ONE aggregate skip for the whole github batch — no per-ref
    // double-counting, no wrong "rate-limited" reason string.
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].severity, 'warning');
    assert.match(skipped[0].detail, /no GitHub token/);
    assert.ok(!skipped.some((x) => /rate.?limit/i.test(x.detail)), 'no bogus rate-limit reason on no-token path');
    if (prev !== undefined) process.env.GITHUB_TOKEN = prev;
    rmSync(cwd, { recursive: true, force: true });
  });

  test('rate-limit → aggregate warning + short-circuit remaining github; local still resolves', async () => {
    const cwd = cwdWith([
      '| 1 | XR-DH-1 | a <!-- xref: github o/n#1 expect=closed --> | COMPLETE |',
      '| 2 | XR-DH-2 | b <!-- xref: github o/n#2 expect=closed --> | COMPLETE |',
      '| 3 | XR-DH-3 | c <!-- xref: url https://x.example/s --> | PLANNED |',
    ]);
    let calls = 0;
    const r = await validateProject(cwd, {
      external: true, githubAuth: auth,
      githubTransport: {
        async request() { calls += 1; const e = new Error('rate limited'); e.rateLimit = { resetMs: 1000 }; throw e; },
      },
    });
    const f = xr(r);
    const skipped = f.filter((x) => x.kind === 'XREF_RESOLUTION_SKIPPED');
    // Exactly ONE aggregate rate-limit skip — second github ref short-
    // circuited SILENTLY, no extra per-ref warning.
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].severity, 'warning');
    assert.match(skipped[0].detail, /rate-limited/);
    assert.equal(f.filter((x) => x.severity === 'error').length, 0);
    // url-class ref still resolved despite github short-circuit
    assert.ok(f.some((x) => x.kind === 'XREF_URL_UNCHECKED'));
    assert.ok(calls <= 1, 'github short-circuited after first rate-limit');
    rmSync(cwd, { recursive: true, force: true });
  });

  test('per-ref isolation: one bad github ref does not poison a sibling url ref', async () => {
    const cwd = cwdWith([
      '| 1 | XR-DH-1 | a <!-- xref: github o/n#1 expect=closed --> | COMPLETE |',
      '| 2 | XR-DH-2 | b <!-- xref: url https://x.example/ok --> | PLANNED |',
    ]);
    const r = await validateProject(cwd, {
      external: true, githubAuth: auth,
      githubTransport: { async request() { return { status: 503, body: {}, headers: new Map() }; } },
    });
    const f = xr(r);
    assert.ok(f.some((x) => x.kind === 'XREF_RESOLUTION_SKIPPED'));
    assert.ok(f.some((x) => x.kind === 'XREF_URL_UNCHECKED'));
    rmSync(cwd, { recursive: true, force: true });
  });
});
