# COMP-ROADMAP-RT — Deterministic Roadmap Roundtripping: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** PLAN
**Date:** 2026-05-29
**Design:** [design.md](design.md)

**Goal:** Make `ROADMAP.md` generation a *proven* deterministic fixed point of `feature.json`, enforced at write time and surfaced through validation.

**Architecture:** A single pure primitive `checkRoundtrip(baseText, features, opts)` proves two invariants — fixed point (`gen(gen(x)) == gen(x)`) and losslessness (`parse(gen(x))` recovers every feature). It backs three consumers that previously each had ad-hoc logic: the write-time guard in `feature-writer.js` (pre-commit dry run), the `roadmap check` CLI, and new `feature-validator.js` findings. Two prerequisites unblock the primitive: one canonical feature-code regex shared by parser/preservers/validator, and a deterministic clock injected into the generator.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, no external deps. Test runner: `node --test test/*.test.js`.

---

## Task Order

Dependency-driven: regex unification (1–3) → deterministic gen (4) → primitive (5) → consumers (6–8) → verify/report (9). Each task ends green and committed.

## Files Summary

| File | Tasks |
|------|-------|
| `lib/feature-code.js` | 1 |
| `lib/roadmap-parser.js` | 2 |
| `lib/roadmap-preservers.js` | 3 |
| `lib/roadmap-gen.js` | 4 |
| `lib/roadmap-roundtrip.js` (new) | 5 |
| `lib/feature-validator.js` | 6 |
| `lib/feature-writer.js` | 7 |
| `bin/compose.js` | 8 |
| `test/feature-code.test.js`, `test/roadmap-checkroundtrip.test.js` (new), `test/cli-roadmap-rt.test.js` (new), + appends to parser/preservers/validator/writer suites | 1–9 |

---

## Task 1: Canonical feature-code predicate

**Files:**
- Modify: `lib/feature-code.js`
- Test: `test/feature-code.test.js` (create if absent)

- [ ] **Step 1: Write the failing test**

Create/append `test/feature-code.test.js`:

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isFeatureCode, FEATURE_CODE_RE_STRICT } from '../lib/feature-code.js';

