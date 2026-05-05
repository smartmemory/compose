# COMP-MCP-MIGRATION-2-1-1: Implementation Blueprint (REVISED to Option A)

**Status:** BLUEPRINT
**Date:** 2026-05-06
**Design:** [`design.md`](./design.md) (Decision 1 revised to hand-rolled augmentation 2026-05-06)

## Scope

Add three targeted preservation patches to the existing string-based `lib/roadmap-parser.js` + `lib/roadmap-gen.js` so typed-writer regens stop destroying curated content. No new dependencies, no AST swap, no consumer migration.

The original Option B blueprint (5,500 words across 9 review rounds) is preserved in git history at `ff7c61a` for reference. This revised blueprint replaces it.

## What this fixes

Per the design's "Why" — typed writers like `set_feature_status` currently destroy:

1. **Anonymous rows** (~10 historical entries with `—` in the `#` column) — parser emits `_anon_*` sentinels, writer drops them.
2. **Phase-status overrides** (9 patterns: `PARTIAL (1a–1d COMPLETE, 2 PLANNED)`, `PARKED (Claude Code dependency)`, `SUPERSEDED by STRAT-1`, etc.) — writer's `phaseStatus()` rollup recomputes from feature.json and overwrites curated text.
3. **Non-feature sections** (`Roadmap Conventions`, `Dogfooding Milestones`, `Execution Sequencing`, `Key Documents`) — writer's `readPreamble()` only preserves content before the first `## ` heading; everything after that is stripped on regen.

## What's deliberately NOT in scope

- AST swap to remark/unified.
- `FEATURE_CODE_RE` strict-regex fix. The current looser regex misclassifies `COMP-MCP-PUBLISH`-style codes as anonymous. Validator (`lib/feature-validator.js:72`) already has its own scanner that works around this. File as separate hygiene ticket if desired.
- `_anon_*` consumer cleanup. Parser keeps emitting `_anon_<n>`; consumers stay unchanged.
- Validator AST migration. Filed as `COMP-MCP-MIGRATION-2-1-1-2`.
- Hybrid-merge for Key Documents. Filed as `COMP-MCP-MIGRATION-2-1-1-3` — for v1, Key Documents becomes preserved-only; auto-add via designDoc fields removed.
- `/compose migrate-anon` interactive promotion flow. Filed as `COMP-MCP-MIGRATION-2-1-1-1`.

## File-by-File Plan

### A. `lib/roadmap-preservers.js` — new file

Three pure functions; no I/O; tested in isolation.

```js
// Reads existing ROADMAP.md text, returns Map<phaseId, override text>.
// Override is everything after `— ` in a `## ...` heading line.
// Empty Map if no headings found.
export function readPhaseOverrides(text) { ... }

// Reads existing ROADMAP.md text, returns Map<phaseId, AnonRow[]>.
// AnonRow shape: { rawLine: string, predecessorCode: string|null }
// predecessorCode is the feature code of the previous typed row in the same
// phase table, or null if the anon row was at table head.
export function readAnonymousRows(text) { ... }

