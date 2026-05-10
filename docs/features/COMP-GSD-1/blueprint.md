# COMP-GSD-1: Boundary Map — Blueprint

**Status:** BLUEPRINT
**Date:** 2026-05-10

## Related Documents

- Design: [`design.md`](./design.md) (REVIEW CLEAN — contract for this blueprint)
- Roadmap: `../../../../ROADMAP.md` § COMP-GSD
- Examples mirrored: [`../COMP-MCP-MIGRATION-2-1-1/blueprint.md`](../COMP-MCP-MIGRATION-2-1-1/blueprint.md), [`../COMP-OBS-STREAM/blueprint.md`](../COMP-OBS-STREAM/blueprint.md)
- Skill prompt edits: `.claude/skills/compose/SKILL.md` (Phase 4 / Phase 5 sections)
- Pipeline edit: `pipelines/build.stratum.yaml` (verification step)

> Paths are repo-relative to the compose package root (`/Users/ruze/reg/my/forge/compose`) unless prefixed.

---

## Scope

Ship the Boundary Map artifact: an opt-in `## Boundary Map` section in `blueprint.md` declaring per-slice produces/consumes at file→symbol granularity, plus a four-check validator wired into Phase 5 verification.

The validator is a self-contained ESM module (`lib/boundary-map.js`) tested with `node --test`. The blueprint-writing agent (Phase 4) gets prompt updates encouraging authoring on multi-unit features. The verification agent (Phase 5) gets a sub-task that calls the validator. One existing multi-slice blueprint is retroactively annotated as a worked example.

This blueprint is itself the first dogfood: the Boundary Map below covers the two-slice decomposition (validator → integration).

---

## File Plan

