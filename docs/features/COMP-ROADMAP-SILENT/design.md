# COMP-ROADMAP-SILENT: Account for empty effects before claiming success

**Status:** DESIGN · **Date:** 2026-09-11 · **Implementation:** not started

## Related Documents

- [Feature brief](feature.json).
- [Source of record: SmartMemory ROADMAP-MIGRATE-1](../../../../../SmartMemory/smart-memory-docs/docs/features/ROADMAP-MIGRATE-1/design.md). Absolute source: `/Users/ruze/reg/my/SmartMemory/smart-memory-docs/docs/features/ROADMAP-MIGRATE-1/design.md`.
- [COMP-ROADMAP-PROSE-READ](../COMP-ROADMAP-PROSE-READ/feature.json): a zero-row parse is the same failure shape at read time. Owns prose recognition/extraction, not this outcome contract.
- [COMP-ROADMAP-GRAPH-3](../COMP-ROADMAP-GRAPH-3/feature.json): owns external nodes and curated graph presentation/label parity. SILENT controls whether generation may claim readiness or replace an artifact.
- [Planning standards](/Users/ruze/.claude/rules/planning-standards.md): checkbox gates at line 5; contract-first requirement at lines 21–24.
- Existing data contracts: [feature JSON](../../../contracts/feature-json.schema.json), [roadmap rows](../../../contracts/roadmap-row.schema.json), [dependencies](../../../contracts/roadmap-deps.schema.json), [vision state](../../../contracts/vision-state.schema.json).

## 1. Independent verification before design

Measured against current files on 2026-09-11. Compose references are relative to `/Users/ruze/reg/my/forge/compose`. **SM** means `/Users/ruze/reg/my/SmartMemory`; **SMD** means `SM/smart-memory-docs/docs`. Counts below are this run's measurements, not copied figures. Code references identify the inspected implementation; directory totals are computed observations, not assertions written in source code.

Only this design is written. Node probes ran from stdin. Migration ran with filesystem mutation methods replaced by throwing functions and attempted no writes. Graph probes diverted the collector's temporary store into an in-memory filesystem: the actual collector creates/removes a temporary directory (`server/roadmap-graph-vision.js:82–84,118–119`). No graph or persisted vision state was written. These were library/CLI probes, not live MCP/HTTP server tests.

### 1.1 Snapshot and measurement boundaries

| Input | This run | Discrepancy from brief/source |
|---|---|---|
| `SMD/features` | **749 immediate directories**, **745 code-like names**, **19 immediate `*/feature.json`**, **0 immediate `*/deps.yaml`** | Brief says 642 folders. Here 19/749 = **2.54%**; 19/745 = **2.55%**. Neither denominator certifies actual feature membership. `_initiatives`, `_archived`, `_categories`, and `GOV` are the four nonmatching names; nested archives excluded. |
| `SMD/ROADMAP.md` | **6,917 newline characters**, **1,230,939 bytes** | Source §2.1 says 6,912 lines / 1,228,805 bytes. |
| `SM/.compose/data/vision-state.json` | **682 items**, **644 features**, **619 connections**, **989,837 bytes** | Feature/connection counts reproduce. |
| `SMD/roadmap-graph.html` | **2,781 newline characters**, **329,034 bytes**, **371 distinct declared node IDs**, **218 active edge declarations**, **38 completed entries** | Source §2.6 says 2,779 lines / 370 nodes / 228 edges. Counted active object declarations in the three arrays, excluding comments; no browser needed. |

Configured paths and narrative ownership are at `SM/.compose/compose.json:21–30`. Graph array anchors are `SMD/roadmap-graph.html:481,1854,2298`. The source figures being compared are at `SMD/features/ROADMAP-MIGRATE-1/design.md:28,41,75,90`. This report does not infer why counts changed in concurrently edited trees.

Snapshot SHA-256 values:

```text
SMD/ROADMAP.md
5d7fe9f71656a5062ae531e890a70ad917e5c08db3959b34991b0505862e5adf
SM/.compose/data/vision-state.json
4ac469687a58fd8f5307ce7a734de10331dfe64ba7e34f2806c845e47cf4253c
SMD/roadmap-graph.html
36c23a17aa5fe3e4f4047bb96cd66c78686a3a868693266f361f56ff9e041adf
```

### 1.2 A — freshness advice confuses comparison with readiness: reproduced

`checkRoadmapGraph(SM, {out:'smart-memory-docs/docs/roadmap-graph.html'})` returned:

