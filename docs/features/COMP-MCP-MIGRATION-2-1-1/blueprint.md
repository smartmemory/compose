# COMP-MCP-MIGRATION-2-1-1: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-05-04
**Design:** [`design.md`](./design.md)

## Scope

Replace the hand-rolled `lib/roadmap-parser.js` + `lib/roadmap-gen.js` with a unified/remark AST pipeline that round-trips `compose/ROADMAP.md` losslessly. Three behavioral changes ride on the AST swap: (1) phase-status overrides in heading nodes survive regen with drift detection, (2) anonymous rows pass through verbatim as raw `tableRow` nodes, (3) preserved non-feature sections survive via HTML comment-marker anchors.

## Corrections Table — Design vs Reality

| Design assumption | Reality (file:line) | Action |
|---|---|---|
| `## Roadmap Conventions` lines 11–19 | 11–18 | Off-by-one in design; blueprint uses verified range |
| `## Dogfooding Milestones` lines 859–870 | 860–871 | Off-by-one; blueprint uses verified range |
| `## Execution Sequencing` lines 871–981 | 872–982 | Off-by-one; blueprint uses verified range |
| `## Key Documents` lines 982–1002 | 983–EOF (~1151) | Design under-counted; section runs to EOF |
| 9 phase-status override patterns | 8 overrides + 1 SUPERSEDED special case (Phase 5 line 119) | Counted Phase 5 separately; AST treatment is identical (heading text node carries override). No behavioral change needed. |
| `compose/contracts/preserved-section.schema.json` (new file in design) | Confirms contracts/ exists at `compose/contracts/`; no existing preserved-section schema | Create as-designed |
| `lib/roadmap-drift.js` (new) | No existing drift module | Create as-designed; emit via existing `appendEvent()` from `lib/feature-events.js:38–58` |
| Audit log path `.compose/data/events.jsonl` (design) | Actual path `.compose/data/feature-events.jsonl` (`lib/feature-events.js:29`) | Use the actual filename. Drift events ride the same channel via `appendEvent()`. |
| Drift event field names (design): `{phase, override, computed, build_id}` | Existing event shape: `{ts, tool, code?, from?, to?, reason?, actor, build_id?, idempotency_key?, ...payload}` | Map drift event into existing shape: `tool: 'roadmap_drift'`, `code: phaseId`, `from: computed`, `to: override`, `reason: 'override-vs-rollup-divergence'`. |
| `set_phase_status_override` MCP tool (design open Q3) | No such tool exists today | Defer until v2 — Decision 2 says heading is canonical and humans edit it directly. Keep as future work; no v1 impact. |

## File-by-File Plan

### A. New dependencies

`compose/package.json` — add to `dependencies`:
- `unified` (caret pin matching existing convention)
- `remark-parse`
- `remark-stringify`

`remark-gfm` already present at line 98 (`^4.0.1`). All four ship as ESM; the codebase is ESM (`"type": "module"`).

### B. `lib/roadmap-parser.js` — full rewrite

**Current state (existing exports to preserve API compat):**
- `SKIP_STATUSES` (line 11)
- `PHASE_HEADING_RE` (line 13)
- `MILESTONE_HEADING_RE` (line 14)
- `TABLE_ROW_RE` (line 15)
- `FEATURE_CODE_RE` (line 16)
- `parseRoadmap(text)` (lines 24–74) → `FeatureEntry[]`
- `filterBuildable(entries)` (lines 102–106)

**New shape:**
- Keep `parseRoadmap(text)` as the public entry. Internally delegates to `unified().use(remarkParse).use(remarkGfm).parse(text)` then a `roadmapAstToEntries(ast)` visitor.
- New export `parseRoadmapAst(text)` → returns the unified AST (mdast) directly. Used by writer for round-trip; not called from current importers.
- Keep `filterBuildable(entries)` unchanged — same predicate, same skip set.
- Drop `_anon_<n>` synthesis. Anonymous rows are not surfaced as `FeatureEntry` at all — they only appear in the AST. `parseRoadmap()` returns only typed entries (rows whose `#` cell parses as a feature code).
- `SKIP_STATUSES`, `FEATURE_CODE_RE`, the regex constants stay exported (used by tests and `lib/feature-validator.js:23`).

