# COMP-ROADMAP-PROSE-READ — Design

## Related Documents

- [Feature brief](feature.json)
- [Coupled ordinal design](../COMP-ROADMAP-ORDINAL/design.md) — owns ordinal preservation, identity and lookup; both features ship the same import seam.
- [COMP-ROADMAP-SILENT brief](../COMP-ROADMAP-SILENT/feature.json) and [design](../COMP-ROADMAP-SILENT/design.md) — owns operation outcomes and CLI failure signaling. Its design is currently a scaffold, not an implemented contract.
- [Source of record: ROADMAP-MIGRATE-1](../../../../../SmartMemory/smart-memory-docs/docs/features/ROADMAP-MIGRATE-1/design.md)
- [Canonical feature schema](../../../contracts/feature-json.schema.json), [dependency schema](../../../contracts/roadmap-deps.schema.json)
- [Planning standards](/Users/ruze/.claude/rules/planning-standards.md:3)

**Status:** DESIGN · **Date:** 2026-09-11 · **Scope:** design only; no implementation or migration performed.

## Evidence and corrections

References below use `SM` for `/Users/ruze/reg/my/SmartMemory/smart-memory-docs/docs`; all other paths are relative to compose. Lines were inspected on 2026-09-11. Counts are observations of the identified snapshot, not universal acceptance thresholds.

| Checked evidence | Design consequence |
|---|---|
| `lib/roadmap-parser.js:97-131` assigns level-three headings to phase membership and discards non-table lines. Its permissive header fallbacks are at `:195-230`. | Classify blocks before extracting fields; never infer a feature table from column count. |
| Direct, read-only `parseRoadmap` invocation on `SM/ROADMAP.md:1-6917` returned 114 entries, zero real codes; the first erroneous status was `enqueued {}` with backticks around the braces. Its source is the implementation table at `SM/ROADMAP.md:4236-4241`. | Feature-body tables are payload, not feature inventories. |
| `lib/migrate-roadmap.js:47-49` skips every anonymous entry; `bin/compose.js:1496-1508` unconditionally exits zero after migration returns. | The zero-write/exit-zero consequence is verified by code inspection, not by executing a migration against SmartMemory. |
| Measured snapshot: 6,917 lines, 1,230,939 UTF-8 bytes; SHA-256 `5d7fe9f71656a5062ae531e890a70ad917e5c08db3959b34991b0505862e5adf`. | This differs from 6,912 / 1,228,805 in `SM/features/ROADMAP-MIGRATE-1/design.md:41`. Freeze the actual fixture before implementing. |
| There are 456 raw `### ` headings; the strict uppercase-code/em-dash regex matches 421 occurrences, 418 distinct tokens. Four matches are `GOV` grouping headings (`SM/ROADMAP.md:5757`, `:5818`, `:5895`, `:5917`). Lowercase-suffix feature headings also exist (`:2778`, `:2882`, `:3334`). | The source's claim that the other 35 are all grouping headings (`SM/features/ROADMAP-MIGRATE-1/design.md:27`) is false. Neither 421 nor 727 is a verified unique-feature oracle. |
| A reproducible lexical list scan finds 325 strict-code list occurrences / 304 distinct codes absent from the strict heading set, totaling 316,335 bytes including each matching line's newline. Scan range: `SM/ROADMAP.md:19-4928`. It is a candidate inventory, including nested lists, not a semantic parse. | The brief's 289 / 313,827 bytes is not reproduced by this definition. Review boundaries and classify candidates independently before setting a fixture total. |
| `SM/ROADMAP.md:350` is now 1,355 bytes and `:627` is 684 bytes, excluding newline. A broader mixed-case list scan finds a 5,771-byte line at `:117`. | Do not assert the cited lines are 3.6 KB, or impose a line-length cap. Preserve full implementation prose. |
| Case-insensitive literal counts across `SM/ROADMAP.md:1-6917`: 387 `Depends on:`, 132 `Blocks:`; beginning-of-line bold labels: 250 and 118. Metadata example now at `:2295-2301`; combined labels share a line at `:2779`. | These differ from 130 Blocks and 249 structured Depends On in the source/brief. Mentions are not edges. The claimed 228-edge equivalence was not independently reconciled and is not a gate. |
| Compose headers: 74 `# / Feature / … / Status` (`ROADMAP.md:158-1598`), seven `# / Item / Status` (`:28-184`), one `# / Layer / Status` (`:136`), six `Feature / Items / Effort / Rationale` (`:924-993`). | The last layout is a sequencing reference table, not a status inventory. Existing protection explicitly covers it in `test/roadmap-parser.test.js:298-325`. |
| `contracts/feature-json.schema.json:12` and `lib/feature-code.js:12` reject lowercase suffixes; `SM/ROADMAP.md:627` contains `SEED-1b`. `SM/ROADMAP.md:30` uses `SPLIT`, absent from the canonical enum at `contracts/feature-json.schema.json:22`. | Recognize source identity/status without silently uppercasing identity or inventing status mappings. Refuse canonicalization until an explicit resolution is supplied. |