```text
matches=false; exists=true; nodeCount=4; edgeCount=0; warnings=[]
stale: .../smart-memory-docs/docs/roadmap-graph.html differs from regenerated output
(run `compose roadmap graph`)
```

The collector kept 19 canon-backed folders, seeded six prose connections, and rendered four nodes/zero edges. Choke points remain `server/roadmap-graph-vision.js:89,116` and terminal exclusions at `lib/roadmap-graph/model.js:12`. `checkArtifact` emits regeneration advice on any byte difference (`lib/roadmap-graph/index.js:59–75`); `writeArtifact` writes without readiness or ownership preflight (`:43–45`). This remains unfixed.

Qualifications: CLI graph check already exits **1** on differences (`bin/compose.js:1611–1619`); it has misleading diagnosis/advice, not a literal exit-0 check. MCP returns the comparison normally (`server/compose-mcp-tools.js:640–653`), and the dispatcher serializes normal results without `isError` (`server/compose-mcp.js:207–209`). Also, **default output is `SM/roadmap-graph.html`, which is absent**: omitting `out` reports missing, four nodes and zero edges. Overwriting the curated graph is a risk when its actual path is selected; the default command currently points elsewhere. No destructive overwrite was executed.

### 1.3 B — unmanaged projection and absent comparison: reproduced with qualifications

The comment remains at `server/feature-scan.js:186–192`. BENCH-APP-BREADTH-1 has `status:complete`, `phase:verification`, and `lifecycle.currentPhase:explore_design` at `SM/.compose/data/vision-state.json:2659–2660,2679–2681`. Its completion projection is explicitly `document-derived` at `:2683–2684`; its folder has **no feature.json**. The narrative says **PARTIAL** at `SMD/ROADMAP.md:3726–3727`. Another checked conflict: ADM-LOG-1 is COMPLETE in the narrative (`SMD/ROADMAP.md:4990–4992`) versus planned in persisted vision (`SM/.compose/data/vision-state.json:2364–2367`).

My bounded extractor found **674 distinct status-bearing codes**, **503 overlapping vision feature codes**, and **141 literal disagreements**. Applying the existing graph normalization PARTIAL → IN_PROGRESS reduces disagreements to **134** (`server/roadmap-graph-vision.js:25–33`). This does **not** reproduce 130/515 from source §2.4 (`SMD/features/ROADMAP-MIGRATE-1/design.md:75–79`). Recognition rules, for reproducibility:

1. Collect inline `**CODE**` immediately followed by a backticked canonical status; last occurrence wins: 278 distinct codes.
2. Collect `### CODE — Title` sections (also en dash/hyphen), stopping at the next heading; take their `**Status:**` canonical token case-insensitively. Section statuses override inline statuses: 424 distinct codes.
3. Match vision features by `lifecycle.featureCode`, falling back to top-level `featureCode`, then title when an earlier key is absent. Compare lowercase tokens; separately collapse `partial` to `in_progress`.
4. CODE regex: `[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+`. Unsupported forms/prose references excluded. This precedence is an audit rule, not an authority decision for migration. These are narrower observations, not a complete replacement parser.

The existing schema has **no cross-field invariant**: independent status/phase enums and nullable-string currentPhase (`contracts/vision-state.schema.json:26–27,52–59`). Seeding itself assigns `explore_design` regardless of status (`server/feature-scan.js:533–548`); updates do not synchronize lifecycle phase (`:555–608`). The tuple is suspicious/unverified, not a violation of an existing schema. The narrative disagreement is concrete.

The source's “nothing reads the cache / only one adapter caller” claim is false on this tree. Canonical collection ignores persisted state, but startup loads it (`server/workspace-runtime.js:113`) and live graph export consumes it through the adapter (`server/graph-export.js:28–33`). Startup/reseed performs scan + seed without narrative comparison (`server/workspace-runtime.js:127–134`). Historical “nothing ever warned” is **COULD NOT DETERMINE**: historical server logs were not audited. The inspected startup and explicit seed paths lack this comparison today.

### 1.4 C — zero-write migration exits 0: reproduced exactly

Parser output: **114 entries, zero real codes, all anonymous**. First entry: `_anon_0`, description `` `_serialize_config` failure ``, status `` enqueued `{}` ``. Headings become phase metadata (`lib/roadmap-parser.js:109–121`); non-table input is skipped (`:125–131`). Migration skips anonymous entries (`lib/migrate-roadmap.js:47–49`) and returns four empty arrays (`:112`).

