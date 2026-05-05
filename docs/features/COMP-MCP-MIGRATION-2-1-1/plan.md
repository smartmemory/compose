# COMP-MCP-MIGRATION-2-1-1: Implementation Plan

**Status:** PLAN
**Date:** 2026-05-06
**Blueprint:** [`blueprint.md`](./blueprint.md)
**Design:** [`design.md`](./design.md)

## Strategy

Atomic combined commit for the AST rewrite (blueprint Implementation Order steps 2, 3, 5, 6, 7). Steps 1, 4, 8, 9, 10 become separate commits before/after. Atomic approach chosen because intermediate state (markers wrapped but writer not marker-aware) strands open markers in current `readPreamble()` slice.

TDD per task — **fail → implement → pass** for every change. Tests cite the canonical specification when ambiguity arises (blueprint section, current parser line, design decision). Never weaken assertions; if a test resists, check the blueprint first, code second.

## Task Backlog

Tasks are ordered by execution sequence. Bracketed dependency tags identify what must land first. Atomic commit boundary marked `=== ATOMIC COMMIT ===`.

### Pre-rewrite

#### T1 — Add unified/remark deps `(existing)`
**File:** `package.json`
**Action:** Add to `dependencies` (caret-pinned, matching existing convention): `unified`, `remark-parse`, `remark-stringify`. `remark-gfm` already at line 104.
**Test:** `npm install` succeeds; `node -e "import('unified')"` works from compose root.
**Acceptance:** package.json diff shows only the three new lines. `npm test` still passes.
**Depends on:** none.

#### T2 — Round-trip POC spike `(new)`
**File:** `scratch/remark-roundtrip-poc.mjs` (temporary, deleted before final commit)
**Action:** Build a 50-line proof-of-concept demonstrating source-slice splice via mdast `position` offsets. Parse a fixture containing a GFM table + an HTML comment marker pair + a code block. Stringify via `unified().use(remarkStringify).use(remarkGfm)` with a custom `mdast-util-to-markdown` handler. Assert that bytes inside the comment-marker pair round-trip byte-equal via source-slice splice.
**Test:** POC runs to completion and prints `POC PASS` / `POC FAIL` with diff.
**Acceptance:** POC PASS. If POC FAIL, **stop and escalate** — Decision 1 (switch to remark/unified) doesn't pay off and the design needs revisiting.
**Depends on:** T1.

#### T3 — Pre-rewrite parser baseline test `(new)`
**File:** `test/roadmap-parser-baseline.test.js`
**Action:** Snapshot test against the *current* parser. Parse `ROADMAP.md`, save the typed `FeatureEntry[]` output to `test/fixtures/roadmap-parser-baseline.json`. Test asserts current parser output matches the snapshot. Purpose: lock current behavior so the AST rewrite can prove parity.
**Test:** Snapshot generated; test passes against current implementation.
**Acceptance:** Fixture file committed. Running `npm test` passes. Snapshot includes typed entry count, milestone phaseIds (cumulative concat), and SKIP_STATUSES propagation.
**Depends on:** none.

### `=== ATOMIC COMMIT BOUNDARY START ===`

#### T4 — Marker-wrap preserved sections in ROADMAP.md `(existing)`
**File:** `ROADMAP.md`
**Action:** Wrap with HTML comment markers per blueprint Section H:
- `<!-- preserved-section: roadmap-conventions -->` ... `<!-- /preserved-section -->` around lines 11–18
- `<!-- preserved-section: dogfooding-milestones -->` ... `<!-- /preserved-section -->` around lines 860–871
- `<!-- preserved-section: execution-sequencing -->` ... `<!-- /preserved-section -->` around lines 872–982
- `<!-- preserved-section: key-documents -->` ... `<!-- /preserved-section -->` around lines 983–1002
**Test:** Visual diff review; markdown still renders normally (HTML comments are invisible).
**Acceptance:** 8 marker insertions, no other content changes. `git diff` shows additions only.
**Depends on:** T3 (snapshot pre-marker for parity comparison).