describe('isFeatureCode', () => {
  test('accepts a code that does not end in -<digits>', () => {
    assert.equal(isFeatureCode('COMP-ROADMAP-RT'), true);
  });
  test('accepts a numeric-suffixed code', () => {
    assert.equal(isFeatureCode('FEAT-1'), true);
  });
  test('rejects leading/trailing hyphen, lowercase, em-dash, empty, null', () => {
    assert.equal(isFeatureCode('-FOO'), false);
    assert.equal(isFeatureCode('FOO-'), false);
    assert.equal(isFeatureCode('foo-1'), false);
    assert.equal(isFeatureCode('—'), false);
    assert.equal(isFeatureCode(''), false);
    assert.equal(isFeatureCode(null), false);
  });
  test('predicate agrees with the strict regex', () => {
    assert.equal(isFeatureCode('COMP-X'), FEATURE_CODE_RE_STRICT.test('COMP-X'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/feature-code.test.js`
Expected: FAIL — `isFeatureCode is not a function`.

- [ ] **Step 3: Add the predicate**

In `lib/feature-code.js`, after `validateCode`, add:

```javascript
/**
 * Non-throwing predicate form of the canonical feature-code contract.
 * Single source of truth for "is this string a feature code?" — consumed by
 * the roadmap parser, preservers, and validator.
 *
 * @param {unknown} code
 * @returns {boolean}
 */
export function isFeatureCode(code) {
  return typeof code === 'string' && FEATURE_CODE_RE_STRICT.test(code);
}
```

Also fix the stale top-of-file comment: delete the sentence "The roadmap parser deliberately uses a looser regex (`/^[A-Z][\w-]*-\d+/`) to match anonymous/legacy table rows and is exempt from this extraction." and replace with: "Consumed by feature-writer, completion-writer, journal-writer, AND (via isFeatureCode) the roadmap parser/preservers/validator."

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/feature-code.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/feature-code.js test/feature-code.test.js
git commit -m "feat(COMP-ROADMAP-RT): add canonical isFeatureCode predicate"
```

---

## Task 2: Fix parser regex; consume canonical predicate

**Files:**
- Modify: `lib/roadmap-parser.js:15,104`
- Test: `test/roadmap-parser.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/roadmap-parser.test.js` (the suite already imports `parseRoadmap`):

```javascript
test('parses a feature code that does not end in -<digits> as a real code', () => {
  const md = [
    '## Phase 6: MCP Writers — PLANNED',
    '',
    '| # | Feature | Description | Status |',
    '|---|---------|-------------|--------|',
    '| 1 | COMP-ROADMAP-RT | harden roundtrip | PLANNED |',
    '',
  ].join('\n');
  const codes = parseRoadmap(md).map(e => e.code);
  assert.ok(codes.includes('COMP-ROADMAP-RT'),
    `expected COMP-ROADMAP-RT as a real code, got ${JSON.stringify(codes)}`);
  assert.ok(!codes.some(c => c.startsWith('_anon_')),
    'COMP-ROADMAP-RT must not be classified anonymous');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/roadmap-parser.test.js`
Expected: FAIL — `COMP-ROADMAP-RT` classified `_anon_*` (old regex `/^[A-Z][\w-]*-\d+/` requires trailing `-<digits>`).

- [ ] **Step 3: Replace the local regex with the canonical predicate**

In `lib/roadmap-parser.js`, add at the top (this file has no imports yet — add at line 7):

```javascript
import { isFeatureCode } from './feature-code.js';
```

Delete:

```javascript
const FEATURE_CODE_RE = /^[A-Z][\w-]*-\d+/;
```

Change line ~104 from:

```javascript
const isAnonymous = code === '—' || code === '-' || !FEATURE_CODE_RE.test(code);
```

to:

```javascript
const isAnonymous = code === '—' || code === '-' || !isFeatureCode(code);
```

- [ ] **Step 4: Run parser suite + full suite for regressions**

Run: `node --test test/roadmap-parser.test.js`
Expected: PASS including the new test.

Run: `node --test test/*.test.js`
Expected: PASS. **If a pre-existing parser test breaks**, it asserts the old buggy behavior — per the project testing rules, fix the test to the corrected contract (a code without a numeric suffix is valid). Never restore the bug. Note any such change in the commit body.

- [ ] **Step 5: Commit**

```bash
git add lib/roadmap-parser.js test/roadmap-parser.test.js
git commit -m "fix(COMP-ROADMAP-RT): parser accepts non-numeric-suffixed codes via canonical regex"
```

---

## Task 3: Preservers consume the canonical regex

**Files:**
- Modify: `lib/roadmap-preservers.js:20,129`
- Test: `test/roadmap-preservers.test.js` (append)

The preservers' local `FEATURE_CODE_RE` (`/^[A-Z][A-Z0-9-]*[A-Z0-9]$/`) is identical to `FEATURE_CODE_RE_STRICT`. This is a no-behavior-change unification, locked with a test first.

- [ ] **Step 1: Write the guard test**

Append to `test/roadmap-preservers.test.js` (suite imports from `../lib/roadmap-preservers.js`):

```javascript
test('a non-numeric-suffixed code in the Feature column is NOT treated as anonymous', () => {
  const md = [
    '## Phase 6 — PLANNED',
    '| # | Feature | Description | Status |',
    '|---|---------|-------------|--------|',
    '| 1 | COMP-ROADMAP-RT | x | PLANNED |',
    '| — | — | a curated note | PLANNED |',
  ].join('\n');
  const rows = readAnonymousRows(md).get('Phase 6') ?? [];
  assert.equal(rows.length, 1); // only the em-dash row is anon
  assert.ok(rows[0].rawLine.includes('curated note'));
});
```

Ensure `readAnonymousRows` is imported.

- [ ] **Step 2: Run to verify current behavior (already green)**

Run: `node --test test/roadmap-preservers.test.js`
Expected: PASS (the local regex is already strict). This pins behavior so the swap can't regress.

- [ ] **Step 3: Swap the local regex for the shared one**

In `lib/roadmap-preservers.js`, add at top:

```javascript
import { FEATURE_CODE_RE_STRICT } from './feature-code.js';
```

Delete:

```javascript
const FEATURE_CODE_RE = /^[A-Z][A-Z0-9-]*[A-Z0-9]$/;
```

Replace the usage at line ~129 `!FEATURE_CODE_RE.test(codeCell)` with `!FEATURE_CODE_RE_STRICT.test(codeCell)`.

- [ ] **Step 4: Run to verify still green**

Run: `node --test test/roadmap-preservers.test.js`
Expected: PASS (unchanged behavior, now sharing the canonical source).

- [ ] **Step 5: Commit**

```bash
git add lib/roadmap-preservers.js test/roadmap-preservers.test.js
git commit -m "refactor(COMP-ROADMAP-RT): preservers share canonical feature-code regex"
```

---

## Task 4: Deterministic clock + drift suppression in the generator

**Files:**
- Modify: `lib/roadmap-gen.js` (`generateRoadmapFromBase`, `generateRoadmap`, `readPreamble`)
- Test: `test/roadmap-checkroundtrip.test.js` (new — first tests land here)

- [ ] **Step 1: Write the failing tests**

Create `test/roadmap-checkroundtrip.test.js`:

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateRoadmapFromBase } from '../lib/roadmap-gen.js';

const FEATURES = [
  { code: 'FEAT-1', phase: 'Phase 1', status: 'PLANNED', description: 'first', position: 1 },
];

describe('generator determinism', () => {
  test('injected now appears in a fresh-file preamble', () => {
    const out = generateRoadmapFromBase('', FEATURES, { now: '2020-01-02', projectName: 'X' });
    assert.ok(out.includes('2020-01-02'), 'injected now should drive the Last updated line');
  });

  test('two fresh generations with the same now are byte-equal', () => {
    const a = generateRoadmapFromBase('', FEATURES, { now: '2020-01-02', projectName: 'X' });
    const b = generateRoadmapFromBase('', FEATURES, { now: '2020-01-02', projectName: 'X' });
    assert.equal(a, b);
  });

  test('suppressDrift prevents drift emission even with cwd + divergent override', () => {
    let wrote = '';
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c) => { wrote += String(c); return true; };
    try {
      const base = '## Phase 1 — PARKED (manual hold)\n\n| # | Feature | Description | Status |\n|---|---------|-------------|--------|\n| 1 | FEAT-1 | first | PLANNED |\n';
      generateRoadmapFromBase(base, FEATURES, { now: '2020-01-02', cwd: '/tmp/nonexistent-xyz', suppressDrift: true });
    } finally {
      process.stderr.write = orig;
    }
    assert.ok(!wrote.includes('diverges'), `expected no drift warning, got: ${wrote}`);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/roadmap-checkroundtrip.test.js`
Expected: FAIL — fresh-file preamble uses `new Date()` (today), not `2020-01-02`; `suppressDrift` ignored.

- [ ] **Step 3: Inject `now` and `suppressDrift`**

In `lib/roadmap-gen.js`:

(a) `readPreamble(cwd, opts, existingText)` — replace `const today = new Date().toISOString().slice(0, 10);` with:

```javascript
  const today = opts.now ?? new Date().toISOString().slice(0, 10);
```

(b) `generateRoadmap(cwd, opts = {})` — own the clock in the I/O wrapper. Change the final return to:

```javascript
  const now = opts.now ?? new Date().toISOString().slice(0, 10);
  return generateRoadmapFromBase(existingText, features, { ...opts, cwd, featuresDir, now });
```

(c) In `generateRoadmapFromBase`, guard the drift call. Change:

```javascript
        if (cwd) emitDrift(cwd, { phaseId: phase, override, computed: rollupStatus });
```

to:

```javascript
        if (cwd && !opts.suppressDrift) emitDrift(cwd, { phaseId: phase, override, computed: rollupStatus });
```

- [ ] **Step 4: Run to verify it passes + full suite**

Run: `node --test test/roadmap-checkroundtrip.test.js`
Expected: PASS (3 tests).

Run: `node --test test/*.test.js`
Expected: PASS — existing gen/roundtrip suites don't pass `now`, so they fall through to the `new Date()` default exactly as before.

- [ ] **Step 5: Commit**

```bash
git add lib/roadmap-gen.js test/roadmap-checkroundtrip.test.js
git commit -m "feat(COMP-ROADMAP-RT): inject now clock and suppressDrift into generator"
```

---

## Task 5: The `checkRoundtrip` primitive

**Files:**
- Create: `lib/roadmap-roundtrip.js`
- Test: `test/roadmap-checkroundtrip.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append to `test/roadmap-checkroundtrip.test.js`:

```javascript
import { checkRoundtrip } from '../lib/roadmap-roundtrip.js';

const OPTS = { now: '2020-01-02', projectName: 'X' };

describe('checkRoundtrip — fixed point + lossless', () => {
  test('a simple feature set is a fixed point and lossless', () => {
    const features = [
      { code: 'FEAT-1', phase: 'Phase 1', status: 'PLANNED', description: 'first', position: 1 },
      { code: 'FEAT-2', phase: 'Phase 1', status: 'COMPLETE', description: 'second', position: 2 },
    ];
    const r = checkRoundtrip('', features, OPTS);
    assert.equal(r.fixedPoint, true, JSON.stringify(r.diffs));
    assert.equal(r.lossless, true, JSON.stringify(r.diffs));
    assert.ok(r.passes <= 2);
  });

  test('reports LOSSLESS_EXTRA for a valid code present in ROADMAP but not in features', () => {
    const base = [
      '# X Roadmap', '',
      '## Phase 9 — PLANNED', '',
      '| # | Feature | Description | Status |',
      '|---|---------|-------------|--------|',
      '| 1 | ORPHAN-1 | not in features | PLANNED |', '',
    ].join('\n');
    const features = [
      { code: 'FEAT-1', phase: 'Phase 1', status: 'PLANNED', description: 'first', position: 1 },
    ];
    const r = checkRoundtrip(base, features, OPTS);
    assert.ok(r.diffs.some(d => d.kind === 'LOSSLESS_EXTRA' && d.code === 'ORPHAN-1'),
      `expected LOSSLESS_EXTRA for ORPHAN-1, got ${JSON.stringify(r.diffs)}`);
  });

  test('anonymous rows are NOT reported as extra', () => {
    const base = [
      '# X Roadmap', '',
      '## Phase 1 — PLANNED', '',
      '| # | Feature | Description | Status |',
      '|---|---------|-------------|--------|',
      '| 1 | FEAT-1 | first | PLANNED |',
      '| — | — | curated anon note | PLANNED |', '',
    ].join('\n');
    const features = [
      { code: 'FEAT-1', phase: 'Phase 1', status: 'PLANNED', description: 'first', position: 1 },
    ];
    const r = checkRoundtrip(base, features, OPTS);
    assert.ok(!r.diffs.some(d => d.kind === 'LOSSLESS_EXTRA'),
      `anon row must not be extra, got ${JSON.stringify(r.diffs)}`);
  });

  test('a feature with items[] recovers each item status without false LOSSLESS', () => {
    const features = [
      { code: 'FEAT-1', phase: 'Phase 1', status: 'PARTIAL', description: 'parent', position: 1,
        items: [
          { position: 1, description: 'sub a', status: 'COMPLETE' },
          { position: 2, description: 'sub b', status: 'PLANNED' },
        ] },
    ];
    const r = checkRoundtrip('', features, OPTS);
    assert.equal(r.lossless, true, JSON.stringify(r.diffs));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/roadmap-checkroundtrip.test.js`
Expected: FAIL — `Cannot find module '../lib/roadmap-roundtrip.js'`.

- [ ] **Step 3: Implement the primitive**

Create `lib/roadmap-roundtrip.js`:

```javascript
/**
 * roadmap-roundtrip.js — prove ROADMAP.md is a deterministic fixed point of
 * feature.json. Pure: no filesystem, no event/stderr side effects.
 *
 * COMP-ROADMAP-RT.
 */

import { generateRoadmapFromBase } from './roadmap-gen.js';
import { parseRoadmap } from './roadmap-parser.js';
import { isFeatureCode } from './feature-code.js';

export const MAX_REGEN_PASSES = 3;

/**
 * @typedef {{ kind: string, phaseId?: string, code?: string, detail?: string }} Diff
 * @typedef {{ fixedPoint: boolean, lossless: boolean, canonical: string, passes: number, diffs: Diff[] }} RoundtripResult
 */

/**
 * @param {string} baseText  Existing ROADMAP.md content ('' for a fresh file)
 * @param {Array}  features  feature.json feature objects
 * @param {object} [opts]    { now, maxPasses, projectName, projectDescription }
 * @returns {RoundtripResult}
 */
export function checkRoundtrip(baseText, features, opts = {}) {
  const maxPasses = opts.maxPasses ?? MAX_REGEN_PASSES;
  // Pure: never pass cwd (so no drift I/O); suppressDrift belt-and-suspenders.
  const genOpts = { ...opts, cwd: undefined, suppressDrift: true };
  const diffs = [];

  // --- Fixed point: iterate gen until output stabilizes. ---
  let prev = generateRoadmapFromBase(baseText, features, genOpts);
  let canonical = prev;
  let passes = 1;
  let fixedPoint = false;
  while (passes < maxPasses) {
    const next = generateRoadmapFromBase(prev, features, genOpts);
    passes++;
    canonical = next;
    if (next === prev) { fixedPoint = true; break; }
    prev = next;
  }
  if (!fixedPoint) {
    const next = generateRoadmapFromBase(prev, features, genOpts);
    if (next === prev) { fixedPoint = true; canonical = prev; }
    else {
      canonical = next;
      diffs.push({ kind: 'FIXED_POINT_DIVERGENCE', detail: firstDiffLine(prev, next) });
    }
  }

  // --- Losslessness: parse canonical, aggregate by code, exclude anon. ---
  const parsed = parseRoadmap(canonical);
  const byCode = new Map();
  for (const e of parsed) {
    if (e.code.startsWith('_anon_') || !isFeatureCode(e.code)) continue;
    const arr = byCode.get(e.code) ?? [];
    arr.push(e);
    byCode.set(e.code, arr);
  }

  const featureCodes = new Set();
  for (const f of features) {
    featureCodes.add(f.code);
    const group = byCode.get(f.code);
    if (!group || group.length === 0) {
      diffs.push({ kind: 'LOSSLESS_MISSING', code: f.code, phaseId: f.phase });
      continue;
    }
    const hasItems = Array.isArray(f.items) && f.items.length > 0;
    if (hasItems) {
      const want = f.items.map(i => up(i.status ?? f.status)).sort();
      const got = group.map(e => up(e.status)).sort();
      if (want.length !== got.length || want.some((s, i) => s !== got[i])) {
        diffs.push({ kind: 'LOSSLESS_CHANGED', code: f.code, phaseId: f.phase,
          detail: `items: want [${want}] got [${got}]` });
      }
    } else {
      const e = group[0];
      if (up(e.status) !== up(f.status)) {
        diffs.push({ kind: 'LOSSLESS_CHANGED', code: f.code, phaseId: f.phase,
          detail: `status: want ${up(f.status)} got ${up(e.status)}` });
      }
      if (f.phase && e.phaseId && e.phaseId !== f.phase) {
        diffs.push({ kind: 'LOSSLESS_CHANGED', code: f.code, phaseId: f.phase,
          detail: `phase: want ${f.phase} got ${e.phaseId}` });
      }
    }
  }
  for (const code of byCode.keys()) {
    if (!featureCodes.has(code)) diffs.push({ kind: 'LOSSLESS_EXTRA', code });
  }

  const lossless = !diffs.some(d => d.kind.startsWith('LOSSLESS_'));
  return { fixedPoint, lossless, canonical, passes, diffs };
}

function up(s) { return String(s ?? '').toUpperCase().trim(); }

/** First differing line between two texts, for FIXED_POINT_DIVERGENCE.detail. */
function firstDiffLine(a, b) {
  const al = a.split('\n'), bl = b.split('\n');
  const n = Math.max(al.length, bl.length);
  for (let i = 0; i < n; i++) {
    if (al[i] !== bl[i]) return `line ${i + 1}: "${al[i] ?? ''}" → "${bl[i] ?? ''}"`;
  }
  return 'lengths differ';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/roadmap-checkroundtrip.test.js`
Expected: PASS (all blocks). If `LOSSLESS_EXTRA` for `ORPHAN-1` does not fire, confirm the featureless `Phase 9` block is spliced verbatim by `generateRoadmapFromBase` (the `phaseBlocks` fallback) so the orphan row survives into `canonical` and is parsed.

- [ ] **Step 5: Commit**

```bash
git add lib/roadmap-roundtrip.js test/roadmap-checkroundtrip.test.js
git commit -m "feat(COMP-ROADMAP-RT): checkRoundtrip primitive (fixed-point + lossless)"
```

---

## Task 6: Validator findings (roundtrip + hierarchy)

**Files:**
- Modify: `lib/feature-validator.js` (`validateProject`)
- Test: `test/feature-validator.test.js` (append)

**Read `validateProject` in `lib/feature-validator.js` before editing** to match its `finding(severity, KIND, code, message)` helper and the names already in scope (`features`, `paths`, `findings`).

- [ ] **Step 1: Write the failing tests**

Append to `test/feature-validator.test.js` (reuse its tmp-dir + seed helpers; if absent, copy `freshCwd`/`seedFeature` from `test/feature-writer.test.js`):

```javascript
describe('COMP-ROADMAP-RT validator findings', () => {
  test('HIERARCHY_DEPTH_INVALID for a feature with no phase', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'FOO-1', description: 'x', status: 'PLANNED' }); // no phase
    const { findings } = await validateProject(cwd);
    assert.ok(findings.some(f => f.kind === 'HIERARCHY_DEPTH_INVALID' && f.code === 'FOO-1'));
  });

  test('ORPHAN_PHASE for a heading with no features and no preserved block', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'FOO-1', description: 'x', status: 'PLANNED', phase: 'Phase 1', position: 1 });
    writeFileSync(join(cwd, 'ROADMAP.md'), [
      '# X Roadmap', '',
      '## Phase 1 — PLANNED', '',
      '| # | Feature | Description | Status |',
      '|---|---------|-------------|--------|',
      '| 1 | FOO-1 | x | PLANNED |', '',
      '## Phase 99 — PLANNED', '',  // orphan: no feature, no body
    ].join('\n'));
    const { findings } = await validateProject(cwd);
    assert.ok(findings.some(f => f.kind === 'ORPHAN_PHASE'),
      JSON.stringify(findings.map(f => f.kind)));
  });

  test('ROADMAP_LOSSY when ROADMAP has a typed orphan code absent from feature.json', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'FOO-1', description: 'x', status: 'PLANNED', phase: 'Phase 1', position: 1 });
    writeFileSync(join(cwd, 'ROADMAP.md'), [
      '# X Roadmap', '',
      '## Phase 9 — PLANNED', '',
      '| # | Feature | Description | Status |',
      '|---|---------|-------------|--------|',
      '| 1 | GHOST-1 | not in feature.json | PLANNED |', '',
    ].join('\n'));
    const { findings } = await validateProject(cwd);
    assert.ok(findings.some(f => f.kind === 'ROADMAP_LOSSY'),
      JSON.stringify(findings.map(f => f.kind)));
  });
});
```

Confirm `validateProject`, `writeFileSync`, `join` are imported in the suite.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/feature-validator.test.js`
Expected: FAIL — the three new finding kinds aren't emitted.