Actual `bin/compose.js` migration, invoked in Node with `COMPOSE_TARGET=SM` and synchronous filesystem mutations guarded, printed:

```text
Created: 0 feature.json files
Updated: 0
Skipped: 0 (already exist, use --overwrite to replace)
Skipped (external, cross-project refs): 0
observedExit=0; writeAttempts=0
```

CLI evidence: `bin/compose.js:1496–1508`. Still unfixed. PROSE-READ owns the parser repair; SILENT must detect this outcome even if that parser regresses later.

### 1.5 Fourth reproduced instance — targeted row update finds no supported target

`setRoadmapRowStatus(SM, {code:'BENCH-APP-BREADTH-1', status:'IN_PROGRESS'})` returned normally with `changed:false` and no write attempts. The narrative feature exists at `SMD/ROADMAP.md:3726`, but this writer recognizes supported tables. Read errors return the same result (`lib/feature-writer.js:899–902`); missing/unsupported targets return it at `:950`; escaped pipes/ambiguous cells are skipped at `:930–946`. Already-correct status also returns `changed:false`, with from/to details (`:952`). Read failure, interpretive refusal, no match and idempotency lack a shared contract. The comment says “Refuse,” but the operation returns normally. This is an internal writer; no direct MCP `set_roadmap_row_status` registration was found in the inspected MCP definitions/dispatcher.

### 1.6 Inventory — more than four; some empty results are legitimate

Search scope: roadmap CLI operations and libraries, roadmap MCP tools, feature scan/seed, graph HTTP export, and their source readers. This is not an audit of every Compose operation. “Inspected” means source-traced, not an executed integration reproduction.

| Operation / boundary | Empty/incomplete behavior and checked evidence | V1 classification |
|---|---|---|
| Migration | Reproduced above; existing/external exclusions also yield zero writes (`lib/migrate-roadmap.js:53–62`). | Unknown parser coverage → indeterminate; explicit exclusions can be no-change. |
| Canonical graph check/generate, CLI/MCP | Reproduced above; tiny/empty graph accepted (`lib/roadmap-graph/index.js:43–75`). | Separate coverage, comparison, ownership and effect. |
| Live graph HTTP export/save | Empty store can render/save; save returns `ok:true` (`server/graph-export.js:28–49,73–80`). Dangling edges removed/retried (`:38–42`). Inspected. | Cover this second producer; disclose exclusions, refuse unsafe replacement. |
| `get_roadmap` | Reproduced on SM: all summary buckets 0, empty lists, `rowsTotal:0`, `stale:false`. Anonymous filtering and unconditional narrative freshness at `lib/get-roadmap.js:68–80,119–127`. | Empty query valid only with accounted coverage. |
| Default `compose roadmap` display | No named rows → return without displaying project (`bin/compose.js:1648–1651`). Inspected. | Explicit empty/indeterminate report. |
| `setRoadmapRowStatus` | Fourth reproduction above. | Known absence → refused; unreadable/ambiguous → indeterminate; equal → no-change. |
| Scan; GET scan; POST seed; startup/reseed | Missing/unreadable directory → `[]`; malformed JSON/YAML swallowed (`server/feature-scan.js:143–149,195,206`). Seed returns `ok:true` (`:754–761`). Inspected. | Failed expected-source observation cannot certify an empty projection. |
| Seed persistence | `_save()` returns false on failure, `createItem` ignores it (`server/vision-store.js:127–142,185–187`), seed increments created count (`server/feature-scan.js:554`). Inspected. | In-memory change is not durable application. |
| Roadmap generate/write | Narrative CLI skip exits 0 (`bin/compose.js:1282–1284`); `writeRoadmap` warns and returns path (`lib/roadmap-gen.js:517–521`). Identical bytes also written and called generated (`bin/compose.js:1363–1366`). Inspected. | Explicit ownership refusal; optional projection child can warn; equal bytes → no-change. |
| Roadmap check | Narrative comparison skips, exits 0 (`bin/compose.js:1525–1528`). Inspected. | Explicit not-applicable, never a passed consistency assertion. |
| `xref-sync` | Missing/all-invalid source → empty; unresolved null state counts unchanged (`lib/xref-sync.js:112–119,132–138,31–35`). CLI exits 0 after unresolved links (`bin/compose.js:1555–1565`). Inspected. | All-unresolved → indeterminate; no eligible/equal known → no-change. |
| `xref-push`, MCP push | Missing/invalid source; skipped failures; dry-run appends `pushed` without writing (`lib/xref-push.js:188–195,210–225,229–250`). CLI exit 0 (`bin/compose.js:1577–1590`), MCP delegate (`server/compose-mcp-tools.js:634–637`). Inspected; no external calls made. | Distinguish planned/applied/partial/indeterminate; retain opt-in. |
| `roadmap_diff` | Missing history → `[]`; malformed lines skipped (`lib/feature-events.js:85–104`), normal collections returned (`lib/feature-writer.js:570–593`). Inspected. | Optional empty history valid; corrupt history cannot certify no changes. |
| Feature status/link/artifact retries; idempotency replay | Equality already returns `noop:true` (`lib/feature-writer.js:447–456`); duplicate artifact/link/external link likewise (`:694–700,774–778,1091–1095`); replay wrapper at `:145–149`. Inspected. | Preserve useful no-change; replay cannot claim fresh writes. |
| Shared canon readers/update primitive | `listFeatures` skips malformed (`lib/feature-json.js:128–139`); `readFeature` conflates missing/unreadable (`:47–54`); `updateFeature` returns null if absent (`:168–173`). Inspected. | Strict observation adapters for covered operations; low-level null is not success proof. |

