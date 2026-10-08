# STRAT-CODEGRAPH-1 — Blueprint (shape C: snapshot file)

**Status:** IN_PROGRESS · **Shape:** C, picked by the owner 2026-10-08 (SmartMemory parses each repo into a bundle JSON; Compose caches it in `.compose/codegraph/` and runs every check locally in Node; no SM server, no MCP).

## Related Documents
- Design and ACs: [design.md](design.md) · spike results: [spikes-2026-10-08.md](spikes-2026-10-08.md) · plan: [plan.md](plan.md)
- Shape analysis (workspace scratch): `forge/scratch/2026-10-08-codegraph/shape.md`
- Spike code this ports to Node: `forge/scratch/2026-10-08-codegraph/replays/tools/{callers,s1_unwired,s3_reality,s3_classify}.py`
- Bundle contract (pending): SmartMemory CODE-BUNDLE-CLI-1, `smart-memory-docs/docs/features/CODE-BUNDLE-CLI-1/` (absent on 2026-10-08). Today's bundle fields: `smart-memory-docs/docs/features/CODE-INGEST-SURFACES-1/code-contract.json`.

## Facts measured before design (2026-10-08)
- **No released smartmemory can produce a bundle.** PyPI `smartmemory-core` 1.5.23 has no `CodeIndexer.parse` / `prepare_bundle` and no `qualified_name` field (probed in a scratch venv). The miniconda install here is 1.4.103 (same). Core main 9ad526cb has both (`smartmemory/code/indexer.py:247` `parse`, `:482` `prepare_bundle`). Live runs used a `git archive` of core 9ad526cb installed into a scratch venv.
- **tree-sitter grammars are a dev-only dependency of core** (`pyproject.toml:192-194`, under the dev extra). A plain install parses Python only and silently skips JS/TS. Availability must check the grammars.
- **`prepare_bundle` refuses forge's stratum/ts** with "Code bundle exceeds MAX_REQUEST_BODY_BYTES=67108864" and zero failed files. The 64 MiB cap is the hosted upload limit and does not apply to a local snapshot, so the fallback calls `parse()` and repeats `prepare_bundle`'s other checks (failed files, path escape, relation endpoint filter).
- **Bundle size and time** (fallback adapter, core 9ad526cb):

  | Repo | Entities | Relations | Raw JSON | Slim JSON | Cold | Warm parse cache |
  |---|---|---|---|---|---|---|
  | stratum/ts | 8,975 | 33,674 | 77 MB | — | 31 s | 9.9 s |
  | compose | 30,979 | 110,105 | 248 MB | 141 MB | 159 s | 75 s |

  Node parses the 141 MB slim compose bundle in 0.9 s (366 ms read + 557 ms parse, ~950 MB RSS), once per fingerprint change.
- **Every resolved edge is `resolution: name_only, confidence: 0.5`** in today's bundles. There are no `exact` edges yet. The model passes resolution and confidence through and does not interpret them.
- `prepare_bundle` drops relations whose target is not indexed (`indexer.py` "omitted N unresolved relations"). Unresolved callee spellings survive only in `entity.call_evidence`, which is why the model reads it.

## Architecture

```
availability.js ──► snapshot.js ──► normalizeBundle() ──► .compose/codegraph/<repo>/<fingerprint>.json
   (python, SM,        (fingerprint,     (ONE envelope                (normalized model,
    grammars,           single-flight,    parser)                      model_version 2)
    warn once)          spawn, timing)
                                  │
                                  ▼
                              model.js  ──►  reality-check.js  ──► build.js plan_gate (warn-only)
                                         └►  prior-art.js      ──► build.js explore_design prompt
```

