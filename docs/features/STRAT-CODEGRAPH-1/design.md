# STRAT-CODEGRAPH-1 — Code graph via SmartMemory

**Status:** PLANNED (rescoped 2026-10-05) · **Epic:** STRAT-CODEGRAPH · **Promoted from:** IDEA-37

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
- [ ] Compose detects SmartMemory availability. Without it, checks log a single warn-only notice and never fail a build.
- [ ] Forge (compose + stratum/ts) is indexed through a SmartMemory surface that reaches JS/TS. The surface used is named in the report.
- [ ] Incremental re-index touches only changed files. The timing is recorded.
- [x] **Spike S3:** replay one past plan or blueprint that named nonexistent symbols. The reality check flags every one. **PASS 2026-10-08** (COMP-GSD-2). Report unmarked proposed names as "unmarked new", not errors ([spikes-2026-10-08.md](spikes-2026-10-08.md)).
- [ ] Plan reality check runs at the plan gate and lists unresolved names with the artifact line.
- [ ] Prior-art search runs before design and lists matches with file:line.