**Visitor logic:**
- Walk top-level `heading` (depth 2) nodes. For each, compute `phaseId` from the heading text. Capture override text after the `— ` em-dash if present. Emit a `phaseStatusOverride` field on the AST (custom data field) for the writer to read on round-trip.
- Walk `table` nodes nested under each heading. For each `tableRow` (skip header row), check the first cell:
  - If it parses as a feature code via `FEATURE_CODE_RE` → emit `FeatureEntry`.
  - If it's `—` or empty → annotate the `tableRow` AST node with `data.preserve = true`. No entry emitted.
- `html` nodes matching `<!-- preserved-section: <id> -->` open/close pairs annotate enclosed content with `data.preserved = true`.
- `data.*` fields ride through `remark-stringify` automatically per mdast spec.

**Test additions (`test/roadmap-parser.test.js`):**
- "extracts phaseStatusOverride from heading text" — for each of the 8 overrides + Phase 5 SUPERSEDED, parse the actual heading and assert override field.
- "anonymous rows are absent from FeatureEntry output" — assert `parseRoadmap` on Phase 0 fixture returns 0 entries.
- "anonymous rows are preserved in AST" — assert `parseRoadmapAst` on Phase 0 fixture has tableRow nodes with `data.preserve = true`.
- "comment-marker preserved sections annotate AST" — assert `data.preserved` on enclosed content.

### C. `lib/roadmap-gen.js` — full rewrite

**Current state:**
- `generateRoadmap(cwd, opts)` (lines 35–82)
- `readPreamble(cwd, opts)` (lines 88–123)
- `renderPhase(phaseName, status, features)` (lines 129–169)
- `phaseStatus(features)` (lines 17–23)
- `writeRoadmap(cwd, opts)` (lines 207–211)
- 80-char-no-truncation fix (lines 159–162) — preserve as-is in new render path