Reproduction definitions: heading regex `^### ([A-Z][A-Z0-9-]*[A-Z0-9]) — `; list regex `^\s*(?:\d[^\s.]*\.\s+|[-*+]\s+)(?:~~)?\*\*([A-Z][A-Z0-9-]*[A-Z0-9])\*\*`, followed by exclusion of the heading-token set. List byte count includes only matched lines, not continuation blocks. This deliberately exposes the limits of the earlier measurements. The forge-top 99-row figure, orphan counts and graph parity figures were not remeasured here and are not used as verified evidence.

## Decision: one loss-aware reader, followed by an explicit migration plan

V1 adds a pure block reader and a separate preflight/planning stage. The reader recognizes table inventories, narrative feature sections and numbered/bulleted feature entries in the same document. It captures source spans and ordinals before deduplicating feature identities. Migration consumes the complete report, never an entries-only projection. The existing `parseRoadmap` array API remains a compatibility adapter over the same classifier; it must throw named unsupported-shape diagnostics rather than discard them. Known historical anonymous rows remain available to existing table consumers but never count as migratable features.

No general natural-language inference, LLM extraction, invented feature code, inferred status from a historical report, or automatic case conversion is allowed. Classification succeeds independently of canonicalization: a recognized mixed-case feature remains visible as a candidate, then fails preflight if it cannot satisfy the canonical schema. This distinction prevents malformed identities from vanishing into `_anon_`.

V1 includes dependency extraction and optional `deps.yaml` publication as part of the same migration plan (proposed `--deps`, represented by MigrationPlan.emitDependencies). Dependency diagnostics are always produced; choosing feature-only publication does not claim graph migration complete. SmartMemory content relocation, rewriting surviving plans, retiring the source roadmap, flipping narrative ownership, graph UX parity and a general initiative model are deferred. The retained import snapshot protects content; it does not count as extracting or authoring the missing feature designs.

## Contract-first seam

**First implementation step: create `docs/features/COMP-ROADMAP-PROSE-READ/reader-contract.ts` (new) and the sibling `docs/features/COMP-ROADMAP-ORDINAL/ordinal-contract.ts` (new), together.** They do not exist today. Runtime validation and schema fixtures must be derived from those contracts before parser or writer work. The following is a formal design draft for the named contract, not a second prose definition of its data shapes. Canonical publication uses `contracts/feature-json.schema.json` (existing) and `contracts/roadmap-deps.schema.json` (existing); the ordinal extension is owned by the sibling contract.