- **Producer order:** `smartmemory code bundle` when `smartmemory code bundle --help` exits 0, else `python -I lib/codegraph/bundle_fallback.py`. Both producers take the same argv, `<path> --repo <name> [--exclude <dir> …] --out <file> --allow-partial --fields minimal` (CODE-BUNDLE-CLI-1 design.md), built by `bundleArgv()` in `snapshot.js` (`cliBundleArgs()` prefixes `code bundle`), next to `normalizeBundle`, so a contract change is a one-file edit. Every fallback-produced snapshot prints a WARNING with the reason the CLI was not used (fix round 1).
- **Envelope parsing lives only in `normalizeBundle`** (`snapshot.js`). It accepts `schema_version "1"` and throws `BundleFormatError` on anything else. It projects the brief's entity/relation field list into the internal model. Nothing else in Compose reads a bundle.
- **The cache holds the normalized model, not the raw bundle** (77-248 MB raw, see above). The raw bundle is written to a temp file inside the repo's cache dir, normalized, and deleted.
- **SmartMemory's parse cache** is pointed at `.compose/codegraph/<repo>/parse-cache` (`SMARTMEMORY_CODE_CHECKPOINT_DIR`) unless the user already set it. That keeps all state under `.compose/codegraph/` and makes a re-index re-parse only changed files (the warm column above).
- **Warn-only everywhere.** Without Python + a capable smartmemory, every entry point returns a skip result after one warn line per process (owner decision 2026-10-05, same pattern as `lib/judgment-gen.js:47`). No entry point throws into the build. Errors become warnings.

## Repos and paths
- Config: `.compose/compose.json` → `codegraph: { enabled, python, timeoutMs, repos: [{ name, root, prefix, exclude[] }] }`. Default when absent: one repo, `name = basename(projectRoot)`, `root = projectRoot`, `prefix = ''`.
- Forge needs two repos (compose root and `../stratum/ts`, explicit names `compose` and `stratum`). Cross-repo edges (compose → `@smartmemory/stratum`) do not resolve, which is accepted.
- `prefix` maps a repo-relative `file_path` to a display path relative to the project root (e.g. `../stratum/ts/`). Reality-check path lookups and every `file:line` shown use display paths.

## Fingerprint
`sha256(salt, tree, status records)` per repo root:
- `tree` = `git rev-parse HEAD:./` run in the repo root, i.e. the tree hash of that subdirectory. A stratum commit that does not touch `ts/` keeps the cache.
- `status` = `git status --porcelain=v1 -z --untracked-files=all --ignored=traditional -- .`; every listed path is hashed with its size and mtime. Porcelain alone does not change when an already-modified file is edited again, so the stat is part of the key.
  - Ignored source files are included, because SmartMemory's collector does not read `.gitignore`. Ignored directories (collapsed `dir/`) are skipped.
  - Paths under `.compose/` are skipped, because the cache itself lives there.
- `salt` = producer mode, Python path, smartmemory version, TS-grammar presence, repo name and excludes.
- The fingerprint is re-computed after the producer finishes. If it moved, the output is used once and not cached.
  - Residual risk: an edit reverted to the exact pre-run state while the producer ran goes undetected.
- Not a git checkout: hash of (path, size, mtime) for source files under the root, skipping `node_modules`, `.git`, `.compose`, `dist`.

## Components

### `lib/codegraph/availability.js` (new)
- `detectCodegraph({ cwd, env }) → Promise<{ available, mode: 'cli'|'fallback'|null, python, version, typescriptGrammar, reason, warnings[] }>`; memoized per (cwd, python).
- Python = `env.COMPOSE_CODEGRAPH_PYTHON` ?? config `codegraph.python` ?? `python3`.
- Probe: `python -I bundle_fallback.py --probe` (JSON). Available when `smartmemory && store_free_parse`. `typescriptGrammar=false` stays available with a warning.
- Disabled by `codegraph.enabled === false` or `COMPOSE_CODEGRAPH=0`.
- `warnOnce(key, message)` prints `[codegraph] …` once per process.
- `resetAvailabilityCache()` is the test seam.