## 2. First implementation step: create the contract

**Create `docs/features/COMP-ROADMAP-SILENT/operation-contract.json` (new) before implementation.** No operation-result contract exists among inspected schemas. This design creates no contract file today. All new wire shapes, reason enums, counters, evidence references and envelopes must be defined there; handlers consume that contract rather than duplicating shapes in prose.

Required named definitions: OperationDescriptor, OperationRequest, SourceObservation, CoverageAssessment, PlannedEffect, EffectReceipt, OperationResult, Diagnostic, ProjectionAssessment, ArtifactProvenance and TransportMapping. These are proposed definitions, not existing types. The sections below specify their semantics; exact properties/examples belong in that file. Semantic constraints not expressible in JSON Schema belong in executable validation in `lib/roadmap-operation.js` (new).

Reuse the existing data contracts linked at the top. Row validation excludes anonymous sentinels (`contracts/roadmap-row.schema.json:5,12–13`); validating surviving rows alone cannot prove parse coverage. Phase/currentPhase coherence needs the new assessment semantics; do not invent an existing invariant.

Ship the exact feature-local contract in the package. Current inclusion covers `contracts/**`, not this feature directory (`package.json:56–72`). Add this specific contract path rather than maintaining an unchecked duplicate schema. Published and local runtimes must validate the same contract.

## 3. General outcome contract

**Design decision:** zero writes is not intrinsically failure. Every covered operation accounts for its observed source universe, selection, exclusions, proposed/completed effects and requested postcondition. An empty collection or fulfilled Promise is not that evidence. Units are explicit: files, records, nodes, edges and bytes cannot be added into one “affected” count. One log write cannot hide zero feature writes.

| Outcome | Meaning required by the contract | CLI / MCP / JSON HTTP |
|---|---|---|
| **applied** | At least one verified semantic effect; requested scope/postcondition satisfied. Identical-byte rewrites/bookkeeping do not count. | 0 / normal / 200 |
| **no_change** | Adequate observation proves equality, no eligible items after explicit exclusions, or permitted empty selection. Reason required. | 0 / normal / 200 |
| **observed** | Read/check completed with adequate evidence; assertion is passed, failed, or not applicable. | pass: 0/normal/200; fail: 1/`isError:true`/409; not applicable: 0/normal/200, never “passed” |
| **planned** | Dry-run has a nonempty validated plan and zero applied effects. Empty valid dry-run is no-change. | 0 / normal / 200 |
| **indeterminate** | Required source coverage/target resolution/read/verification cannot be established. Not evidence of an empty world. | 2 / `isError:true` / 422 |
| **refused** | Known precondition forbids the request: absent exact target in fully read supported source, ownership, unsafe replacement/loss. No primary effects occurred. | 3 / `isError:true` / 409 |
| **failed** | Execution failed without a verified durable effect. Preserve underlying cause and any uncertainty whether effects occurred. | 1 / `isError:true` / 500 |
| **partial** | Some effects verified; required remainder unresolved/refused/failed/unverifiable. Never claim full application or unverified rollback. | 4 / `isError:true` / 409, receipts and retry scope |

TransportMapping in the new contract is authoritative. Preserve existing result fields alongside the mandatory outcome for one compatibility period, but never preserve false success. A byte-comparison fact remains available even when readiness is unknown; the overall result cannot certify verification. HTTP HTML export returns diagnostics on refusal; successful preview HTML displays coverage warnings and exposes the same assessment through contract-defined response metadata.