```ts
// reader-contract.ts — proposed contract surface; v1
import type { SourceSpan, OrdinalIndex, OrdinalOccurrence }
  from '../COMP-ROADMAP-ORDINAL/ordinal-contract';
type Snapshot = { path: string; sha256: string; text: string };
type Diagnostic = {
  code: string; severity: 'refusal' | 'notice'; spans: SourceSpan[];
  message: string; remediation: string;
};
type BlockKind = 'feature-section' | 'feature-list' | 'feature-table'
  | 'anonymous-table' | 'reference-table' | 'body-table' | 'group'
  | 'narrative' | 'fence' | 'preserved' | 'unsupported';
type Block = { span: SourceSpan; kind: BlockKind; owner: string | null };
type FieldEvidence = {
  field: 'title' | 'status' | 'priority' | 'track';
  raw: string; span: SourceSpan; inherited: boolean;
};
type Candidate = {
  occurrenceId: string; sourceCode: string; canonicalCode: string | null;
  span: SourceSpan; fields: FieldEvidence[];
  context: SourceSpan[]; ordinal: OrdinalOccurrence | null;
};
type DependencyEvidence = {
  ownerOccurrenceId: string; relation: 'depends_on' | 'blocks' | 'concurrent_with';
  raw: string; targets: string[]; span: SourceSpan;
  resolution: 'resolved' | 'explicit-none' | 'unresolved';
};
type Resolution = {
  sourceSha256: string; span: SourceSpan;
  action: 'preserve' | 'map-code' | 'select-field' | 'resolve-dependency' | 'classify-ordinal';
  value: string | string[]; reason: string;
};
type ReadReport = {
  version: 1; source: Snapshot; blocks: Block[]; candidates: Candidate[];
  dependencies: DependencyEvidence[]; diagnostics: Diagnostic[];
  ordinals: OrdinalIndex;
};
type PlannedFile = {
  path: string; beforeSha256: string | null; afterSha256: string; bytes: string;
};
type ImportOutcome = 'READY' | 'APPLIED' | 'ALREADY_APPLIED' | 'REFUSED' | 'PARTIAL_WRITE';
type MigrationPlan = {
  version: 1; sourceSha256: string; resolutionSha256: string;
  outcome: ImportOutcome; emitDependencies: boolean; files: PlannedFile[]; unchanged: string[];
  excludedExternal: string[]; diagnostics: Diagnostic[];
};
type ImportLedger = {
  version: 1; report: ReadReport; resolutions: Resolution[];
  baseline: PlannedFile[]; outcome: ImportOutcome;
};
```

ImportLedger.baseline contains only canonical feature/dependency afterimages; it excludes the ledger and intent themselves, avoiding recursive self-serialization. MigrationPlan.files may include the completed ledger as its final afterimage. The future contract must close the diagnostic vocabulary below, validate UTF-8 span bounds, distinguish missing metadata from an explicit empty value, and constrain Resolution actions individually. The draft does not license an unvalidated arbitrary dictionary. Priority/track publication requires explicit schema additions as part of this feature; neither is declared in the current canonical schema (`contracts/feature-json.schema.json:9-24`, full properties inspected). They remain verbatim evidence until their contract and reviewed mappings are accepted.

Persist the ImportLedger at `roadmap-import.json` beside the resolved roadmap (new runtime artifact). Keep the immutable source text once per published ledger, with references into it; do not copy the entire body into the short feature description. `roadmap-import.intent.json` beside it (new runtime artifact) uses MigrationPlan for interrupted-write recovery. Resolutions use the Resolution contract in an explicit input file; no unreviewed filename or title heuristic may silently resolve a conflict. Paths honor the existing configured roadmap/features roots (`lib/migrate-roadmap.js:28-39`).

## Block recognition and ownership

