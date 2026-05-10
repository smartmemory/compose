# COMP-GSD-1: Boundary Map — Implementation Plan

**Status:** PLAN
**Date:** 2026-05-10

## Related Documents

- Design (REVIEW CLEAN, contract): [`design.md`](./design.md)
- Blueprint (verified): [`blueprint.md`](./blueprint.md)
- Test conventions mirrored: `test/feature-validator.test.js` (`node:test` style, `mkdtempSync` fixtures)
- Roadmap: `../../../../ROADMAP.md` § COMP-GSD-1

> Paths relative to compose package root (`/Users/ruze/reg/my/forge/compose`).

---

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `lib/boundary-map.js` | new | Parser + four-check validator |
| `test/boundary-map.test.js` | new | `node --test` suite covering parse + each violation/warning kind |
| `.claude/skills/compose/templates/boundary-map.md` | new | Authoring template + grammar + worked example |
| `.claude/skills/compose/SKILL.md` | edit | Phase 4 + Phase 5 prompt updates (lines 176-186, 188-201) |
| `pipelines/build.stratum.yaml` | edit | Verification step intent references the validator (lines 277-291) |
| `docs/features/COMP-MCP-MIGRATION-2-1-1/blueprint.md` | edit | Retroactive Boundary Map annotation as worked example (target swapped from COMP-OBS-STREAM per Phase 5 verification: this blueprint already has a real `## File-by-File Plan`, so the validator runs end-to-end against real File-Plan rows) |
| `../ROADMAP.md` (forge-top) | edit | File three follow-up tickets under Standalone Tickets |

---

## Phase A — Pure logic: parser

### T01 — Write parser tests
- **File(s):** `test/boundary-map.test.js` (new)
- **What to do:** Author `node:test` cases for `parseBoundaryMap`. Mirror import header from `test/feature-validator.test.js:1-15`. No implementation yet — all cases must fail (or error on missing module).
- **Test first:** This task is the tests.
- **Acceptance:**
  - [ ] Imports `parseBoundaryMap` from `../lib/boundary-map.js`
  - [ ] Case: parses valid 3-slice auth example from design (`design.md:48-74`) — asserts `slices.length === 3`, S01.leaf, kind extraction
  - [ ] Case: parses leaf slice via `Consumes: nothing (leaf node)` — `slices[0].leaf === true`, `consumes.length === 0`
  - [ ] Case: parses sink slice via `Produces: nothing (integration only)` — `sink === true`, `produces.length === 0`
  - [ ] Case: accepts U+2192 `→` arrow — fixture parses
  - [ ] Case: accepts ASCII `->` arrow — same fixture parses identically
  - [ ] Case: duplicate `### S01` heading produces parse violation `{ kind: "duplicate_slice_id", scope: "parse" }`
  - [ ] Case: malformed Produces line missing `(<kind>)` produces `{ kind: "missing_kind", scope: "parse" }`
  - [ ] Case: blueprint with no `## Boundary Map` returns `{ slices: [], parseViolations: [] }`
  - [ ] Tests run via `node --test test/boundary-map.test.js` and currently fail because module is absent (or all tests assert)
- **Depends on:** —

### T02 — Implement `parseBoundaryMap`
- **File(s):** `lib/boundary-map.js` (new)
- **What to do:** ESM module with `export function parseBoundaryMap(blueprintText)`. Line-based scan per blueprint §1. Locate `^## Boundary Map\s*$`; walk until next `^## ` or EOF; state machine over `### S\d{2,}` headings and `Produces:` / `Consumes:` block headers; entry regex per blueprint (Produces requires `(<kind>)`; Consumes ignores trailing parenthetical). Accept both `→` and `->`. Emit parse violations for duplicate slice IDs, missing kind, malformed entries.
- **Test first:** T01.
- **Acceptance:**
  - [ ] All T01 tests pass via `node --test test/boundary-map.test.js`
  - [ ] Module is ESM (`export function …`), no `module.exports`
  - [ ] Returns `{ slices: Slice[], parseViolations: Violation[] }` shape per blueprint
  - [ ] Both `→` and `->` arrow forms parse identically (one fixture asserted twice with each form)
  - [ ] Duplicate slice ID first-occurrence-wins; second occurrence still parses for further error reporting but is not used downstream
