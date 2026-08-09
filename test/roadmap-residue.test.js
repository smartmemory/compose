/**
 * roadmap-residue.test.js — COMP-CONFLICT-MERGE.
 *
 * `roadmap generate` rendered feature rows and dropped hand-authored content that
 * matched none of the six preservers, while the row-level roundtrip check
 * reported "lossless". These cover the residue detector, the typed errors, the
 * unbalanced-marker raise, and the three CLI outcomes (halt / --accept-loss /
 * --protect).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { generateRoadmapFromBase } from '../lib/roadmap-gen.js';
import { checkRoundtrip } from '../lib/roadmap-roundtrip.js';
import { computeResidue, protectResidue } from '../lib/roadmap-residue.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'compose.js');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const feat = (over = {}) => ({
  code: 'FOO-1', description: 'the foo feature', status: 'PLANNED',
  phase: 'Phase 1', position: 1, ...over,
});

/** Final canonical bytes that `generate` would write, for a base + features. */
const finalBytes = (base, features) =>
  checkRoundtrip(base, features, { now: '2026-01-01' }).canonical;

describe('computeResidue', () => {
  test('a normal status flip produces zero residue (no false positive)', () => {
    const base = generateRoadmapFromBase('', [feat({ status: 'PLANNED' })], { now: '2026-01-01' });
    const canonical = finalBytes(base, [feat({ status: 'COMPLETE' })]);
    assert.deepEqual(computeResidue(base, canonical), [],
      'a feature row rewritten by a status flip is not residue');
  });

  test('curated intro prose under a phase that HAS feature.json features survives (the historical failure)', () => {
    const base = [
      '# Roadmap',
      '',
      '## Phase 1 — PLANNED',
      '',
      'Curated intro paragraph that must survive regeneration.',
      '',
      '| # | Feature | Description | Status |',
      '|---|---------|-------------|--------|',
      '| 1 | FOO-1 | the foo feature | PLANNED |',
      '',
    ].join('\n');
    const canonical = finalBytes(base, [feat()]);
    assert.ok(canonical.includes('Curated intro paragraph that must survive'),
      'sanity: the splice path keeps intro prose');
    assert.deepEqual(computeResidue(base, canonical), [], 'surviving prose is not residue');
  });

  test('a duplicate phase-heading collision drops the earlier block — reported as residue', () => {
    // Two `## Notes` blocks collapse to the last one (readPhaseBlocks Map
    // collision), so the FIRST block's curated line is lost.
    const base = [
      '# Roadmap',
      '',
      '## Notes — PLANNED',
      '',
      'FIRST curated note that gets clobbered.',
      '',
      '## Notes — PLANNED',
      '',
      'SECOND curated note.',
      '',
    ].join('\n');
    const canonical = finalBytes(base, [feat()]);
    const residue = computeResidue(base, canonical);
    assert.ok(residue.some((r) => r.text.includes('FIRST curated note')),
      `expected the first note as residue, got ${JSON.stringify(residue)}`);
    assert.ok(!canonical.includes('FIRST curated note'), 'sanity: it really was dropped');
    assert.ok(canonical.includes('SECOND curated note'), 'sanity: the survivor stayed');
  });

  test('residue carries lineNo, text, and nearestHeading', () => {
    const base = [
      '# Roadmap', '', '## Notes — PLANNED', '', 'LOST line.', '',
      '## Notes — PLANNED', '', 'kept.', '',
    ].join('\n');
    const residue = computeResidue(base, finalBytes(base, [feat()]));
    const lost = residue.find((r) => r.text === 'LOST line.');
    assert.ok(lost, 'the lost line is reported');
    assert.equal(lost.nearestHeading, 'Notes');
    assert.equal(lost.lineNo, 5);
  });

  test('a vanished non-feature phase reports its heading as residue', () => {
    // A phase heading present in base but gone from the output is residue.
    const base = ['# Roadmap', '', '## Ghost', '', 'content under ghost', ''].join('\n');
    // Regenerate against a base that no longer has Ghost: feed the generated
    // output of a Ghost-less base as the "candidate" the check compares to.
    const candidate = generateRoadmapFromBase('# Roadmap\n', [feat()], { now: '2026-01-01' });
    const residue = computeResidue(base, candidate);
    assert.ok(residue.some((r) => r.text === '## Ghost' || r.nearestHeading === 'Ghost'),
      `expected the vanished phase reported, got ${JSON.stringify(residue)}`);
  });

  test('a status flip on a phase heading is not residue (block key is status-insensitive)', () => {
    const base = generateRoadmapFromBase('', [feat({ status: 'PLANNED' })], { now: '2026-01-01' });
    const canonical = finalBytes(base, [feat({ status: 'COMPLETE' })]);
    const residue = computeResidue(base, canonical);
    assert.ok(!residue.some((r) => /^## /.test(r.text)),
      `a status-flipped heading is not residue, got ${JSON.stringify(residue)}`);
  });

  test('a lost curated (non-feature) TABLE keeps its header and divider in the residue', () => {
    // Review r1 P1: excluding all table headers let --protect wrap a headerless,
    // orphaned table. A curated table's header + divider must be residue too.
    const base = [
      '# Roadmap', '',
      '## Docs — PLANNED', '',
      '| Document | What it is |',
      '|---|---|',
      '| ADR-1 | curated decision |',
      '',
      '## Docs — PLANNED', '', 'second.', '',
    ].join('\n');
    const residue = computeResidue(base, finalBytes(base, [feat()]));
    const texts = residue.map((r) => r.text);
    assert.ok(texts.includes('| Document | What it is |'), `header must be residue, got ${JSON.stringify(texts)}`);
    assert.ok(texts.includes('|---|---|'), 'divider must be residue');
    assert.ok(texts.includes('| ADR-1 | curated decision |'), 'row must be residue');

    // ...and --protect wraps the whole table so it is not orphaned.
    const protectedBase = protectResidue(base, residue);
    const canonical = finalBytes(protectedBase, [feat()]);
    assert.ok(canonical.includes('| Document | What it is |'), 'protected table keeps its header');
    assert.ok(canonical.includes('| ADR-1 | curated decision |'), 'protected table keeps its row');
    assert.deepEqual(computeResidue(protectedBase, canonical), [], 'no residue after protecting the table');
  });

  test('changing a feature designDoc does NOT flag the regenerated Key Documents row (r2 P1)', () => {
    // The auto Key Documents table is generator-owned — a designDoc change
    // rewrites it and must not read as hand-authored loss (else --protect freezes
    // a stale generated link).
    const v1 = [feat({ designDoc: 'docs/old.md' })];
    const v2 = [feat({ designDoc: 'docs/new.md' })];
    const base = generateRoadmapFromBase('', v1, { now: '2026-01-01' });
    const canonical = finalBytes(base, v2);
    assert.deepEqual(computeResidue(base, canonical), [],
      'a regenerated Key Documents row is not residue');
  });

  test('a genuinely curated (non-"design") Key Documents row IS still caught (path-2 preserved)', () => {
    const base = [
      '# R', '', '## Key Documents', '', '| Document | What it is |', '|---|---|',
      '| `https://x` | external reference |', '',
      '## Key Documents', '', '| Document | What it is |', '|---|---|', '| `y` | second |', '',
    ].join('\n');
    const residue = computeResidue(base, finalBytes(base, [feat()]));
    assert.ok(residue.some((r) => r.text.includes('external reference')),
      `curated key-docs row must still be caught, got ${JSON.stringify(residue)}`);
  });

  test('a curated Key Documents row whose description ends in "design" is NOT excluded (r3 P1)', () => {
    // The generated-row shape must match `| `path` | <CODE> design |` exactly, not
    // "description ends in design", or a curated external row is silently dropped.
    const base = [
      '# R', '', '## Key Documents', '', '| Document | What it is |', '|---|---|',
      '| `https://example.com/api` | External API design |', '',
      '## Key Documents', '', '| Document | What it is |', '|---|---|', '| `y` | second |', '',
    ].join('\n');
    const residue = computeResidue(base, finalBytes(base, [feat()]));
    assert.ok(residue.some((r) => r.text.includes('External API design')),
      `curated "…design" row must be caught, got ${JSON.stringify(residue)}`);
  });

  test('duplicate identical sub-headings: the LOST (earlier) occurrence is reported and --protect resolves it (r3 P2)', () => {
    const base = [
      '# R', '',
      '## Alpha — PLANNED', '', '### Sub', '',
      '## Alpha — PLANNED', '', '### Widget', '',
      '## Beta — PLANNED', '', '### Sub', '',
    ].join('\n');
    const residue = computeResidue(base, finalBytes(base, [feat()]));
    const subs = residue.filter((r) => r.text === '### Sub');
    assert.equal(subs.length, 1, 'exactly one Sub is residue');
    assert.equal(subs[0].lineNo, 5, 'the reported line is the LOST (earlier) occurrence, not the survivor');

    const protectedBase = protectResidue(base, residue);
    assert.deepEqual(computeResidue(protectedBase, finalBytes(protectedBase, [feat()])), [],
      '--protect wraps the occurrence that actually disappears, resolving the conflict');
  });

  test('a bare sub-heading dropped when an identical one survives elsewhere is residue (r2 P2)', () => {
    // `###` sub-headings are not deduped by the generator, so losing one is real
    // loss even though a same-named `### Sub` survives under another phase.
    const base = [
      '# R', '',
      '## Alpha — PLANNED', '', '### Sub', '',
      '## Alpha — PLANNED', '', '### Widget', '',
      '## Beta — PLANNED', '', '### Sub', '',
    ].join('\n');
    const residue = computeResidue(base, finalBytes(base, [feat()]));
    assert.ok(residue.some((r) => r.text === '### Sub'),
      `expected the dropped sub-heading, got ${JSON.stringify(residue)}`);
  });

  test('a curated Key Documents row is recognised by feature IDENTITY, not shape (r4 P1)', () => {
    // `| `url` | API-1 design |` looks exactly like a generated row, but API-1 is
    // NOT a current feature, so it is curated and must be caught. A real feature's
    // row (FOO-1) is generator-owned even after its designDoc changes.
    const base = [
      '# R', '', '## Key Documents', '', '| Document | What it is |', '|---|---|',
      '| `https://x/spec` | API-1 design |', '',
      '## Key Documents', '', '| Document | What it is |', '|---|---|', '| `y` | second |', '',
    ].join('\n');
    const canonical = finalBytes(base, []);
    const caught = computeResidue(base, canonical, { featureCodes: new Set(['FOO-1']) });
    assert.ok(caught.some((r) => r.text.includes('API-1 design')),
      `curated row referencing a non-feature code must be caught, got ${JSON.stringify(caught)}`);
  });

  test('a candidate feature row does NOT pay for a lost base prose line of identical text (r4 P1)', () => {
    // candCount must count only eligible prose, symmetric with the base side, or a
    // regenerated feature row silently absorbs a dropped fenced/prose line.
    const base = [
      '# R', '',
      '## Phase 1 — PLANNED', '', '```', '| 1 | FOO-1 | x | PLANNED |', '```', '',
      '| # | Feature | Description | Status |', '|---|---------|-------------|--------|',
      '| 1 | FOO-1 | x | PLANNED |', '',
      '## Phase 1 — PLANNED', '',
      '| # | Feature | Description | Status |', '|---|---------|-------------|--------|',
      '| 1 | FOO-1 | x | PLANNED |', '',
    ].join('\n');
    const feats = [{ code: 'FOO-1', description: 'x', status: 'PLANNED', phase: 'Phase 1', position: 1 }];
    const residue = computeResidue(base, finalBytes(base, feats), { featureCodes: new Set(['FOO-1']) });
    assert.ok(residue.some((r) => r.text === '| 1 | FOO-1 | x | PLANNED |'),
      `the dropped fenced line must be caught, not absorbed by the feature row, got ${JSON.stringify(residue)}`);
  });

  test('feature rows, table headers, and dividers are never residue', () => {
    // Base's feature row differs from the regenerated one (status), the table
    // header/divider are re-emitted verbatim — none of these count.
    const base = generateRoadmapFromBase('', [feat({ status: 'PLANNED' })], { now: '2026-01-01' });
    const canonical = finalBytes(base, [feat({ status: 'IN_PROGRESS' })]);
    const residue = computeResidue(base, canonical);
    assert.ok(!residue.some((r) => /^\|/.test(r.text)), `no table lines expected, got ${JSON.stringify(residue)}`);
  });
});

describe('protectResidue', () => {
  test('wrapping the residue and regenerating preserves the previously-dropped content', () => {
    const base = [
      '# Roadmap', '', '## Notes — PLANNED', '', 'FIRST curated note that gets clobbered.', '',
      '## Notes — PLANNED', '', 'SECOND curated note.', '',
    ].join('\n');
    const residue = computeResidue(base, finalBytes(base, [feat()]));
    assert.ok(residue.length > 0, 'precondition: there is residue to protect');

    const protectedBase = protectResidue(base, residue);
    assert.match(protectedBase, /<!-- preserved-section: [a-z][a-z0-9-]* -->/, 'inserts a valid marker');

    const canonical = finalBytes(protectedBase, [feat()]);
    assert.ok(canonical.includes('FIRST curated note'), 'the once-lost note now survives');
    assert.deepEqual(computeResidue(protectedBase, canonical), [], 'no residue remains after protection');
  });

  test('a generated id never collides with a preserved-section id already in the file', () => {
    // The residue is under a `## Notes` heading (slug "notes"), but a `notes`
    // preserved-section already exists — the new id must not reuse it, or the
    // id-keyed Map would drop one on the next generate.
    const base = [
      '# Roadmap', '',
      '<!-- preserved-section: notes -->', 'pre-existing guarded block', '<!-- /preserved-section -->', '',
      '## Notes — PLANNED', '', 'FIRST curated note that gets clobbered.', '',
      '## Notes — PLANNED', '', 'SECOND.', '',
    ].join('\n');
    const residue = computeResidue(base, finalBytes(base, [feat()]));
    const protectedBase = protectResidue(base, residue);
    const ids = [...protectedBase.matchAll(/<!-- preserved-section:\s*([a-z][a-z0-9-]*)\s*-->/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `ids must be unique, got ${JSON.stringify(ids)}`);
    assert.ok(ids.includes('notes'), 'the pre-existing id is untouched');
  });
});

// ── CLI integration ──────────────────────────────────────────────────────────

function project() {
  const cwd = mkdtempSync(join(tmpdir(), 'residue-cli-'));
  mkdirSync(join(cwd, 'docs', 'features', 'FOO-1'), { recursive: true });
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'),
    JSON.stringify({ version: '0.1', paths: { features: 'docs/features' } }));
  writeFileSync(join(cwd, 'docs', 'features', 'FOO-1', 'feature.json'),
    JSON.stringify({ code: 'FOO-1', description: 'the foo feature', status: 'PLANNED', phase: 'Phase 1', position: 1 }));
  return cwd;
}

function run(cwd, args) {
  try {
    return { code: 0, stdout: execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf-8' }) };
  } catch (e) {
    return { code: e.status ?? 1, stdout: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

/** Append two duplicate `## Notes` phases so regen collapses them and loses the first. */
function injectLossyDuplicate(roadmapPath) {
  const cur = readFileSync(roadmapPath, 'utf-8');
  writeFileSync(roadmapPath, cur +
    '\n## Notes — PLANNED\n\nHAND-AUTHORED note worth keeping.\n\n## Notes — PLANNED\n\nsecond.\n');
}

describe('compose roadmap generate — prose-loss guard (COMP-CONFLICT-MERGE)', () => {
  test('halts (exit 1) on residue and writes nothing by default', () => {
    const cwd = project();
    assert.equal(run(cwd, ['roadmap', 'generate']).code, 0);
    const rm = join(cwd, 'ROADMAP.md');
    injectLossyDuplicate(rm);
    const before = readFileSync(rm, 'utf-8');

    const r = run(cwd, ['roadmap', 'generate']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /HAND-AUTHORED note worth keeping/, r.stdout);
    assert.equal(readFileSync(rm, 'utf-8'), before, 'nothing written on conflict');
  });

  test('--accept-loss writes and prints what was dropped', () => {
    const cwd = project();
    run(cwd, ['roadmap', 'generate']);
    const rm = join(cwd, 'ROADMAP.md');
    injectLossyDuplicate(rm);

    const r = run(cwd, ['roadmap', 'generate', '--accept-loss']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /accept-loss/i, r.stdout);
    assert.ok(!readFileSync(rm, 'utf-8').includes('HAND-AUTHORED note worth keeping'),
      'the dropped line is gone after --accept-loss');
  });

  test('--protect wraps the residue and preserves it', () => {
    const cwd = project();
    run(cwd, ['roadmap', 'generate']);
    const rm = join(cwd, 'ROADMAP.md');
    injectLossyDuplicate(rm);

    const r = run(cwd, ['roadmap', 'generate', '--protect']);
    assert.equal(r.code, 0, r.stdout);
    const out = readFileSync(rm, 'utf-8');
    assert.ok(out.includes('HAND-AUTHORED note worth keeping'), 'protected content survives');
    assert.match(out, /<!-- preserved-section:/, 'a marker was written');

    // And it is now stable — a second generate is clean.
    assert.equal(run(cwd, ['roadmap', 'generate']).code, 0, 'protected file regenerates cleanly');
  });

  test('halts (exit 1) on an unbalanced preserved-section marker, writing nothing', () => {
    const cwd = project();
    run(cwd, ['roadmap', 'generate']);
    const rm = join(cwd, 'ROADMAP.md');
    writeFileSync(rm, readFileSync(rm, 'utf-8') +
      '\n<!-- preserved-section: orphan -->\nguarded content, but the close is missing\n');
    const before = readFileSync(rm, 'utf-8');

    const r = run(cwd, ['roadmap', 'generate']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /unbalanced|orphan/i, r.stdout);
    assert.equal(readFileSync(rm, 'utf-8'), before, 'nothing written on unbalanced marker');
  });

  test('halts (exit 1) on duplicate preserved-section ids, writing nothing', () => {
    // Review r1 P1: two balanced sections with the same id collide in the Map and
    // the first is silently dropped — the residue check treats marker content as
    // safe, so this must be caught by the strict marker guard.
    const cwd = project();
    run(cwd, ['roadmap', 'generate']);
    const rm = join(cwd, 'ROADMAP.md');
    writeFileSync(rm, readFileSync(rm, 'utf-8') +
      '\n<!-- preserved-section: dup -->\nblock A\n<!-- /preserved-section -->\n' +
      '\n<!-- preserved-section: dup -->\nblock B\n<!-- /preserved-section -->\n');
    const before = readFileSync(rm, 'utf-8');
    const r = run(cwd, ['roadmap', 'generate']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /duplicate|dup/i, r.stdout);
    assert.equal(readFileSync(rm, 'utf-8'), before, 'nothing written on duplicate ids');
  });

  test('a clean fixed-point roadmap regenerates without a false positive', () => {
    const cwd = project();
    assert.equal(run(cwd, ['roadmap', 'generate']).code, 0);
    assert.equal(run(cwd, ['roadmap', 'generate']).code, 0, 'second generate is clean');
  });

  test('respects a configured non-default features directory (paths.features)', () => {
    // Review r1 P1: generate must load features from the configured dir, else it
    // regenerates from an empty set and drops every row.
    const cwd = mkdtempSync(join(tmpdir(), 'residue-cli-alt-'));
    mkdirSync(join(cwd, 'planning', 'BAR-1'), { recursive: true });
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'compose.json'),
      JSON.stringify({ version: '0.1', paths: { features: 'planning' } }));
    writeFileSync(join(cwd, 'planning', 'BAR-1', 'feature.json'),
      JSON.stringify({ code: 'BAR-1', description: 'bar', status: 'PLANNED', phase: 'Phase 1', position: 1 }));

    const r = run(cwd, ['roadmap', 'generate']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8'), /BAR-1/,
      'the roadmap must include the feature from the configured dir');
  });
});

describe('the live compose ROADMAP.md is residue-clean', () => {
  test('generating it drops nothing', async () => {
    const roadmapPath = join(REPO_ROOT, 'ROADMAP.md');
    if (!existsSync(roadmapPath)) return; // repo layout guard
    const base = readFileSync(roadmapPath, 'utf-8');
    const { listFeatures } = await import('../lib/feature-json.js');
    const { loadExternalPrefixes } = await import('../lib/project-paths.js');
    const externalPrefixes = loadExternalPrefixes(REPO_ROOT);
    const canonical = checkRoundtrip(base, listFeatures(REPO_ROOT), { now: '2026-01-01', externalPrefixes }).canonical;
    const residue = computeResidue(base, canonical);
    assert.deepEqual(residue, [],
      `live ROADMAP.md must be residue-clean; got ${JSON.stringify(residue, null, 2)}`);
  });
});