Process fenced and preserved regions before headings, then feature sections, structural groups, list entries and whole tables. The table compatibility adapter retains existing phase-status inheritance and anonymous-row positioning, with inherited values identified in evidence; strict prose migration never manufactures PLANNED for absent metadata. V1 supports backtick/tilde fences with matching delimiter length, preserved markers, inline code, Markdown emphasis/strike wrappers and escaped pipes. These are grammar requirements; the existing fence toggle only recognizes column-zero backticks (`lib/roadmap-parser.js:22`, `:66-93`). Unterminated shielding yields `ROADMAP_UNTERMINATED_FENCE` or `ROADMAP_UNTERMINATED_PRESERVED`, not permission to hide the rest of the document.

| Known shape | V1 behavior | Refusal boundary |
|---|---|---|
| `### CODE — Title`, including balanced emphasis/strike wrappers | Recognize a feature candidate only with feature evidence: metadata, an explicit source resolution, or a matching feature entry elsewhere. Own its body through the next same-or-higher heading. Lower headings stay payload unless explicitly classified. | Bare `GOV — Enforcement` is not sufficient identity evidence. A section not classifiable as a feature, group, known narrative section or explicit preservation yields `ROADMAP_UNSUPPORTED_SECTION`. |
| Literal bold labels, including several on one line | Parse Status, Priority, Track, Depends On and Blocks at label boundaries, case-insensitively. Keep unknown labels as body evidence. Parse only declared metadata regions, not quoted examples. | For prose entries, accept only the leading explicit status at the entry boundary or a labeled field; never use a status inside a sub-report. Missing status yields `ROADMAP_STATUS_MISSING`; unrecognized or conflicting status yields `ROADMAP_STATUS_UNRESOLVED`. Do not scan later COMPLETE/PARKED words to select a state. |
| Number/irregular-ordinal or bullet followed by emphasized code | Capture marker before stripping formatting; retain every continuation line. Indentation determines syntactic containment. A nested bold code is its own candidate only when the entry grammar and feature evidence agree. | Ambiguous boundaries or multiple identities yield `ROADMAP_UNSUPPORTED_LIST` or `ROADMAP_IDENTITY_AMBIGUOUS`. No prose-length truncation. |
| Named feature tables | Match headers by explicit semantic columns, using `splitRoadmapCells` (`lib/roadmap-parser.js:38`). Support the existing ID/Feature/Item/Description variants with an explicit Status column; permit an ordinal column under the sibling contract. | Missing/duplicate required columns, width mismatch or unrecognized layout yields `ROADMAP_UNSUPPORTED_TABLE`. No last-column-is-status fallback. |
| `# / Item / Status`, `# / Layer / Status` | Recognized historical anonymous inventories; preserve their rows without minting feature files. An explicit code-bearing layout is required to promote them. | An anonymous-only migration yields `ROADMAP_NO_FEATURES`; it is not successful feature extraction. |
| `Feature / Items / Effort / Rationale` | Sequencing references, retained as structural content. Never read Rationale as status or duplicate their referenced features. | A near-match header without a known layout yields `ROADMAP_UNSUPPORTED_TABLE` unless inside an explicitly preserved region. |
| Well-formed table owned by a recognized feature body | Known payload-table shape; preserve verbatim regardless of its column labels. Even a nested table containing a real feature code does not become an inventory. | Malformed table syntax yields `ROADMAP_UNSUPPORTED_TABLE`. |
| Group headings/banners, Revision History, archive pointers, reconciliation notes | Grouping requires recognized children or an explicit preservation resolution. Date/Version/Changes under Revision History is a known narrative table. Preserve all structural text and source order. | No catch-all “everything else is narrative” for unrecognized sections/tables. Require `ROADMAP_UNSUPPORTED_SECTION` / `ROADMAP_UNSUPPORTED_TABLE` plus precise spans and a repair or preservation action. |

Coverage is a partition of source bytes into leaf blocks; candidate spans may reference overlapping parent context but leaf accounting must neither overlap nor leave holes. Unknown blocks remain in the report with refusal diagnostics. A caller cannot suppress a refusal merely because other features parsed successfully. Explicit preservation is scoped to the exact source hash/span, included in the ledger and visible in the summary; stale resolutions fail with `ROADMAP_RESOLUTION_STALE`.