- **Depends on:** T01

---

## Phase B — Pure logic: validator checks (sequential)

> T03–T06 each pair a check's tests with its implementation. Although the four checks are conceptually independent (different internal helpers), every task touches the same two files (`lib/boundary-map.js` and `test/boundary-map.test.js`), so they execute **sequentially** to avoid merge conflicts and TDD churn. T07 orchestrates them after all four land.

### T03 — File-Plan-or-disk check
- **File(s):** `test/boundary-map.test.js` (existing), `lib/boundary-map.js` (existing)
- **What to do:** Implement `_checkFilesAgainstPlan(slices, blueprintText, repoRoot)`. Parse File Plan section under heading aliases `["## File Plan", "## Files", "## File-by-File Plan"]` (first match wins). Extract `(file, action)` from markdown table rows; strip backticks. Normalize action: leading whitespace-token, lowercased, trailing `[.,;:]+` stripped. Allow-list write actions: `{new, create, add, edit, modify, update, refactor, replace}`. Emit `missing_file` violation when file is neither in File Plan with allow-listed action nor exists on disk. Emit `no_file_plan` warning (scope: "blueprint") when no heading alias found. Emit `unknown_action` warning (scope: "file-plan", deduped per file) for unrecognized leading verbs.
- **Test first:**
  - [ ] Test: `missing_file` — file absent from disk and File Plan
  - [ ] Test: pass — file in File Plan with `new` action, no disk file
  - [ ] Test: pass — file on disk, no File Plan entry
  - [ ] Test: alias `## Files` recognized
  - [ ] Test: alias `## File-by-File Plan` recognized
  - [ ] Test: action `MODIFY (existing, 119 lines)` normalizes to `modify` and passes
  - [ ] Test: `no_file_plan` warning emitted exactly once when no heading present, file-disk fallback applied
  - [ ] Test: `unknown_action` warning per row with verb like `reference`, deduplicated by file
- **Acceptance:**
  - [ ] All listed test cases pass
  - [ ] Heading-alias selection: first occurrence in document order wins
  - [ ] `unknown_action` warnings carry `scope: "file-plan"`, populate `file`, omit `slice`/`symbol`
  - [ ] `no_file_plan` warning carries `scope: "blueprint"`, omits all locator fields
  - [ ] `missing_file` violation carries `scope: "entry"`, populates `slice` and `file`
- **Depends on:** T02

### T04 — Symbol-presence check
> Sequenced after T03 — same files. Do not run in parallel with T03.
- **File(s):** `test/boundary-map.test.js` (existing), `lib/boundary-map.js` (existing)
- **What to do:** Implement `_checkSymbolPresence(slices, filePlanIndex, repoRoot)`. For each Produces/Consumes entry: skip if file is in File Plan with allow-listed write action; else if file exists on disk, substring-grep each declared symbol. Miss → `missing_symbol` violation (`scope: "entry"`, `slice`, `file`, `symbol`).
- **Test first:**
  - [ ] Test: `missing_symbol` when file on disk lacks symbol identifier and file is NOT in File Plan
  - [ ] Test: skip — file listed in File Plan as `new` even if file on disk is empty/missing the symbol
  - [ ] Test: skip — file listed in File Plan as `modify` (allow-listed)
  - [ ] Test: pass — file on disk contains symbol substring (even in a comment — name-mention guarantee)
- **Acceptance:**
  - [ ] All listed test cases pass
  - [ ] Substring grep (no regex anchoring) per design v1 guarantee
  - [ ] One violation per missing symbol per entry
- **Depends on:** T03