#### T5 — Marker-wrap preserved sections in templates/ROADMAP.md `(existing)`
**File:** `templates/ROADMAP.md`
**Action:** Wrap `## Roadmap Conventions` (template line 8) and `## Dogfooding Milestones` (template line 40) with their respective markers.
**Test:** Template still renders valid markdown.
**Acceptance:** 4 marker insertions (2 sections × open+close).
**Depends on:** none.

#### T6 — Rewrite `lib/roadmap-parser.js` against AST `(existing)`
**File:** `lib/roadmap-parser.js`
**Action:** Replace hand-rolled regex parser with unified+remark-parse+remark-gfm AST visitor per blueprint Section B:
- Public API preserved: `parseRoadmap(text)` → `FeatureEntry[]`, `filterBuildable(entries)`.
- New export: `parseRoadmapAst(text)` → mdast AST.
- Visitor walks heading depth 2 (phase) and depth 3 (milestone, cumulative concat); composes phaseId via `' > '` delimiter exactly per current behavior.
- Detects column layout per `detectColumnLayout()` semantics (header-driven, NOT first-cell-keyed).
- Uses `FEATURE_CODE_RE_STRICT` from `lib/feature-code.js` (replaces buggy parser regex).
- Decomposes phase-status override as `{statusToken, displaySuffix}`.
- Annotates non-typed `tableRow` AST nodes with `data.preserve = true` and captures `data.rawSource` from `position` offsets.
- Annotates html-comment-bracketed subtrees with `data.preserved = true` and captures rawSource.
- Replicates SKIP_STATUSES heading→row propagation.
- Drops `_anon_*` synthesis entirely.
- `filterBuildable()` simplifies — drop dead `_anon_` clause.
**Test:** New test `test/roadmap-parser.test.js` rewrite (see T7 + T8). Baseline test from T3 must continue passing for typed-entry parity.
**Acceptance:** All baseline + new parser tests green. `parseRoadmap(ROADMAP.md)` typed-entry output matches T3 snapshot 1:1 for codes, statuses, milestone phaseIds.
**Depends on:** T1, T2, T4 (markers must be in place for parser to encounter them).

#### T7 — Update parser tests for AST behavior `(existing)`
**File:** `test/roadmap-parser.test.js`
**Action:**
- Rewrite anonymous-row test (currently at line 80) — assert anonymous rows are NOT in `parseRoadmap()` output; AST passthrough is asserted in T9 round-trip test.
- Add test for `phaseStatusOverride` decomposition: 8 overrides + Phase 5 SUPERSEDED → assert `{statusToken, displaySuffix}` shape per heading.
- Add test for cumulative milestone phaseId: fixture with 2-milestone phase asserts `STRAT-1: Engine > Milestone 1 > Milestone 2` style concat.
- Add test for SKIP_STATUSES propagation: COMPLETE-status phase forces row entries to `status: 'COMPLETE'`.
- Add test for column-layout detection: `| # | Feature | Description | Status |` resolves code at index 1; `| # | Item | Status |` returns codeCol=-1.
**Test:** All AST visitor behaviors covered.
**Acceptance:** Tests pass against T6 implementation.
**Depends on:** T6.

#### T8 — Delete obsolete `_anon_*` sentinel test `(existing)`
**File:** `test/schema-validator-generalize.test.js`
**Action:** Delete the test at line 97-100 (`test('roadmap-row schema rejects anonymous _anon_* sentinel'...`). The sentinel no longer exists in validator input.
**Test:** N/A (deletion). Adjacent tests still pass.
**Acceptance:** Test count decreases by 1; suite green.
**Depends on:** T6.