- [ ] **Step 3: Emit the findings in `validateProject`**

Add to the import block at the top of `lib/feature-validator.js`:

```javascript
import { checkRoundtrip } from './roadmap-roundtrip.js';
import { readPhaseOrder, readPhaseBlocks, readPreservedSectionAnchors } from './roadmap-preservers.js';
```

Inside `validateProject`, after `features` and the roadmap path are available, add:

```javascript
  // --- COMP-ROADMAP-RT: roundtrip + hierarchy ---
  const roadmapText = fs.existsSync(paths.roadmap) ? fs.readFileSync(paths.roadmap, 'utf8') : '';

  for (const f of features) {
    if (!f.phase) {
      findings.push(finding('warning', 'HIERARCHY_DEPTH_INVALID', f.code,
        `feature has no phase — renders ungrouped (depth < 2)`));
    }
  }

  const rt = checkRoundtrip(roadmapText, features, { now: '0000-00-00' });
  if (!rt.fixedPoint) {
    const d = rt.diffs.find(x => x.kind === 'FIXED_POINT_DIVERGENCE');
    findings.push(finding('error', 'ROUNDTRIP_NOT_FIXED_POINT', null,
      `ROADMAP.md is not a generation fixed point: ${d?.detail ?? 'diverges on regen'}`));
  }
  for (const d of rt.diffs.filter(x => x.kind.startsWith('LOSSLESS_'))) {
    findings.push(finding('warning', 'ROADMAP_LOSSY', d.code ?? null,
      `${d.kind}${d.detail ? ': ' + d.detail : ''}`));
  }

  const phasesWithFeatures = new Set(features.map(f => f.phase).filter(Boolean));
  const phaseBlocks = readPhaseBlocks(roadmapText);
  const anchoredPhases = new Set([...readPreservedSectionAnchors(roadmapText).values()].filter(Boolean));
  for (const phaseId of readPhaseOrder(roadmapText)) {
    if (phasesWithFeatures.has(phaseId)) continue;
    const block = phaseBlocks.get(phaseId);
    const hasBody = block && block.split('\n').slice(1).some(l => l.trim().length > 0);
    if (!hasBody && !anchoredPhases.has(phaseId)) {
      findings.push(finding('warning', 'ORPHAN_PHASE', null,
        `phase "${phaseId}" has no feature.json features and no preserved content`));
    }
  }
```