### T05 — Topology check
> Sequenced after T04 — same files. Do not run in parallel with T04.
- **File(s):** `test/boundary-map.test.js` (existing), `lib/boundary-map.js` (existing)
- **What to do:** Implement `_checkTopology(slices)`. For each Consumes entry on slice S_i with `from: S_j`: if S_j has no heading anywhere → `dangling_consume`; if S_j exists but appears at index ≥ i → `forward_reference`. Backward-only edges acyclic by construction; no cycle pass.
- **Test first:**
  - [ ] Test: `dangling_consume` when `from S99:` references a slice ID that has no heading
  - [ ] Test: `forward_reference` when S01 consumes from S02 (later in document order)
  - [ ] Test: pass — S02 consumes from S01 (backward edge)
  - [ ] Test: self-reference (S01 consumes from S01) flagged as `forward_reference`
- **Acceptance:**
  - [ ] All listed test cases pass
  - [ ] Violation `scope: "entry"`, populates `slice`
- **Depends on:** T04

### T06 — Producer/consumer match check
> Sequenced after T05 — same files. Do not run in parallel with T05.
- **File(s):** `test/boundary-map.test.js` (existing), `lib/boundary-map.js` (existing)
- **What to do:** Implement `_checkProducerConsumerMatch(slices)`. For each Consumes entry `(from S_j, file F, symbols [s…])`: require a Produces entry on S_j with the same file path whose symbol set is a superset. Else emit one `producer_consumer_mismatch` violation per missing symbol.
- **Test first:**
  - [ ] Test: pass — consumer's symbol is in producer's symbol list
  - [ ] Test: `producer_consumer_mismatch` when consumed symbol absent from producer's set; `symbol` field populated
  - [ ] Test: `producer_consumer_mismatch` when consumed file path doesn't appear in producer's Produces entries (one violation per consumed symbol)
  - [ ] Test: multi-symbol consume — only the missing symbol(s) flagged, present ones pass silently
- **Acceptance:**
  - [ ] All listed test cases pass
  - [ ] One violation per missing symbol (not one per entry)
  - [ ] Violation populates `slice`, `file`, `symbol`
- **Depends on:** T05

### T07 — Orchestrator `validateBoundaryMap`
- **File(s):** `test/boundary-map.test.js` (existing), `lib/boundary-map.js` (existing)
- **What to do:** Public `validateBoundaryMap({ blueprintText, blueprintPath, repoRoot })`. Calls `parseBoundaryMap` then T03→T04→T05→T06 in order. Concatenate parse violations + entry violations into `violations`; collect warnings. `ok = violations.length === 0`. No `## Boundary Map` → `{ ok: true, violations: [], warnings: [] }`.
- **Test first:**
  - [ ] Test: single-unit blueprint (no `## Boundary Map`) → `ok: true`, empty arrays
  - [ ] Test: warnings-only fixture (e.g. `no_file_plan` + valid map) → `ok: true`, warnings populated
  - [ ] Test: parse violation surfaces in `violations` with `scope: "parse"`
  - [ ] Test: entry violation surfaces with `scope: "entry"`
  - [ ] Test: full valid 3-slice fixture (auth example, files mocked into tmp repo) → `ok: true, violations: [], warnings: []`
- **Acceptance:**
  - [ ] `ok` is `false` iff `violations` is non-empty
  - [ ] Warnings never set `ok: false` (asserted)
  - [ ] Check order: parse → file-plan-or-disk → symbol-presence → topology → producer/consumer
  - [ ] `Violation` and `Warning` shapes match design acceptance criteria (scope/slice/file/symbol fields)
  - [ ] Tests use `mkdtempSync` fixtures per `feature-validator.test.js:8-14` pattern
- **Depends on:** T03, T04, T05, T06

---

## Phase C — Integration: skill + pipeline (sequential, different files)