### `lib/codegraph/snapshot.js` (new)
- `resolveRepos(projectRoot)`, `computeFingerprint(root)`, `normalizeBundle(raw)`, `bundleArgv({ root, repo, out, exclude })`, `cliBundleArgs(…)`, `ensureSnapshot({ projectRoot, repo, availability, timeoutMs, producer? })`, `loadSnapshots({ projectRoot, … })`.
- Single flight: an in-process `Map<cacheDir, Promise>`, plus a cross-process `acquireDirLock(<repo dir>/.lock, { timeoutMs })` (`lib/dir-lock.js:84`). The cache is re-checked after the lock is taken.
- Timing goes to `<repo dir>/timings.jsonl` as `{ ts, fingerprint, cached, mode, fingerprintMs, bundleMs, normalizeMs, totalMs, entities, relations, complete }`. Only the newest 3 snapshot files are kept.
- Child output is capped (last 8 KB of stderr kept). Timeout from config (default 300 s).

### `lib/codegraph/model.js` (new)
- `buildModel(snapshots) → { entities, byId, byName, byQualified, byFile, displayPath(e), callersOf(name), enclosing(file, line), files }`.
- `byName` indexes `name` and its last dotted segment. Module entities are skipped for name lookups.
- `callersOf(name)` returns:
  - `definitions[]`
  - `resolved[]` from CALLS + REFERENCES, keeping `resolution`, `confidence` and `relation_type`, and excluding `unresolved: true`
  - `spelling[]` from `call_evidence` where `callee === name` or `callee` ends with `.name` (port of `callers.py`)

### `lib/codegraph/reality-check.js` (new), on top of `validateBoundaryMap` (`lib/boundary-map.js:275`)
- `extractPlanNames(text)` uses the backtick-token regexes from `s3_reality.py`.
  - Tokens are classified as path, symbol:line, identifier or not-a-name.
  - Plain lowercase single words are not names.
  - A token is marked `(new)` when it is directly followed by `(new)`, or when it is the first cell of a row whose action is new/create/add in a table under a File Plan heading (`## File Plan` / `## Files` / `## File-by-File Plan`). This fixes the S3 checker gap where a whole row was treated as new.
  - Template paths (`<code>`) and JSONPath (`$.x`) are skipped. Simple PascalCase names (`Widget`) count as names.
  - `(existing)` marks are recorded too.
- `labelNames({ names, model, projectRoot, repos })` gives every name one label.
  - Declared-new propagates to other mentions of the same normalized name. A path also propagates to a bare-basename mention, but never to a different path that shares the basename.
  - Path checks also use `git ls-files -co --exclude-standard` for each repo, because docs, YAML and JSON are not in the code index.
  - When a name's mentions are aggregated, every conflicting note is kept.
  - `existing`, with evidence `index` | `disk` | `text`.
  - `new`: marked `(new)` and absent. When a name is marked `(new)` but exists, it is labelled `existing` with the note `marked (new) but exists`.
  - `unmarked-new`: absent and not marked.
  - Hints: `exists without compose/ prefix` and basename matches (ported from `s3_classify.py`).
  - `symbol:line` gets `line_in_span`. `path:line` gets `line_owner`.
- `runRealityCheck({ text, artifactPath, projectRoot, model, repos })` returns `{ labels, counts, boundaryMap: validateBoundaryMap(...) }`.
- `formatRealityReport(result)` renders `L<line> <label> \`token\` <hint>`.
- `planGateRealityCheck({ cwd, artifact, featureCode })` orchestrates availability, snapshots, model and check. It records `.compose/codegraph/reality/<featureCode>.json` and returns `{ text, counts, recordPath }` or `{ skipped, reason }`. It never throws.

### `lib/codegraph/prior-art.js` (new)
- `findPriorArt({ text, model, limit = 15 })` splits the concept into terms (camel/snake split, lowercase, stopwords dropped, length ≥ 3).
  - Scoring: name term ×3, qualified_name term ×2, docstring term ×1.
  - An entity matches if two or more distinct terms hit, or its exact name appears in the text.
  - Each match comes back as `file:line`, name, entity_type and the matched terms.