## Consolidation, dependencies and refusals

Consolidate by validated canonical feature code only after keeping every occurrence. Agreeing metadata coalesces; missing metadata may be filled from another occurrence. Conflicting explicit metadata never uses last-wins, most-advanced-status or heading-wins inference: require a hash-bound select-field resolution (`ROADMAP_FIELD_CONFLICT`). All descriptions and bodies remain recoverable from the source snapshot. Existing canon is a separate authority boundary: default migration creates missing files, verifies equality of existing files, and refuses divergent existing managed fields with `ROADMAP_EXISTING_CONFLICT`; explicit overwrite permits the reviewed roadmap values to replace those fields only. Preserve unrelated existing metadata. Explicitly exclude existing position, phase and parent from ordinal backfill; ordinal import must not reinterpret current grouping/ranking decisions. New records derive ordinary phase/position from the accepted reader context, independently of ordinal spelling.

For dependencies, read only labeled fields and recognized inline Depends on/Blocks/Concurrent with clauses attached to a feature entry. Stop at clause/label boundaries; do not mine every code in the body. Accept None as explicit absence; retain qualifiers. Unresolved alternatives, ranges, prose-only references, missing targets, incompatible target codes and contradictory None-plus-target declarations yield `ROADMAP_DEPENDENCY_UNRESOLVED`. Resolve forward references after inventory, allow explicitly declared external targets, and reject self-dependency and contradictory edge declarations. A mixed recognized/unrecognized target list is not partially published.

Publish through `contracts/roadmap-deps.schema.json`; preserve depends_on/blocks direction as implemented by `lib/roadmap-graph/model.js:125-133`. Deduplicate equivalent declarations deterministically; never infer concurrency from an absence of blocking. Validate cycles as `ROADMAP_DEPENDENCY_CYCLE` before optional graph publication. Existing valid hand-authored edges survive additive migration; removing an edge requires overwrite plus comparison to the last import baseline. Never replace a pre-existing manifest wholesale with only the mined subset. Unknown YAML keys fail its existing schema (`contracts/roadmap-deps.schema.json:7`).

Ordinal failures and lookup behavior come exclusively from [COMP-ROADMAP-ORDINAL](../COMP-ROADMAP-ORDINAL/design.md). `ROADMAP_CODE_UNREPRESENTABLE` blocks any invalid canonical code, including a lowercase suffix unless a reviewed mapping is provided. Widening compose's global feature-code grammar is deferred; the v1 reader still captures these features and explains why their publication is refused.

## COMP-ROADMAP-SILENT dependency

The sibling brief (`../COMP-ROADMAP-SILENT/feature.json:3`) names the no-op defect; its current `design.md:1-31` provides no outcome contract. The ImportOutcome proposal above is a required integration agreement, not a claim that SILENT already implements it. SILENT must adopt or formally reconcile it before release; do not ship with the unconditional exit at `bin/compose.js:1508`.

Required behavior: zero real candidates is `ROADMAP_NO_FEATURES`; real candidates but no local eligible feature is `ROADMAP_NO_LOCAL_FEATURES`; unresolved preflight diagnostics produce REFUSED. All must result in nonzero CLI exit, including dry run, with named reasons, source locations and zero target writes. A legitimate repeat is ALREADY_APPLIED only after comparing desired canonical content, dependencies and ordinal ledger to disk. APPLIED requires a verified committed plan. PARTIAL_WRITE is nonzero and resumable. READY is a nonempty validated dry-run plan, not proof of writes. Anonymous rows, excluded externals and “skipped existing” counts cannot prove ALREADY_APPLIED.

## Idempotency and publication