### T08 — Boundary Map authoring template
- **File(s):** `.claude/skills/compose/templates/boundary-map.md` (new)
- **What to do:** Write template per blueprint §3. Include: format spec (verbatim from `design.md:48-74`), grammar bullets (Produces/Consumes line shapes, leaf/sink sentinels, kind allow-list), one worked example (auth-primitives 3-slice), "When to author" guidance, symbol-only restriction note.
- **Test first:** Manual review only — markdown content has no automated test, but the worked example must validate cleanly when fed to `validateBoundaryMap` (covered by T07's auth-example fixture).
- **Acceptance:**
  - [ ] File exists at the planned path
  - [ ] Format spec matches `design.md:48-74` verbatim
  - [ ] Kind allow-list listed: `interface, type, function, class, const, hook, component`
  - [ ] Worked example includes a leaf slice
  - [ ] "When to author" rule: 2+ work units → append `## Boundary Map` after `## File Plan`
  - [ ] Symbol-only restriction note present (endpoints/payloads/invariants stay in prose)
- **Depends on:** T07

### T09 — SKILL.md Phase 4 edit
- **File(s):** `.claude/skills/compose/SKILL.md` (existing, lines 176-186)
- **What to do:** Append the additive Boundary Map bullet from `blueprint.md:206`. Restrict entry kinds to symbols.
- **Test first:** Diff inspection — no automated test for prose changes.
- **Acceptance:**
  - [ ] Phase 4 section gains exactly one new bullet referencing `templates/boundary-map.md`
  - [ ] Bullet enumerates the kind allow-list
  - [ ] Bullet states endpoints/payloads/invariants belong in prose, not entries
  - [ ] Existing gate text unchanged
- **Depends on:** T08

### T10 — SKILL.md Phase 5 edit
- **File(s):** `.claude/skills/compose/SKILL.md` (existing, lines 188-201)
- **What to do:** Insert the Boundary Map verification paragraph from `blueprint.md:242` between the existing checklist and the "Produce a verification table" line. Update gate text to require zero Boundary Map violations (warnings allowed). Update skip-when to require absent Boundary Map.
- **Test first:** Diff inspection.
- **Acceptance:**
  - [ ] Phase 5 references `validateBoundaryMap` from `lib/boundary-map.js`
  - [ ] Names all four checks: File-Plan-or-disk, symbol presence, topology, producer/consumer match
  - [ ] Gate text: "Zero Boundary Map violations (warnings allowed)"
  - [ ] Skip-when clause requires "no Boundary Map" in addition to existing condition
- **Depends on:** T09

### T11 — Pipeline verification step intent
- **File(s):** `pipelines/build.stratum.yaml` (existing, lines 277-291)
- **What to do:** Replace `intent:` text with the proposed text from `blueprint.md:282-289`. Structure (id, agent, inputs, output_contract, ensure, retries, on_fail, depends_on) unchanged.
- **Test first:** YAML syntax check via existing pipeline-validation flow if present; otherwise manual diff.
- **Acceptance:**
  - [ ] Intent mentions `validateBoundaryMap` and `lib/boundary-map.js`
  - [ ] Intent treats violations as stale references and warnings as informational
  - [ ] Boundary Map results are summarized inside the existing `PhaseResult.summary` string field (the contract at `pipelines/build.stratum.yaml:23` defines `PhaseResult` as `{phase, artifact, outcome, summary}` — do NOT add a new top-level field; widening that contract is out of scope for COMP-GSD-1 and would touch every step that returns it)
  - [ ] YAML still parses (no schema regressions in CI / pipeline lint)
  - [ ] Step structure (id `verification`, depends_on `[blueprint]`, retries 2, on_fail `blueprint`) unchanged
- **Depends on:** T10

---

## Phase D — Dogfood

### T12 — Retroactive Boundary Map on COMP-MCP-MIGRATION-2-1-1
- **File(s):** `docs/features/COMP-MCP-MIGRATION-2-1-1/blueprint.md` (existing)
- **What to do:** Append a `## Boundary Map` section to the blueprint reflecting its actual multi-slice structure. Use the existing `## File-by-File Plan` (line 30) as the File-Plan source the validator will check against. **Target swapped** from COMP-OBS-STREAM per Phase 5 verification of this plan's source blueprint: COMP-OBS-STREAM lacks a File Plan, which would force the validator into `no_file_plan` warning mode and skip the File-Plan-vs-disk check entirely; COMP-MCP-MIGRATION-2-1-1 has a real `## File-by-File Plan` so the validator exercises every check end-to-end.
- **Test first:** Run `validateBoundaryMap` against the edited blueprint (the actual Phase E gate). The annotation is the test fixture; the validator is the assertion.
- **Acceptance:**
  - [ ] `## Boundary Map` section inserted after `## File-by-File Plan` and before `## Implementation Order` in the target blueprint (target has `File-by-File Plan` → `Implementation Order` → `Verification Table` — no `## Corrections Table` heading; the Boundary Map slots between the file plan and the implementation-order section per design Decision 1's "after File Plan" prescription)
  - [ ] At least 2 slices, with at least one consume edge between them
  - [ ] At least one leaf slice (`Consumes: nothing`)
  - [ ] All referenced files appear in the blueprint's `## File-by-File Plan` with allow-listed actions, OR exist on disk
  - [ ] All declared symbols are name-mention-present in their named files (when files are on disk)
  - [ ] Topology: every `from S##` references an earlier slice
  - [ ] Producer/consumer match: every consumed symbol is in the matching producer's symbol set
- **Depends on:** T11

---

## Phase E — Verification

### T13 — Self-validate the dogfood
- **File(s):** none (verification only)
- **What to do:** Run `validateBoundaryMap` against `docs/features/COMP-MCP-MIGRATION-2-1-1/blueprint.md` from a small node script (or add a temporary CLI entry to `lib/boundary-map.js` so `node lib/boundary-map.js <path>` prints the result). Assert `ok === true`. If `false`, fix T12's annotation until clean.
- **Test first:** This task IS the verification of T12.
- **Acceptance:**
  - [ ] `validateBoundaryMap({ blueprintText, blueprintPath, repoRoot })` returns `ok: true` against the dogfood blueprint
  - [ ] Zero violations
  - [ ] Any warnings (e.g. `unknown_action`) are documented in this plan's Risks section, not silently ignored
- **Depends on:** T12

### T14 — Full compose test suite — no regressions
- **File(s):** none (verification only)
- **What to do:** Run `npm test` from compose package root. Confirm no pre-existing test regressed. Per `~/.claude/rules/testing.md` "Run full suite before merge."
- **Test first:** —
- **Acceptance:**
  - [ ] `npm test` exits 0
  - [ ] New `boundary-map.test.js` cases all pass
  - [ ] No previously-passing test now fails
- **Depends on:** T13

---

## Phase F — Post-merge bookkeeping (outside build contract)

> **Scope note:** T15 is bookkeeping that happens *after* the COMP-GSD-1 build deliverables (T01–T14) ship. It edits an upstream tracking artifact (`forge/ROADMAP.md`) that is intentionally outside the design's File table and the blueprint's File Plan — those documents only enumerate code/contract deliverables. T15 is run during Phase 9 (Update Docs) of the build lifecycle, not as part of Phase 7 execution. It is listed here for completeness so nothing is lost between sessions.

### T15 — File follow-up tickets in forge ROADMAP (Phase 9 docs work)
- **File(s):** `../ROADMAP.md` (existing, forge-top-level Standalone Tickets section — relative to compose root) — **outside the COMP-GSD-1 build deliverable contract; runs during Phase 9 docs, not Phase 7 execute**
- **What to do:** Append three rows to Standalone Tickets:
  1. `COMP-GSD-1-FU-EXPORT-CHECK` — Tighten symbol-presence check from substring grep to definition/export-anchored regex per kind (e.g. `^export (interface|type|function|const|class) <symbol>` for TS). Status `PLANNED`.
  2. `COMP-GSD-1-FU-TYPECHECK` — Add real `tsc --noEmit` pass for type-only Boundary Map entries; requires TS toolchain in the compose package. Status `PLANNED`.
  3. `COMP-GSD-1-FU-MARKDOWN-DOGFOOD` — The S02 self-Boundary-Map in COMP-GSD-1's own blueprint (lines 341-360) declares markdown-anchor and YAML-step-id "symbols" with kind `(const)`; v1's name-mention check passes them but the kind annotation is misleading. Tightening (per FU-EXPORT-CHECK) will surface this; either relax the kind allow-list to include `markdown-anchor`/`yaml-step-id`, or drop those entries from the self-map. Status `PLANNED`.
- **Test first:** —
- **Acceptance:**
  - [ ] Three new rows added under forge ROADMAP Standalone Tickets
  - [ ] Each row links to this feature folder
  - [ ] Status `PLANNED`, owner unset
- **Depends on:** T14

---

## Risks / Open Questions

- **Heading alias parsing edge cases.** Existing blueprints occasionally use H3 or include trailing decorations. The alias allow-list is exact-match on the line; non-canonical headings will trigger `no_file_plan` warning. Acceptable for v1 — warning nudges authors to canonicalize.
- **Substring grep false negatives are rare; false positives are common.** A symbol named `Type` or `Hook` will match any file mentioning that English word. v1 grep is case-sensitive on the identifier so PascalCase symbols are mostly safe; common-noun symbols are not. Filed as FU-EXPORT-CHECK.
- **Markdown-anchor / YAML-step-id "symbols" in dogfooding.** COMP-GSD-1's own self-Boundary-Map (in `blueprint.md:341-360`) declares non-JS identifiers under kind `(const)`. Filed as `COMP-GSD-1-FU-MARKDOWN-DOGFOOD` (T15.3).
- **Pipeline YAML edit risk.** `pipelines/build.stratum.yaml` is consumed by stratum-mcp; a malformed intent string could break the pipeline at runtime. Mitigated by T11's YAML-parse acceptance gate, but no end-to-end pipeline run is in scope for this plan.
- **Open question — should Phase 5 skip-when reflect Boundary Map presence?** Blueprint proposes "Skip when written same-session AND no Boundary Map." Reasonable; flagged in case the gate proves too strict in practice.

---

## Test Plan Summary

Snapshot/fixture cases written in `test/boundary-map.test.js` (per design acceptance criteria — at least 5 failure modes plus 1 valid + 1 warnings-only):

**Parse layer (T01):**
1. Valid 3-slice auth example parses (kinds, leaf, counts)
2. Leaf slice via `Consumes: nothing (leaf node)`
3. Sink slice via `Produces: nothing (integration only)`
4. `→` arrow form parses
5. `->` arrow form parses identically (parallel fixture)
6. Duplicate slice ID → `duplicate_slice_id` parse violation
7. Missing kind parenthetical → `missing_kind` parse violation
8. No `## Boundary Map` heading → empty result, no violations

**Validator failure modes (T03–T06):**
9. `missing_file` — file neither in File Plan nor on disk
10. `missing_symbol` — file on disk lacks symbol, file not in File Plan
11. Symbol-presence skipped for File-Plan `new` file
12. `forward_reference` — consumes from later slice
13. `dangling_consume` — consumes from non-existent slice
14. `producer_consumer_mismatch` — symbol not in producer's set
15. Self-reference flagged as `forward_reference`

**Warning surface (T03, T07):**
16. `no_file_plan` — no recognized heading, `ok: true`, file-disk fallback applied
17. `unknown_action` — File Plan row with verb like `reference`, deduped per file
18. Warnings-only fixture → `ok: true`

**Orchestration (T07):**
19. Single-unit blueprint (no map) → `ok: true`, empty arrays
20. Full valid 3-slice fixture in tmp repo → `ok: true, violations: [], warnings: []`

All cases use `mkdtempSync` fixtures per `feature-validator.test.js:8-14` and assert against `node:assert/strict`.