// Reads existing ROADMAP.md text, returns Map<id, rawSource>.
// rawSource includes both open and close markers and everything between.
// Returns empty Map if no markers found (e.g. on first run before T1
// markup migration lands).
export function readPreservedSections(text) { ... }
```

Each function uses simple line-by-line scanning. No external deps. Tested by `test/roadmap-preservers.test.js` against fixtures.

### B. `lib/roadmap-gen.js` — three additions

The existing `generateRoadmap()` flow stays largely intact. Three insertion points:

**B1. Override capture before phase rendering.**
```js
// existing
function generateRoadmap(cwd, opts) {
  const features = listFeatures(cwd);
  const existingText = readFileSafe(roadmapPath); // new helper
  const overrides = readPhaseOverrides(existingText); // NEW
  const anonRows = readAnonymousRows(existingText);   // NEW
  const preserved = readPreservedSections(existingText); // NEW
  // ... preamble, feature grouping ...
  for (const phase of phases) {
    const rollupStatus = phaseStatus(phase.features);
    const override = overrides.get(phase.phaseId);
    let headingStatus = rollupStatus;
    if (override) {
      const overrideToken = parseStatusToken(override);
      if (overrideToken !== rollupStatus) {
        emitDrift(cwd, { phaseId: phase.phaseId, override, computed: rollupStatus });
      }
      headingStatus = override; // override wins; full text retained
    }
    output += renderPhase(phase, headingStatus, anonRows.get(phase.phaseId) ?? []);
  }
  // splice preserved sections back
  output = splicePreservedSections(output, preserved);
  return output;
}
```

**B2. `renderPhase()` interleaves anon rows.**

Existing function emits typed feature rows in order. New: insert each `AnonRow` at its parsed position relative to the current typed row list:
- If `predecessorCode === null` → row first.
- Else → row immediately after the typed feature whose `code === predecessorCode`.
- If predecessor was deleted → row stays adjacent to nearest surviving typed row by parsed-order proximity.

**B3. `splicePreservedSections(output, preserved)`.**

After full generation, scan output for any `<!-- preserved-section: <id> -->` ... `<!-- /preserved-section -->` pairs. For each id present in `preserved` Map, replace the (possibly empty/regenerated) span with `preserved.get(id)`. Pairs that exist in output but not in `preserved` are left untouched (this happens on first run, before the markers are in the file).

### C. `lib/roadmap-drift.js` — new file

Single export:
```js
export function emitDrift(cwd, { phaseId, override, computed }) {
  // 1. read recent feature-events.jsonl, look for matching roadmap_drift event in last 24h
  // 2. if found with same { phaseId, override, computed } triple, return (deduped)
  // 3. else appendEvent({ tool: 'roadmap_drift', code: phaseId, from: computed, to: override, reason: 'override-vs-rollup-divergence' })
  // 4. always emit stderr warn
}
```

Imports `appendEvent` and `readEvents` from `lib/feature-events.js`. Uses idempotency through reading prior events, NOT through the unenforced `idempotency_key` field.

### D. `ROADMAP.md` — one-time markup wrap

Wrap 4 preserved sections with HTML comment markers:

| Section | Lines | Open marker | Close marker |
|---|---|---|---|
| Roadmap Conventions | 11–18 | before line 11 | after line 18 |
| Dogfooding Milestones | 860–871 | before line 860 | after line 871 |
| Execution Sequencing | 872–982 | before line 872 | after line 982 |
| Key Documents | 983–1002 | before line 983 | after line 1002 |

Marker IDs: `roadmap-conventions`, `dogfooding-milestones`, `execution-sequencing`, `key-documents`.

**Note on Key Documents.** The current writer regenerates this section from `feature.json#designDoc` fields (`lib/roadmap-gen.js:186`). After this migration, the section is preserved-only. Disable the existing designDoc-based regeneration code (or make it conditional on the absence of preserved markers). Auto-add to Key Documents is dropped in v1; humans edit the section directly. Hybrid-merge regen is `COMP-MCP-MIGRATION-2-1-1-3`.

### E. `templates/ROADMAP.md` — marker wrap for compose-init bootstrap

Wrap `## Roadmap Conventions` (template line 8) and `## Dogfooding Milestones` (template line 40) with their respective markers. Newly initialized repos start marker-aware so first `writeRoadmap()` doesn't strand markers in `readPreamble()` slice.

### F. Tests

**`test/roadmap-preservers.test.js`** (new). Unit tests for the three pure helpers:
- `readPhaseOverrides`: 9 fixture patterns produce the right Map.
- `readAnonymousRows`: anon rows captured with correct `predecessorCode` (including null for head-of-table).
- `readPreservedSections`: balanced markers captured; unbalanced returns empty (or warns); markers in unrelated context (e.g. inside code blocks) ignored.

**`test/roadmap-roundtrip.test.js`** (new). Integration test:
- Parse current `ROADMAP.md` → `writeRoadmap()` → diff. Assert: zero changes inside the 4 preserved-section spans, all anonymous rows present at their parsed positions, all 9 override texts intact.
- Subsequent regen with no feature.json mutations: same input → same output (idempotent).

