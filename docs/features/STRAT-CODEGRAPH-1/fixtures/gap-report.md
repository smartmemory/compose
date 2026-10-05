VERDICT: SmartMemory can provide partial JS symbol search today, but cannot reliably serve forge’s TS dependencies, impact analysis, write inventory, or patch fences.

Evidence roots: `C/` = SmartMemory/smart-memory-core/smartmemory/code/, `M/` = smart-memory-mcp/smartmemory_mcp/, `A/` = smart-memory/smartmemory_app/, `R` = smart-memory-service/memory_service/api/routes/code.py, `F/` = smart-memory-docs/docs/features/FULL-ALIGN-1/facts/. Sizes are estimates.

| Ranked gap | Evidence | Blocks uses # | Size | Fix shape |
|---|---|---|---|---|
| 1. TS module resolution | C/ts_parser.py:514–526; measurement.json: zero TS bindings | 2,5,7,8,10 | M | Resolve emitted extensions, aliases, package exports and barrels. |
| 2. Missing call sites | C/ts_parser.py:664–689; ground-truth.json: 4/15 found | 2,4,5,7,8,10 | M | Traverse callees, expression roots, callbacks and module execution with scope ownership. |
| 3. Python-only sink scanner | F/sink_inventory.py:3402,373 | 4,10 | L | Add JS/TS AST adapters and driver identity analysis. |
| 4. MCP ingestion disconnect | M/tools/code_tools.py:74; M/hosted/tools.py:40 | 1,2,3,5,7,8,10 via MCP | S | Share core parsing/resolution and expose hosted upload. |
| 5. Symbol collisions, missing ranges | C/ts_parser.py:411; C/models.py:43–56; 35 duplicate IDs | 1,5,6,10 | M | Scope-qualified identities and persisted byte/line spans. |
| 6. Framework/test semantics absent | C/ts_parser.py:195–245; R:652,606 | 4,7,8,10 | M | Model registrations, JSX references, test callbacks and export reachability. |
| 7. Grammar partials | measurement.json: two partials; both node --check exit 0 | 1,3,5,6,10 | M | Diagnose valid-JS grammar errors and enforce coverage diagnostics. |

**1. Entry points.** Local MCP `code_index` uses its separate Python parser, then local writes or REST upload (M/tools/code_tools.py:57–116). Hosted MCP exposes search/dead-code/dependencies only (M/hosted/tools.py:40). REST accepts already-parsed entities/relations, including arbitrary entity-type strings, without parsing/resolution (R:44,67,184,217). `CodeIndexer.index()` defaults Python, enables .ts/.tsx/.js/.jsx through `languages=["typescript"]` (C/indexer.py:200–219). `SmartMemory.ingest_code` forwards to its manager/indexer (smart-memory-core/smartmemory/smart_memory.py:8141; managers/code_intel.py:75).

CLI `sm code index --language typescript` supports local and client-side hosted parsing/resolution (A/cli_code.py:86–94,164; A/hosted_code.py:97–121). Hosted upload rejects partials (:106). FULL-ALIGN mirror indexing defaults Python (smart-memory-docs/docs/features/FULL-ALIGN-1/mirror/structure.py:159). Python and JS SDKs upload parsed payloads, without parsing (smart-memory-client/smartmemory_client/client.py:1230; smart-memory-sdk-js/src/api/MemoryAPI.js:487). Individual structured ingestion accepts module/class/function/route/test, rejects component/hook, and trusts supplied edges (smart-memory-core/smartmemory/memory/ingestion/handlers/code_entity.py:17,80).

**2. Extraction.** Function declarations, const/let arrows/function expressions and class methods work (C/ts_parser.py:195,335,394). Object-literal methods are skipped: variable values must be function nodes (:353). Named declaration exports and default exports work (:207–234,432). Export aliases/re-exports lack bindings. JSX functions become components, but JSX tag references are not CALLS (:110,267,667).

Relative ESM named/aliased/default/namespace imports work (:551–643). CommonJS `require` and dynamic `import()` produce ordinary calls inside captured bodies, without import bindings. Member calls retain raw `obj.fn` names. Imported namespace calls resolve via C/indexer.py:118–122, ordinary object receiver calls do not. Saved fixtures confirm these distinctions (features.json). Three real JSX samples yielded ten components, but only 146/452 AST calls captured.

