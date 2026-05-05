# COMP-MCP-MIGRATION-2-1-1: Implementation Plan (REVISED to Option A)

**Status:** PLAN
**Date:** 2026-05-06
**Blueprint:** [`blueprint.md`](./blueprint.md) (revised 2026-05-06)
**Design:** [`design.md`](./design.md)

## Strategy

Three targeted preservation patches added to existing string-based parser/writer. Single atomic commit (markers + helpers + drift + writer patch + tests). TDD per task — fail → implement → pass. Total ~200 lines + tests, ~2–3 hours.

The original Option B plan (20 tasks, 8–13 hours) is preserved in git history at `60bdc95`.

## Tasks

### T1 — `lib/roadmap-preservers.js` `(new)` + tests

**Files:**
- `lib/roadmap-preservers.js` (new)
- `test/roadmap-preservers.test.js` (new)

**Action:** Three pure functions, no I/O:
- `readPhaseOverrides(text)` → `Map<phaseId, override>` — scans `## ...` heading lines, extracts text after `— `.
- `readAnonymousRows(text)` → `Map<phaseId, AnonRow[]>` where `AnonRow = {rawLine, predecessorCode}`. predecessorCode is `null` if anon row was at table head.
- `readPreservedSections(text)` → `Map<id, rawSource>`. Tracks fenced-code-block state; ignores markers inside code blocks.

