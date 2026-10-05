# STRAT-CODEGRAPH-1 fixtures: SmartMemory JS/TS baseline

The baseline measurement of SmartMemory's JS/TS code parser and resolver against forge source. It is the acceptance test for STRAT-CODEGRAPH-1 here, and for CODE-TS-RESOLVE-1 / CODE-CALLSITE-COVERAGE-1 in SmartMemory, which keeps its own copy.

## Provenance
- Produced 2026-10-05 by a Codex `gpt-6.1-sol/high` read-only run (stratum run `0a4090792729`). Key claims were spot-checked against source.
- Parsing is in-process and never writes to any SmartMemory store.
- Measured against these commits, with clean trees on the parsed paths. The line numbers in `ground-truth.json` are valid only at these SHAs:

  | Repo | Commit |
  |---|---|
  | forge compose | `ddec237c73e20648b28598a8db12f034819a8ed5` (`lib/` identical to the measured tree) |
  | forge stratum | `d697d9c779048ea71d7b77aa6d98efefd785d0f4` |
  | smart-memory-core `smartmemory/code/` | `55d45db3106ff5395e8f1f172d0b843c69529995` |

- Grammar versions: tree-sitter 0.25.2, tree-sitter-typescript 0.23.2, tree-sitter-javascript 0.25.0.

## Files
| File | What it is |
|---|---|
| `ground-truth.json` | 15 cross-file call edges, each verified by grep: caller file:line, callee definition file:line, source text of both lines, and the import line. It also records `found` / `extracted` for the baseline run. |
| `measurement.json` | Baseline numbers. 176 files, 174 clean, 2 partial. 14,202 extracted CALLS, of which 904 resolve cross-file. All 904 are JS; TS resolves 0 of 1,386. |
| `probe.py` | Parses compose/lib/*.js, stratum/ts/src/engine/*.ts and stratum/ts/src/ir/*.ts. It then runs SmartMemory's own `SymbolTable` and `_resolve_cross_file_calls` on the result. |
| `ground_truth.py` | Re-verifies the 15 edges against source and checks each against the probe's resolved relations. |
| `gap-report.md` | The full ranked gap analysis from the same run. |

## Re-running
Run in a copy, never in this folder: both scripts write their outputs beside themselves, and `ground_truth.py` would overwrite `ground-truth.json`.

```bash
cp -r compose/docs/features/STRAT-CODEGRAPH-1/fixtures <workspace>/scratch/<date>-codegraph-probe
cd <workspace>/scratch/<date>-codegraph-probe
# Optional overrides; the defaults are this machine's paths
export SM_CORE=/path/to/smart-memory-core FORGE_ROOT=/path/to/forge
uv run --no-project --with tree-sitter==0.25.2 --with tree-sitter-typescript==0.23.2 \
  --with tree-sitter-javascript==0.25.0 python probe.py
uv run --no-project --with tree-sitter==0.25.2 --with tree-sitter-typescript==0.23.2 \
  --with tree-sitter-javascript==0.25.0 python ground_truth.py
```

To compare against the baseline line numbers, check out the forge SHAs above first. At a later forge HEAD, `ground_truth.py`'s line asserts will fail once those files move. Re-pin the edges by their stored `call_source` / `definition_source` text.

## Caveats
- **The probe is coupled to the indexer's internals.** It exec's only the `SymbolTable`, `_build_symbol_table` and `_resolve_cross_file_calls` ASTs out of `indexer.py`, to avoid package initialisers. A refactor that renames those breaks the probe, not the measurement.
- **The fractions measure resolution, not recall.** Many call sites are builtins or same-file calls. `ground-truth.json` is the recall check (baseline: 4/15 found).