**`test/roadmap-drift.test.js`** (new). Drift detection:
- Override-vs-rollup mismatch → `roadmap_drift` event written, stderr warn fires.
- Same drift on next regen within 24h → no duplicate event written, stderr warn still fires.
- No drift → no event.

**Existing tests stay green** — parser API surface unchanged (`parseRoadmap` still returns `FeatureEntry[]` including `_anon_<n>` codes; `filterBuildable` unchanged).

## Implementation Order

1. **Markup wrap** (atomic with the rest because the current writer's `readPreamble()` would strand open markers — but with Option A the writer changes minimally and the strand risk is small. Land in same commit as B/C just to be safe.)
2. `lib/roadmap-preservers.js` + `test/roadmap-preservers.test.js`
3. `lib/roadmap-drift.js` + `test/roadmap-drift.test.js`
4. Patch `lib/roadmap-gen.js` for B1, B2, B3
5. `test/roadmap-roundtrip.test.js`
6. `templates/ROADMAP.md` marker wrap
7. Manual smoke: `node -e "import('./lib/roadmap-gen.js').then(m => m.writeRoadmap(process.cwd()))"` → `git diff ROADMAP.md` should be empty (no diff, idempotent).

All 7 steps land as one commit; total surface ~200 lines + tests.

## Risk Register

1. **`readPreserveSections()` scanner false positives.** If `<!-- preserved-section: ... -->` appears inside a code block or as quoted markdown text, the scanner could capture too much. *Mitigation:* the scanner ignores markers inside fenced code blocks (track ` ``` ` state during line scan).

2. **Anonymous-row predecessor reordering.** If a typed feature gets renamed or its `position` changes, an anon row's `predecessorCode` lookup may miss. *Mitigation:* when predecessor not found, fall back to "stay adjacent to nearest surviving typed row by parsed-order index." Test the rename case explicitly.

3. **Drift event spam.** Same as Option B — read-side dedupe in `emitDrift()` prevents `feature-events.jsonl` filling up.

4. **Key Documents auto-add removal is a behavior change.** Today `addRoadmapEntry({designDoc: '...'})` flows into Key Documents automatically. After this PR, that path is dead until `COMP-MCP-MIGRATION-2-1-1-3` reintroduces it as hybrid merge. *Mitigation:* call this out in the commit message and CHANGELOG entry. Only impacts new feature creation; existing Key Documents entries are preserved.

## Test Plan

`package.json:22` — `npm test` runs `node --test test/*.test.js test/comp-obs-branch/*.test.js && npm run test:ui`.

New tests: `test/roadmap-preservers.test.js`, `test/roadmap-roundtrip.test.js`, `test/roadmap-drift.test.js`. Existing tests unchanged.

Manual smoke before merge: `node -e "import('./lib/roadmap-gen.js').then(m => m.writeRoadmap(process.cwd()))"` from compose root. `git diff ROADMAP.md` must show **zero** changes (idempotent on the marker-wrapped file with no feature.json mutations).

## Verification Table

| Claim | Source |
|---|---|
| `lib/roadmap-parser.js` API surface unchanged | Per Decision 1 revision; `_anon_<n>` codes still emitted |
| `lib/roadmap-gen.js` mutations are local: 3 helpers added, no flow restructuring | Section B above |
| Audit log via existing `appendEvent()` from `lib/feature-events.js:38` | unchanged from prior blueprint |
| 4 preserved sections at lines 11–18 / 860–871 / 872–982 / 983–1002 | unchanged from prior blueprint |
| 9 phase-status overrides | unchanged from prior blueprint |
| `templates/ROADMAP.md` has `## Roadmap Conventions` (line 8) and `## Dogfooding Milestones` (line 40) | confirmed by exploration |
| No new package.json deps | per Option A |
| No `_anon_*` consumer migration | per Option A; consumers see same parser output |

## Spike-or-Stop

No POC required. The mechanism (string scan + splice) is well-understood and used in many places in the codebase. Risk register covers the only genuine uncertainty (false-positive marker scan inside code blocks).

## Estimated Effort

2–3 hours of focused work. Heavy refactor was Option B; Option A is targeted.