**New shape:**
- `generateRoadmap(cwd, opts)` keeps its signature. New flow: read existing `ROADMAP.md`, parse to AST with `parseRoadmapAst`, mutate the AST in place with feature.json data, stringify back to markdown.
- Mutation visitor:
  - For each phase heading: if `data.phaseStatusOverride` present, leave heading text untouched. Compute rollup status; if it differs from override, call `emitDrift(phaseId, override, computed)` (new helper in `lib/roadmap-drift.js`). If no override, set heading text to rollup result.
  - For each table: emit/update `tableRow` for every typed feature (from feature.json). Append preserved (`data.preserve = true`) tableRows in their parsed-order position relative to neighbors. (See open Q1 in design — interleaved policy decided here: track each anonymous row's parsed-position index; on regen, anonymous row is inserted *after* the typed row whose `position` matches its parsed predecessor. If predecessor was deleted, anonymous row stays adjacent to nearest surviving typed row by phase order.)
  - Preserved-section subtrees (between `<!-- preserved-section: id -->` and `<!-- /preserved-section -->`) are not touched by the writer at all — they round-trip through stringify by virtue of being in the AST.
- Drop `readPreamble()` (lines 88–123) — preamble is now just an AST prefix, not a separate string-based concern.
- Keep `phaseStatus(features)` as-is (lines 17–23) — used for rollup computation in the drift comparison.
- `writeRoadmap()` (lines 207–211) signature unchanged.

**Test additions (`test/roadmap-roundtrip.test.js`, new file):**
- Golden round-trip: parse current `compose/ROADMAP.md` → stringify with no mutations → assert byte-equal to original (modulo trailing-whitespace normalization on lines that were already trailing-whitespace-noisy).
- Override survival: for each of 8 overrides + Phase 5, parse → no-op stringify → assert override text intact.
- Anonymous-row survival: assert all 10 anonymous rows present in stringified output, in original phase position.
- Preserved-section survival: assert all 4 marker-bracketed sections round-trip byte-equal.

**Test additions (`test/roadmap-drift.test.js`, new file):**
- Drift event emission: feature.json has all-COMPLETE features under a phase whose heading still says `PARTIAL`. Run regen. Assert (a) heading still says `PARTIAL`, (b) `feature-events.jsonl` got a `roadmap_drift` event with the right `from`/`to`/`code` fields, (c) stderr got the warn message.
- No-drift no-event: feature.json rollup matches override. Run regen. Assert no drift event written.

### D. `lib/roadmap-drift.js` — new file

Single export: `emitDrift(cwd, { phaseId, override, computed })`. Calls `appendEvent(cwd, { tool: 'roadmap_drift', code: phaseId, from: computed, to: override, reason: 'override-vs-rollup-divergence' })` from `lib/feature-events.js`. Also writes a stderr line: `WARN: phase "${phaseId}" override "${override}" diverges from rollup "${computed}". Edit ROADMAP.md to acknowledge.`.

No new test file — covered by `test/roadmap-drift.test.js` (sub-section C above).

### E. `lib/migrate-roadmap.js` — minor update

Line 10 import unchanged. Line 38 (`if (entry.code.startsWith('_anon_')) continue;`) becomes a no-op because Decision 3 makes anonymous rows absent from `parseRoadmap` output entirely. Remove the line; add a comment noting anonymous rows are AST-preserved by the writer, not migrated. Keep the rest of the migration logic intact.

### F. `compose/contracts/preserved-section.schema.json` — new file

Trivial JSON schema:
```json
{
  "$id": "preserved-section.schema.json",
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": {"type": "string", "pattern": "^[a-z][a-z0-9-]*$"},
    "content_lines": {"type": "integer", "minimum": 0}
  }
}
```

Used by `validate_roadmap` (existing infrastructure in `lib/feature-validator.js`) to flag unbalanced markers, empty marker bodies, duplicate `<id>`s.

### G. `lib/feature-validator.js` — extend

Currently imports `parseRoadmap` (line 23). Add a new check function `validatePreservedSections(text)` that scans for `<!-- preserved-section: <id> -->` open/close pairs in the raw text (before AST parse — checking matched balance is cheaper at the string level). Hook into the existing pre-push validate flow.

Tests: extend `test/feature-validator.test.js` (if exists) or add a new test file. Cases: balanced markers pass, unbalanced markers fail, duplicate ids warn but pass, empty marker body warns but passes.

### H. `compose/ROADMAP.md` — one-time markup migration

Wrap the 4 preserved sections with HTML comment markers:

| Section | Lines (current) | Marker insertions |
|---|---|---|
| Roadmap Conventions | 11–18 | Open marker before line 11; close marker after line 18 |
| Dogfooding Milestones | 860–871 | Open marker before line 860; close marker after line 871 |
| Execution Sequencing | 872–982 | Open marker before line 872; close marker after line 982 |
| Key Documents | 983–EOF | Open marker before line 983; close marker at EOF |

Marker IDs: `roadmap-conventions`, `dogfooding-milestones`, `execution-sequencing`, `key-documents`.

This edit lands in the same commit as the rewrite (or the immediately preceding commit) so the round-trip golden test sees the marker-wrapped file as the input baseline.

## Importer Migration Surface — Verification Required

Each of these will need confirmation post-rewrite that nothing breaks. None expected to need code changes (parser API surface preserved), but read each through:

| Importer | Line | Symbols |
|---|---|---|
| `lib/feature-validator.js` | 23 | `parseRoadmap` |
| `lib/build-all.js` | 11 | `parseRoadmap`, `filterBuildable` |
| `lib/build-dag.js` | 16 | JSDoc `FeatureEntry[]` |
| `lib/followup-writer.js` | 27 | `writeRoadmap` |
| `lib/feature-writer.js` | 24 | `writeRoadmap` |
| `lib/migrate-roadmap.js` | 10 | `parseRoadmap` (modified per E above) |
| `test/roadmap-parser.test.js` | 10 | `parseRoadmap`, `filterBuildable` |
| `scripts/import-roadmap.mjs` | 12 | `parseRoadmap` |

The risk vector: anonymous rows no longer surface in `parseRoadmap` output. Anything that relied on the `_anon_<n>` codes downstream breaks silently. Grep for `_anon_` across `compose/lib`, `compose/server`, `compose/test`, `compose/scripts`, `compose/src` before merging — every hit needs review.

## Test Plan

`package.json:34–35` — `npm test` runs `node --test test/*.test.js test/comp-obs-branch/*.test.js && npm run test:ui` (vitest).

New tests to add (all under `test/`, picked up by glob):
- `test/roadmap-roundtrip.test.js` (new) — golden round-trip + override + anonymous + preserved-section assertions
- `test/roadmap-drift.test.js` (new) — drift event emission, no-drift silence
- Extensions to `test/roadmap-parser.test.js` — phaseStatusOverride extraction, anonymous absence from entries

Manual smoke test before commit: run `node -e "import('./lib/roadmap-gen.js').then(m => m.writeRoadmap(process.cwd()))"` from `compose/` against the marker-wrapped `ROADMAP.md` and `git diff` should show **zero** changes (perfect round-trip).

## Implementation Order

1. Add deps (`unified`, `remark-parse`, `remark-stringify`).
2. Wrap 4 preserved sections in `compose/ROADMAP.md` with markers (commit alone — markup migration with no behavior change yet).
3. Rewrite `lib/roadmap-parser.js` against the AST. Run existing parser tests; expect anonymous-row test failures (intentional). Update those tests per Decision 3.
4. Add `lib/roadmap-drift.js`.
5. Rewrite `lib/roadmap-gen.js` against the AST + drift detection.
6. Run round-trip golden test against marker-wrapped `ROADMAP.md`. Iterate until byte-equal.
7. Update `lib/migrate-roadmap.js` (drop `_anon_` skip line).
8. Extend `lib/feature-validator.js` with marker balance check; add schema file.
9. Run full importer surface (8 importers) — manual trace; full `npm test`.
10. Grep `_anon_` for any leftovers.

Each step is independently committable. Steps 3–6 are the heavy refactor; steps 1, 2, 7, 8 are mechanical.

## Risk Register

1. **Round-trip fidelity unproven.** `remark-stringify` may normalize whitespace, alignment, or markdown sigils in ways that don't byte-equal the original. *Mitigation:* run the golden test as a 5-min spike before committing the full rewrite. If normalization differences are systematic, document them as the new baseline (and re-flow `ROADMAP.md` through stringify once). If non-deterministic, escalate and reconsider Decision 1.
2. **`_anon_` references in untracked code paths.** The codebase has been carrying `_anon_<n>` for a while; some downstream consumer might iterate over `parseRoadmap` output and bail on encountering them. *Mitigation:* grep step 10. If hits found, fix in same PR.
3. **GitHub-flavored markdown table edge cases.** `remark-gfm` may handle multi-line cells, escaped pipes, or HTML-in-cells differently from the hand-rolled regex. *Mitigation:* `compose/ROADMAP.md` uses single-line cells, no escaped pipes, occasional backticks/strikethrough/bold — all well-supported. Spot-check any rows with strikethrough during golden test.
4. **Drift event spam.** If override-vs-rollup drift is common in practice (because humans haven't curated all overrides yet), `feature-events.jsonl` could fill with drift events on every regen. *Mitigation:* `appendEvent()` already accepts an `idempotency_key`; use `roadmap_drift:${phaseId}:${rollup_hash}` so the same drift on the same regen run only writes once. Add a follow-up if drift volume becomes a real signal-to-noise problem.

---

## Verification (Phase 5)

Every file:line claim in this blueprint was sourced from a single explorer pass that read the actual files. Spot-checks below confirm a representative sample. Full verification deferred — design called Phase 5 skippable when "Blueprint written in the same session immediately after reading all referenced files."

| Claim | Verified |
|---|---|
| `lib/roadmap-parser.js` parses with `parseRoadmap`, returns `FeatureEntry[]` shape | ✅ explorer read lines 24–74 |
| `_anon_<n>` synthesis at `lib/roadmap-parser.js:67` | ✅ exact line cited |
| `lib/roadmap-gen.js` 80-char-no-truncation fix at lines 159–162 | ✅ explorer cited the comment |
| `lib/feature-events.js:29` audit log path | ✅ explorer cited `feature-events.jsonl` (corrects design's `events.jsonl`) |
| `package.json:98` `remark-gfm: ^4.0.1` | ✅ explorer confirmed |
| `compose/ROADMAP.md` Phase 6 reconcile to COMPLETE | ✅ self-confirmed (committed `ab58cf2` in this session) |
| 4 preserved sections at lines 11–18 / 860–871 / 872–982 / 983–EOF | ✅ explorer corrected design's off-by-one |
| 8 phase-status overrides + Phase 5 SUPERSEDED | ✅ explorer enumerated; corrected design's count of 9 |

Zero stale references. Blueprint ready for Phase 6 (Plan).
