# STRAT-CODEGRAPH-1 — Implementation Plan

## Related Documents
- Blueprint: [blueprint.md](blueprint.md) · design and ACs: [design.md](design.md) · spikes: [spikes-2026-10-08.md](spikes-2026-10-08.md)

All paths are relative to `compose/`.

## Tasks

### T1 — Fallback producer (`lib/codegraph/bundle_fallback.py` (new))
- [x] `--probe` reports python, smartmemory, version, store_free_parse, typescript_grammar; never raises
- [x] Build writes the envelope (`schema_version "1"`, languages, generator, source, complete, failed_paths) plus the hosted bundle fields, and `item_id` on every entity
- [x] Repeats `prepare_bundle`'s refusals except the 64 MiB upload cap; `--allow-partial` turns failed files into `complete: false`
- [x] `--slim` keeps the brief's field list under contract names; `--exclude`, `--verbose`
- [x] Atomic write to `--out`; exit codes 0/2/3/4

### T2 — Availability (`lib/codegraph/availability.js` (new)) — depends on T1
- [x] CLI first (`smartmemory code bundle --help` exit 0), else Python probe
- [x] `COMPOSE_CODEGRAPH_PYTHON` / `codegraph.python` / `python3`; `COMPOSE_CODEGRAPH=0` and `codegraph.enabled:false` disable
- [x] Memoized; `warnOnce` prints one line per key per process; missing TS grammar is a warning, not unavailable

### T3 — Snapshot (`lib/codegraph/snapshot.js` (new)) — depends on T1, T2
- [x] `resolveRepos` from `.compose/compose.json` `codegraph.repos`, default one repo at the project root
- [x] `computeFingerprint`: subdir tree hash + porcelain + stat; non-git stat walk
- [x] `normalizeBundle` is the only envelope reader; rejects schema_version ≠ "1" with `BundleFormatError`; accepts slim and full bundles
- [x] `ensureSnapshot`: cache hit returns without spawning; in-process single flight plus `acquireDirLock`; re-check after lock; parse cache under the repo dir; timings.jsonl; keep newest 3
- [x] `cliBundleArgs` holds the provisional CLI argv

### T4 — Model (`lib/codegraph/model.js` (new)) — depends on T3
- [x] Indexes by name (plus last dotted segment), qualified_name, display file
- [x] `callersOf` resolved (CALLS + REFERENCES with resolution/confidence) and spelling (call_evidence)
- [x] `enclosing(file, line)` smallest span owner

### T5 — Reality check (`lib/codegraph/reality-check.js` (new)) — depends on T4
- [x] `extractPlanNames` with `(new)` / File Plan row marking (row subject only)
- [x] Labels existing / new / unmarked-new; hints for `compose/` prefix and basename; `marked (new) but exists`
- [x] Includes `validateBoundaryMap` result (`lib/boundary-map.js:275` (existing))
- [x] `planGateRealityCheck` records `.compose/codegraph/reality/<feature>.json`, never throws, skip result when unavailable

### T6 — Prior art (`lib/codegraph/prior-art.js` (new)) — depends on T4
- [x] Term split, weighted score, threshold, `file:line` output
- [x] `priorArtForDesign` records `.compose/codegraph/prior-art/<feature>.json`, returns markdown or skip

### T7 — Pipeline hooks (`lib/build.js` (existing), `.gitignore` (existing)) — depends on T5, T6
- [x] plan_gate: reality check appended to `gateExtras.summary`, `gateExtras.realityCheck`, console line, `build_reality_check` stream event; gate flow untouched
- [x] explore_design: prior-art block appended to `prompt`
- [x] `.compose/codegraph/` ignored

### T8 — Tests — depends on T1-T7
- [x] Record slim bundles of the 17 ground-truth files at the pinned SHAs (`test/fixtures/codegraph/` (new)), with README provenance
- [x] `test/codegraph-golden.test.js` (new): all 15 ground-truth edges appear in `callersOf` at the right caller `file:line`; reality check on `plan-fixture.md` gives the expected labels; prior art finds `checkOrInsert`; `normalizeBundle` rejects schema_version "2"
- [x] `test/codegraph-availability.test.js` (new): with no Python/SM, plan-gate and prior-art entry points return skip, warn exactly once, never throw
- [x] `test/codegraph-live.test.js` (new): skips without SM; with SM, snapshots a temp tree, second call is a cache hit with no spawn, edit changes the fingerprint
- [x] `test/codegraph-snapshot.test.js` (new): fingerprint changes on re-edit of a dirty file; two concurrent `ensureSnapshot` calls run the producer once (injected producer)