**3. Resolution.** Relative existing files, extensionless imports and index files resolve (C/ts_parser.py:502–528). `.js`→`.ts` substitution is absent. Bare aliases/workspace packages are rejected at :508, with no tsconfig/package lookup. SymbolTable binds imported names/defaults/namespaces (C/indexer.py:108–152), without export visibility or lexical scope checking. TS module entities use filenames while symbols use dotted paths (C/ts_parser.py:173; C/indexer.py:75–87).

Neither core Python nor TS CALLS carry exact/name-only confidence (C/parser.py:253; C/ts_parser.py:678; C/indexer.py:552). Python V2 scanner edges do (F/sink_inventory.py:2714).

**4. Downstream.** Search matches language-neutral names/metadata (C/search.py:56,159). Dependency queries traverse stored edges (R:468,506), so missing edges degrade results. Dead-code selects only functions, excludes Python dunders/decorators, and misses component/hook kinds (R:652,606,703). Python module naming at C/parser.py:52/364 is bypassed by TS dispatch at :382. TS emits no TESTS, unlike Python’s name convention (:257). Dependency/dead-code MCP require REST (M/tools/code_tools.py:410,459). Use 9 is independent: provenance matches text spans, not Python AST (smart-memory-core/smartmemory/provenance/matcher.py:46,72), but needs captured sessions. Store-backed behavior remains **unverified**.

**5. Measured probe.** In-process, pinned grammar versions already installed, no stores/services touched. Per-file checkpoints preserved. Requested glob set: 165 JS + 11 TS = 176 files, 174 clean, two partials (`boundary-map.js`, `policy-check.js`), zero hard failures. Summed parse time: 0.543s. Entities: 176 modules, 2,230 functions, 54 classes, zero components/hooks. 2,460 records collapse to 2,425 IDs. AST calls: 18,315; extracted CALLS: 14,202. Cross-file definitions: 904/14,202 = 6.37%, or 904/18,315 = 4.94% of AST sites. JS: 904/12,816; TS: 0/1,386. These are resolution fractions, not recall estimates (measurement.json).

Grep-verified edges below are checked against saved targets in ground-truth.json. JS paths are forge/compose/lib/, TS paths forge/stratum/ts/src/.

| Caller | Definition | Result |
|---|---|---|
| journal-writer.js:540 | idempotency.js:144 checkOrInsert | missed |
| judgment-writer.js:1002 | idempotency.js:144 checkOrInsert | found |
| followup-writer.js:323 | idempotency.js:144 checkOrInsert | found |
| feature-writer.js:147 | idempotency.js:144 checkOrInsert | missed |
| changelog-writer.js:327 | idempotency.js:144 checkOrInsert | missed |
| completion-writer.js:265 | idempotency.js:144 checkOrInsert | missed |
| build.js:3885 | pipeline-compat.js:55 tsCompatibilityOf | found |
| new.js:101 | pipeline-compat.js:55 tsCompatibilityOf | found |
| engine/engine.ts:561 | ir/validate.ts:348 validateSpec | missed |
| engine/engine.ts:515 | engine/run_lock.ts:332 acquireRunLock | missed |
| engine/engine.ts:921 | engine/receipts.ts:26 buildReceipt | missed |
| engine/engine.ts:968 | engine/checkpoint.ts:36 commitCheckpoint | missed |
| engine/engine.ts:1010 | engine/receipts.ts:67 spineSpent | missed |
| ir/validate.ts:447 | ir/refs.ts:78 extractReferences | missed |
| engine/run_lock.ts:333 | engine/state.ts:274 assertRunId | missed |

**6. V2 scanner.** Python-only source loading/AST traversal (F/sink_inventory.py:373,3402), including merge_atoms.py:179. Proposed port needs scoped import/type resolution, exact/uncertain edges, fs write/append/rename/delete, SQL/Redis/HTTP driver classifiers, literal-operation analysis and uncertainty propagation. Detect MCP dispatch registrations (forge/compose/server/compose-mcp.js:132), Express callbacks (forge/compose/server/index.js:202), CLI command dispatch (forge/compose/bin/compose.js:1258) and test registrations. Adapt merging to language-neutral spans and nodes.

<oai-mem-citation>
<citation_entries>
MEMORY.md:552-552|note=[guided store-free parser strategy verified against current source]
</citation_entries>
<rollout_ids>
01a0fd97-7f79-7790-b999-1bbc4ab21e94
</rollout_ids>
</oai-mem-citation>
