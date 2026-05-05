# COMP-MCP-MIGRATION-2-1-1: Implementation Blueprint

**Status:** BLUEPRINT
**Date:** 2026-05-04
**Design:** [`design.md`](./design.md)

## Scope

Replace the hand-rolled `lib/roadmap-parser.js` + `lib/roadmap-gen.js` with a unified/remark AST pipeline that round-trips `ROADMAP.md` losslessly. Three behavioral changes ride on the AST swap: (1) phase-status overrides in heading nodes survive regen with drift detection, (2) anonymous rows pass through verbatim as raw `tableRow` nodes, (3) preserved non-feature sections survive via HTML comment-marker anchors.

## Corrections Table — Design vs Reality

| Design assumption | Reality (file:line) | Action |
|---|---|---|
| `## Roadmap Conventions` lines 11–19 | 11–18 | Off-by-one in design; blueprint uses verified range |
| `## Dogfooding Milestones` lines 859–870 | 860–871 | Off-by-one; blueprint uses verified range |
| `## Execution Sequencing` lines 871–981 | 872–982 | Off-by-one; blueprint uses verified range |
| `## Key Documents` lines 982–1002 | 983–1002 (next heading `## COMP-CONSENSUS` at 1004) | Design under-counted by 17 lines; section ends at 1002, NOT EOF. **Final decision (Codex iter 5):** Key Documents IS a preserved section. The live section contains curated entries + external links not represented in any `feature.json` (e.g. external repo references at line 983+). Generating it from `designDoc` fields would drop curated content. Treat it as preserved; humans edit Key Documents directly. The auto-add-to-Key-Documents behavior of the current writer (`lib/roadmap-gen.js:186`) is removed in v1. **Follow-up filed:** `COMP-MCP-MIGRATION-2-1-1-3` for hybrid-merge Key Documents (regen designDoc-linked rows, byte-preserve curated rows). Four preserved sections total. |
| 9 phase-status override patterns | 8 overrides + 1 SUPERSEDED special case (Phase 5 line 119) | Counted Phase 5 separately; AST treatment is identical (heading text node carries override). No behavioral change needed. |
| `contracts/preserved-section.schema.json` (new file in design) | Confirms contracts/ exists at `contracts/`; no existing preserved-section schema | Create as-designed |
| `lib/roadmap-drift.js` (new) | No existing drift module | Create as-designed; emit via existing `appendEvent()` from `lib/feature-events.js:38–58` |
| Audit log path `.compose/data/events.jsonl` (design) | Actual path `.compose/data/feature-events.jsonl` (`lib/feature-events.js:29`) | Use the actual filename. Drift events ride the same channel via `appendEvent()`. |
| Drift event field names (design): `{phase, override, computed, build_id}` | Existing event shape: `{ts, tool, code?, from?, to?, reason?, actor, build_id?, idempotency_key?, ...payload}` | Map drift event into existing shape: `tool: 'roadmap_drift'`, `code: phaseId`, `from: computed`, `to: override`, `reason: 'override-vs-rollup-divergence'`. |
| `set_phase_status_override` MCP tool (design open Q3) | No such tool exists today | Defer until v2 — Decision 2 says heading is canonical and humans edit it directly. Keep as future work; no v1 impact. |
| Parser feature-code regex `FEATURE_CODE_RE` (`lib/roadmap-parser.js:16`) | Existing strict regex `FEATURE_CODE_RE_STRICT` at `lib/feature-code.js:14` is the contract source of truth. Current parser uses a looser regex that incorrectly rejects valid codes like `COMP-MCP-PUBLISH` (no trailing digits). Validator (`lib/feature-validator.js:72`) works around this with its own raw scanner. | **Switch parser to `FEATURE_CODE_RE_STRICT`** during the AST rewrite. Latent misclassification gets fixed in the same change. |
| `package.json` `remark-gfm` line (claimed by exploration: line 98) | Actual line 104 | Stale line ref in original exploration; corrected here. |
| `lib/feature-validator.js:72` raw table scanner | Validator does NOT consume `parseRoadmap()` for ROADMAP rows. It has an independent column-aware scanner. Comment at lines 68–73 explains the workaround. | **Out of scope this PR.** Once the parser uses `FEATURE_CODE_RE_STRICT`, the workaround scanner becomes redundant — but collapsing the validator onto the AST is its own diff (touches every validation path). File as follow-up `COMP-MCP-MIGRATION-2-1-1-2` (validator AST migration). |

## File-by-File Plan

### A. New dependencies

`package.json` — add to `dependencies`:
- `unified` (caret pin matching existing convention)
- `remark-parse`
- `remark-stringify`

`remark-gfm` already present at `package.json:104` (`^4.0.1`). All four ship as ESM; the codebase is ESM (`"type": "module"`).

### B. `lib/roadmap-parser.js` — full rewrite

**Current state (existing exports to preserve API compat):**
- `SKIP_STATUSES` (line 10)
- `PHASE_HEADING_RE` (line 12)
- `MILESTONE_HEADING_RE` (line 13)
- `TABLE_ROW_RE` (line 14)
- `FEATURE_CODE_RE` (line 15) — buggy looser regex, replaced by `FEATURE_CODE_RE_STRICT` import (Decision: switch to strict)
- `parseRoadmap(text)` (lines 29–115) → `FeatureEntry[]`
- `filterBuildable(entries)` (lines 174–177)

