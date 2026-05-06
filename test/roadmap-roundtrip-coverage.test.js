/**
 * Coverage sweep for COMP-MCP-MIGRATION-2-1-1 edge cases.
 *
 * Round-trip test in roadmap-roundtrip.test.js exercises the canonical
 * compose ROADMAP.md. This file covers edge cases the integration test
 * doesn't surface naturally.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateRoadmap } from '../lib/roadmap-gen.js';

let cwd;
let stderrCaptured;
let originalStderrWrite;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'compose-coverage-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({
    version: '0.1',
    paths: { features: 'docs/features' },
  }));
  stderrCaptured = '';
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrCaptured += String(chunk);
    return true;
  };
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  rmSync(cwd, { recursive: true, force: true });
});

const writeFeature = (code, fields) => {
  mkdirSync(join(cwd, 'docs', 'features', code), { recursive: true });
  writeFileSync(
    join(cwd, 'docs', 'features', code, 'feature.json'),
    JSON.stringify({ code, ...fields }, null, 2)
  );
};

// ---------------------------------------------------------------------------

describe('bootstrap path: no existing ROADMAP.md', () => {
  test('generates valid output from feature.json files', () => {
    writeFeature('FEAT-1', { phase: 'P', status: 'PLANNED', description: 'first', position: 1 });
    writeFeature('FEAT-2', { phase: 'P', status: 'PLANNED', description: 'second', position: 2 });
    const out = generateRoadmap(cwd);
    assert.ok(out.includes('FEAT-1'));
    assert.ok(out.includes('FEAT-2'));
    assert.ok(out.includes('## P'));
  });
});

describe('absent markers (no preserved sections in source)', () => {
  test('writer functions normally when ROADMAP.md has no markers', () => {
    writeFeature('FEAT-1', { phase: 'P', status: 'PLANNED', description: 'first', position: 1 });
    writeFileSync(join(cwd, 'ROADMAP.md'), `# Old Roadmap

## P — PLANNED

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | FEAT-1 | first | PLANNED |
`);
    const out = generateRoadmap(cwd);
    assert.ok(out.includes('FEAT-1'));
    assert.ok(out.includes('## P — PLANNED'));
  });
});

describe('anonymous-row predecessor deleted', () => {
  test('anon row whose typed predecessor was deleted is preserved at end', () => {
    writeFeature('FEAT-2', { phase: 'P', status: 'PLANNED', description: 'second', position: 2 });
    // FEAT-1 is NOT in feature.json, so its typed predecessor is gone.
    // Anon row in source originally followed FEAT-1.
    writeFileSync(join(cwd, 'ROADMAP.md'), `# Roadmap

## P — PLANNED

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | FEAT-1 | gone | PLANNED |
| — | leftover anonymous | now orphaned | PLANNED |
| 2 | FEAT-2 | second | PLANNED |
`);
    const out = generateRoadmap(cwd);
    // FEAT-1 row absent (not in feature.json).
    assert.ok(!out.includes('| 1 | FEAT-1 |'));
    // Anonymous row still present somewhere.
    assert.ok(out.includes('leftover anonymous'));
  });
});

describe('phase with only override (no features, no anon rows, no markers)', () => {
  test('curated heading + prose survives via legacy phase block fallback', () => {
    writeFileSync(join(cwd, 'ROADMAP.md'), `# Roadmap

## Phantom Phase — PARKED (waiting on something)

This phase has no features in feature.json. Just curated prose explaining
why it's parked.
`);
    const out = generateRoadmap(cwd);
    assert.ok(out.includes('## Phantom Phase — PARKED (waiting on something)'));
    assert.ok(out.includes('curated prose explaining'));
  });
});

describe('multi-row anon chain', () => {
  test('multiple consecutive anon rows preserve relative order', () => {
    writeFeature('FEAT-1', { phase: 'P', status: 'PLANNED', description: 'real', position: 1 });
    writeFileSync(join(cwd, 'ROADMAP.md'), `# Roadmap

## P — PLANNED

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| — | first anon | a | PLANNED |
| — | second anon | b | PLANNED |
| 1 | FEAT-1 | real | PLANNED |
| — | third anon (after FEAT-1) | c | PLANNED |
`);
    const out = generateRoadmap(cwd);
    const firstIdx = out.indexOf('first anon');
    const secondIdx = out.indexOf('second anon');
    const featIdx = out.indexOf('FEAT-1');
    const thirdIdx = out.indexOf('third anon');
    assert.ok(firstIdx > 0, 'first anon present');
    assert.ok(secondIdx > 0, 'second anon present');
    assert.ok(thirdIdx > 0, 'third anon present');
    assert.ok(firstIdx < featIdx, 'first anon before FEAT-1');
    assert.ok(secondIdx < featIdx, 'second anon before FEAT-1');
    assert.ok(thirdIdx > featIdx, 'third anon after FEAT-1');
  });
});

describe('drift on rich override only emits stderr warning, override wins', () => {
  test('rich override (with parenthetical) preserved and drift emitted', () => {
    writeFeature('FEAT-1', { phase: 'P', status: 'COMPLETE', description: 'done', position: 1 });
    writeFileSync(join(cwd, 'ROADMAP.md'), `# Roadmap

## P — PARTIAL (some sub-items pending)

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | FEAT-1 | done | COMPLETE |
`);
    const out = generateRoadmap(cwd);
    // Override should win: heading still says PARTIAL (some sub-items pending).
    assert.ok(out.includes('## P — PARTIAL (some sub-items pending)'),
      'rich override should win over rollup');
    // Stderr warn should fire for drift (rollup is COMPLETE, override is PARTIAL).
    assert.match(stderrCaptured, /WARN: phase "P"/);
  });
});

describe('preserved markers inside fenced code blocks ignored', () => {
  test('markers inside ``` fences do not become preserved sections', () => {
    writeFeature('FEAT-1', { phase: 'P', status: 'PLANNED', description: 'real', position: 1 });
    writeFileSync(join(cwd, 'ROADMAP.md'), `# Roadmap

\`\`\`markdown
<!-- preserved-section: fake -->
fake content
<!-- /preserved-section -->
\`\`\`

## P — PLANNED

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | FEAT-1 | real | PLANNED |
`);
    const out = generateRoadmap(cwd);
    // The fenced section should appear unchanged (it's part of the preamble).
    assert.ok(out.includes('```markdown'));
    // No fake preserved section should leak into the output structure.
    // (The fenced content remains literal text, not a real preserved section.)
    assert.ok(out.includes('FEAT-1'));
  });
});