#### T9 — Round-trip golden test `(new)`
**File:** `test/roadmap-roundtrip.test.js`
**Action:** Per blueprint Test Plan section:
- Preserved-subtree byte-equality: for each `data.preserve = true` tableRow and each preserved-section subtree, parse `ROADMAP.md` → no-op stringify → assert byte-equal source-slice splice.
- Typed-feature content equality: parse → no-op stringify → assert content-equal modulo whitespace via a markdown-aware comparator.
- Override survival: 8 overrides + Phase 5 → no-op stringify → override text intact.
- Anonymous-row survival: enumerate via `parseRoadmapAst()` rows-with-`data.preserve`; assert each `data.rawSource` substring present in output (count locked from current parser baseline before rewrite).
- Preserved-section survival: 4 marker-bracketed sections byte-equal.
**Test:** Round-trip test green when run against marker-wrapped `ROADMAP.md`.
**Acceptance:** Zero diff inside preserved subtrees; cosmetic deltas allowed in typed-feature tables.
**Depends on:** T6, T11 (writer must exist).

#### T10 — Add `lib/roadmap-drift.js` `(new)`
**File:** `lib/roadmap-drift.js`
**Action:** Single export `emitDrift(cwd, {phaseId, override, computed})`:
- Read last 24h of events via `readEvents()` from `lib/feature-events.js`.
- Scan for matching `tool: 'roadmap_drift'` row with same phaseId + from + to. Short-circuit if found.
- Else `appendEvent(cwd, {tool: 'roadmap_drift', code: phaseId, from: computed, to: override, reason: 'override-vs-rollup-divergence'})`.
- Always emit stderr warn: `WARN: phase "${phaseId}" override "${override}" diverges from rollup "${computed}". Edit ROADMAP.md to acknowledge.`
**Test:** New `test/roadmap-drift.test.js` covers: dedupe within 24h window, no-drift no-event, malformed-override emission with `reason: 'override-malformed'`.
**Acceptance:** Drift module green; tests pass.
**Depends on:** T1.

#### T11 — Rewrite `lib/roadmap-gen.js` against AST `(existing)`
**File:** `lib/roadmap-gen.js`
**Action:** Per blueprint Section C:
- `generateRoadmap(cwd, opts)` flow: read ROADMAP.md → parseRoadmapAst → mutate AST in place with feature.json data → stringify via `unified().use(remarkStringify).use(remarkGfm)` with custom mdast-util-to-markdown handlers.
- Custom handler: when tableRow has `data.rawSource`, emit verbatim (skip child re-render).
- Custom handler: when traversal reaches a preserved-section open marker, emit raw bytes from open-marker offset through close-marker end-offset; skip subsequent siblings until close.
- Mutation visitor: phase headings honor `phaseStatusOverride.statusToken + displaySuffix`; rollup status compared against statusToken; on drift, call `emitDrift()` and keep override.
- For each table: emit/update typed-feature tableRows from feature.json; insert preserved tableRows per parsed-position rule (head-of-table when parsed predecessor was null).
- Existing-ROADMAP path + no-ROADMAP bootstrap path with default template (template ships with `roadmap-conventions` marker pair).
- **NEW-PHASE INSERTION** (carry-forward iter-8/9 finding): when `feature.json` references a phase not present in ROADMAP.md, generate the phase heading + intro paragraph + table from the phase metadata in feature.json; insert at correct position (sorted by phase order). Test: `addRoadmapEntry()` into a missing phase produces a properly-rendered new section. (See T13 for test coverage.)
- Drop `readPreamble()` (replaced by AST prefix nodes + bootstrap default).
**Test:** Round-trip test (T9) covers core path; T13 covers new-phase insertion; T14 covers `set_feature_status` drift.
**Acceptance:** Round-trip green; `writeRoadmap()` against marker-wrapped ROADMAP.md produces zero-diff inside preserved subtrees and cosmetic-only deltas inside typed sections.
**Depends on:** T6, T10.