> Adjust `fs`/`paths`/`finding`/`features`/`findings` to the exact identifiers in scope (the file already imports `fs` and defines `finding` and the parsed-roadmap context — read it first). `now: '0000-00-00'` is a stable sentinel: the validator needs only two-pass internal consistency, not a real date.

- [ ] **Step 4: Run to verify it passes + full suite**

Run: `node --test test/feature-validator.test.js`
Expected: PASS including the three new tests.

Run: `node --test test/*.test.js`
Expected: PASS. If a pre-existing validator integration fixture now reports `ROADMAP_LOSSY`/`ORPHAN_PHASE`, inspect it — a real orphan/lossy row in test data is fixed in the fixture, not silenced.

- [ ] **Step 5: Commit**

```bash
git add lib/feature-validator.js test/feature-validator.test.js
git commit -m "feat(COMP-ROADMAP-RT): roundtrip + hierarchy validator findings"
```

---

## Task 7: Write-time pre-commit guard

**Files:**
- Modify: `lib/feature-writer.js` (`addRoadmapEntry`, `setFeatureStatus`)
- Test: `test/feature-writer.test.js` (append)

The guard runs `checkRoundtrip` on the *prospective* feature set **before** persisting, so a non-convergent render aborts the whole mutation (no canonical/rendered split). Convergence is the normal case, so existing tests stay green.

