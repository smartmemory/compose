# STRAT-CODEGRAPH-1 golden fixtures

Recorded SmartMemory snapshot bundles (envelope `schema_version "1"`, `--fields minimal`, with the snapshot amendment's `edge_state` and skip fields) of the 17 source files named by
[`docs/features/STRAT-CODEGRAPH-1/fixtures/ground-truth.json`](../../../docs/features/STRAT-CODEGRAPH-1/fixtures/ground-truth.json),
exported at the SHAs that ground truth is pinned to:

| Bundle | Repo | Commit | Files |
|---|---|---|---|
| `compose.bundle.json.gz` | forge compose | `ddec237c73e20648b28598a8db12f034819a8ed5` | the 10 `compose/lib/*.js` files in ground truth |
| `stratum.bundle.json.gz` | forge stratum (`ts/`) | `d697d9c779048ea71d7b77aa6d98efefd785d0f4` | the 7 `stratum/ts/src/**/*.ts` files in ground truth |

- Producer: `smartmemory code bundle <path> --repo <name> --allow-partial --fields minimal`, SmartMemory 1.5.26
  (PyPI wheel, Python 3.12.7), tree-sitter 0.25.2. Re-recorded 2026-10-09 for the STRAT-CODEGRAPH-1 switch-over to
  the CLI (821 entities / 2529 relations and 439 / 1505, both `complete`). `edge_state` now sits in
  `relations[].properties` (CALLS and REFERENCES only), and the envelope carries `source.resolution_dependencies`.
  Earlier recordings (2026-10-08) came from the retired private-import adapter and core `9ad526cb`.
- `plan-fixture.md` is the reality-check golden input; `test/codegraph-golden.test.js` holds the expected labels.

## Re-recording
Export the files at the SHAs above into `<tree>/compose/lib/…` and `<tree>/stratum/src/…`, then, with
`smartmemory>=1.5.26` installed:

```bash
SMARTMEMORY_CODE_CHECKPOINT_DIR=<scratch>/ckpt smartmemory code bundle \
  <tree>/compose --repo compose --out <scratch>/compose.json --allow-partial --fields minimal
gzip -9 -n -c <scratch>/compose.json > test/fixtures/codegraph/compose.bundle.json.gz
```

(same for `stratum`). A new SmartMemory may change entity counts; the golden asserts the ground-truth edges and the
plan labels, not counts.