#### T12 — Update `lib/migrate-roadmap.js` `(existing)`
**File:** `lib/migrate-roadmap.js`
**Action:** Drop the `_anon_` skip line at line 43 (carry-forward iter-9 line-ref correction; was claimed line 38 in earlier blueprint). Replace with a comment noting anonymous rows are AST-preserved by the new writer, not migrated.
**Test:** Existing migrate tests still pass (anonymous rows now absent from `parseRoadmap()` output entirely).
**Acceptance:** Diff is one-line replacement plus comment.
**Depends on:** T6.

#### T13 — `_anon_*` consumer cleanup sweep `(existing, multi-file)`
**Files:**
- `lib/build-all.js:100` — drop `!e.code.startsWith('_anon_')` clause from filter.
- `bin/compose.js:835/848/886` — drop three `_anon_` filter sites (dead code).
- `scripts/import-roadmap.mjs:58/74/93` — drop the import-as-task branch entirely; entries are all typed by construction. (Iter-9 correction: line 92/93 sets featureCode in POST body, not a feature.json write — adjust per actual semantics.)
- `contracts/roadmap-row.schema.json:5,13` — update description text to reflect new contract (anonymous rows absent from validator input by construction; not a schema field change).
- `lib/feature-validator.js:72` — rewrite the workaround-comment block (carry-forward iter-8/9; current text references `_anon_*` and would trigger the step-10 grep).
- `test/feature-validator.test.js:340` — rewrite test to assert "rows whose Feature column doesn't match `FEATURE_CODE_RE_STRICT` are absent from `parseRoadmap()` output and skipped by validation."
**Test:** Existing tests for affected paths must still pass post-edit. Plus new test for `addRoadmapEntry()` into missing phase (covers T11's new-phase insertion).
**Acceptance:** All consumer-site tests green. `rg '_anon_' lib bin scripts server` returns zero hits. `rg '_anon_' test` returns only `test/feature-code.test.js:28,48` (allowed strict-rejection cases).
**Depends on:** T6.

#### T14 — Drift event integration test `(new)`
**File:** Append to `test/roadmap-drift.test.js` (created in T10).
**Action:** Integration test: feature.json all-COMPLETE under a phase whose heading still says `PARTIAL (...)` → run `writeRoadmap()` → assert (a) heading retains `PARTIAL (...)` (override wins), (b) `feature-events.jsonl` has one new `roadmap_drift` row with correct fields, (c) stderr received warn message. Plus no-drift case: rollup matches override → no event written.
**Test:** Self-contained integration test.
**Acceptance:** Both cases green.
**Depends on:** T10, T11.

### `=== ATOMIC COMMIT BOUNDARY END ===`

### Post-rewrite

#### T15 — Add `contracts/preserved-section.schema.json` `(new)`
**File:** `contracts/preserved-section.schema.json`
**Action:** Write the trivial JSON schema per blueprint Section F. Documents marker shape; consumed by `validatePreservedSections()` in T16.
**Test:** N/A (data file).
**Acceptance:** Schema lints valid JSON; `_id` field present.
**Depends on:** T1 (no, none — but logically lands with T16).

#### T16 — Extend `lib/feature-validator.js` with marker balance check `(existing)`
**File:** `lib/feature-validator.js`
**Action:** Add `validatePreservedSections(text)` per blueprint Section G:
- String-level scan for `<!-- preserved-section: <id> -->` open/close pairs.
- Cases: balanced markers pass; unbalanced markers fail (validation error); duplicate ids warn but pass; empty marker body warns but passes.
- Hook into `validateProject()` at line 608.
**Test:** Add `test/feature-validator-preserved-sections.test.js`. Cases: 4 markers in `ROADMAP.md` pass; tampered fixture (open without close) fails.
**Acceptance:** Validator green on real ROADMAP.md; tampered fixtures fail with clear error messages.
**Depends on:** T6, T15. Tests need T6 in place because validator imports `parseRoadmap`.

#### T17 — Bootstrap path test `(new)`
**File:** Append to `test/feature-writer.test.js` (existing test file).
**Action:** Test: empty workspace → `addRoadmapEntry({code: 'TEST-1', ...})` → assert resulting `ROADMAP.md` contains `<!-- preserved-section: roadmap-conventions -->` markers (no-ROADMAP bootstrap default ships with markers).
**Test:** Self-contained.
**Acceptance:** Test green.
**Depends on:** T11.

#### T18 — Final acceptance grep `(verification)`
**File:** N/A.
**Action:** From compose root: `rg -n '_anon_' lib bin scripts server` returns zero. `rg -n '_anon_' test contracts` returns only the strict-rejection cases at `test/feature-code.test.js:28,48`. Also: `npm test` full suite green.
**Test:** Manual verification step.
**Acceptance:** Both greps satisfy the criteria above; full test suite green.
**Depends on:** T13, T14, T16, T17.

#### T19 — Manual smoke test `(verification)`
**File:** N/A.
**Action:** From compose root: `node -e "import('./lib/roadmap-gen.js').then(m => m.writeRoadmap(process.cwd()))"`. Inspect `git diff ROADMAP.md`.
**Test:** Manual.
**Acceptance:** Zero changes inside the 4 preserved subtrees + every anonymous tableRow. At-most cosmetic deltas (column padding, whitespace) inside typed-feature tables. No content changes (codes, descriptions, statuses).
**Depends on:** T18.

#### T20 — Delete POC scratch file `(existing)`
**File:** `scratch/remark-roundtrip-poc.mjs`
**Action:** Delete; not part of the shipped surface.
**Test:** N/A.
**Acceptance:** File absent; no broken imports.
**Depends on:** T19.

## Atomic Commit Composition

Tasks T4–T14 land as one atomic commit. Reasoning per blueprint: marker-wrap before writer is marker-aware would strand open markers in current `readPreamble()` slice; combined commit avoids transient broken state.

T1 (deps), T2 (POC spike — file deleted before commit), T3 (baseline snapshot test) land separately before the atomic commit so each is independently reviewable.

T15 (schema), T16 (validator), T17 (bootstrap test) can land in the atomic commit OR as a follow-up commit — they don't change parser/writer behavior and can be re-tested in isolation.

T18 + T19 are verification steps, not commits.

T20 cleanup commit drops the POC scratch.

## Risk-to-Task Mapping

Blueprint risks 1–4 have explicit task coverage:

| Risk | Task |
|---|---|
| R1: Round-trip fidelity unproven | T2 POC + T9 golden test |
| R2: `_anon_` references in untracked code | T13 sweep + T18 grep |
| R3: GFM edge cases | T9 covers all rows in current ROADMAP.md including strikethrough/backticks |
| R4: Drift event spam | T10 dedupe + T14 integration test |

## TDD Discipline

For each task with a test:
1. Write the test first.
2. Run it. Watch it fail.
3. Implement the code.
4. Run again. Watch it pass.
5. Commit only after pass.

For non-test tasks (T1 deps, T4/T5 markup, T15 schema, T20 cleanup):
1. Make the change.
2. Run `npm test` — full suite green.
3. Commit.

## Estimated Effort

- T1–T3: ~30min combined (deps + spike + baseline)
- T4–T14 atomic: ~6–10 hours (parser + writer rewrite is the bulk)
- T15–T17: ~1–2 hours
- T18–T20: ~30min verification + cleanup

Total: ~8–13 hours of focused work. Heavy refactor; not a quick PR.

## Spike-or-Stop Gate

**T2 (POC) is a hard gate.** If `mdast-util-to-markdown` cannot byte-preserve source-slice subtrees as designed, Decision 1 (switch to remark/unified) doesn't pay off. Stop, escalate, and reconsider — the alternative is hand-rolled augmentation (Decision 1 Option A originally rejected).