**New shape:**
- Keep `parseRoadmap(text)` as the public entry. Internally delegates to `unified().use(remarkParse).use(remarkGfm).parse(text)` then a `roadmapAstToEntries(ast)` visitor.
- New export `parseRoadmapAst(text)` → returns the unified AST (mdast) directly. Used by writer for round-trip; not called from current importers.
- `filterBuildable(entries)` (lines 174–177) — drop the `!e.code.startsWith('_anon_')` clause (becomes dead since anon rows aren't in entries). Predicate simplifies to `entries.filter(e => !SKIP_STATUSES.has(e.status))`. Same observable behavior; cleaner code.
- Drop `_anon_<n>` synthesis. Anonymous rows are not surfaced as `FeatureEntry` at all — they only appear in the AST. `parseRoadmap()` returns only typed entries (rows whose `#` cell parses as a feature code via `FEATURE_CODE_RE_STRICT`).
- `SKIP_STATUSES` and the parser-internal regexes stay (used internally; if any test imports them, leave the export). **Note:** `lib/feature-validator.js:22` imports `FEATURE_CODE_RE_STRICT` from `lib/feature-code.js`, NOT the parser's looser `FEATURE_CODE_RE`. The validator never depended on the buggy regex; switching the parser to strict aligns the two sources of truth without changing validator behavior.

**Visitor logic:**
- Walk top-level `heading` (depth 2) nodes. For each, compute `phaseId` from the heading text. Capture override text after the `— ` em-dash if present. **Decompose the override into `{statusToken, displaySuffix}`** where `statusToken` is the leading enum (`COMPLETE | PARTIAL | PLANNED | BLOCKED | PARKED | SUPERSEDED | KILLED`) matched at the start of the override text, and `displaySuffix` is the remaining string (parenthetical, " by STRAT-1", " (Claude Code dependency)", etc.). Examples:
  - `PARTIAL (1a–1d COMPLETE, 2 PLANNED)` → `{statusToken: 'PARTIAL', displaySuffix: ' (1a–1d COMPLETE, 2 PLANNED)'}`
  - `SUPERSEDED by STRAT-1` → `{statusToken: 'SUPERSEDED', displaySuffix: ' by STRAT-1'}`
  - `PARKED (Claude Code dependency)` → `{statusToken: 'PARKED', displaySuffix: ' (Claude Code dependency)'}`
  - `COMPLETE` → `{statusToken: 'COMPLETE', displaySuffix: ''}`
  - `COMPLETE (v1)` → `{statusToken: 'COMPLETE', displaySuffix: ' (v1)'}`
- Drift comparison (Decision 2) operates on `statusToken` only — bare-enum vs bare-enum. `displaySuffix` is opaque human curation that survives unchanged. If `phaseStatus()` rollup produces `COMPLETE` and override is `PARTIAL (suffix...)`, that's a real drift; if rollup is `PARTIAL` and override is `PARTIAL (suffix...)`, no drift.
- Reject malformed overrides (no recognized leading enum) — emit a parse warning via `appendEvent({tool: 'roadmap_drift', code: phaseId, reason: 'override-malformed'})` and treat the heading as having no override (fall through to rollup).
- Emit `phaseStatusOverride: {statusToken, displaySuffix}` on the AST as a custom data field for the writer to read on round-trip.
- **Walk `heading` (depth 3) milestone sub-headings under each depth-2 phase.** Current parser at `lib/roadmap-parser.js:52–63` matches `MILESTONE_HEADING_RE` and composes `phaseId` by **cumulative concatenation** with the `' > '` delimiter:
  - First milestone after a phase heading: `phaseId = "<phase> > <milestone1>"`.
  - Second milestone (same phase): `phaseId = "<phase> > <milestone1> > <milestone2>"` (currentPhaseId is mutated; previous milestone label is NOT replaced).
  - Tables under a milestone heading inherit whatever the cumulative `currentPhaseId` is when the table is encountered.
- The AST visitor must replicate this cumulative behavior verbatim, even though it's quirky — `lib/migrate-roadmap.js:92` `extractPhase()` splits on `' > '` and takes only the first segment, and `bin/compose.js:908` `phase.split(' > ').pop()` takes the last segment. Existing consumers tolerate the cumulative nesting because each only consumes one end of the chain. Changing the format breaks both consumers in subtle ways. Tests at `test/roadmap-parser.test.js:94` only assert substring presence — the cumulative behavior is currently unlocked. Add a regression test asserting the exact concat for a multi-milestone phase fixture (e.g. STRAT-1's Engine + Compose Runner milestones).
- `buildDag()` (`lib/build-dag.js:32`) groups by `phaseId`. Cumulative nesting puts each milestone in its own group — that's the semantics the rewrite must preserve.
- **DO NOT** "fix" the cumulative nesting in this PR. File as separate hygiene ticket if desired; out of scope here.
- Walk `table` nodes nested under each heading (depth 2 OR depth 3 — milestones own their tables). For each table:
  - **Detect column layout from the header row** (the first `tableRow` of the table). Replicate the current `detectColumnLayout()` logic at `lib/roadmap-parser.js:128–164`:
    - 4+ columns with a header cell `'Feature'` (case-insensitive): code is in that column. Examples: `| # | Feature | Description | Status |` (Phase 7 MCP Writers, line 153) → code at index 1.
    - 4+ columns without `'Feature'` header: code at index 0, desc at index 1.
    - 3 columns with first header `'ID'`: code at index 0.
    - 3 columns otherwise (anonymous form `| # | Item | Status |`): codeCol = -1 → all rows are anonymous.
  - For each non-header `tableRow`:
    - If `codeCol === -1`, annotate `tableRow.data.preserve = true`. No entry emitted.
    - Else read the cell at `codeCol`. **Use `FEATURE_CODE_RE_STRICT` from `lib/feature-code.js:14`** (`/^[A-Z][A-Z0-9-]*[A-Z0-9]$/`) to test it. This replaces the current looser parser regex `FEATURE_CODE_RE` at `lib/roadmap-parser.js:15` which requires a trailing `-<digits>` segment and incorrectly rejects valid codes like `COMP-MCP-PUBLISH` (`ROADMAP.md:161`) — those rows currently fall into the `_anon_*` bucket. The validator already uses the strict regex (`lib/feature-validator.js:22`); switching the parser aligns the two sources of truth.
    - If cell matches `FEATURE_CODE_RE_STRICT` → emit `FeatureEntry`.
    - If cell is `—`, empty, or doesn't match → `tableRow.data.preserve = true`. No entry emitted.
  - **DO NOT key off the first cell uniformly.** The first cell is the row number `#` for typed-feature tables, not the feature code. Using first-cell matching would route most real feature rows to anonymous and emit almost no `FeatureEntry`s.