**REFUSAL prevents the requested effect and requires caller action. WARNING accompanies an operation that proceeds and satisfies its declared obligation.** Optional metadata unavailable during an explicit subset preview is a warning. Unreadable required canon prevents canonical replacement as indeterminate; known unmanaged replacement is refused. Explicit best-effort batches may proceed on resolved xrefs, but unresolved required work makes the overall result partial, not a warning on “all reconciled.” Unrelated optional diagnostic failure may warn without changing an otherwise satisfied outcome.

Eligibility is declared before execution. All-external migration or absent optional event history can be no-change; exact-target update to a missing code is refused. Existing migration records skipped without overwrite are exclusions, not proof of equality: report “already exists; not compared.” Pagination such as `limit:0` can yield zero returned rows with nonzero matches (`lib/get-roadmap.js:118–122`); do not call the source empty. A replay reports no fresh effects, even if its cached original result was applied.

Partial coverage is distinct from empty output. Four nodes from hundreds of candidates require accounting, as do zero nodes. A fully known graph with all-terminal nodes, no dependencies or no filter matches is legitimate. No percentage threshold decides correctness: directories are not automatically features. Expected IDs come from supported rows, canon and declared projection membership; unsupported narrative/unclassified candidate directories make coverage unknown. Archive/external/category exclusions must be explicit and observable. Input errors cannot silently become exclusions.

## 4. Enforcement: the control that fires at the mistake

### 4.1 Mandatory executor and guarded effects

Create `lib/roadmap-operation.js` and `lib/roadmap-operations.js` (new). Register every public operation in §1.6 plus the targeted row writer with its contract-defined obligation, mode, exclusions, empty-selection policy and best-effort policy. Missing policies reject registration; unknown operation IDs refuse before invoking a handler.

The executor owns **observe → account → plan → preflight → apply → verify → respond**. Handlers supply selection/planning through the contract, never a naked success or caller-invented applied count. Strict observation adapters distinguish absent, empty, unreadable, malformed, unsupported and excluded. The executor checks conservation of candidate/selected/excluded/unresolved populations and derives effect counts from receipts. Finalization rejects unaccounted candidates, omitted evidence, applied-with-zero-receipts, no-change-with-unresolved-input and planned-with-writes. A future handler returning an empty array without evidence fails at this runtime boundary immediately.

Mutations use guarded effect adapters, not arbitrary handler callbacks. Successful preflight mints an opaque execution-local capability bound to workspace, planned targets, source/destination fingerprints and policy. Each write consumes authorization; missing capability, changed destination/source, unplanned target or wrong workspace refuses **before the filesystem/provider call**. Direct library calls to covered exports use the same executor; pure renderers may remain pure, but their output alone cannot authorize publication.

Local effects verify planned bytes/state after atomic replacement. Remote effects use provider responses/readback as appropriate; ambiguous timeouts never mean equality. Seed requires persistence receipts: `_save() === false` is failure. Preserve existing completion, link, residue, auth and workspace controls; this capability bypasses none of them. Production does not use the filesystem monkey patch used for this read-only audit.

### 4.2 Required integration seams

- **CLI:** replace operation-specific roadmap exits with registry dispatch and one renderer at the roadmap block (`bin/compose.js:1266` onward). Default display is an explicit registered read; unknown subcommands cannot fall through to display.
- **MCP:** enforce outcomes at the common response seam (`server/compose-mcp.js:207–209`), preserve structured failure diagnostics instead of only error text (`:217–242`). Every tool registration requires explicit domain classification, not prefix guessing; roadmap registrations require executor membership. Graph wrappers currently select only certain fields (`server/compose-mcp-tools.js:611–618,644–653`) and must preserve the outcome.
- **HTTP/startup:** register scan/seed (`server/feature-scan.js:743–765`) and both graph exports (`server/graph-export.js:63–80`) through the operation route adapter. Give those route namespaces one registry owner; reject duplicate/unregistered route installation. Startup/reseed uses the registered projection operation (`server/workspace-runtime.js:127–134`) without requiring an HTTP request.
- **Sinks:** cover graph write (`lib/roadmap-graph/index.js:43–45`), roadmap write (`lib/roadmap-gen.js:514–526`), row patch (`lib/feature-writer.js:957–960`), migration writes (`lib/migrate-roadmap.js:99–103`), xref effects and seed persistence. No success formatting after an already-unguarded write qualifies as enforcement.

### 4.3 Prevent omission from shipping