Preflight the entire input before any feature write. Dry run performs the same classification, validation, conflict checks and byte planning and writes nothing. Even feature-only publication refuses unresolved dependency clauses in v1; opting out of YAML output is not an ignore-errors switch. A reviewed plan binds source, resolutions and destination preimages; changes before publication yield `ROADMAP_SOURCE_CHANGED` / `ROADMAP_TARGET_CHANGED`.

Publication acquires an exclusive import lock beside the roadmap (`roadmap-import.lock`, new runtime artifact), writes a durable intent, uses atomic per-file replacement, and publishes the completed ledger last. A concurrent importer gets `ROADMAP_IMPORT_BUSY`; an abandoned lock requires intent/preimage recovery before replacement. The lock coordinates importers only; destination hashes still guard unrelated writers. This extends the existing per-feature temporary-file/rename primitive (`lib/feature-json.js:80-93`); it does not claim cross-file filesystem atomicity. Crash recovery compares preimages and planned afterimages, completes pending files, and refuses unexpected third-party edits. It must not call a partially published run APPLIED. Existing migration's per-write COMPLETE exemption remains named and logged (`lib/migrate-roadmap.js:84-98`); no new normal-completion bypass is introduced.

Compare content before invoking writers. An unchanged rerun, including overwrite and a different calendar day, does not invoke `writeFeature`, whose current behavior always changes `updated` (`lib/feature-json.js:83`). It also does not rewrite YAML, ledger or source, change mtimes, add duplicate aliases, or append identical intent records. Changed source is a fresh preflight; preserve existing unmanaged metadata and use the previous successful baseline for conflict detection. Source deletion is never automatic deletion of canonical features or aliases. New/changed ordinal relationships follow the sibling's stricter refusal rule.

## Implementation order and affected files

All paths here describe future implementation; this design task changes only this file and its sibling design.

1. Create `reader-contract.ts` (new, this feature folder), `ordinal-contract.ts` (new, sibling folder), contract validation and independently reviewed fixture expectations (new, these feature folders). Reconcile SILENT outcomes before wiring CLI success.
2. Implement block reader and compatibility adapter in `lib/roadmap-parser.js` (existing); reuse status/pipe helpers rather than fork them. Add pure source accounting and ordinal capture before consolidation.
3. Add preflight, dependency publication and resumable intent handling to `lib/migrate-roadmap.js` (existing); extend canonical metadata contracts in `contracts/feature-json.schema.json` (existing). Integrate ordinal persistence only after its contract validators exist.
4. Integrate SILENT outcome handling in `bin/compose.js` (existing). Adapt `lib/roadmap-roundtrip.js` (existing) to the rich report without counting summary/section duplicates as independent canonical features; its current aggregation is at `:75-104`.
5. Extend `test/roadmap-parser.test.js`, `test/migrate-roadmap.test.js`, `test/roadmap-roundtrip.test.js` (existing); add contract, fault-injection and CLI fixtures (new). No implementation step mutates the real SmartMemory source as a test.

## Acceptance gates and falsification

Each gate needs an executable assertion and a demonstrated failing negative control. Expected IDs, source excerpts and edge direction must be authored from reviewed fixture text, not produced by the parser under test. Run the focused Node tests plus relevant CLI/round-trip regressions after each implementation slice; record which gate catches each mutant.