**Tests:**
- `readPhaseOverrides`: 9 actual fixtures from current ROADMAP.md (Phase 4 PARTIAL, Phase 5 SUPERSEDED by STRAT-1, COMP-DESIGN, COMP-RT, COMP-TUI, SKILL-PD, COMP-AGENT-CAPS, COMP-OBS-SURFACE, COMP-IDEABOX). Assert correct override text for each.
- `readAnonymousRows`: fixture with mixed typed + anon rows; assert correct `predecessorCode` including `null` for head-of-table case (e.g. `ROADMAP.md:201` `| 37 | — | Audit Stratum...` is the first row).
- `readPreservedSections`: balanced markers captured byte-equal; unbalanced markers produce empty Map; markers inside ` ``` ` fenced code blocks are ignored (false-positive guard).

**TDD:** Write each test, watch fail, implement, watch pass.

**Acceptance:** All preserver tests green. No I/O performed by these functions.

**Depends on:** none.

### T2 — `lib/roadmap-drift.js` `(new)` + tests

**File:**
- `lib/roadmap-drift.js` (new)
- `test/roadmap-drift.test.js` (new)

**Action:** Single export `emitDrift(cwd, {phaseId, override, computed})`:
1. `readEvents(cwd)` — scan last 24h for `tool: 'roadmap_drift'` rows matching `code: phaseId, from: computed, to: override`.
2. If found → return (deduped, no event written).
3. Else → `appendEvent(cwd, {tool: 'roadmap_drift', code: phaseId, from: computed, to: override, reason: 'override-vs-rollup-divergence'})`.
4. Always emit `process.stderr.write(\`WARN: phase "\${phaseId}" override "\${override}" diverges from rollup "\${computed}". Edit ROADMAP.md to acknowledge.\n\`)`.

**Tests:**
- Override-vs-rollup mismatch → event written + stderr warn fires.
- Same drift twice within 24h → second call writes no event, but stderr warn fires both times.
- Different drift (different phaseId or different from/to) → both events written.
- Use `tmpdir()` for isolated `feature-events.jsonl` per test.

**TDD:** Write each test, watch fail, implement, watch pass.

**Acceptance:** All drift tests green. Manual: trigger drift in fixture; inspect generated `.compose/data/feature-events.jsonl`.

**Depends on:** none (independent of T1).

### T3 — Markup wrap `ROADMAP.md` + `templates/ROADMAP.md` `(existing)`

**Files:**
- `ROADMAP.md` (existing)
- `templates/ROADMAP.md` (existing)

**Action:**
- `ROADMAP.md`: wrap 4 sections (Roadmap Conventions 11–18, Dogfooding Milestones 860–871, Execution Sequencing 872–982, Key Documents 983–1002) with `<!-- preserved-section: <id> -->` ... `<!-- /preserved-section -->` per blueprint Section D.
- `templates/ROADMAP.md`: wrap `## Roadmap Conventions` (line 8) and `## Dogfooding Milestones` (line 40) per blueprint Section E.

**Test:** Visual diff review; markdown still renders normally (HTML comments are invisible). Verify total marker count: 8 in `ROADMAP.md` (4 open + 4 close), 4 in `templates/ROADMAP.md` (2 open + 2 close).

**Acceptance:** No content changes; only marker insertions. Both files still render valid markdown when previewed.

**Depends on:** none (can land before T1/T2 because the new writer in T4 is the first thing that reads them).

### T4 — Patch `lib/roadmap-gen.js` `(existing)`

**File:** `lib/roadmap-gen.js`

**Action:** Three insertions per blueprint Section B:

**B1.** In `generateRoadmap(cwd, opts)`, before phase loop:
```js
const existingText = readFileSafe(roadmapPath);
const overrides = readPhaseOverrides(existingText);
const anonRows = readAnonymousRows(existingText);
const preserved = readPreservedSections(existingText);
```

**B2.** Inside phase rendering loop:
- Compute rollup status as today.
- If `overrides.has(phaseId)`, parse leading status token from override; if it differs from rollup → `emitDrift(cwd, {phaseId, override, computed: rollup})`.
- Heading status = override (if present) or rollup.
- Pass `anonRows.get(phaseId) ?? []` to `renderPhase()`.

**B3.** `renderPhase(phaseName, status, features, anonRows)` interleaves anon rows:
- For each typed feature row, emit it.
- After emitting, check if any `anonRow.predecessorCode === thisFeature.code` and emit those rawLines next.
- Anon rows with `predecessorCode === null` emit before the first typed row.
- Anon rows whose predecessor was deleted (no matching typed row in current features) stay adjacent to nearest surviving typed row by parsed-order index.

**B4.** After full output assembly:
```js
output = splicePreservedSections(output, preserved);
```
where `splicePreservedSections` finds each `<!-- preserved-section: id -->` ... `<!-- /preserved-section -->` pair in the output and replaces it with `preserved.get(id)` (if present in the captured Map). Pairs in output but not in Map are left untouched (first-run case before T3 markers exist in upstream caller's input; should not happen here since T3 lands first).

**B5.** Disable existing Key Documents auto-regeneration at `lib/roadmap-gen.js:186` (or guard it on absence of preserved markers).

**Test:** Existing tests still pass. New round-trip test from T5 covers the integration.

**Acceptance:** `lib/roadmap-gen.js` diff is additive + the Key Documents code path disabled. No restructuring of existing flow.

**Depends on:** T1, T2.

### T5 — Round-trip integration test `(new)`

**File:** `test/roadmap-roundtrip.test.js` (new)

**Action:**
- Read marker-wrapped `ROADMAP.md` fixture.
- Run `writeRoadmap()` against fixture.
- Assert: zero changes inside the 4 preserved-section spans (byte-equal).
- Assert: all anonymous rows present in output at their parsed positions.
- Assert: all 9 override texts intact in their headings.
- Assert: idempotent — running `writeRoadmap()` twice produces the same output.

**TDD:** Write the test, watch fail (because T4 isn't done yet, or as proof Option A's mechanism works), implement T4 to make it pass.

**Acceptance:** Round-trip test green.

**Depends on:** T1, T2, T3, T4.

### T6 — Manual smoke `(verification)`

**File:** N/A.

**Action:** From compose root: `node -e "import('./lib/roadmap-gen.js').then(m => m.writeRoadmap(process.cwd()))"` then `git diff ROADMAP.md`.

**Acceptance:** Zero changes. Idempotent regen on the marker-wrapped file with no feature.json mutations produces no diff. If diff appears, debug T4 before commit.

**Depends on:** T5.

### T7 — Full test suite `(verification)`

**File:** N/A.

**Action:** `npm test` from compose root.

**Acceptance:** Full suite green. Existing tests unaffected (Option A keeps parser API surface unchanged).

**Depends on:** T6.

## Atomic Commit

T1–T7 land as one commit:
- T1, T2 ship the preservers + drift modules with tests.
- T3 lands the markup migration.
- T4 patches the writer.
- T5 integration test.
- T6, T7 verifications gate the commit.

Single commit because the markup migration (T3) without the writer patch (T4) would mean `readPreamble()` in the current writer slices off the open marker on first regen. Combined commit avoids any transient broken state.

## Risk-to-Task Mapping

| Blueprint risk | Task |
|---|---|
| R1: marker false positives in code blocks | T1 (`readPreservedSections` ignores fenced code) + T1 test |
| R2: anonymous-row predecessor reordering | T4 B3 fallback rule + T5 integration test |
| R3: drift event spam | T2 read-side dedupe + T2 test |
| R4: Key Documents auto-add removal | T4 B5 disabling; called out in commit message |

## TDD Discipline

For each task:
1. Write the test first.
2. Run `npm test` — watch new test fail.
3. Implement.
4. Run `npm test` — watch new test pass + full suite green.
5. Commit only after pass.

For T3 (markup migration, no test):
1. Make the wrap edits.
2. Visual review of `git diff` — confirm only marker additions.
3. Then proceed to T4 (which depends on T3).

## Estimated Effort

- T1: ~30 min (preservers + tests)
- T2: ~20 min (drift + tests)
- T3: ~10 min (markup wrap)
- T4: ~45 min (writer patches)
- T5: ~20 min (round-trip test)
- T6, T7: ~10 min combined (verification)

Total: ~2–2.5 hours of focused work.

## Out-of-Scope Follow-Ups (already filed)

- `COMP-MCP-MIGRATION-2-1-1-1`: `/compose migrate-anon` interactive promotion flow.
- `COMP-MCP-MIGRATION-2-1-1-2`: validator AST migration (collapse raw scanner onto AST). Note: with Option A, validator stays untouched in this PR; the collapse is even more clearly out of scope.
- `COMP-MCP-MIGRATION-2-1-1-3`: Key Documents hybrid-merge regen.
- (New, file if user wants:) `COMP-MARKDOWN-AST` — full unified/remark switch as a separate initiative if/when CHANGELOG/journal round-trip earns it.
- (New, file if user wants:) `FEATURE-CODE-RE-FIX` — switch parser regex to `FEATURE_CODE_RE_STRICT`; collapse validator's workaround scanner.