Add `scripts/check-roadmap-operation-boundaries.mjs` and `test/roadmap-operation-boundaries.test.js` (new). Discover actual CLI branches, MCP/HTTP registrations, covered library exports and reachable effect adapters, and compare them with the registry. Reject missing/stale entries, direct responses/exits outside transport adapters, raw filesystem/provider effects outside guarded sinks, and unresolved dynamic dispatch in the covered operation graph. Resolve imports/aliases/re-exports with an AST; name-prefix/filename grep is insufficient. Opaque external code is confined to named adapters, never a wildcard exemption.

Run the checker in tests and **before publication**, plus registration validation at startup. Current `npm test` includes `test/*.test.js`, but `prepublishOnly` only builds (`package.json:23,28`); publication enforcement is proposed, not currently guaranteed. Existing completion enforcement is a baseline, but scans lines with regexes (`test/completion-write-allowlist.test.js:113–135`) and does not enforce this contract.

Runtime executor/sink checks fire on the mistaken call. The structural check stops new bypasses from shipping; adversarial mutants must prove discovery is independent of the registry. Both are completion gates. This protects against accidental omission through supported APIs, not malicious source deliberately disabling all controls.

## 5. Application decisions

### 5.1 Graph coverage, ownership and safe continuation

Assess coverage and artifact ownership before freshness advice/writing in **both** producers. Equal bytes from incomplete sources do not establish readiness. Missing deps files alone are legitimate; an uninterpreted narrative containing dependencies cannot certify zero relationships. Consume PROSE-READ diagnostics when available; unsupported narrative remains indeterminate until then. Do not build a competing prose parser in SILENT.

Existing HTML without recognized generator provenance is unmanaged. **V1 refuses replacing it** regardless of apparent node count. Do not execute arbitrary HTML/JavaScript to count old nodes: §1's declaration count is an audit, not a generic runtime detector. Newly generated artifacts embed ArtifactProvenance from the new contract; subsequent writes verify ownership, coverage and destination fingerprint. Legacy generated files lacking provenance are conservatively unmanaged; adoption is deferred.

Read-only checks may report byte difference and candidate counts without claiming regeneration is safe. Only established readiness for the **exact destination** permits “stale — regenerate.” This SM case reports unknown/insufficient coverage plus unmanaged destination; replacement is refused. Default and explicit destinations remain visibly distinct. Matching counts cannot prove GRAPH-3 visual parity.

Add a safe one-command continuation: **new** `compose roadmap graph --preview --out <unused-path>`. It renders the observable subset to a previously absent file, visibly labeled preview with coverage/exclusion diagnostics; any existing destination refuses, and default graph is untouched. This explicitly reduced obligation is not a force flag certifying canon completeness. Also add **new**, read-only `compose roadmap inspect --json` exposing the same preflight and resolved source paths. Neither command is claimed to exist today. Canon population and curated graph adoption may require content decisions; do not pretend one command safely completes those decisions.

### 5.2 Projection integrity without invented lifecycle rules

Assess persisted projection at load and before reseed changes managed fields; surface the assessment on seed/check responses. Compare managed records to their real canonical source; label document-derived records unmanaged. In narrative mode, compare recognized narrative statuses as a separate authority assessment. Never automatically merge statuses according to “more advanced,” or use this audit's precedence rule for writes.

Normalize PARTIAL/IN_PROGRESS using the existing declared mapping. Status, display phase and lifecycle phase are different concepts. BENCH's tuple warns of unverified lifecycle coherence until provenance proves an impossible combination; do not rewrite lifecycle progress or claim a schema violation. Its PARTIAL-versus-complete narrative disagreement is separately reported.

Cockpit viewing and available-document scanning may proceed with visible warnings/assessment. A synchronization assertion cannot pass without coverage. Reseed may update verified managed records and leave unmanaged ones intact, returning partial if its required scope remains unresolved. Startup must emit/display this diagnostic instead of discarding the result. Canonical graph checks report persisted projection assessment separately without consuming it as graph truth. Failed loading/parsing must not cause “starting fresh” seeding to overwrite an unexamined persisted file.

### 5.3 Migration, exact targets and batches

Migration observes source coverage before its first write. Named rows, anonymous rows, unsupported spans, existing records, external exclusions and planned writes are separately accounted through the contract. The legacy SM reader produces indeterminate/no writes, even though its array has 114 entries. Fully read empty supported roadmaps can be no-change. Dry-run reports planned rather than created effects.