- [ ] **Step 1: Write the failing test**

Append to `test/feature-writer.test.js`:

```javascript
describe('write-time roundtrip guard', () => {
  test('addRoadmapEntry still succeeds on a normal (convergent) mutation', async () => {
    const cwd = freshCwd();
    const r = await addRoadmapEntry(cwd, { code: 'FOO-1', description: 'x', phase: 'Phase 0' });
    assert.equal(r.code, 'FOO-1');
    assert.ok(existsSync(join(cwd, 'ROADMAP.md')));
    const { checkRoundtrip } = await import('../lib/roadmap-roundtrip.js');
    const { listFeatures } = await import('../lib/feature-json.js');
    const text = readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8');
    const rt = checkRoundtrip(text, listFeatures(cwd), { now: '0000-00-00' });
    assert.equal(rt.fixedPoint, true);
    assert.equal(rt.lossless, true);
  });

  test('guard result is exposed on the return value', async () => {
    const cwd = freshCwd();
    const r = await addRoadmapEntry(cwd, { code: 'FOO-2', description: 'y', phase: 'Phase 0' });
    assert.equal(r.roundtrip.fixedPoint, true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/feature-writer.test.js`
Expected: FAIL — `r.roundtrip` is undefined.

- [ ] **Step 3: Add a guard helper and wire both writers**

