import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'compose.js');

function project() {
  const cwd = mkdtempSync(join(tmpdir(), 'cli-rt-'));
  mkdirSync(join(cwd, 'docs', 'features', 'FOO-1'), { recursive: true });
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'),
    JSON.stringify({ version: '0.1', paths: { features: 'docs/features' } }));
  writeFileSync(join(cwd, 'docs', 'features', 'FOO-1', 'feature.json'),
    JSON.stringify({ code: 'FOO-1', description: 'x', status: 'PLANNED', phase: 'Phase 1', position: 1 }));
  return cwd;
}

function run(cwd, args) {
  try {
    return { code: 0, stdout: execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf-8' }) };
  } catch (e) {
    return { code: e.status ?? 1, stdout: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

describe('compose roadmap check (COMP-ROADMAP-RT)', () => {
  test('passes on a generated (fixed-point, lossless) roadmap', () => {
    const cwd = project();
    assert.equal(run(cwd, ['roadmap', 'generate']).code, 0);
    assert.equal(run(cwd, ['roadmap', 'check']).code, 0);
  });

  test('fails nonzero when ROADMAP has a typed code absent from feature.json', () => {
    const cwd = project();
    run(cwd, ['roadmap', 'generate']);
    const rm = join(cwd, 'ROADMAP.md');
    writeFileSync(rm, readFileSync(rm, 'utf-8') +
      '\n\n## Phase 9 — PLANNED\n\n| # | Feature | Description | Status |\n|---|---------|-------------|--------|\n| 1 | GHOST-1 | nope | PLANNED |\n');
    const r = run(cwd, ['roadmap', 'check']);
    assert.equal(r.code, 1, r.stdout);
    assert.ok(/LOSSLESS|GHOST-1|lossy|feature\.json/i.test(r.stdout), r.stdout);
  });

  test('generate is a no-op on a narrative-owned workspace — never overwrites the hand-authored ROADMAP (#39)', () => {
    const cwd = project();
    writeFileSync(join(cwd, '.compose', 'compose.json'),
      JSON.stringify({ version: '0.1', paths: { features: 'docs/features' }, roadmap: { narrative: true } }));
    const hand = '# Hand-authored\n\nCurated prose the generator would otherwise clobber.\n';
    writeFileSync(join(cwd, 'ROADMAP.md'), hand);
    const r = run(cwd, ['roadmap', 'generate']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8'), hand,
      'narrative-owned ROADMAP.md must survive `roadmap generate` byte-for-byte');
    assert.ok(/narrative-owned/i.test(r.stdout), r.stdout);
  });

  test('skips (exit 0) on a narrative-owned workspace even when ROADMAP mismatches feature.json (#39)', () => {
    const cwd = project();
    // Flag narrative-owned and hand-author a ROADMAP that does NOT match FOO-1.
    writeFileSync(join(cwd, '.compose', 'compose.json'),
      JSON.stringify({ version: '0.1', paths: { features: 'docs/features' }, roadmap: { narrative: true } }));
    writeFileSync(join(cwd, 'ROADMAP.md'), '# Hand-authored\n\nCurated prose, no feature tables.\n');
    const r = run(cwd, ['roadmap', 'check']);
    assert.equal(r.code, 0, r.stdout);
    assert.ok(/narrative-owned/i.test(r.stdout), r.stdout);
  });
});