| File | Action | Purpose |
|------|--------|---------|
| `lib/boundary-map.js` | new | Parser + four-check validator (`parseBoundaryMap`, `validateBoundaryMap`) |
| `test/boundary-map.test.js` | new | `node --test` unit suite covering parse + each violation/warning kind |
| `.claude/skills/compose/templates/boundary-map.md` | new | Authoring template + grammar reference + 1 worked example |
| `.claude/skills/compose/SKILL.md` | edit | Phase 4 prompt (author guidance), Phase 5 prompt (validator invocation) |
| `pipelines/build.stratum.yaml` | edit | Verification step intent references the validator |
| `docs/features/COMP-MCP-MIGRATION-2-1-1/blueprint.md` | edit | Retroactive Boundary Map annotation as a worked example (target swapped from COMP-OBS-STREAM after Phase 5 verification — that blueprint has no `## File Plan` section, so the dogfood would fail the validator's own checks) |

---

## Corrections Table

Assumptions in `design.md` checked against the actual repo state on 2026-05-10:

| Spec assumption | Reality | Impact |
|---|---|---|
| `lib/` is the right home for `boundary-map.js` | Confirmed: `lib/` houses ~40 cross-cutting modules (`feature-validator.js`, `roadmap-parser.js`, `build-stream-schema.js`, etc.). New module fits the convention. | None — proceed. |
| Module style is ESM with named exports | Confirmed via `package.json` `"type": "module"` and neighbours like `lib/feature-validator.js` (`export function validateFeature(...)`). | Use `export { parseBoundaryMap, validateBoundaryMap }` — **not** `module.exports`. The user-supplied prompt suggested CommonJS as one option; ESM is the only option here. |
| Test runner is `node --test` | Confirmed via `package.json:22` (`"test": "node --test test/*.test.js test/comp-obs-branch/*.test.js && npm run test:ui"`) and existing `test/feature-validator.test.js` using `import { test } from 'node:test'; import assert from 'node:assert/strict'`. | Tests live at `test/boundary-map.test.js` (top-level glob), not under a sub-folder. |
| Phase 4 (Implementation Blueprint) and Phase 5 (Blueprint Verification) sections exist in `SKILL.md` | Confirmed: `.claude/skills/compose/SKILL.md:176-201`. Phase 4 starts at line 176 (`### Phase 4: Implementation Blueprint`); Phase 5 starts at line 188 (`### Phase 5: Blueprint Verification`); Phase 5 ends at line 201 (`**Skip when:** ...`). | Edits land at known line ranges; see "SKILL.md edits" below. |
| Verification step exists in `pipelines/build.stratum.yaml` | Confirmed: id `verification` at lines 277-291. Intent currently focuses on file:line references only — no Boundary Map awareness. | Edit intent text in-place (lines 279-282). |
| Heading aliases the validator must support | Confirmed by grepping `docs/features/*/blueprint.md`: `## File Plan` (canonical, ~10 features incl. all GSD- and ITEM-), `## Files` (`COMP-MCP-MIGRATION/`, `COMP-MCP-FOLLOWUP/`), `## File-by-File Plan` (`COMP-MCP-MIGRATION-2-1-1/`). All three aliases must be accepted; `## File Plan` is preferred. | Validator's File-Plan-or-disk check uses an alias allow-list, picks the first heading found. |
| `COMP-OBS-STREAM/blueprint.md` is multi-slice and suitable for retroactive annotation | Confirmed: 7 numbered integration points spanning `server/connectors/`, `lib/`, `server/`, and `src/components/agent/`. Slices naturally split into "envelope enrichment" (1-5) → "UI rendering" (6-7). | Annotation is purely additive — appends `## Boundary Map` after existing Corrections Table. |

No corrections invalidate the design — it is implementable as written.

---

## File-by-File Patches

### 1. `lib/boundary-map.js` (new)

**Implements:** Decision 1 grammar + Decision 3 four checks.

**Module shape (ESM, named exports):**

```js
// lib/boundary-map.js
//
// parseBoundaryMap(blueprintText) -> { slices: Slice[], parseViolations: Violation[] }
//   Slice = { id: "S01"|..., name?: string, produces: Entry[], consumes: ConsumeEntry[],
//             leaf: bool, sink: bool, line: number }
//   Entry = { file: string, symbols: string[], kind: SymbolKind, line: number }
//   ConsumeEntry = { from: "S##", file: string, symbols: string[], line: number }
//   SymbolKind = "interface"|"type"|"function"|"class"|"const"|"hook"|"component"
//
// validateBoundaryMap({ blueprintText, blueprintPath, repoRoot }) ->
//   { ok: bool, violations: Violation[], warnings: Warning[] }
//
//   Violation = { kind, scope: "parse"|"entry", slice?, file?, symbol?, message }
//   Warning   = { kind, scope: "blueprint"|"file-plan"|"entry", slice?, file?, symbol?, message }
//
//   ok === violations.length === 0; warnings never affect ok.

export function parseBoundaryMap(blueprintText) { /* see Parser approach */ }
export function validateBoundaryMap({ blueprintText, blueprintPath, repoRoot }) { /* see Validator approach */ }
```

**Parser approach (line-based scan, no AST):**

1. Locate `^## Boundary Map\s*$` (case-sensitive). If absent, return `{ slices: [], parseViolations: [] }` — single-unit blueprint, validator no-ops with `ok: true`.
2. Walk lines until next `^## ` heading or EOF. State machine over slice headings and entry lines.
3. Slice heading: `^### (S\d{2,})(:.*)?$` → start new slice. Duplicate id within the same map → push parse violation `{ kind: "duplicate_slice_id", scope: "parse", slice, message, ... }`; subsequent entries on the duplicate are still parsed for further error reporting but are not used by topology/match checks (the first occurrence wins).
4. Block headers `^Produces:\s*(nothing\s*(\(.*\))?)?\s*$` and `^Consumes:\s*(nothing\s*(\(.*\))?)?\s*$` → toggle current block. The `nothing [(<comment>)]` form sets `leaf=true` (consumes) or `sink=true` (produces); no entry parsing for that block.
5. Entry lines (indented under a block):
   - **Produces regex:** `^\s+(?<file>\S+)\s*(?:→|->)\s*(?<symbols>[^()]+?)\s*\((?<kind>interface|type|function|class|const|hook|component)\)\s*$`
   - **Consumes regex:** `^\s+from\s+(?<from>S\d{2,})\s*:\s*(?<file>\S+)\s*(?:→|->)\s*(?<symbols>[^()]+?)(?:\s*\([^)]*\))?\s*$` (trailing kind parenthetical optional and ignored).
   - Symbols split on `,` and trimmed; empty list → parse violation `malformed_entry`.
6. Malformed entry lines under a block (line non-blank, no match) → parse violation `{ kind: "malformed_produces" | "malformed_consumes" | "missing_kind", scope: "parse", slice, line, message }`.

Both `→` (U+2192) and ASCII `->` are accepted (the design's example uses `→`; `->` is a forgiving fallback).

**Validator approach (4 checks in fixed order on `parseBoundaryMap` output):**

1. **File-Plan-or-disk check** (`missing_file` violation, `no_file_plan` / `unknown_action` warnings):
   - Parse the blueprint's File Plan section. Heading alias allow-list: `["## File Plan", "## Files", "## File-by-File Plan"]`. First match wins; if none → emit single `{ kind: "no_file_plan", scope: "blueprint" }` warning.
   - Within the File Plan section, parse markdown table rows. Schema is `| File | Action | Purpose |`. Extract `file` (strip backticks) and `action`.
   - Action normalization: leading whitespace-delimited token of `action`, lowercased, trailing punctuation stripped (`/[.,;:]+$/` removed). Allow-list of write actions: `{"new", "create", "add", "edit", "modify", "update", "refactor", "replace"}`. Unknown leading verbs → `{ kind: "unknown_action", scope: "file-plan", file, message }` warning (one per row, deduplicated by file).
   - For every Boundary Map entry file: pass if (in File Plan with allow-listed action) OR (exists on disk relative to `repoRoot`). Else → `{ kind: "missing_file", scope: "entry", slice, file, message }` violation.
2. **Symbol presence check** (`missing_symbol` violation):
   - Skip when: file is in File Plan with allow-listed write action (planned write — symbol may not exist yet).
   - Otherwise: read file from disk, substring-grep each declared symbol identifier. Miss → `{ kind: "missing_symbol", scope: "entry", slice, file, symbol, message }` violation.
   - This is the v1 "name-mention" guarantee per Decision 3 §2.
3. **Topology check** (`dangling_consume` / `forward_reference` violation):
   - For every consumes entry on slice `S_i` with `from: S_j`: `S_j` must be a slice that appears earlier in the map (lower index in the parsed `slices` array). Else → `{ kind: "dangling_consume", scope: "entry", slice: S_i, message }` (the target doesn't exist) or `{ kind: "forward_reference", scope: "entry", slice: S_i, message }` (target exists but appears later).
   - Backward-only edges → acyclic by construction (Decision 3 §3); no cycle pass.
4. **Producer/consumer match check** (`producer_consumer_mismatch` violation):
   - For every consumes entry `(from S_j, file F, symbols [s1, s2, ...])`: there must be a `Produces:` entry on `S_j` with the same `file` whose symbol set is a superset of `[s1, s2, ...]`. Else → `{ kind: "producer_consumer_mismatch", scope: "entry", slice, file, symbol, message }` (one violation per missing symbol).

`ok` is `false` iff `violations` is non-empty. Warnings never block.

**Implements:** Decision 1 (grammar), Decision 3 (all four checks), acceptance-criteria return shape.

---

### 2. `test/boundary-map.test.js` (new)

`node --test` style — mirrors `test/feature-validator.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBoundaryMap, validateBoundaryMap } from '../lib/boundary-map.js';
```

**Test cases (one `test(...)` per row):**

| # | Name | Asserts |
|---|---|---|
| 1 | parses valid 3-slice map (auth example from design) | `slices.length === 3`, S01.leaf, entry counts, kinds |
| 2 | parses leaf slice via `Consumes: nothing (leaf node)` | `slices[0].leaf === true`, `consumes.length === 0` |
| 3 | parses sink slice via `Produces: nothing (integration only)` | `slices[N].sink === true`, `produces.length === 0` |
| 4 | accepts both `→` and `->` arrows | both fixtures parse identically |
| 5 | parse violation: duplicate slice id | `parseViolations` contains `{ kind: "duplicate_slice_id", scope: "parse" }` |
| 6 | parse violation: malformed Produces (no kind parenthetical) | `parseViolations` contains `{ kind: "missing_kind", scope: "parse" }` |
| 7 | violation: `missing_file` (file not in File Plan, not on disk) | `ok === false`, violation kind matches |
| 8 | violation: `missing_symbol` (file on disk, not in File Plan, symbol absent) | `ok === false`, violation kind matches |
| 9 | symbol-presence skipped for File-Plan-listed `new` file | no `missing_symbol` even though file is empty/missing |
| 10 | violation: `forward_reference` (consumes from later slice) | violation kind matches |
| 11 | violation: `dangling_consume` (consumes from non-existent slice) | violation kind matches |
| 12 | violation: `producer_consumer_mismatch` (symbol not in producer's set) | violation kind matches, `symbol` populated |
| 13 | warning: `no_file_plan` when blueprint has no recognized heading | `ok === true`, single warning, `scope: "blueprint"` |
| 14 | warning: `unknown_action` for File Plan row with unrecognized verb | warning emitted, file-disk fallback still applied |
| 15 | single-unit blueprint (no `## Boundary Map`) returns `ok: true` with empty arrays | per acceptance criterion |
| 16 | warnings never set `ok: false` | fixture with warnings only → `ok: true` |

Fixtures use `mkdtempSync` to scratch a fake repo root, write referenced files (or omit them) per case. Pattern matches `test/feature-validator.test.js:1-15`.

---

### 3. `.claude/skills/compose/templates/boundary-map.md` (new)

Authoring template the Phase 4 agent reads. Contains:

- **Format spec** (verbatim from design Decision 1 grammar block).
- **Grammar rules** as a bulleted list (Produces/Consumes line shapes, leaf/sink sentinels, kind allow-list).
- **One worked example** — the auth-primitives 3-slice example from `design.md:48-74`.
- **When to author:** "If your feature has 2+ slices, sub-features, or parallel tasks, append a `## Boundary Map` section after `## File Plan` and before `## Verification Table`."
- **Symbol-only restriction note:** endpoints, payloads, file formats, invariants stay in blueprint prose — not in entries.

---

### 4. `.claude/skills/compose/SKILL.md` — Phase 4 + Phase 5 edits

**Phase 4 — existing text (lines 176-186):**

```
### Phase 4: Implementation Blueprint

**Agent:** `compose-explorer` (targeted research)

- Check for overlapping in-flight features: scan other `docs/features/*/blueprint.md` for shared file references
- Launch `compose-explorer` targeting the specific area
- Read every critical file, note patterns with line references
- Build corrections table (spec assumption vs reality)
- Write to `docs/features/<feature-code>/blueprint.md`

**Gate:** Corrections table empty or all corrections documented.
```

**Phase 4 — proposed replacement (additive bullet):**

```
### Phase 4: Implementation Blueprint

**Agent:** `compose-explorer` (targeted research)

- Check for overlapping in-flight features: scan other `docs/features/*/blueprint.md` for shared file references
- Launch `compose-explorer` targeting the specific area
- Read every critical file, note patterns with line references
- Build corrections table (spec assumption vs reality)
- Write to `docs/features/<feature-code>/blueprint.md`
- **Boundary Map (when feature has 2+ work units):** append a `## Boundary Map` section per `.claude/skills/compose/templates/boundary-map.md`. Each entry must name a concrete code symbol with a kind in `{interface, type, function, class, const, hook, component}`. Endpoints, event payloads, file formats, and invariants belong in prose, not in Boundary Map entries.

**Gate:** Corrections table empty or all corrections documented.
```

**Phase 5 — existing text (lines 188-201):**

```
### Phase 5: Blueprint Verification

For every file:line reference in the blueprint:
1. Read the actual file at that line — does it match?
2. Check function signatures
3. Verify pattern claims
4. Confirm imports/exports
5. Flag stale references

Produce a verification table, append to `blueprint.md`. If any stale/wrong, loop back to Phase 4.

**Gate:** All file:line references verified. Zero stale entries.

**Skip when:** Blueprint written in the same session immediately after reading all referenced files.
```

**Phase 5 — proposed replacement:**

```
### Phase 5: Blueprint Verification

For every file:line reference in the blueprint:
1. Read the actual file at that line — does it match?
2. Check function signatures
3. Verify pattern claims
4. Confirm imports/exports
5. Flag stale references

If the blueprint contains a `## Boundary Map` section, run `validateBoundaryMap` from `lib/boundary-map.js` against the blueprint. Append every violation as a row in the Verification Table; warnings render as informational rows but do not block the gate. The four checks are: File-Plan-or-disk, symbol presence (untouched dependencies only), topology (every `from S##` references an earlier slice), producer/consumer match.

Produce a verification table, append to `blueprint.md`. If any stale/wrong, loop back to Phase 4.

**Gate:** All file:line references verified. Zero stale entries. Zero Boundary Map violations (warnings allowed).

**Skip when:** Blueprint written in the same session immediately after reading all referenced files **and** the blueprint has no Boundary Map.
```

**Implements:** Decision 2 (Phase 4 author guidance) + Decision 3 (Phase 5 verification).

---

### 5. `pipelines/build.stratum.yaml` — verification step intent edit

**Existing text (lines 277-291):**

```yaml
      - id: verification
        agent: claude
        intent: >
          Verify every file:line reference in the blueprint against the actual codebase.
          Flag stale or incorrect references. Return { verified: true } only if all
          references are valid. Return { verified: false, staleRefs: [...] } otherwise.
        inputs:
          featureCode: "$.input.featureCode"
          description: "$.input.description"
        output_contract: PhaseResult
        ensure:
          - "result.outcome == 'complete'"
        retries: 2
        on_fail: blueprint
        depends_on: [blueprint]
```

**Proposed replacement (intent text only; structure unchanged):**

```yaml
      - id: verification
        agent: claude
        intent: >
          Verify every file:line reference in the blueprint against the actual codebase.
          Flag stale or incorrect references. If the blueprint contains a `## Boundary Map`
          section, additionally invoke `validateBoundaryMap` from `lib/boundary-map.js` and
          treat its violations as stale references; treat its warnings as informational
          rows in the Verification Table. Return { verified: true } only if all references
          are valid AND there are no Boundary Map violations. Otherwise return
          { verified: false, staleRefs: [...], boundaryViolations: [...] }.
        inputs:
          featureCode: "$.input.featureCode"
          description: "$.input.description"
        output_contract: PhaseResult
        ensure:
          - "result.outcome == 'complete'"
        retries: 2
        on_fail: blueprint
        depends_on: [blueprint]
```

**Implements:** Decision 3 verification wiring at the pipeline level.

---

### 6. `docs/features/COMP-MCP-MIGRATION-2-1-1/blueprint.md` — retroactive Boundary Map

**Target swap rationale:** Phase 5 verification surfaced that `COMP-OBS-STREAM/blueprint.md` has no `## File Plan` section, so a Boundary Map there would emit `missing_file` violations on every entry plus a `no_file_plan` warning — i.e. the dogfood example would fail its own validator. `COMP-MCP-MIGRATION-2-1-1/blueprint.md` has a real `## File-by-File Plan` (line 30) which exercises the alias system end-to-end. The natural-slice-split argument that motivated COMP-OBS-STREAM is preserved here: MIGRATION-2-1-1 has three clear units (preserver primitives → roadmap generator integration → migration tool).

**Insertion point:** after the existing `## File-by-File Plan` and before `## Corrections Table` (target blueprint already has both — the Boundary Map slots between them per design Decision 1).

**Addition:** new `## Boundary Map` section with two slices, drawn from the existing file-by-file structure:

- **S01: preserver primitives** — `lib/roadmap-preservers.js` exports three pure scanning functions. Leaf node.
- **S02: roadmap-gen integration** — `lib/roadmap-gen.js` consumes the preserver functions to apply override/anon/preserved-section behaviors during regen.

Concrete entries:

```markdown
## Boundary Map

### S01: preserver primitives
Produces:
  lib/roadmap-preservers.js → readPhaseOverrides, readAnonymousRows, readPreservedSections (function)

Consumes: nothing (leaf node)

### S02: roadmap-gen integration
Produces:
  lib/roadmap-gen.js → generateRoadmap (function)

Consumes:
  from S01: lib/roadmap-preservers.js → readPhaseOverrides, readAnonymousRows, readPreservedSections
```

All cited symbols literally appear in the target files (`readPhaseOverrides`, `readAnonymousRows`, `readPreservedSections` at `lib/roadmap-preservers.js`; `generateRoadmap` at `lib/roadmap-gen.js`) — name-mention check passes, validator emits `ok: true`.

**Implements:** acceptance criterion "At least one existing multi-slice blueprint is retroactively annotated as a worked example."

---

## Boundary Map

### S01: validator library
Produces:
  lib/boundary-map.js → parseBoundaryMap, validateBoundaryMap (function)
  test/boundary-map.test.js → boundary-map (const)

Consumes: nothing (leaf node)

### S02: skill + pipeline integration
Produces:
  .claude/skills/compose/templates/boundary-map.md → boundary-map-template (const)
  .claude/skills/compose/SKILL.md → boundary-map (const)
  pipelines/build.stratum.yaml → verification (const)
  docs/features/COMP-MCP-MIGRATION-2-1-1/blueprint.md → boundary-map (const)

Consumes:
  from S01: lib/boundary-map.js → validateBoundaryMap

**Note (v1 dogfooding caveat):** S02's "symbols" are markdown anchors and YAML step ids, not JS identifiers. They satisfy v1's substring grep against the named files. The v1 validator does not distinguish identifier kinds across file types — the kind annotation is documentation-only at the parse level except for the allow-list check. Flagging the limitation here at the first dogfood instance makes it visible before authors are surprised by it; the `COMP-GSD-1-FU-EXPORT-CHECK` follow-up is the work that tightens this.

---

## Verification Table

Filled by Phase 5 on 2026-05-10.

| Reference | Claim | Reality | Status |
|---|---|---|---|
| `SKILL.md:176` | Phase 4 starts at line 176 (`### Phase 4: Implementation Blueprint`) | Confirmed — line 176 is `### Phase 4: Implementation Blueprint` | OK |
| `SKILL.md:188` | Phase 5 starts at line 188 (`### Phase 5: Blueprint Verification`) | Confirmed — line 188 is `### Phase 5: Blueprint Verification` | OK |
| `SKILL.md:176-186` | Phase 4 body matches the quoted block (gate at 186) | Confirmed — lines 176-186 match verbatim, gate at line 186 | OK |
| `SKILL.md:188-201` | Phase 5 body matches the quoted block (skip-when at 201) | Confirmed — lines 188-201 match verbatim, skip-when at line 201 | OK |
| `pipelines/build.stratum.yaml:277-291` | `verification` step occupies lines 277-291 | Confirmed — `id: verification` at line 277, `depends_on: [blueprint]` at line 291 | OK |
| `pipelines/build.stratum.yaml:279-282` | Intent block at lines 279-282 | Confirmed — intent text spans 279-282, matches the quoted block exactly | OK |
| `package.json:22` | Test script glob `node --test test/*.test.js test/comp-obs-branch/*.test.js && npm run test:ui` at line 22 | Confirmed verbatim at line 22 | OK |
| `package.json` `"type": "module"` | Module type is ESM | Confirmed at line 7 | OK |
| `## File Plan` heading alias in active use | Used as canonical heading | Confirmed in 12 blueprints (COMP-GSD-{1..7}, COMP-GSD, COMP-UX-2b, ITEM-25a, COMP-VIS-1, ITEM-26) | OK |
| `## Files` heading alias in active use | Used in COMP-MCP-MIGRATION + COMP-MCP-FOLLOWUP | Confirmed in both blueprints | OK |
| `## File-by-File Plan` heading alias in active use | Used in COMP-MCP-MIGRATION-2-1-1 | Confirmed (line 30 of that blueprint) | OK |
| `lib/boundary-map.js` location convention | `lib/` houses cross-cutting modules | Confirmed — `lib/feature-validator.js`, `lib/roadmap-parser.js`, `lib/build-stream-schema.js` all present; new module fits | OK |
| `test/boundary-map.test.js` location convention | Top-level `test/` glob, mirrors `test/feature-validator.test.js` | Confirmed — `test/feature-validator.test.js` exists, top-level glob (`test/*.test.js`) per package.json:22 | OK |
| `test/feature-validator.test.js:1-15` import pattern | `import { test } from 'node:test'`, `import assert from 'node:assert/strict'`, `mkdtempSync` fixtures | Confirmed verbatim at lines 1-15 | OK |
| `lib/feature-validator.js` exports `validateFeature` | Used as ESM neighbour reference | Confirmed — public exports `validateFeature`, `validateProject` at lines 11-12 | OK |
| `COMP-MCP-MIGRATION-2-1-1` blueprint structure | Uses `## File-by-File Plan` heading | Confirmed at line 30 | OK |
| `COMP-OBS-STREAM` is multi-slice with 7 integration points | 7 numbered integration points spanning connectors/lib/server/components | Confirmed — `### 1.` through `### 7.` at lines 10/30/53/72/90/101/134 | OK |
| `COMP-OBS-STREAM/blueprint.md` Corrections Table at end-of-file (~line 199) | Insertion point for retroactive annotation | Confirmed — `## Corrections Table` at line 189, file ends at line 198 | OK |
| `COMP-UX-2a` blueprint exists | Cited example | Confirmed — `docs/features/COMP-UX-2a/{blueprint.md,design.md}` present | OK |
| COMP-OBS-STREAM `agent-connector.js:7-11` JSDoc envelope | Envelope type lives at `server/connectors/agent-connector.js:7-11` | `server/connectors/` directory does not exist on disk; the file is planned by COMP-OBS-STREAM but unimplemented. Blueprint already flags this as the dogfood caveat (see note at line 335). Symbol-presence check will be skipped iff COMP-OBS-STREAM gains a File Plan listing the file as `new`. | N/A |
| COMP-OBS-STREAM has a File Plan section | Implicit when retroactively annotating | NOT present — none of `## File Plan`, `## Files`, `## File-by-File Plan` appear in COMP-OBS-STREAM/blueprint.md | STALE |
| `## Boundary Map` insertion line in COMP-OBS-STREAM ("around line 199") | Append after Corrections Table at end-of-file | File is 198 lines; "around line 199" is correct (one past EOF, i.e. append) | OK |

## Verification Notes

One STALE entry to address before Phase 6 (Plan):

- **COMP-OBS-STREAM has no File Plan section.** The retroactive Boundary Map annotation in §6 of this blueprint (`docs/features/COMP-OBS-STREAM/blueprint.md` edit) will reference files (`server/connectors/agent-connector.js`, `server/build-stream-bridge.js`, `src/components/agent/ToolResultBlock.jsx`, `src/components/AgentStream.jsx`) that do not exist on disk. Without a `## File Plan` listing them as `new`/`edit`, the validator's File-Plan-or-disk check will emit `missing_file` violations on every entry, plus a `no_file_plan` warning, making the dogfood example fail its own validator. **Resolution options for the Phase 6 plan:**
  1. Phase 6 task adds a minimal `## File Plan` table to `COMP-OBS-STREAM/blueprint.md` alongside the Boundary Map insertion (preferred — makes the example self-consistent and demonstrates the alias system).
  2. Or skip COMP-OBS-STREAM as the worked example and pick a multi-slice blueprint that already has a File Plan (e.g. `COMP-MCP-MIGRATION-2-1-1`). Less ideal — loses the natural envelope/UI slice split.

The N/A entry on the JSDoc envelope reference is downstream of the same issue and resolves automatically once option 1 is taken.

All other references are OK. Bottom line: the blueprint is one small fix away from approve-ready — the §6 patch must add a File Plan to COMP-OBS-STREAM (or pick a different example). No Phase 4 rework needed; this is a localized correction to a single file-by-file patch.