In `lib/feature-writer.js`, add to the imports:

```javascript
import { checkRoundtrip } from './roadmap-roundtrip.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
```

Add a helper:

```javascript
// Pre-commit roundtrip guard (LOCAL providers only — remote providers render
// server-side and are out of scope for COMP-ROADMAP-RT). Runs checkRoundtrip on
// the prospective feature set BEFORE persistence; throws (unless force) when the
// render won't stabilize, so canonical feature.json is never written ahead of a
// broken view. Returns the RoundtripResult on success.
async function roundtripGuard(cwd, provider, mutate, { force, label }) {
  const current = await provider.listFeatures();
  const projected = mutate(current.map(f => ({ ...f })));
  const roadmapPath = join(cwd, 'ROADMAP.md');
  const baseText = existsSync(roadmapPath) ? readFileSync(roadmapPath, 'utf-8') : '';
  const rt = checkRoundtrip(baseText, projected, { now: '0000-00-00' });
  if (!rt.fixedPoint && !force) {
    const d = rt.diffs.find(x => x.kind === 'FIXED_POINT_DIVERGENCE');
    const err = new Error(
      `${label}: aborted — ROADMAP.md would not be a generation fixed point ` +
      `(${d?.detail ?? 'diverges on regen'}). No changes were written. ` +
      `Pass force: true to commit anyway.`
    );
    err.code = 'ROUNDTRIP_NOT_FIXED_POINT';
    throw err;
  }
  return rt;
}
```

