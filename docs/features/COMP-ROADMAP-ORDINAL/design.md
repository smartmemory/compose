# COMP-ROADMAP-ORDINAL — Design

## Related Documents

- [Feature brief](feature.json)
- [Coupled prose-reader design](../COMP-ROADMAP-PROSE-READ/design.md) — owns block classification, import ledger, migration publication and source resolutions.
- [COMP-ROADMAP-SILENT brief](../COMP-ROADMAP-SILENT/feature.json) and [design](../COMP-ROADMAP-SILENT/design.md) — required refusal/operation-outcome integration; the design is currently a scaffold.
- [Source of record: ROADMAP-MIGRATE-1](../../../../../SmartMemory/smart-memory-docs/docs/features/ROADMAP-MIGRATE-1/design.md)
- [Canonical feature schema](../../../contracts/feature-json.schema.json)
- [Planning standards](/Users/ruze/.claude/rules/planning-standards.md:19)

**Status:** DESIGN · **Date:** 2026-09-11 · **Scope:** design only; no schema changes or migration performed.

## Evidence and corrections

References use `SM` for `/Users/ruze/reg/my/SmartMemory/smart-memory-docs/docs`. Other paths are relative to compose. All cited lines were inspected on 2026-09-11. The source snapshot and measurement definitions are shared with [the reader design](../COMP-ROADMAP-PROSE-READ/design.md#evidence-and-corrections).

| Checked evidence | Consequence |
|---|---|
| Scanning line prefixes with `^\s*(\d[^\s.]*?)\.\s+` before the GRANTS section (`SM/ROADMAP.md:687`) finds **336 occurrences, 188 distinct labels**. Across all 6,917 lines the same lexical scan finds 388 / 188, including numbered body prose through `:6693`. | The source's 336 / approximately 170 distinct labels (`SM/features/ROADMAP-MIGRATE-1/design.md:107`) understates distinct labels. Do not import all 388 prefixes as ranks. Entry ownership is decided by the reader. |
| The priority contexts start at `SM/ROADMAP.md:11` and `:219`; bold group banners occur at `:273`, `:288`, `:318`, `:633`. | Rank is contextual. A single global ordering field cannot reproduce all views. Preserve observed context and order. |
| PLAT-FALKOR-1 is `1` at `SM/ROADMAP.md:36` and `9` at `:285`. | One feature can have several meaningful ordinals. A single preserved field alone loses information. |
| Two different features use `16a-iii` at `SM/ROADMAP.md:149` and `:155`. SLEEP-DAEMON-3 repeats `9b''''` at `:563` and `:565`. | Labels are not globally unique, nor necessarily unique within a section. Repeated source occurrences are not necessarily duplicate canonical features. |
| Observed tokens include stars (`SM/ROADMAP.md:16`, `:19`, `:24-30`), `3o-C3` (`:75`), `16a-iii` (`:149`), `19a`–`19v` (`:172-208`), `9b'''''` (`:567`), `25a2` (`:654`), and `25f6` (`:674`). | Preserve Unicode, case, hyphens and every apostrophe; do not derive a numeric rank or semantic parent by parsing the spelling. |
| `SM/features/CORE-VEC-DOMAINS-1/plan.md:9`, `:174`; `plan-1b.md:10`, `:160`, `:195`; `design-1b.md:11`, `:292` cite `25f6`. | These are verified inbound textual identifiers, not proof of existing Markdown anchors. Keep the original reference resolvable and visibly present. |
| `contracts/feature-json.schema.json:24`, `:53-54` declare phase, integer-or-string position, and a parent property. No legacyOrdinal or initiative/nesting type is declared. `lib/feature-json.js:108-118` reduces a string position to its leading integer; sorting is phase, numeric position, code at `:148-153`. | Correct the brief: position is not schema-limited to 0–5, and a generic parent property already exists. Neither represents these occurrence-specific labels or their contextual ordering. |
| `SM/roadmap-graph.html:481` starts nodes, `:1854` starts edges; full-file literal search found neither `ordinal` nor `25f6`. `SM/FEATURES.md:9-17` uses Feature/Description/Doc rows without rank. | These checked artifacts do not supply the missing ordinal index. This is not a claim to have searched every file in every repository. |
| `lib/roadmap-parser.js:173-179` only emits code, description, status, phaseId and an incrementing position. `lib/migrate-roadmap.js:68-77` projects those fields and overlays existing state. | Capture ordinals before this projection/consolidation; an ordinal field added only to the schema would not repair the loss. |

Snapshot: `SM/ROADMAP.md:1-6917`, 1,230,939 UTF-8 bytes, SHA-256 `5d7fe9f71656a5062ae531e890a70ad917e5c08db3959b34991b0505862e5adf`. The reader design reports the other independently measured discrepancies. None of the lexical counts alone proves feature or rank coverage.

## Decision: preserve occurrence identity; make legacyOrdinal a convenience

| Option | Evaluation |
|---|---|
| Reuse position | Reject. The current numeric sort helper collapses distinguishing suffixes, and phase-first sorting changes cross-section ordering (`lib/feature-json.js:108-153`). It also fails the verified inbound-reference requirement. |
| Add only legacyOrdinal | Insufficient as the complete design. It preserves a primary spelling but cannot retain PLAT-FALKOR-1's two labels or distinguish duplicate-label references. Accept it only as the simple per-feature display projection defined below. |
| Infer a parent tree from ordinal syntax | Reject for v1. Shared numeric prefixes do not establish containment; repeated `16a-iii` already defeats a unique parent/key interpretation. Do not populate the existing parent property from those guesses. |
| Preserve every observed ordinal/context/order in the import ledger, plus a primary legacyOrdinal on canon | **Selected.** This preserves references and the authored sequences without claiming a new initiative model. It uses the same occurrences captured by the reader. |

Canonical feature identity remains its validated feature code. Ordinals are legacy lookup aliases attached to source occurrences. The earliest ranked occurrence in document order supplies the primary display label; subsequent distinct labels remain resolvable through the index. This deterministic choice is not a claim that the first section is more authoritative than the second. The full index is required whenever imported ordinal-bearing features are published; a field-only implementation does not satisfy this feature.

V1 preserves syntactic indentation, heading/banner context and order. It deliberately does **not** infer that `19a` is a child initiative of `19`, that apostrophes mean a particular insertion algorithm, or that `C3` has a machine-actionable audit meaning. Those semantic interpretations are deferred with explicit retained evidence. Source text remains available in the reader's ledger and the original roadmap remains in place.

## Contract-first seam

**First implementation step: create `docs/features/COMP-ROADMAP-ORDINAL/ordinal-contract.ts` (new) and the sibling `docs/features/COMP-ROADMAP-PROSE-READ/reader-contract.ts` (new), together.** Neither exists today. The following formal design draft belongs in the named ordinal contract. Consumers must use that contract and runtime validation, not independently reconstruct its data shapes from this document.

```ts
// ordinal-contract.ts — proposed contract surface; v1
export type SourceSpan = {
  path: string; sha256: string;
  startByte: number; endByte: number; startLine: number; endLine: number;
};
export type OrdinalContext = {
  id: string; parentId: string | null;
  kind: 'heading' | 'banner' | 'list-parent';
  span: SourceSpan;
};
export type OrdinalOccurrence = {
  occurrenceId: string;
  sourceCode: string | null; canonicalCode: string | null;
  legacyOrdinal: string;
  markerSpan: SourceSpan; entrySpan: SourceSpan;
  contextIds: string[]; sourceOrder: number; indentation: string;
};
export type OrdinalIndex = {
  version: 1; sourcePath: string; sourceSha256: string;
  contexts: OrdinalContext[]; occurrences: OrdinalOccurrence[];
};
export type FeatureOrdinalExtension = { legacyOrdinal?: string };
export type OrdinalQuery = {
  sourcePath: string; legacyOrdinal: string;
  canonicalCode?: string; contextId?: string;
};
export type OrdinalLookup =
  | { outcome: 'FOUND'; canonicalCode: string; occurrences: OrdinalOccurrence[] }
  | { outcome: 'ORDINAL_AMBIGUOUS'; occurrences: OrdinalOccurrence[] }
  | { outcome: 'ORDINAL_NOT_FOUND'; occurrences: [] };
```

The publication schema extension belongs in `contracts/feature-json.schema.json` (existing) and must be validated explicitly despite its current `additionalProperties: true` (`:7`). Formal proposed property fragment:

```json
{
  "legacyOrdinal": {
    "type": "string",
    "minLength": 1,
    "pattern": "^[^\\s]+$"
  }
}
```

The contract's runtime invariants, specified as operations below, additionally verify the exact token against the marker span. Schema acceptance of an arbitrary string is not preservation evidence. The feature extension contains no generated label when the source has no ordinal; omit the property, never use empty string, zero or a minted substitute. The legacy ordinal index is embedded in ImportLedger, whose formal definition and runtime location are owned by [reader-contract.ts, proposed in the sibling design](../COMP-ROADMAP-PROSE-READ/design.md#contract-first-seam). Do not add an independent hand-maintained ordinal file or another writer for the index.

## Capture, identity and ordering rules

1. The reader recognizes an entry before assigning ordinal meaning to its list marker. In a recognized table inventory with an explicit legacy-ordinal column, capture that cell verbatim after trimming cell padding; an ordinary numeric # column is position evidence unless the import resolution explicitly classifies it as a legacy rank. The same ordinal contract covers both sources. For recognized entries, capture the exact token preceding the terminal Markdown list period; exclude that period and surrounding whitespace only. Preserve all interior bytes. MarkerSpan includes the original list marker or table cell; EntrySpan covers the owned source entry. No Unicode normalization, apostrophe folding, numeric parsing, suffix lowercasing or reassignment is permitted.
2. Byte offsets are UTF-8, zero-based, half-open. Lines are one-based and inclusive. Validate spans against the pinned source snapshot. Contexts refer to observed headings, bold banners or explicit list containment; labels themselves do not create contexts. Context and occurrence IDs are deterministic snapshot-scoped identifiers derived from source hash and start-byte offset. They are evidence addresses, not durable feature IDs across changed snapshots.
3. Order is physical source order within a selected context, or physical source order across contexts when the caller explicitly requests the whole source. SourceOrder is a monotonically increasing index over retained ordinal occurrences. Preserve repeated occurrences, including repeated labels for the same feature; canonical feature consolidation must not deduplicate the evidence. Do not sort by label or feed a label into positionSortKey.
4. A recognized structural ranked entry without a canonical feature retains its ordinal evidence. It does not get a synthetic feature. Unresolved code mappings remain visible and block feature publication through the reader's `ROADMAP_CODE_UNREPRESENTABLE`; no loss is excused by a failed canonicalization.
5. Derive a feature's primary label from its earliest accepted occurrence. Preserve all other occurrences in the same ledger. If an existing primary label differs, default preflight refuses `ORDINAL_EXISTING_CONFLICT`; overwrite alone is insufficient to discard an existing label absent from source evidence.
6. Exact lookup includes all indexed occurrences, not just primary fields. After optional code/context filtering, one distinct non-null canonical code is FOUND, even if several occurrences match; more than one code or any remaining unresolved/structural candidate is ORDINAL_AMBIGUOUS. Zero matches is ORDINAL_NOT_FOUND. Never choose the first match on ambiguity. SourcePath scopes the lookup; contexts narrow it when the source repeats a label.

For `25f6`, an exact lookup plus CORE-VEC-DOMAINS-1 must find its source occurrence at `SM/ROADMAP.md:674`. For PLAT-FALKOR-1 both `1` and `9` must resolve when scoped by code. Bare `16a-iii` must report ambiguity on the two inspected entries. V1 exposes this through a pure lookup function used by verification; a separate public CLI/search interface is deferred.

## Preservation and display boundary

Import leaves the source roadmap unchanged. For retained-source regeneration, protect all ranked occurrence markers and their relationship to the same code/context. `generateRoadmapFromBase` already accepts the old text as substrate (`lib/roadmap-gen.js:42-67`), but that API fact is not a proof that ordinal fidelity holds. Extend round-trip verification to compare the contracted ordinal occurrence sequence as well as canonical features; the present checks aggregate by code and compare statuses (`lib/roadmap-roundtrip.js:75-104`).

V1 canonical feature displays may show the primary legacyOrdinal verbatim alongside the code. They must not present it as unique or as the sort key. The complete preserved sequence is read from OrdinalIndex for verification and reference lookup. No new UI work is required to complete this feature: persistence, lookup and retained-source round-trip protection are the release gates.

A base-less renderer that cannot reproduce all aliases/context/order must refuse `ORDINAL_SOURCE_REQUIRED` for an imported ranked roadmap. Retiring or replacing the source is explicitly deferred. This prevents a seemingly successful fresh rendering from leaving only the primary label and breaking surviving references. Adding invented Markdown anchors is also deferred: the verified `25f6` references are textual and do not establish an anchor format to preserve.

## Refusals and shared responsibility

| Named refusal | Trigger and required response |
|---|---|
| `ORDINAL_CAPTURE_INVALID` | Empty/altered token, invalid UTF-8 bounds or marker that does not match its captured token; refuse preflight with source spans. |
| `ORDINAL_CONTEXT_UNRESOLVED` | Claimed context/ownership cannot be established from the source; retain candidate evidence and refuse rather than infer hierarchy. |
| `ORDINAL_INDEX_INCOMPLETE` | A recognized ordinal-bearing occurrence lacks index coverage, or a canonical primary cannot be backed by it; block publication and round-trip success. |
| `ORDINAL_EXISTING_CONFLICT` | Existing primary/index disagrees with the planned import; show the conflicting evidence and leave targets unchanged. |
| `ORDINAL_CHANGE_REQUIRES_RESOLUTION` | A changed-source import removes or relabels an existing feature/ordinal/context association; do not silently replace the old index or alias. V1 requires source reconciliation before retry. |
| `ORDINAL_AMBIGUOUS`, `ORDINAL_NOT_FOUND` | Exact lookup cannot produce a unique feature; report the contracted outcome, never resolve by first match. |
| `ORDINAL_SOURCE_REQUIRED` | Rendering or verification lacks the source/index required to preserve imported ranks; refuse a success/lossless claim. |

All unknown section/table shapes use the reader's `ROADMAP_UNSUPPORTED_SECTION` / `ROADMAP_UNSUPPORTED_TABLE`; this feature introduces no permissive fallback. The reader also owns zero-candidate preflight and all-or-nothing validation. [COMP-ROADMAP-SILENT](../COMP-ROADMAP-SILENT/feature.json) must make those failures nonzero at the operation boundary, including dry run. Its design is a scaffold (`../COMP-ROADMAP-SILENT/design.md:1-31`); the exact ImportOutcome contract proposed in the reader design is a release dependency, not existing functionality. No known ordinal, zero-row parse or skipped-existing count permits exit-zero success without the sibling's evidence requirements.

## Idempotency and changed source

Initial import plans canonical records and their complete ledger together. A field write without the ledger cannot finish APPLIED. Use the reader-owned durable intent and publication-last ledger; resume verifies the source and destination hashes before finishing pending writes. Existing ordinary feature edits must preserve legacyOrdinal unless an explicit supported operation changes it; importing ranks must not overwrite existing position/phase/parent decisions.

An unchanged source and unchanged targets produce exactly the same primary labels, occurrence order, context IDs and index bytes. A verified repeat is ALREADY_APPLIED and leaves mtimes and dates unchanged, including with overwrite. Offset-based IDs are safe for this case because the source hash is unchanged. Timestamp fields are excluded from semantic comparison and are not refreshed during a no-op; the current unconditional update in `lib/feature-json.js:83` must not run.

Changed source is a new snapshot. Recompute evidence addresses; compare associations by source path, literal context ancestry, source code/canonical mapping and exact ordinal, preserving multiplicity. Do not compare byte offsets as durable identity. If repeated identical context ancestry makes rebasing ambiguous, refuse ORDINAL_CONTEXT_UNRESOLVED instead of matching the first occurrence. Whitespace or unrelated prose changes may move spans without losing associations. Explicit overwrite may accept ordering changes or new occurrences after full preflight. Removal, relabeling, context renaming/moving, or a mapping change that would lose an old association refuses ORDINAL_CHANGE_REQUIRES_RESOLUTION. V1 does not support automatic rank renumbering or historical alias retirement: reconcile the source to retain required aliases before retry, or implement a later explicit alias-history contract. Overwrite is not permission to discard inbound references.

The ledger remains generated, never manually merged. Canonical records lacking historical ordinal evidence are not “already applied” merely because their status matches; this import must either backfill them under the reviewed plan or report the conflict. Other features without ordinals retain their existing sort behavior.

## Implementation order and affected files

These are future implementation paths; this task writes only this design and the coupled design.

1. Create `ordinal-contract.ts` (new, this feature folder) and `reader-contract.ts` (new, sibling folder). Add runtime invariants and independently authored fixtures (new, these feature folders), then extend `contracts/feature-json.schema.json` (existing). Freeze primary selection and lookup semantics before reader changes.
2. Integrate capture into `lib/roadmap-parser.js` (existing) before candidate consolidation, using the reader's ownership classification. Implement pure index, primary projection and lookup functions in `lib/roadmap-ordinal.js` (new); they perform no writes.
3. Integrate validated primary projection and index publication through `lib/migrate-roadmap.js` (existing), sharing its import plan/ledger. Verify `lib/feature-json.js` and normal update paths in `lib/feature-writer.js` (existing) preserve the extension; do not reinterpret their position sorting.
4. Add ordinal-aware loss checks and source-required refusal in `lib/roadmap-roundtrip.js` and `lib/roadmap-gen.js` (existing). Protect the retained source; do not introduce a second ordinal renderer or a graph schema change.
5. Extend `test/feature-json-sort.test.js`, `test/migrate-roadmap.test.js`, `test/roadmap-roundtrip.test.js` (existing); add `test/roadmap-ordinal.test.js` (new). Run these and the reader/SILENT CLI integration gates after each affected slice.

## Acceptance gates and falsification

An acceptance gate is complete only when its negative control demonstrably makes the associated assertion fail. Preserve explicit fixture inputs and expected associations independently of the index builder; count equality alone cannot establish preservation.

- [ ] **OR-1 — Contract and capture seam:** the explicit feature schema validates legacyOrdinal, the reader imports the ordinal contract, and runtime validation verifies every captured token/span before publication. **Fails when:** remove the schema property while additionalProperties remains true, delete ordinal capture in the parser, or pass an empty label; contract-declaration and exact-capture assertions must each fail rather than relying solely on permissive schema validation.
- [ ] **OR-2 — Exact spelling and byte evidence:** reviewed fixtures retain `0⭐⭐⭐⭐⭐`, `3o-C3`, `16a-iii`, `19a`, `19v`, `9b'''''`, `25a2` and `25f6`, with the terminal list period excluded only from the lookup token. Full marker bytes remain reconstructible. **Fails when:** drop one apostrophe/star, normalize a hyphen or parseInt the label; exact token and UTF-8 span comparisons must turn red.
- [ ] **OR-3 — Multi-occurrence preservation:** PLAT-FALKOR-1 retains both labels from `SM/ROADMAP.md:36` and `:285`; repeated SLEEP-DAEMON-3 at `:563` and `:565` remains two evidence occurrences but one canonical feature; first-source occurrence determines primary. **Fails when:** store only a scalar field, deduplicate evidence by code/label, or choose the last primary; independent occurrence and primary assertions must fail.
- [ ] **OR-4 — Lookup and inbound references:** exact `25f6` plus CORE-VEC-DOMAINS-1 resolves after import/reload; both PLAT-FALKOR-1 aliases resolve by code; bare `16a-iii` returns ambiguity and an absent label returns not-found. All seven inspected surviving-document citations remain textually unchanged and covered by the indexed association. **Fails when:** load only primary fields, select the first duplicate, remove `25f6` while keeping feature counts constant, or return success with no matches; the corresponding lookup assertion must fail.
- [ ] **OR-5 — Order/context separation:** the index reproduces physical order and explicit heading/banner/indentation context across both priority sections; imported ordinals never change existing position, phase or parent. Table cells explicitly classified as legacy ordinals preserve their literal labels; ordinary # cells remain positions. Numbered body instructions are classified without becoming feature ranks. **Fails when:** sort labels lexically/numerically, infer parent from `19a`, merge equal headings from distinct locations, rank every numeric list item, or convert ordinary # cells into aliases; exact sequence/context and untouched-canon assertions must fail.
- [ ] **OR-6 — Coupled persistence and repeat:** first import stores the complete index and primary together; unchanged repeat and overwrite repeat on a later date leave bytes/mtimes unchanged; crash between feature and ledger publication reports PARTIAL_WRITE and resumes to the same final state. **Fails when:** omit the ledger, refresh updated on no-op, or report APPLIED before ledger publication; filesystem, outcome and reload assertions must fail separately.
- [ ] **OR-7 — Changed source and conflict:** unrelated prose insertion rebases spans without losing associations; explicit overwrite can add an occurrence or reorder retained associations; removal/relabeling/context changes refuse without target mutations. Concurrent destination edits refuse resume. **Fails when:** use byte offset as durable identity, silently replace an old label, accept removal with overwrite, or overwrite an unexpected target hash; rebase/refusal/preimage assertions must turn red.
- [ ] **OR-8 — Rendering and independent corpus audit:** retained-source round trip preserves all accepted ordinal/code/context associations and ordered marker bytes; no-source rendering refuses for imported ranks. Independently classify all 336 priority-prefix occurrences in the pinned snapshot and account for each as feature rank, structural rank or explicit refusal; do not call all 388 full-document numeric prefixes ranks. **Fails when:** drop one alias during regeneration while keeping primary labels, bypass the source-required guard, or omit one classified occurrence while preserving totals; independent sequence and byte assertions must fail. Run PR-1 through PR-10 as the shared integration gate.

## Explicitly deferred

Semantic initiatives, cluster entities, inferred parentage, automatic renumbering, insertion arithmetic, rank editing/dragging, a public lookup UI/CLI, ordinal graph nodes and alias retirement/history are outside v1. Base-less replacement of the narrative remains blocked until it can preserve all aliases and context. The v1 guarantee is narrower and testable: every accepted source ordinal remains exact, contextual, ordered, persisted and resolvable, while uncertain interpretations are named refusals.