Targeted row writes distinguish known absence, unsupported syntax, ambiguous target/status, read failure and equality. PROSE-READ owns expanded recognition; SILENT owns truthful outcomes before and after that expansion. Xref operations/history readers follow the same accounting: all unresolved is indeterminate, known equal is no-change, mixed effects retain receipts. External write opt-in is unchanged.

### 5.4 Model the refusal on protectResidue

The implementation begins at `lib/roadmap-residue.js:269`; line 261 is the comment. It inserts preservation markers (`:273–298`). The useful precedent is the entire chain: compute loss → typed `ROADMAP_PROSE_LOSS` with source/remediation (`lib/roadmap-errors.js:16–26`) → refuse before writing → offer `--protect` → recheck the protected candidate before writing (`bin/compose.js:1332–1355`).

Follow that contract: failed precondition, bounded evidence with exact paths/locations and total counts, concrete safe next action, and re-observation on retry. No generic `--force`/`--allow-empty` converts unknown coverage into success. Existing `--accept-loss` remains scoped to prose loss, not new coverage/ownership/projection checks.

## 6. V1 and implementation sequence

**V1:** common contract/executor, runtime response/write enforcement, structural omission check, all §1.6 operation boundaries, strict source observations, graph readiness/ownership for both producers, inspect/new-file preview, projection assessment and transport mapping. Preserve legitimate idempotency and empty queries. Bound routine diagnostics while exposing full evidence via inspect; truncation cannot hide unresolved records.

**Deferred:** prose grammar/dependency extraction and content migration (PROSE-READ/SmartMemory); graph visual parity/external nodes (GRAPH-3); in-place adoption/replacement of unmanaged graphs; automatic lifecycle/status authority repair; historical cache correctness; all non-roadmap Compose operations; distributed rollback/transactions; background telemetry storage/new analytics UI. Refusing legacy in-place graph replacement is deliberate v1 behavior, with new-file preview available.

Ordered future implementation (this task changes only the design):

1. Create `docs/features/COMP-ROADMAP-SILENT/operation-contract.json` and contract fixtures **(new)**. Define §2 types/§3 semantics, referencing existing schemas. Include the contract in `package.json` **(existing)**.
2. Create `lib/roadmap-operation.js`, `lib/roadmap-operations.js`, `lib/roadmap-observation.js` **(new)**: registry, strict observations, outcome derivation, capabilities, receipts, graph provenance/projection checks and transport mapping.
3. Wire migration/generation/read/check/display, row updates, xrefs, retries/history in the **existing** §1.6 files. Strict paths preserve input failures; do not broaden nullable low-level APIs for unrelated callers without a compatibility decision.
4. Wire both graph producers, scan/seed, startup/reseed and persistence in the **existing** §4.2 files; add inspect/preview through the registry. Retain existing authority/residue guards.
5. Add `scripts/check-roadmap-operation-boundaries.mjs`, `test/roadmap-operation-boundaries.test.js` and focused contract/transport/graph/projection/migration tests **(new)**. Wire test/publication checks in `package.json` **(existing)**; run focused and relevant existing tests incrementally.
6. Pass all gates below, including negative controls, installed-package contract loading and transport parity. Document changed outcomes/exit codes at release time; no release metadata is edited in this design task.

## 7. Checkbox acceptance gates and negative controls

All new data/fixture shapes use §2's contract. Execute reversions/mutants in disposable test environments during implementation. Every negative control must break the relevant behavior assertion, not merely exercise a helper agreeing with itself. **These gates are not yet run or passed.**