In `addRoadmapEntry`, **before** `await provider.createFeature(...)` (after the `feature` object is fully built):

```javascript
    let roundtrip = null;
    if (isLocalProvider(provider)) {
      roundtrip = await roundtripGuard(cwd, provider,
        (feats) => [...feats, feature],
        { force: args.force, label: 'add_roadmap_entry' });
    }
```

Add `roundtrip` to its return object.

In `setFeatureStatus`, **before** `await provider.persistFeatureRaw(...)` (after `updated` is built):

```javascript
    let roundtrip = null;
    if (isLocalProvider(provider)) {
      roundtrip = await roundtripGuard(cwd, provider,
        (feats) => feats.map(f => f.code === args.code ? updated : f),
        { force: args.force, label: 'set_feature_status' });
    }
```

Add `roundtrip` to its return object.

> **`isLocalProvider`:** read `lib/providers/` to find the existing local-vs-remote discriminator (e.g. a `kind`/`type` field or the LocalFileProvider class) and implement `isLocalProvider` against it — do NOT invent a field. If there is genuinely no discriminator, gate on the provider being an instance of the local file provider. Confirm during implementation; the goal is "guard local writes, skip remote (GitHub) writes."

- [ ] **Step 4: Run to verify it passes + full suite**

Run: `node --test test/feature-writer.test.js`
Expected: PASS including the two new tests.

Run: `node --test test/*.test.js`
Expected: PASS — the guard converges for all normal mutations.

- [ ] **Step 5: Commit**

```bash
git add lib/feature-writer.js test/feature-writer.test.js
git commit -m "feat(COMP-ROADMAP-RT): pre-commit roundtrip guard on local writers"
```

---

## Task 8: Harden CLI `roadmap check`; converge `roadmap generate`

**Files:**
- Modify: `bin/compose.js:1040-1114`
- Test: `test/cli-roadmap-rt.test.js` (new)

- [ ] **Step 1: Write the failing test**

Read `test/cli-validate.test.js` first to copy its child-process invocation pattern. Then create `test/cli-roadmap-rt.test.js`:

```javascript
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
    assert.ok(/LOSSLESS|GHOST-1|lossy/i.test(r.stdout), r.stdout);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/cli-roadmap-rt.test.js`
Expected: FAIL — the current `roadmap check` won't emit the `LOSSLESS`/`GHOST-1` wording (it reports `NO feature.json` instead; we route it through `checkRoundtrip` for consistent diagnostics + fixed-point coverage).

- [ ] **Step 3: Rewrite `roadmap check` on `checkRoundtrip`; converge `generate`**

In `bin/compose.js`, replace the `if (subcmd === 'check')` block body (~lines 1067-1114) with:

```javascript
  if (subcmd === 'check') {
    const { listFeatures } = await import('../lib/feature-json.js')
    const { checkRoundtrip } = await import('../lib/roadmap-roundtrip.js')
    const { root: cwd } = resolveCwdWithWorkspace(args)
    const roadmapPath = join(cwd, 'ROADMAP.md')
    if (!existsSync(roadmapPath)) {
      console.error('No ROADMAP.md found. Run: compose roadmap generate')
      process.exit(1)
    }
    const rt = checkRoundtrip(readFileSync(roadmapPath, 'utf-8'), listFeatures(cwd), { now: '0000-00-00' })
    if (rt.fixedPoint && rt.lossless) {
      console.log('feature.json and ROADMAP.md are in sync (fixed point, lossless).')
      process.exit(0)
    }
    if (!rt.fixedPoint) {
      const d = rt.diffs.find(x => x.kind === 'FIXED_POINT_DIVERGENCE')
      console.log(`NOT A FIXED POINT: ${d?.detail ?? 'ROADMAP.md changes on regen'}`)
    }
    for (const d of rt.diffs.filter(x => x.kind.startsWith('LOSSLESS_'))) {
      console.log(`${d.kind}${d.code ? ' ' + d.code : ''}${d.detail ? ': ' + d.detail : ''}`)
    }
    console.log('\nRun `compose roadmap generate` to regenerate ROADMAP.md from feature.json.')
    process.exit(1)
  }
```