- **Preserve the SKIP_STATUSES heading→row propagation behavior** (`lib/roadmap-parser.js:99–101`). When a phase heading's `statusToken` ∈ `{COMPLETE, SUPERSEDED, PARKED, BLOCKED, KILLED}` (the `SKIP_STATUSES` set at line 11), every `FeatureEntry` emitted under that phase has its `status` overridden to the heading's `statusToken` regardless of the row's own Status cell. This is current public behavior; existing consumers (`compose roadmap check`, `lib/build-all.js:42` filterBuildable, downstream DAG edge cases) depend on it. The AST visitor MUST replicate.
- `html` nodes matching `<!-- preserved-section: <id> -->` open/close pairs annotate enclosed content with `data.preserved = true`. **See "Preservation Mechanism" below for actual byte-preservation strategy** — `data.*` fields ride through stringify but the *content* of preserved subtrees does not byte-preserve through stringify normalization without help.

### Preservation Mechanism — Source-Slice Splice

`remark-stringify` re-renders AST nodes from their tree representation; whitespace, list-marker style, table column padding, and code-block fence info-strings normalize. For tableRows annotated `data.preserve = true` and for content between `<!-- preserved-section -->` markers, AST round-trip is structurally lossless but NOT byte-equal.

The writer achieves byte preservation via source-slice splice using mdast `position` data:

1. After `unified().use(remarkParse).use(remarkGfm).parse(source)`, every node has a `position: {start: {offset, line, col}, end: {offset, line, col}}` field.
2. For preserved tableRows and preserved-section subtrees: capture the original source byte range from `position.start.offset` to `position.end.offset` at parse time, store on the node as `data.rawSource: string`.
3. Custom `mdast-util-to-markdown` handlers: when a tableRow node has `data.rawSource`, emit that string verbatim instead of recursing. When traversal reaches a preserved-section's opening `<!-- preserved-section: id -->` html node, emit the entire span from open-marker offset through close-marker end-offset as one rawSource string and skip subsequent siblings until the matching close marker.
4. Children inside preserved subtrees are NEVER re-stringified — even if mutated, the raw source wins.

**Mixed-table strategy (typed rows rewritten + anonymous rows byte-preserved in the same `table` node):**

- mdast `table` is flat: `table.children` is an array of `tableRow` nodes. The custom handler iterates `table.children` and for each row emits either:
  - **Typed row** (`data.preserve` falsy): use the default `tableRow` handler — column padding/alignment normalizes per remark-stringify defaults.
  - **Preserved anonymous row** (`data.preserve = true`): emit `data.rawSource` verbatim, including its leading/trailing pipes.
- Result: column padding around anonymous rows may differ from typed rows in the regenerated table. This is acceptable — markdown tables don't require uniform padding to render correctly, and the round-trip test asserts row-content equality, not table-cosmetic equality.
- Acceptance test (`test/roadmap-roundtrip.test.js`): for each anonymous row in `ROADMAP.md`, assert that the regenerated file contains the exact `data.rawSource` substring on its own line. For typed rows, assert content-equal modulo whitespace.

This is a known mdast pattern (used by `mdast-util-to-markdown` via custom `handlers` override). Preserves bytes for the preserved subtrees only; everything else stringifies normally.

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
- `generateRoadmap(cwd, opts)` keeps its signature. New flow: read existing `ROADMAP.md`, parse to AST with `parseRoadmapAst` (using `unified().use(remarkParse).use(remarkGfm)`), mutate the AST in place with feature.json data, stringify back to markdown via **`unified().use(remarkStringify).use(remarkGfm)`** with the custom `mdast-util-to-markdown` handler for tableRow + html-bracketed source-slice splice. Both parse and stringify must use `remark-gfm` — without it, GFM tables won't round-trip at all (the parser would emit `paragraph` nodes containing pipes, and stringify would produce raw text not table syntax). Confirm by writing the parse + no-op stringify spike test (Risk 1) before committing the rewrite.
- Mutation visitor:
  - For each phase heading: if `data.phaseStatusOverride` present, leave heading text untouched. Compute rollup status; if it differs from override, call `emitDrift(phaseId, override, computed)` (new helper in `lib/roadmap-drift.js`). If no override, set heading text to rollup result.
  - For each table: emit/update `tableRow` for every typed feature (from feature.json). Insert preserved (`data.preserve = true`) tableRows at their parsed-order position relative to neighbors. **Anonymous-row placement rule** (resolves design open Q1):
    - Track each anonymous row's parsed-position index AND its parsed predecessor (the previous tableRow in source order, typed or anonymous, or `null` if it was the first row in the table after the header).
    - On regen:
      - If parsed predecessor was a typed row that still exists → insert immediately after it.
      - If parsed predecessor was a typed row that was deleted → insert adjacent to nearest surviving typed row by parsed-order proximity.
      - If parsed predecessor was another anonymous row → insert after that anonymous row (chains preserve).
      - **If parsed predecessor was `null` (anonymous row was the first row)** → insert at the head of the table, before the first typed row. Example: `ROADMAP.md:201` `| 37 | — | Audit Stratum...` is the first row of its phase's STRAT-ENG table; on regen it must remain first, before STRAT-ENG-1 at `ROADMAP.md:202`.
  - Preserved-section subtrees (between `<!-- preserved-section: id -->` and `<!-- /preserved-section -->`) are emitted via source-slice splice (Section B "Preservation Mechanism"). The writer never re-stringifies them; raw source bytes win.
