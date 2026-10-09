# STRAT-CODEGRAPH-1 — Code graph via SmartMemory

**Status:** PARTIAL (built 2026-10-08, compose 66d86e46..724b6787; waits on SM CODE-BUNDLE-CLI-1 + a TS-capable release) (rescoped 2026-10-05) · **Epic:** STRAT-CODEGRAPH · **Promoted from:** IDEA-37

## Related Documents
- Roadmap: `compose/ROADMAP.md` § STRAT-CODEGRAPH
- Sibling: [STRAT-CODEGRAPH-2](../STRAT-CODEGRAPH-2/design.md) (consumes this backend), STRAT-CODEGRAPH-3 (blast-radius scoring)
- Related: COMP-CANON-INVENTORY (canon write list via the SmartMemory effects engine)
- Spike results: [spikes-2026-10-08.md](spikes-2026-10-08.md)
- Evidence: [fixtures/](fixtures/README.md) (baseline gap report, 15 grep-verified cross-file edges, probe; pinned SHAs)
- SmartMemory dependencies (smart-memory-docs, CODE-DEV initiative): CODE-INGEST-SURFACES-1, CODE-TS-RESOLVE-1, CODE-PARSE-DIAGNOSTICS-1

## Why the rescope
The original item planned to adopt an outside code-graph tool (Scope or CodeGraphContext). Forge already runs on SmartMemory, which ships a tree-sitter JS/TS + Python code parser and graph (CODE-DEV-5/7) behind `code_search` / `code_dependencies` / `code_dead_code`. Those tools were offered in sessions but never called once (transcript search, 2026-10-05), so the job is to wire forge to SmartMemory, not to adopt a third tool.

## Ownership split (owner decision 2026-10-05)
- **SmartMemory** owns parsing, resolution, the graph and the effects engine. It lands on 1.x and is carried into 2.0 by CODE-EFFECTS-V2-MIGRATE-1.
- **Forge** owns its consumers plus repo-specific rules (which writes count as canon), as config.
- **Optional dependency:** Compose ships on npm, so SmartMemory is optional. Without it, every check degrades to warn-only, the same pattern as the judgment enrichment (`lib/judgment-gen.js:47`).

## Measured baseline (2026-10-05, 176 forge files)
- Parsing works: 0.54 s, 174 clean, 2 partial (`lib/boundary-map.js`, `lib/policy-check.js`).
- Cross-file call resolution is weak:
  - TS resolved 0 of 1,386 calls, because an ESM `./foo.js` specifier is not mapped to `foo.ts` (`ts_parser.py:514-526`).
  - Only 4 of 15 grep-verified edges were found.
- The local MCP `code_index` collects Python only (`code_tools.py:74`).

## Scope
- **Index forge.** Index compose (JS/JSX) and stratum/ts (TS) on first build run, and re-index changed files incrementally.
- **Plan reality check.** At design/blueprint/plan, every symbol and file the artifact names must resolve in the index. Unresolved names are flagged.
- **Prior-art search.** Before a design starts, search the index for the concept. Hits are surfaced as "this may already exist".

## Acceptance criteria
- [x] **Spike S0 (first):** re-run `fixtures/probe.py` against SmartMemory once CODE-TS-RESOLVE-1 lands. TS cross-file resolution must be > 0, and the result is recorded against the baseline above. **PASS 2026-10-08:** TS 0 → 51, ground truth 4 → 15/15 ([spikes-2026-10-08.md](spikes-2026-10-08.md)).
- [x] Compose detects SmartMemory availability. Without it, checks log a single warn-only notice and never fail a build. **MET 2026-10-08** (`lib/codegraph/availability.js`, `test/codegraph-availability.test.js`). Against PyPI 1.5.24 it reports available with a visible "no TS grammar" warning, and TS files land in skipped_paths as `grammar_unavailable`.
- [x] Forge (compose + stratum/ts) is indexed through a SmartMemory surface that reaches JS/TS. The surface used is named in the report. **MET 2026-10-08, with a caveat:** the surface is `lib/codegraph/bundle_fallback.py` (a private `CodeIndexer.parse` import) on core main plus the dev TS grammars. No released smartmemory reaches JS/TS yet; that waits on CODE-BUNDLE-CLI-1 and the `[typescript]` extra release ([build report](../../../../scratch/2026-10-08-codegraph/build/REPORT.md)). **Superseded 2026-10-09:** the surface is now the released `smartmemory code bundle` CLI (>= 1.5.26); the fallback is removed ([switch-over report](../../../../scratch/2026-10-08-codegraph/build/REPORT-switch.md)).
- [ ] Incremental re-index touches only changed files. The timing is recorded. **PARTIAL 2026-10-08:** SM re-parses only changed files, but it re-runs resolution over the whole repo (compose: cold 170 s, warm 75 s, cache hit 0.4 s). Timings are in `.compose/codegraph/<repo>/timings.jsonl`. Build-start prebuild hides most of it.
- [x] **Spike S3:** replay one past plan or blueprint that named nonexistent symbols. The reality check flags every one. **PASS 2026-10-08** (COMP-GSD-2). Report unmarked proposed names as "unmarked new", not errors ([spikes-2026-10-08.md](spikes-2026-10-08.md)).
- [x] Plan reality check runs at the plan gate and lists unresolved names with the artifact line. **MET 2026-10-08** (`lib/codegraph/reality-check.js`, plan_gate hook in `lib/build.js`, warn-only).
- [x] Prior-art search runs before design and lists matches with file:line. **MET 2026-10-08** (`lib/codegraph/prior-art.js`, explore_design hook in `lib/build.js`).