- `priorArtForDesign({ cwd, featureCode, description })` records `.compose/codegraph/prior-art/<featureCode>.json` and returns a markdown block, or `{ skipped }`. It never throws.

### `lib/codegraph/bundle_fallback.py` (new)
- `--probe` prints the capability JSON.
- A build writes the agreed envelope to `--out`:
  - `schema_version "1"`, `languages`, `generator {smartmemory_version, core_sha, producer, slim}`
  - `source {head, dirty, fingerprint, commit_hash, repo_identity}`, `complete`, `failed_paths`
  - the hosted bundle fields `repo, entities[] (with item_id), relations[], commit_hash, parse_summary`
- Fingerprint = HEAD + dirty flag + a hash of `git status --porcelain`.
- `--fields minimal` keeps exactly the fields Compose reads, under their contract names, and drops clean `parse_diagnostic` (was `--slim` before fix round 1). Every relation and call/test evidence record carries `edge_state` (resolved | ambiguous | unresolved | unsupported), stamped before slimming; the envelope carries `files_skipped`, `skipped_paths` and `budget_exhausted` (snapshot amendment).
- Other flags: `--exclude` (additive to SM defaults) and `--allow-partial`. SM's per-call WARNING lines are silenced unless `--verbose` (10 MB of stderr on compose otherwise).

## Build-pipeline hooks (`lib/build.js`, existing)
- **plan_gate:** after `const gateExtras = {…}` (`lib/build.js:6192`), when `stepId === 'plan_gate'`:
  - call `planGateRealityCheck({ cwd, artifact: synthArtifact, featureCode })`
  - append its text to `gateExtras.summary` (the gate UI, `buildGateContext` and the ask-agent all read it)
  - set `gateExtras.realityCheck = counts`
  - print it, and write a `build_reality_check` stream event
  - The gate decision path is untouched (`build.stratum.yaml:200` `plan_gate`): **warn-only, never blocks.**
- **explore_design:** after `const basePrompt = buildStepPrompt(stepDispatch, context);` (`lib/build.js:5324`), when `stepId === 'explore_design'`, the prior-art block is appended to `prompt` (not to `requiredPrompt`, which only review steps budget).
- `.gitignore` (existing): add `.compose/codegraph/`.

## File Plan
| File | Action | Purpose |
|---|---|---|
| `lib/codegraph/availability.js` | new | detection, memo, warn once |
| `lib/codegraph/snapshot.js` | new | fingerprint, single-flight producer spawn, `normalizeBundle`, cache, timing |
| `lib/codegraph/model.js` | new | indexes and callers |
| `lib/codegraph/reality-check.js` | new | name extraction, labels, boundary map, plan-gate entry |
| `lib/codegraph/prior-art.js` | new | concept match, design entry |
| `lib/codegraph/bundle_fallback.py` | new | Python producer until CODE-BUNDLE-CLI-1 |
| `lib/build.js` | edit | plan_gate and explore_design hooks |
| `.gitignore` | edit | ignore `.compose/codegraph/` |
| `test/codegraph-golden.test.js` | new | committed-fixture golden (callers vs ground truth, reality check, prior art, normalizeBundle) |
| `test/codegraph-availability.test.js` | new | absent SM → warn-once no-ops |
| `test/codegraph-live.test.js` | new | live producer on a temp tree; skips without SM |
| `test/fixtures/codegraph/*.bundle.json.gz` | new | recorded slim bundles of the ground-truth files at the pinned SHAs |
| `test/fixtures/codegraph/README.md` | new | provenance and re-record command |
| `test/fixtures/codegraph/plan-fixture.md` | new | reality-check golden input |
| `CHANGELOG.md` | edit | entry |

## Out of scope (named so nobody assumes otherwise)
- Liveness / unwired-export checks (S1) and callers-of-X at design time (S2) are STRAT-CODEGRAPH-2. `model.callersOf` ships here because the golden needs it.
- Publishing to the SM server and HTTP semantic prior-art search.
- Incremental parsing beyond SmartMemory's own per-file parse cache.