Replace the `generate`/`gen` block (~lines 1040-1046) with:

```javascript
  if (subcmd === 'generate' || subcmd === 'gen') {
    const { writeRoadmap } = await import('../lib/roadmap-gen.js')
    const { checkRoundtrip } = await import('../lib/roadmap-roundtrip.js')
    const { listFeatures } = await import('../lib/feature-json.js')
    const { root: cwd } = resolveCwdWithWorkspace(args)
    const path = writeRoadmap(cwd)
    const rt = checkRoundtrip(readFileSync(path, 'utf-8'), listFeatures(cwd), { now: '0000-00-00' })
    if (!rt.fixedPoint) {
      writeFileSync(path, rt.canonical)
      console.log(`Generated ${path} (canonicalized over ${rt.passes} passes)`)
    } else {
      console.log(`Generated ${path} from feature.json files`)
    }
    process.exit(0)
  }
```

`readFileSync`/`writeFileSync` are already imported in `bin/compose.js` (used at lines ~490, 1016).

- [ ] **Step 4: Run to verify it passes + full suite**

Run: `node --test test/cli-roadmap-rt.test.js`
Expected: PASS (both tests).

Run: `node --test test/*.test.js && npm run test:ui && npm run test:tracker`
Expected: PASS — full suite (per the project rule: run the whole suite before considering the feature done).

- [ ] **Step 5: Commit**

```bash
git add bin/compose.js test/cli-roadmap-rt.test.js
git commit -m "feat(COMP-ROADMAP-RT): roundtrip-backed roadmap check + convergent generate"
```

---

## Task 9: Wire-up verification, status, and report

**Files:**
- Modify: `docs/features/COMP-ROADMAP-RT/report.md`
- Feature status via MCP

- [ ] **Step 1: Run the live roundtrip on the real roadmap (regression guard)**

Run (in the compose workspace): `node bin/compose.js roadmap check`
Expected: "in sync (fixed point, lossless)." If it reports findings, they are *real* pre-existing drift on compose's own ROADMAP.md — triage each (fix feature.json, or acknowledge prose) before closing the feature. Do not silence.

- [ ] **Step 2: Verify no orphaned dead code**

Run: `grep -rn "FEATURE_CODE_RE\b" lib/ | grep -v STRICT`
Expected: no matches in `roadmap-parser.js` / `roadmap-preservers.js` (the local copies are gone).
Confirm the old ad-hoc comparison vars (`roadmapCodes`/`featureCodes`) are fully removed from `roadmap check`.

- [ ] **Step 3: Fill in `report.md`**

Document: what shipped per task, the parser-bug fix and any tests changed because of it, the `isLocalProvider` discriminator chosen in Task 7, the prose-drift exit policy decision, and the deferred `COMP-ROADMAP-XREF-SYNC` follow-up.

- [ ] **Step 4: Set status and commit the report**

```bash
git add docs/features/COMP-ROADMAP-RT/report.md
git commit -m "docs(COMP-ROADMAP-RT): implementation report"
```

Then mark the feature COMPLETE via the compose MCP `set_feature_status` — which now runs the Task-7 guard itself, an end-to-end smoke test.

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** Design Decisions 1–5 + Goal checklist map to tasks — clock (4); `checkRoundtrip` purity/lossless/anon-exclusion/sub-item aggregation (5); unified regex + parser-bug fix (1–3); hierarchy/orphan/findings (6); pre-commit guard / no-split (7); CLI check + convergent generate (8). External xref is **out of scope** → `COMP-ROADMAP-XREF-SYNC`.
- **Parser parity (Decision 3 caveat):** this plan unifies the *regex* only. It does **not** collapse the validator's broader-header scan onto `parseRoadmap()`. Leave the validator's scan in place.
- **`now` sentinel:** validator + writer guard pass `now: '0000-00-00'` (only two-pass internal consistency matters there). CLI `generate` uses the real clock via `writeRoadmap`→`generateRoadmap`.
- **Known risk:** Task 2 may surface pre-existing parser tests that asserted the buggy trailing-`-\d+` behavior. Fix those tests to the corrected contract; never restore the bug.
- **Provider scope:** the write-time guard is local-provider only. Remote (GitHub) rendering is server-side and explicitly not guarded here.