### T9 — Live timing, CHANGELOG, commit
- [x] Live bundle timing for compose and stratum/ts through `ensureSnapshot` (cold, warm, cache hit) recorded in the report
- [x] CHANGELOG line in the same commit; explicit staging; no push

## Acceptance criteria (maps to design.md)
Ticked by forge-d0 after verification (author report: `forge/scratch/2026-10-08-codegraph/build/REPORT.md`).
- [ ] SM availability detected; without it one warn line and no build failure (T2, `test/codegraph-availability.test.js`)
- [ ] Forge indexed through a surface reaching JS/TS, named in the report (T1/T3, T9)
- [ ] Re-index re-parses only changed files, timing recorded (T3 parse cache + timings.jsonl, T9). Caveat: SmartMemory re-runs whole-repo resolution, so a warm re-index is 75 s for compose (parse cache) vs 170 s cold
- [ ] Plan reality check runs at plan_gate and lists unresolved names with the artifact line (T5, T7)
- [ ] Prior-art search runs before design and lists matches with file:line (T6, T7)
- [x] Remove `lib/codegraph/bundle_fallback.py` and its spawn path once CODE-BUNDLE-CLI-1 ships `smartmemory code bundle` (waits on CODE-INDEXER-HARDEN-1 U5). **Done 2026-10-09 (switch-over, smartmemory 1.5.26):** CLI-only detection `test/codegraph-availability.test.js:76`, 1.5.25 refused `test/codegraph-availability.test.js:85`, discovery order `test/codegraph-availability.test.js:176`, reinstall at the same path re-probed `test/codegraph-availability.test.js:105`, CLI spawn and producer log `test/codegraph-snapshot.test.js:573`, live CLI `test/codegraph-live.test.js:26`.
- [x] Replace the JS copy of core's read rules in `snapshot.js` (pruning, tsconfig `extends` chains, suffix rule, ancestor manifests) with the snapshot's `source` plus `source.resolution_dependencies` (path, kind exists|content, sha256), accepted by sm-scanner 2026-10-08 for CODE-BUNDLE-CLI-1. Why: three review rounds on the mirrored rules did not converge (3, 3, 6 findings), and every change to core's read rules would silently break the cache key. **Done 2026-10-09 (switch-over):** `lib/codegraph/cache-validity.js` checks HEAD, a working-tree state hash and every recorded dependency (exists, content, listing, glob). Dependency invalidation `test/codegraph-snapshot.test.js:382`, null digest never cached `test/codegraph-snapshot.test.js:457`, ignored and assume-unchanged files `test/codegraph-snapshot.test.js:116`, members_sha256 recipe against the live CLI `test/codegraph-cache-validity.test.js:175`. Review round 1 (13 findings fixed): edits a clean `git status` hides (submodule, tracked symlinks, root below the toplevel) `test/codegraph-snapshot.test.js:201`, racy stat keys never cached `test/codegraph-snapshot.test.js:219`, salt covers root, excludes and policy env `test/codegraph-snapshot.test.js:316`, re-read after the lock `test/codegraph-snapshot.test.js:363`, outside listing never cached `test/codegraph-snapshot.test.js:445`, core's null cases `test/codegraph-cache-validity.test.js:80`, Unicode wildcards `test/codegraph-cache-validity.test.js:63`. Review round 2 (5 fixed, 1 rejected): JSON-framed state records `test/codegraph-snapshot.test.js:139`, the CLI's Python runtime in the memo and salt `test/codegraph-availability.test.js:130`, `test/codegraph-availability.test.js:162`, `test/codegraph-snapshot.test.js:344`, outward links a walk or pattern meets `test/codegraph-cache-validity.test.js:80`, dependencies changed during the run `test/codegraph-snapshot.test.js:407`, a joined caller keeps its prefix `test/codegraph-snapshot.test.js:287`.
