# COMP-MCP-VALIDATE-4 — Validator escaped-pipe column-parse fix

> Status: fix (bug). Tracked under the COMP-MCP-VALIDATE umbrella alongside −1/−2/−3. Surfaced by COMP-MCP-VALIDATE-2 dogfooding.

## Related Documents
- Parent umbrella: [`../COMP-MCP-VALIDATE/`](../COMP-MCP-VALIDATE/design.md)
- Surfaced by: [`../COMP-MCP-VALIDATE-2/report.md`](../COMP-MCP-VALIDATE-2/report.md)

## Symptom

`compose validate` emits false `STATUS_MISMATCH_ROADMAP_VS_FEATUREJSON`, `STATUS_MISMATCH_ROADMAP_VS_VISION_STATE`, `ROADMAP_ROW_SCHEMA_VIOLATION`, and `COMPLEXITY_OR_DESCRIPTION_DRIFT` warnings for ROADMAP rows whose **status visually agrees** with feature.json. Observed on the live repo for 3 rows (COMP-PARITY-1, COMP-CAPS-ENFORCE-4, COMP-ROADMAP-RT-GENFIX), e.g. `ROADMAP says "FLAG", feature.json says PLANNED` — where the row actually shows `| PLANNED |`.

## Root Cause

The validator's table-row parser splits cells with `rowMatch[1].split('|')` (`lib/feature-validator.js`), which also splits on **escaped** pipes (`\|` — the standard markdown escape for a literal pipe inside a cell). A description containing `\|` adds a phantom column, shifting every column after it. Status-column detection (computed from the header) then indexes into description prose, reading a word like `FLAG` as the row's "status" → spurious mismatch/schema findings.

`lib/roadmap-parser.js` already splits correctly (`/(?<!\\)\|/` + unescape); only the read validator and `lib/feature-write-guard.js` used the naive split.

## Fix

Promote the escaped-pipe-aware splitter to a shared, exported helper and use it at **every** ROADMAP-row parse site:

- **`lib/roadmap-parser.js`** — export `splitRoadmapCells(rawLine)`: `rawLine.trim().split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim().replace(/\\\|/g, '|'))`. Refactor the parser's own inline use to call it.
- **`lib/feature-validator.js`** — column parse uses `splitRoadmapCells(rawLine)`.
- **`lib/feature-write-guard.js`** — `scanRoadmapRows` uses `splitRoadmapCells(rawLine)`.

For pipe-free rows the helper is byte-identical to the old naive split, so all existing behavior is preserved; only `\|`-containing rows change (correctly).

The COMP-MCP-VALIDATE-2 surgical writer (`setRoadmapRowStatus`) keeps its escaped-pipe **refusal** guard — once detection no longer false-flags `\|` rows, no `roadmap_status_rewrite` finding drives the writer at them, so the refusal is pure defense-in-depth and stays.

## Acceptance Criteria

- [ ] `splitRoadmapCells` splits on unescaped pipes only and unescapes `\|` → `|`.
- [ ] A `\|`-description row whose status agrees with feature.json emits **no** STATUS_MISMATCH / ROADMAP_ROW_SCHEMA_VIOLATION.
- [ ] A `\|`-description row with a **real** status mismatch is **still** flagged.
- [ ] `scanRoadmapRows` still finds the code on a `\|`-description row.
- [ ] Live repo: the 3 false positives clear; no new errors; full suite green.