- [ ] **PR-1 — Contract seam:** reader, planner, ordinal index and runtime validators use the named contract files; every planned canonical file validates against its schema. **Fails when:** remove ordinal evidence at the reader-to-planner boundary or replace a required source span with an invalid range; validation must reject it before any write. A permissive schema accepting arbitrary extra fields is not evidence.
- [ ] **PR-2 — Prose sections:** independent fixtures reproduce the metadata at `SM/ROADMAP.md:2295-2301`, combined labels at `:2779`, duplicate occurrences and grouping-only GOV headings. **Fails when:** demote a real heading to phase membership, promote GOV into a feature, or read the later KILLED discussion at `:2305` as the feature's status; exact candidate/field assertions must fail.
- [ ] **PR-3 — Lists and full content:** a reviewed inventory covers irregular ordinals, struck codes, nested bullets, continuation paragraphs and a source line exceeding 5 KB. Source leaf accounting and saved snapshot reconstruct every UTF-8 byte, including body tables. **Fails when:** truncate at 3.6 KB, stop a list at its first newline, strip an apostrophe, or omit a continuation; independent byte and occurrence comparisons must fail.
- [ ] **PR-4 — Table discrimination:** all six observed compose header layouts classify correctly; the two body tables and Revision History produce no feature rows. Existing table-only fixtures keep their identity, statuses and anonymous-row behavior. **Fails when:** restore the header-count fallback, treat Rationale as status, or promote the `_serialize_config` table at `SM/ROADMAP.md:4236`; exact classifications and zero phantom-feature assertions must fail.
- [ ] **PR-5 — Total refusal coverage:** unsupported section, table and list shapes, malformed shielding and stale preservation resolutions all yield their named refusals with source spans, even alongside a valid feature. **Fails when:** replace one refusal with `continue` or a generic narrative classification; the mixed valid/invalid CLI fixture must then fail its nonzero-exit and zero-write assertions.
- [ ] **PR-6 — Identity and authority:** mixed-case codes, SPLIT/missing status and conflicting repeated metadata remain visible but refuse publication until explicitly resolved. Conflicting existing canon refuses by default and only managed fields change on overwrite. **Fails when:** uppercase SEED-1b, default missing status to PLANNED, choose last occurrence, or overwrite unrelated metadata; assertions must identify each loss.
- [ ] **PR-7 — Dependencies:** reviewed labeled/inline clauses produce exact schema-valid per-feature manifests, with explicit None, forward/external references, inverse Blocks, duplicate declarations and existing authored edges covered. Ambiguous clauses and cycles refuse graph publication. **Fails when:** reverse Blocks, silently omit one unresolved target, mine a body citation, duplicate an edge on rerun, or erase an existing authored edge; exact graph/file assertions must fail. The raw 387/132 mention counts are not the expected edge count.
- [ ] **PR-8 — SILENT integration:** run the real migration CLI in isolated fixtures for empty, anonymous-only, all-external, mixed-invalid, valid dry run and verified-repeat input; assert outcome, exit code, diagnostics and filesystem effects. **Fails when:** reinstate unconditional exit zero or equate skipped-existing with already-applied; at least the empty/divergent-existing subprocess tests must turn red.
- [ ] **PR-9 — Idempotency/recovery:** first migration, unchanged repeat, overwrite repeat on the next date and resume after each file boundary yield identical final content; repeat leaves bytes and mtimes unchanged. Dry run and preflight refusal leave no artifacts. **Fails when:** force unchanged writes, crash before ledger publication, or edit a destination between plan and resume; clock/mtime checks and partial-write/target-conflict assertions must catch these separately.
- [ ] **PR-10 — Coupled migration and round trip:** freeze and independently classify the measured SmartMemory fixture; every feature-like occurrence is accepted or explicitly refused, every ordinal satisfies OR-1 through OR-8, and source bytes remain retained. Validate rich-reader/legacy-adapter behavior against canonical round-trip fixtures. **Fails when:** delete one expected feature/ordinal from output while leaving row counts constant, or use the old parser for migration/round-trip; exact identity and source-evidence comparisons must fail. This gate cannot pass merely by reproducing 421, 727 or 228.

## Release boundary

Ship the reader, ordinal persistence and SILENT CLI contract together. A raw SmartMemory import may correctly refuse unresolved legacy codes or conflicting metadata; “supported reading” does not mean fabricating canonical values to force a successful import. Completion requires reviewed fixtures proving both successful resolved migration and actionable refusal of unresolved originals. No approval to replace the narrative or adopt the generated graph follows from these features.
