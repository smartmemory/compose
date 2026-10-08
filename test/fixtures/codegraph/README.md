# STRAT-CODEGRAPH-1 golden fixtures

Recorded SmartMemory snapshot bundles (envelope `schema_version "1"`, `--slim`) of the 17 source files named by
[`docs/features/STRAT-CODEGRAPH-1/fixtures/ground-truth.json`](../../../docs/features/STRAT-CODEGRAPH-1/fixtures/ground-truth.json),
exported at the SHAs that ground truth is pinned to:

| Bundle | Repo | Commit | Files |
|---|---|---|---|
| `compose.bundle.json.gz` | forge compose | `ddec237c73e20648b28598a8db12f034819a8ed5` | the 10 `compose/lib/*.js` files in ground truth |
| `stratum.bundle.json.gz` | forge stratum (`ts/`) | `d697d9c779048ea71d7b77aa6d98efefd785d0f4` | the 7 `stratum/ts/src/**/*.ts` files in ground truth |

- Producer: `lib/codegraph/bundle_fallback.py --slim --allow-partial`, SmartMemory core `9ad526cb` (VERSION 1.5.23,
  unreleased main; PyPI 1.5.23 lacks `CodeIndexer.parse`), tree-sitter 0.25.2, tree-sitter-typescript 0.23.2,
  tree-sitter-javascript 0.25.0. Recorded 2026-10-08.
- `plan-fixture.md` is the reality-check golden input; `test/codegraph-golden.test.js` holds the expected labels.

## Re-recording
Export the files at the SHAs above into `<tree>/compose/lib/…` and `<tree>/stratum/src/…`, then, with a Python
whose smartmemory has `CodeIndexer.parse` plus the tree-sitter grammars:

```bash
SMARTMEMORY_CODE_CHECKPOINT_DIR=<scratch>/ckpt python -I lib/codegraph/bundle_fallback.py \
  --repo-root <tree>/compose --repo compose --out <scratch>/compose.json --slim --allow-partial
gzip -9 -n -c <scratch>/compose.json > test/fixtures/codegraph/compose.bundle.json.gz
```

(same for `stratum`). A new SmartMemory may change entity counts; the golden asserts the ground-truth edges and the
plan labels, not counts.