- Replace `readPreamble()` (lines 88–123) with two paths:
  - **Existing-ROADMAP path:** preamble is just AST prefix nodes (everything before the first phase heading). Round-trips through stringify (or source-slice splice if those nodes fall inside a preserved-section marker — currently `## Roadmap Conventions` does, line 11–18).
  - **No-ROADMAP bootstrap path:** when `ROADMAP.md` doesn't exist (test exercise: `test/feature-writer.test.js:39` calls `addRoadmapEntry()` in an empty workspace via `lib/feature-writer.js:90`), `generateRoadmap()` synthesizes a minimal AST from a hard-coded default template (same content as today's `readPreamble()` default at `lib/roadmap-gen.js:95–117`) plus the typed-feature phases. The default ships with the `roadmap-conventions` marker pair already wrapped. (`compose init` uses a separate `templates/ROADMAP.md` — see Section H — which gets the same marker treatment.) New repos start out marker-aware regardless of the entry path.
  - Both paths converge at the AST stringify step. The bootstrap path is exercised by `test/feature-writer.test.js:39` and any new test asserting `addRoadmapEntry()` against an empty workspace produces a valid marker-wrapped ROADMAP.md.
- Keep `phaseStatus(features)` as-is (lines 17–23) — used for rollup computation in the drift comparison.
- `writeRoadmap()` (lines 207–211) signature unchanged.

**Test additions (`test/roadmap-roundtrip.test.js`, new file):**
- **Preserved-subtree byte-equality:** for each `data.preserve = true` tableRow and each preserved-section subtree, parse current `ROADMAP.md` → no-op stringify → assert byte-equal source-slice splice for the captured byte ranges.
- **Typed-feature content equality:** for typed rows, parse → no-op stringify → assert content-equal modulo whitespace normalization (column-padding, trailing space). Use a markdown-aware comparator that ignores cosmetic deltas. Failures here mean real content loss.
- Override survival: for each of 8 overrides + Phase 5, parse → no-op stringify → assert override text intact.
- Anonymous-row survival: enumerate all rows in `ROADMAP.md` whose Feature column (per the new column-layout detection) does not match `FEATURE_CODE_RE_STRICT`. The 10-row count from earlier exploration was an under-count; tables inside preserved-section markers (Dogfooding Milestones at `ROADMAP.md:862`, Execution Sequencing wave tables at `ROADMAP.md:886+`) carry additional rows that don't have feature codes and currently get tagged `_anon_*` (those rows are PARTIAL/PLANNED, not just COMPLETE). Under the new design, all those rows live inside preserved-section markers and round-trip via source-slice splice — they're not anonymous-row passthrough cases; they're preserved-section-content cases. The test asserts every non-typed row in any phase table (excluding rows inside preserved-section markers) is present byte-equal in stringified output. Run `node -e 'const {parseRoadmap} = await import("./lib/roadmap-parser.js"); const txt = require("fs").readFileSync("ROADMAP.md","utf8"); const all = /* current parser */; const typed = parseRoadmap(txt); console.log("anon =", all.length - typed.length)'` against the *current* parser before rewrite to lock in the actual count for the test fixture.
- Preserved-section survival: assert all 4 marker-bracketed sections byte-equal to source.

**Test additions (`test/roadmap-drift.test.js`, new file):**
- Drift event emission: feature.json has all-COMPLETE features under a phase whose heading still says `PARTIAL`. Run regen. Assert (a) heading still says `PARTIAL`, (b) `feature-events.jsonl` got a `roadmap_drift` event with the right `from`/`to`/`code` fields, (c) stderr got the warn message.
- No-drift no-event: feature.json rollup matches override. Run regen. Assert no drift event written.

### D. `lib/roadmap-drift.js` — new file

Single export: `emitDrift(cwd, { phaseId, override, computed })`. Calls `appendEvent(cwd, { tool: 'roadmap_drift', code: phaseId, from: computed, to: override, reason: 'override-vs-rollup-divergence' })` from `lib/feature-events.js`. Also writes a stderr line: `WARN: phase "${phaseId}" override "${override}" diverges from rollup "${computed}". Edit ROADMAP.md to acknowledge.`.

No new test file — covered by `test/roadmap-drift.test.js` (sub-section C above).

### E. `lib/migrate-roadmap.js` — minor update

Line 10 import unchanged. Line 38 (`if (entry.code.startsWith('_anon_')) continue;`) becomes a no-op because Decision 3 makes anonymous rows absent from `parseRoadmap` output entirely. Remove the line; add a comment noting anonymous rows are AST-preserved by the writer, not migrated. Keep the rest of the migration logic intact.

### F. `contracts/preserved-section.schema.json` — new file

Trivial JSON schema documenting the marker shape:
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

**Wire-up:** No `validate_roadmap` flow exists today (Codex-flagged). The actual CLI path is `compose validate` → `validateProject()` (`lib/feature-validator.js:608`, called from `bin/compose.js:1367`). The new schema is consumed by `validatePreservedSections()` (Section G) which `validateProject()` calls. The schema serves as documentation + JSON Schema input to the validator; enforcement is in code.

### G. `lib/feature-validator.js` — extend

Currently imports `parseRoadmap` (line 23) and has its own raw table scanner at line 72 (out of scope this PR; follow-up `COMP-MCP-MIGRATION-2-1-1-2`). Add a new check function `validatePreservedSections(text)` that scans for `<!-- preserved-section: <id> -->` open/close pairs in the raw text (before AST parse — matched-balance check is cheaper at the string level). Hook into `validateProject()` at `lib/feature-validator.js:608`. Pre-push hook at `bin/compose.js:1367` (`compose validate`) picks it up automatically.

Tests: extend `test/feature-validator.test.js` (if exists) or add a new test file. Cases: balanced markers pass, unbalanced markers fail, duplicate ids warn but pass, empty marker body warns but passes.

### H. `ROADMAP.md` and `templates/ROADMAP.md` — one-time markup migration

Wrap the 4 preserved sections with HTML comment markers in **both** files:

**`ROADMAP.md`** (compose's live roadmap):

| Section | Lines (current) | Marker insertions |
|---|---|---|
| Roadmap Conventions | 11–18 | Open marker before line 11; close marker after line 18 |
| Dogfooding Milestones | 860–871 | Open marker before line 860; close marker after line 871 |
| Execution Sequencing | 872–982 | Open marker before line 872; close marker after line 982 |
| Key Documents | 983–1002 | Open marker before line 983; close marker after line 1002. **Removes** the auto-add-to-Key-Documents behavior currently in `lib/roadmap-gen.js:186–200`; humans edit Key Documents directly. Follow-up `COMP-MCP-MIGRATION-2-1-1-3` will reintroduce it as a hybrid merge (regen designDoc-linked rows, byte-preserve curated rows). |

**`templates/ROADMAP.md`** (compose-init bootstrap template, used by `bin/compose.js:367–380`):

The template has these preserved sections:
- `## Roadmap Conventions` at template line 8
- `## Dogfooding Milestones` at template line 40

The template does NOT currently have Execution Sequencing or Key Documents — newly initialized repos start without them. Wrap both Roadmap Conventions AND Dogfooding Milestones with their respective markers (`roadmap-conventions`, `dogfooding-milestones`). This ensures freshly initialized repos start marker-aware on every preserved section the template includes; first `writeRoadmap()` doesn't strand any open marker. Add a test asserting `compose init` against an empty workspace produces a marker-wrapped ROADMAP.md that round-trips through `writeRoadmap()` with zero diff.

Marker IDs: `roadmap-conventions`, `dogfooding-milestones`, `execution-sequencing`, `key-documents`.

This edit lands in the same atomic commit as the parser/writer rewrite so the round-trip golden test sees the marker-wrapped file as the input baseline.

## Importer Migration Surface — Verification Required

Each of these will need confirmation post-rewrite that nothing breaks. The parser API surface is preserved, but Decision 3 (anonymous rows no longer surface as `FeatureEntry`) ripples through every consumer that branched on `_anon_*` sentinels. Read each through:

| Importer | Line | Symbols |
|---|---|---|
| `lib/feature-validator.js` | 23 | `parseRoadmap` |
| `lib/build-all.js` | 11 | `parseRoadmap`, `filterBuildable` |
| `lib/build-dag.js` | 16, 32, 47 | **Behavioral consumer** — `buildDag(allEntries)` (called from `lib/build-all.js:47`) groups entries by `phaseId` and creates sequential edges within phases + cross-phase edges between phase-last and next-phase-first. **Decision 3 implication:** anonymous rows currently appear in `parseRoadmap()` output "for dependency chain purposes" (`lib/roadmap-parser.js:22`) and contribute hops in those edges. After this rewrite, anon rows are absent from `parseRoadmap()`; cross-phase edges still exist between typed-feature phase boundaries, sequential edges still exist within phases, and `filterBuildable()` already excluded COMPLETE anon rows from the buildable set (`lib/roadmap-parser.js:102–106`). Net build-order semantics are unchanged because all anon rows are COMPLETE/historical and would not be built either way. **Risk:** explicit dep edges (visible via `--dryRun` or graph inspection) get fewer transitive hops; if anything reads the full DAG for analytics rather than build ordering, output changes. Add a regression test asserting topo order over `filterBuildable()` is unchanged before/after the rewrite. |
| `lib/followup-writer.js` | 27 | `writeRoadmap` |
| `lib/feature-writer.js` | 24 | `writeRoadmap` |
| `lib/migrate-roadmap.js` | 10 | `parseRoadmap` (modified per E above) |
| `test/roadmap-parser.test.js` | 10 | `parseRoadmap`, `filterBuildable` |
| `scripts/import-roadmap.mjs` | 12 | `parseRoadmap` |
| `bin/compose.js` | (uses `_anon_` sentinel — see below) | `parseRoadmap` (transitively) |

### `_anon_` Consumer Migration — Concrete Table

Decision 3 makes anonymous rows absent from `parseRoadmap()` output. Every site that branches on `_anon_*` becomes dead code or behaviorally different. Each must be updated in the same PR as the parser rewrite (Step 3 of Implementation Order).

| File:Line | Current behavior | Action under Decision 3 |
|---|---|---|
| `lib/build-all.js:100` | `.filter(e => !e.code.startsWith('_anon_') && e.status === 'COMPLETE')` excludes anon rows from completion check | Drop the `_anon_` clause — anon rows no longer in entries. Filter becomes `e.status === 'COMPLETE'`. |
| `lib/migrate-roadmap.js:41` | `if (entry.code.startsWith('_anon_')) continue` skips anon rows during one-time backfill | Drop entirely — already covered in Section E. Anon rows aren't in entries; the line is dead. Replace with comment noting AST-side preservation. |
| `bin/compose.js:835` | `roadmapCodes = new Set(roadmapEntries.filter(e => !e.code.startsWith('_anon_')).map(e => e.code))` builds the set of named feature codes for sync | Drop the `_anon_` filter — entries are already filtered. |
| `bin/compose.js:848` | `if (e.code.startsWith('_anon_')) continue` in sync loop | Dead code; remove. |
| `bin/compose.js:886` | `named = allEntries.filter(e => !e.code.startsWith('_anon_'))` for status display | Dead filter; remove. |
| `scripts/import-roadmap.mjs:58` | `if (entry.code.startsWith('_anon_')) return 'task'` — classifies anon rows as tasks during import | **Resolved: drop the import-as-task path.** Anonymous rows are historical record (Phases 0–4.5 shipped work) — they don't need to land as tasks in vision-state. The `:58` branch + `:74` title fallback + `:93` gate all become dead code. Simplify the type-classification helper; entries from `parseRoadmap()` are all typed by construction post-rewrite. |
| `scripts/import-roadmap.mjs:74` | `title = entry.code.startsWith('_anon_') ? entry.description : ...` — uses description as title for anon | Drop the conditional; title is always derived from the typed entry. |
| `scripts/import-roadmap.mjs:93` | `if (!entry.code.startsWith('_anon_'))` gates `feature.json` write | Drop the gate; always write. |
| `contracts/roadmap-row.schema.json:5,13` | Descriptions reference `_anon_*` sentinel filter as part of the contract | Update descriptions to reflect new contract: anon rows are absent from validator input by construction (handled at parser level, not schema level). No schema field changes. |
| `test/schema-validator-generalize.test.js:97–100` | `test('roadmap-row schema rejects anonymous _anon_* sentinel', () => { ... code: '_anon_3' })` | Either delete the test (sentinel no longer exists in the validator's input) or rewrite to assert that `parseRoadmap` *output* never contains `_anon_*` codes. The latter is more useful; delete this test and add to `test/roadmap-parser.test.js` as "parseRoadmap output excludes anonymous rows entirely." |
| `test/roadmap-parser.test.js:80` | Existing test "handles 3-column tables (no Feature column)" likely asserts `_anon_<n>` codes appear | Rewrite to assert anon rows are NOT in entries; AST passthrough is asserted in new round-trip tests. |

**Verification grep before merge:** `rg -n '_anon_' lib/ bin/ scripts/ server/` from compose root. Acceptance: zero hits in those runtime paths.

**Allowed hits (do NOT touch):**
- `test/feature-code.test.js:28,48` — strict-regex *rejection* test cases (`_anon_3` is in a list of invalid codes the strict regex must reject). The test asserts the strict contract; keeping `_anon_*` as an example of invalid input is correct and should stay.
- `docs/journal/`, commit messages, this blueprint — historical record, not runtime.

**Tests requiring rewrite (Codex iter 8):**
- `test/feature-validator.test.js:340` — currently has `test('false positive: anonymous _anon_* rows are filtered before validation', ...)` which writes a malformed row and asserts the parser tags it `_anon_*`. Under Decision 3 the parser no longer emits `_anon_*` codes; rows that fail `FEATURE_CODE_RE_STRICT` are absent from `parseRoadmap()` output entirely. Rewrite the test to assert "rows whose Feature column doesn't match `FEATURE_CODE_RE_STRICT` are absent from `parseRoadmap()` output and skipped by validation" — same intent, updated mechanism.

**Out of scope:**
- `lib/feature-validator.js:72` raw table scanner. Validator has its own ROADMAP scanner that doesn't go through `parseRoadmap`. Updating parser does not update validator behavior. Filed as follow-up `COMP-MCP-MIGRATION-2-1-1-2`.

## Test Plan

`package.json:22` — `npm test` runs `node --test test/*.test.js test/comp-obs-branch/*.test.js && npm run test:ui` (vitest).

New tests to add (all under `test/`, picked up by glob):
- `test/roadmap-roundtrip.test.js` (new) — golden round-trip + override + anonymous + preserved-section assertions
- `test/roadmap-drift.test.js` (new) — drift event emission, no-drift silence
- Extensions to `test/roadmap-parser.test.js` — phaseStatusOverride extraction, anonymous absence from entries

Manual smoke test before commit: from compose root, run `node -e "import('./lib/roadmap-gen.js').then(m => m.writeRoadmap(process.cwd()))"` against the marker-wrapped `ROADMAP.md`. `git diff` should show **zero** changes inside preserved subtrees (the 4 marker-wrapped sections — Roadmap Conventions, Dogfooding Milestones, Execution Sequencing, Key Documents — plus every anonymous tableRow — source-slice splice byte-preserves these). Cosmetic deltas inside typed-feature tables are allowed (column padding, whitespace) per the round-trip acceptance criteria above. If diff shows content changes — feature codes, descriptions, statuses — round-trip is broken; debug before committing.

## Implementation Order

**Step 2 ordering note (Codex iter 4):** wrapping the 4 preserved sections with markers BEFORE the new writer is marker-aware would strand the open marker in the preamble that the current `readPreamble()` (`lib/roadmap-gen.js:87`) slices away. Two safe approaches:
- **Atomic combined commit (preferred):** marker wrap + parser rewrite + writer rewrite + drift module land as one commit. Larger PR, no transient unsafe state. Steps 2, 3, 5, 6, 7 collapse.
- **Marker-aware patch first (alternative):** add a 5-line patch to current `readPreamble()` that detects `<!-- preserved-section: ... -->` open markers and includes them in the preamble slice. Then marker wrap can land safely as its own commit. Then full rewrite. More commits, smaller diffs each, but adds a 5-line throwaway change.

Default to the atomic combined commit unless the diff is too large to review in one pass.

1. Add deps (`unified`, `remark-parse`, `remark-stringify`).
2. **(Atomic with steps 3, 5, 6, 7)** Wrap **4 preserved sections** in `ROADMAP.md` with markers — Roadmap Conventions, Dogfooding Milestones, Execution Sequencing, Key Documents. Also wrap the same sections in `templates/ROADMAP.md` (the `compose init` bootstrap template at `bin/compose.js:367–380`) so freshly initialized repos start marker-aware.
3. Rewrite `lib/roadmap-parser.js` against the AST (depth-3 milestone visitor + status-token/suffix split + `FEATURE_CODE_RE_STRICT`). Update `test/roadmap-parser.test.js:80` (anonymous-row test); delete `test/schema-validator-generalize.test.js:97-100` (sentinel test).
4. Walk every entry in the `_anon_` Consumer Migration table (`lib/build-all.js:100`, `lib/migrate-roadmap.js:41`, `bin/compose.js:835/848/886`, `scripts/import-roadmap.mjs:58/74/93`, `contracts/roadmap-row.schema.json:5,13`). Update each in this commit; no entries should reach these sites anymore.
5. Add `lib/roadmap-drift.js` (with read-side dedupe — see Risk 4).
6. Rewrite `lib/roadmap-gen.js` against the AST + drift detection. Includes: existing-ROADMAP path, no-ROADMAP bootstrap path with default template that ships with markers already wrapped. (Section H removed in iter 5 — Key Documents is now preserved, not regenerated.)
7. Run round-trip golden test against marker-wrapped `ROADMAP.md`. Iterate until passing per the split acceptance criteria (preserved subtrees byte-equal; typed sections content-equal modulo whitespace).
8. Extend `lib/feature-validator.js` with marker balance check; add `contracts/preserved-section.schema.json`.
9. Run full importer surface — manual trace + full `npm test` (including bootstrap-path test exercising empty-workspace `addRoadmapEntry()`).
10. From compose root: `rg -n '_anon_' lib bin scripts test contracts server` — acceptance: zero runtime hits in `lib`, `bin`, `scripts`, `server`. `test/feature-code.test.js:28,48` are allowed (strict-rejection cases) and `contracts/roadmap-row.schema.json` description text should be updated, not the schema fields themselves.

Each step is independently committable. Steps 3–6 are the heavy refactor; steps 1, 2, 7, 8 are mechanical.

## Risk Register

1. **Round-trip fidelity unproven.** `remark-stringify` re-renders AST nodes from their tree representation; whitespace, list-marker style, table column padding, and code-block fence info-strings normalize. *Mitigation:* the source-slice splice mechanism (Section B "Preservation Mechanism") byte-preserves `data.preserve = true` subtrees and preserved-section content via `position.start.offset` / `position.end.offset` raw-string capture. Non-preserved content (typed-feature tables, phase headings) goes through stringify and is allowed to normalize. Round-trip test split into two assertions: (a) preserved subtrees are byte-equal, (b) typed-feature subtrees are content-equal modulo whitespace. Spike step before main rewrite: build a 50-line proof-of-concept using mdast-util-to-markdown's custom handler to confirm source-slice splice works for tableRow + html-bracketed subtrees. If POC fails, escalate before committing to Decision 1.
2. **`_anon_` references in untracked code paths.** The codebase has been carrying `_anon_<n>` for a while; multiple consumers branch on the sentinel. *Mitigation:* concrete migration enumerated above (`_anon_` Consumer Migration table — 11 sites across `lib/`, `bin/`, `scripts/`, contracts, tests). Final grep at step 10 catches anything missed.
3. **GitHub-flavored markdown table edge cases.** `remark-gfm` may handle multi-line cells, escaped pipes, or HTML-in-cells differently from the hand-rolled regex. *Mitigation:* `ROADMAP.md` uses single-line cells, no escaped pipes, occasional backticks/strikethrough/bold — all well-supported. Spot-check any rows with strikethrough during golden test.
4. **Drift event spam.** If override-vs-rollup drift is common in practice (because humans haven't curated all overrides yet), `feature-events.jsonl` could fill with drift events on every regen. *Mitigation:* `appendEvent()` (`lib/feature-events.js:44`) only appends; the `idempotency_key` field is metadata, NOT enforced (Codex iter 4 caught — initial mitigation was wrong). The actual dedupe must happen *before* append: `lib/roadmap-drift.js#emitDrift()` reads the last 24h of events via `readEvents()`, scans for any `tool: 'roadmap_drift'` row matching `code: phaseId` AND `to: override` AND `from: computed`, and short-circuits if found. Stderr warn still fires every regen so the developer sees it; only the persistent event is deduped. Tests: assert `emitDrift()` writes once per (phaseId, override, computed) triple within a 24h window even across multiple `writeRoadmap()` calls.

---

## Verification (Phase 5)

Initial blueprint built from a single explorer pass; Codex review caught six gaps now corrected here. Verification table reflects the post-correction state.

| Claim | Verified |
|---|---|
| `lib/roadmap-parser.js` parses with `parseRoadmap`, returns `FeatureEntry[]` shape | ✅ explorer + Codex |
| `_anon_<n>` synthesis at `lib/roadmap-parser.js` | ✅ ; current parser regex `^[A-Z][\w-]*-\d+` rejects valid codes like `COMP-MCP-PUBLISH` (latent bug) — fixed by switching to `FEATURE_CODE_RE_STRICT` |
| `lib/roadmap-gen.js` 80-char-no-truncation fix | ✅ |
| `lib/feature-events.js:29` audit log path | ✅ corrects design's `events.jsonl` to `feature-events.jsonl` |
| `package.json` `remark-gfm` line | ✅ corrected to line 104 (was 98 in initial exploration) |
| `ROADMAP.md` Phase 6 reconcile to COMPLETE | ✅ committed `ab58cf2` |
| **4** preserved sections at lines 11–18 / 860–871 / 872–982 / 983–1002 | ✅ Final state after iter 5: Key Documents IS preserved (live section has curated/external content not represented in any feature.json). 4 markers in `ROADMAP.md`, 2 markers in `templates/ROADMAP.md` (template only contains Conventions + Milestones at template lines 8 + 40). Auto-add to Key Documents removed in v1; follow-up `COMP-MCP-MIGRATION-2-1-1-3` for hybrid-merge regen. |
| `validateProject()` line in `lib/feature-validator.js` | ✅ corrected to line 608 (was 284) |
| `bin/compose.js` validate call site | ✅ corrected to line 1367 (was 1362) |
| `compose/`-prefix paths scrubbed throughout | ✅ paths normalized to compose-root-relative |
| Status-token vs display-suffix split for headings like `PARTIAL (1a–1d COMPLETE...)` | ✅ Codex iter 4 caught; visitor decomposes into `{statusToken, displaySuffix}`; drift compares tokens only; suffix is opaque human curation |
| No-ROADMAP bootstrap path | ✅ Codex iter 4 caught; replaced `readPreamble()` with explicit existing-vs-bootstrap branch; default template ships pre-wrapped with markers |
| Step 2 ordering (markers-before-writer would strand open markers) | ✅ Codex iter 4 caught; default to atomic combined commit; alternative marker-aware patch documented |
| `appendEvent()` does not enforce `idempotency_key` | ✅ Codex iter 4 caught; dedupe moved to read-side check inside `emitDrift()` before append |
| Key Documents has curated/external rows beyond designDoc fields | ✅ Codex iter 5 caught; Key Documents re-added to preserved sections (4 total). Auto-add behavior dropped in v1; follow-up `COMP-MCP-MIGRATION-2-1-1-3` for hybrid-merge regeneration. |
| Anonymous-row leading-position case (no typed predecessor) | ✅ Codex iter 5 caught; explicit rule "preserve at head of table when parsed predecessor was null" with concrete example (`ROADMAP.md:201`) |
| Milestone phaseId concat is exactly `' > '` (space-greater-space) | ✅ Codex iter 5 caught; consumers locked in (`lib/migrate-roadmap.js:92`, `bin/compose.js:908`) |
| SKIP_STATUSES heading→row propagation behavior preserved | ✅ Codex iter 5 caught; AST visitor replicates `lib/roadmap-parser.js:99–101` |
| `templates/ROADMAP.md` bootstrap template | ✅ Codex iter 6 caught; added to Section H, file change list updated. `compose init` uses this template at `bin/compose.js:367–380`. Marker wrap on `## Roadmap Conventions` in template ensures fresh-init repos don't strand markers on first `writeRoadmap()`. |
| Parser line refs (SKIP_STATUSES, regexes, parseRoadmap, filterBuildable) | ✅ Codex iter 6 corrected: SKIP_STATUSES at line 10, regexes 12–15, parseRoadmap 29–115, filterBuildable 174–177. |
| `lib/feature-validator.js:22` imports `FEATURE_CODE_RE_STRICT` from `feature-code.js`, not parser's `FEATURE_CODE_RE` | ✅ Codex iter 6 caught; corrected blueprint claim. Validator already uses strict regex; parser switch aligns sources of truth without changing validator behavior. |
| Iter-5 vs iter-6 internal consistency: 4 preserved sections everywhere | ✅ Implementation Order step 2 ("4 preserved sections"), Section H (4 rows), bootstrap default ("`roadmap-conventions` marker pair"), corrections table all aligned. |
| Cumulative milestone phaseId behavior (parser line 57 mutates `currentPhaseId` instead of resetting per milestone) | ✅ Codex iter 7 caught; visitor explicitly replicates cumulative concat. Test fixture covers 2-milestone phase (e.g. STRAT-1 Engine + Compose Runner) to lock the behavior. Out-of-scope to "fix" the cumulative nesting itself. |
| `templates/ROADMAP.md` has Dogfooding Milestones at line 40 (not just Conventions) | ✅ Codex iter 7 caught; Section H now wraps both Conventions (line 8) and Dogfooding Milestones (line 40) in the template. Two markers in template, four in live ROADMAP.md. |
| Writer pipeline must include `remark-gfm` in stringify chain | ✅ Codex iter 7 caught; Section C now requires `unified().use(remarkStringify).use(remarkGfm)` for both parse and stringify. Without GFM in stringify, tables round-trip as raw text. |
| 3-vs-4 preserved-section internal consistency | ✅ Codex iter 7 caught; smoke test now says "4 marker-wrapped sections", verification table corrected, Step 2 ordering note updated. No remaining "3 preserved" references. |
| Column-layout detection (typed-row code is in `Feature` column not `#` column) | ✅ Codex iter 8 caught; Section B now requires replicating `detectColumnLayout()` from `lib/roadmap-parser.js:128–164`. Without column detection, AST visitor would route most real feature rows to anonymous and emit almost no FeatureEntry. |
| `filterBuildable()` — drop dead `_anon_` clause | ✅ Codex iter 8 caught; Section B updated. Predicate simplifies to status-skip only. |
| `_anon_` count in tests was an under-count | ✅ Codex iter 8 caught; rows inside preserved-section markers (Dogfooding, Execution Sequencing) carry additional non-typed entries with PARTIAL/PLANNED. Round-trip test enumerates real count from current parser pre-rewrite. |
| `test/feature-validator.test.js:340` test assertion no longer valid | ✅ Codex iter 8 caught; rewrite test to assert "rows that don't match strict regex absent from parseRoadmap output", not "_anon_* sentinel emitted". |
| 8 phase-status overrides + Phase 5 SUPERSEDED | ✅ |
| 11 `_anon_` consumer sites enumerated | ✅ Codex caught `bin/compose.js:835/848/886` and the import-roadmap.mjs detail; now in concrete migration table |
| `FEATURE_CODE_RE_STRICT` is the contract source of truth at `lib/feature-code.js:14` | ✅ Codex caught; parser switches to strict regex |
| `lib/feature-validator.js:72` raw scanner is independent from parser | ✅ Codex caught; out of scope this PR; follow-up filed |
| Source-slice splice mechanism for byte preservation | ✅ replaces "structurally preserved by the AST" hand-wave with a real preservation strategy via mdast `position` offsets |
| `test/feature-code.test.js:28,48` `_anon_` references are strict-rejection tests, KEEP | ✅ Codex caught; grep acceptance criteria scoped to runtime paths only |
| Milestone (depth-3) heading visitor — STRAT-1 milestone tables under depth-3 sub-headings | ✅ Codex iter 2 caught; visitor logic now explicitly composes `phaseId` from depth-2 + depth-3 headings to match parser behavior at `lib/roadmap-parser.js:51` and tests at `test/roadmap-parser.test.js:94` |
| Mixed-table serialization (typed rewritten + anonymous byte-preserved) | ✅ Codex iter 2 caught; concrete handler strategy now in "Mixed-table strategy" sub-section of Preservation Mechanism. Custom `mdast-util-to-markdown` handler iterates `table.children`, branches per row on `data.preserve` |
| `buildDag()` is a behavioral consumer, not just type | ✅ Codex iter 2 caught; importer table now flags it explicitly. Net build-order over `filterBuildable()` is unchanged (anon rows are all COMPLETE and pre-filtered); regression test added to lock this in |
| `validate_roadmap` flow doesn't exist; `validateProject()` is the real path | ✅ Codex iter 2 caught; section F + G updated to wire `validatePreservedSections()` into `validateProject()` at `lib/feature-validator.js:608` (CLI call site `bin/compose.js:1367`) |
| `package.json` test script line | ✅ corrected to line 22 (was 34-35) |
| Grep paths from compose root, not `compose/`-prefixed | ✅ corrected step 10 |

Zero stale references. Two follow-ups identified during review: `COMP-MCP-MIGRATION-2-1-1-2` (validator AST migration) — file before plan phase. Blueprint ready for Phase 6 (Plan).