- [ ] **AC1 — Contract exists and ships:** schema/runtime validation cover each registered operation/transport; the installed package loads the exact feature-local contract. **Negative control:** omit required outcome/coverage evidence or remove package inclusion; validation or installed-runtime assertions must fail.
- [ ] **AC2 — Omission fails at runtime:** execute a new empty-result handler without observations, an unregistered operation, and direct covered library entry calls; no naked success escapes. **Negative control:** bypass registration/finalization; assertions expecting typed contract violations must fail.
- [ ] **AC3 — Preflight precedes writes:** refused/indeterminate plans leave primary artifacts byte-identical; wrong workspace, unplanned target or changed source/destination invalidates authorization. **Negative control:** move a real sink write ahead of preflight or accept a missing/stale capability; write-spy/unchanged-bytes assertions must fail.
- [ ] **AC4 — Structural omission is detected:** actual CLI/MCP/HTTP/export/sink discovery covers aliases/re-exports, rejects stale entries and has no wildcard exemption. **Negative control:** introduce an unregistered route/tool/CLI branch, unwrapped export and aliased raw write; each makes the checker nonzero. Disabling checker wiring must fail test/publication assertions.
- [ ] **AC5 — Valid emptiness/dry-runs remain usable:** supported empty source, equal state, explicit exclusions, filtered-out results, `limit:0`, retries, identical bytes and nonempty dry-runs receive correct successful no-change/observed/planned outcomes, never fresh applied counts. **Negative control:** fail every zero-write operation, count dry-run effects as applied or replay cached applied counts; corresponding behavior assertions must fail.
- [ ] **AC6 — Parser-independent migration regression:** representative feature-heading narrative plus prose table under the legacy parser yields zero eligible codes; CLI/library report indeterminate before writes. Supported table migration applies; repeats report exclusions. **Negative control:** restore anonymous-skip plus unconditional exit 0; nonzero/outcome/no-write assertions must fail. CI must not require the user's SM checkout.
- [ ] **AC7 — Graph readiness differs from freshness:** sparse/unsupported source versus rich unmanaged destination refuses replacement and suppresses unsafe regeneration advice; byte equality cannot certify coverage. Test both producers. **Negative control:** restore unconditional stale advice, skip coverage for equal bytes or bypass live-export preflight; advice/outcome/unchanged-artifact assertions must fail.
- [ ] **AC8 — Legitimate empty graphs and continuation work:** fully accounted zero nodes/edges are allowed; exclusions visible; inspect read-only; preview writes only a new chosen path and labels incomplete coverage. **Negative control:** impose a minimum count, allow an existing preview destination or remove its warning; legitimate-empty/refusal/content assertions must fail.
- [ ] **AC9 — Projection assessment runs at use boundaries:** startup/reseed/seed/check expose a BENCH-like narrative disagreement, unmanaged source and unverified phase coherence; canonical graph uses only declared truth; normalized equivalent statuses do not conflict; lifecycle data remains intact. **Negative control:** remove boundary assessment, erase PARTIAL-versus-complete conflict, flag PARTIAL-versus-in_progress, or rewrite lifecycle to display phase; corresponding diagnostic/unchanged-state assertions must fail.
- [ ] **AC10 — Durable effects are truthful:** failed vision saves/local/provider writes cannot report applied or `ok:true`; mixed batches retain verified receipts and unresolved retry scope. **Negative control:** ignore `_save()` failure, inject failure after the first batch effect, or treat timeout as equality; durable-count/outcome assertions must fail.
- [ ] **AC11 — Exact-target outcomes differ:** missing code, unsupported prose, escaped-pipe/ambiguous status, unreadable source and equal supported row produce specified refusal/indeterminate/no-change results. **Negative control:** restore shared `changed:false` in catch/no-target branches; caller-visible reason/outcome assertions must fail.
- [ ] **AC12 — Reads/xrefs cannot hide unknown source:** cover absent optional history, corrupt JSONL, malformed canon/deps, unreadable configured directory, unsupported grammar, all-unresolved/all-equal xrefs and mixed batches. **Negative control:** restore empty fallbacks or null-state-as-unchanged; indeterminate/partial assertions must fail. Rejecting optional empty history must fail its positive control.
- [ ] **AC13 — Refusal/warning and transport parity:** exercise real CLI/MCP/relevant HTTP adapters for each outcome, checking exit/`isError`/HTTP mapping, diagnostics and effects. Explicit narrative generation refuses; optional narrative projection child warns; not-applicable checks never pass an assertion. **Negative control:** strip MCP envelope, force exit 0, return seed `ok:true` on failure, or turn the optional warning into refusal; end-to-end assertions must fail.
- [ ] **AC14 — Prior safeguards survive:** residue refusal/`--protect` use final candidate bytes; dangling-dependency, completion/auth/workspace controls still enforce; remediation names valid source/destination actions. **Negative control:** disable residue recheck or route `--accept-loss` around readiness/authority checks; corresponding safeguard regressions must fail.

## 8. Review limits

A/C remain unfixed in inspected source. B is an unmanaged/document-derived projection disagreeing with narrative, not proof that managed feature.json drifted or an existing lifecycle schema was violated. D is a fourth live empty-success reproduction. Further inventory paths are source-verified; their integration controls remain implementation work.

The source's 130/515 tally was not reproduced: use this run's 141/503 literal and 134/503 graph-normalized counts with the explicit extraction rules. Folder/graph counts also differ. Historical warning absence and causes of changed totals remain unverified. The contract must expose such uncertainty rather than silently declare success.
