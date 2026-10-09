# STRAT-CODEGRAPH-1 — Blueprint (shape C: snapshot file)

**Status:** IN_PROGRESS · **Shape:** C, picked by the owner 2026-10-08 (SmartMemory parses each repo into a bundle JSON; Compose caches it in `.compose/codegraph/` and runs every check locally in Node; no SM server, no MCP).

## Related Documents
- Design and ACs: [design.md](design.md) · spike results: [spikes-2026-10-08.md](spikes-2026-10-08.md) · plan: [plan.md](plan.md)
- Shape analysis (workspace scratch): `forge/scratch/2026-10-08-codegraph/shape.md`
- Spike code this ports to Node: `forge/scratch/2026-10-08-codegraph/replays/tools/{callers,s1_unwired,s3_reality,s3_classify}.py`
- Bundle contract (pending): SmartMemory CODE-BUNDLE-CLI-1, `smart-memory-docs/docs/features/CODE-BUNDLE-CLI-1/` (absent on 2026-10-08). Today's bundle fields: `smart-memory-docs/docs/features/CODE-INGEST-SURFACES-1/code-contract.json`.

## Facts measured before design (2026-10-08)

**Switch-over 2026-10-09:** SmartMemory 1.5.26 ships `smartmemory code bundle` (CODE-BUNDLE-CLI-1). The fallback producer and the JS copy of core's read rules are gone; the sections below marked (switch-over) describe the current shape, and the facts in this section are kept as measured history.

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
availability.js ──► snapshot.js ──► normalizeBundle() ──► .compose/codegraph/<repo>/<key>.json
   (smartmemory CLI    (cache-validity,  (ONE envelope                (normalized model,
    >= 1.5.26,          single-flight,    parser)                      model_version 3)
    warn once)          spawn, timing)
                                  │
                                  ▼
                              model.js  ──►  reality-check.js  ──► build.js plan_gate (warn-only)
                                         └►  prior-art.js      ──► build.js explore_design prompt
```

- **Producer (switch-over):** the `smartmemory code bundle` CLI only, >= 1.5.26. It takes the argv `<path> --repo <name> [--exclude <dir> …] --out <file> --allow-partial --fields minimal` (CODE-BUNDLE-CLI-1 design.md), built by `bundleArgv()` in `snapshot.js` (`cliBundleArgs()` prefixes `code bundle`), next to `normalizeBundle`, so a contract change is a one-file edit. `--exclude .compose` is always added (the cache lives there). The CLI's stderr goes to `<repo dir>/producer.log` and the console gets one summary line per run (exit code, WARNING count, the `[code:bundle]` totals, the log path, any ERROR lines).
- **Envelope parsing lives only in `normalizeBundle`** (`snapshot.js`). It accepts `schema_version "1"` and throws `BundleFormatError` on anything else. It projects the brief's entity/relation field list into the internal model. Nothing else in Compose reads a bundle.
- **The cache holds the normalized model, not the raw bundle** (77-248 MB raw, see above). The raw bundle is written to a temp file inside the repo's cache dir, normalized, and deleted.
- **SmartMemory's parse cache** is pointed at `.compose/codegraph/<repo>/parse-cache` (`SMARTMEMORY_CODE_CHECKPOINT_DIR`) unless the user already set it. That keeps all state under `.compose/codegraph/` and makes a re-index re-parse only changed files (the warm column above).
- **Warn-only everywhere.** Without a capable `smartmemory` CLI, every entry point returns a skip result after one warn line per process (owner decision 2026-10-05, same pattern as `lib/judgment-gen.js:47`). No entry point throws into the build. Errors become warnings.

## Repos and paths
- Config: `.compose/compose.json` → `codegraph: { enabled, smartmemory, timeoutMs, repos: [{ name, root, prefix, exclude[] }] }`. Default when absent: one repo, `name = basename(projectRoot)`, `root = projectRoot`, `prefix = ''`.
- Forge needs two repos (compose root and `../stratum/ts`, explicit names `compose` and `stratum`). Cross-repo edges (compose → `@smartmemory/stratum`) do not resolve, which is accepted.
- `prefix` maps a repo-relative `file_path` to a display path relative to the project root (e.g. `../stratum/ts/`). Reality-check path lookups and every `file:line` shown use display paths.

## Cache validity (switch-over; `lib/codegraph/cache-validity.js`)
Compose does not copy core's read rules. A cached snapshot is valid only while all of these hold; anything Compose cannot verify makes it invalid (over-invalidation accepted, under-invalidation not):
- **(a) HEAD.** `git rev-parse HEAD` of the indexed root equals the snapshot's `source.head`. Any commit misses, including a stratum commit outside `ts/` (accepted).
- **(b) Working-tree state.** A hash over every path `git status --porcelain=v1 -z --untracked-files=all --ignored=traditional --ignore-submodules=none -- .` lists under the root: non-ignored paths keyed by content sha256, ignored (`!!`) paths by stat (core does not read `.gitignore`, so ignored files are indexed), collapsed `dir/` entries (nested repos) by a stat walk. Every tracked entry from `git ls-files -s -v --full-name -z -- .` is added on top of status (paths toplevel-relative, so a root below the git toplevel matches): assume-unchanged and skip-worktree files are content-keyed, because `git status` never lists them; every other tracked file that status did not list is keyed by stat (not counted as racy: git already compares those by content) and by whether its directory still spells its name exactly so, because a clean filter can normalize an edit away and a case-only rename on a case-insensitive filesystem leaves status clean (r3-1); tracked symlinks (mode 120000) are keyed by link text plus their target's content (a target outside the root or under `.compose` included); a gitlink (mode 160000) recurses into the submodule's own worktree state when populated (so an ignored file in a clean submodule counts) and is stat-walked when not. Any symlink met by a stat key is keyed by link text plus target content (or directory stat). Paths with a `.compose` segment below the root are left out, because the producer always runs with `--exclude .compose`. Not a git checkout: a stat walk of every file, skipping `.git` and `.compose`. Every record is a JSON array (`rec(...)`), so no file name (one holding `=` or a newline) can make two different trees hash alike.
  - **Racy stat keys.** A stat-keyed regular file whose mtime or ctime is within `RACY_WINDOW_MS` (3 s) of the run start counts as racy (a same-size edit inside the timestamp granularity would keep its key). A state with any racy file is used but never stored.
- **(c) Resolution dependencies.** Every `source.resolution_dependencies` entry core recorded still holds: `exists` (followed stat), `content` (sha256), `listing` / `glob` (`members_sha256` recomputed by the CODE-BUNDLE-CLI-1 design.md recipe, Python 3.12 semantics). Pattern globs match per code point (Unicode wildcards). Core's null cases are modelled for all three shapes: a missing or non-directory base, or a base that resolves outside the checkout, is invalid, as is a listing symlink member or a pattern match resolving outside the checkout, a pattern's intermediate directory link resolving outside (even with no final match), and any symlink the walk meets outside a pruned directory (a directory link it does not follow, a member, or a non-source file) resolving outside. The walk rule is conservative: core's exact null rule for non-member links could not be probed locally, so Compose treats them as null (over-invalidation). A null `members_sha256`, an unknown kind, a `**` / `..` / absolute glob pattern, or an outside-checkout listing is invalid (never cached). The walk prunes `*.egg-info`, and `exclude_unless_package` needs `__init__.py` to be a file.
- **Key.** The file name is `sha256(salt, git, head, worktree hash)`; the stored `cache_key` is re-checked on read, then (c) runs. `salt` = `JSON.stringify` of model version, CLI path, CLI version, repo name, the canonical (realpath) root, the exclude list as an array, a sha256 of the sorted `SMARTMEMORY_CODE_*` environment pairs except `SMARTMEMORY_CODE_CHECKPOINT_DIR` (values hashed, never stored), and the CLI's Python runtime identity (`runtimeIdentity`: the interpreter its `#!` line names, `env` and uv-trampoline forms included; `pyvenv.cfg`; every `*.dist-info` / `*.egg-info` in its site-packages with the stat of RECORD / METADATA / PKG-INFO; every `.pth` / `.egg-link` content; the `PYTHON*` environment), plus the `node` found on PATH (path, realpath, stat, or `absent`: core's independent JavaScript syntax check needs it) and `NODE_OPTIONS` (r3-2). Parser grammars are separate distributions, so installing, repairing or removing one changes the key. Residual: hand edits inside a package directory, and a non-venv user site, are not seen. The in-flight map is keyed by directory plus salt; a caller that joins a run in flight gets the shared result with its own `repo` (prefix).
- **Re-read after the lock.** A caller that waited for the per-repo lock recomputes the salt (a grammar installed while it waited is keyed in, r3-6), (b), the file key and the cache path before reading, so a snapshot published meanwhile for the old tree is not served.
- **Store rule.** A produced snapshot is cached only if (a)+(b) and the salt are the same before and after the run (r3-6), the producer's `source.head` equals HEAD, no stat key is racy, and (c) holds. At store time (c) is also a recency check on every dependency (b) does not cover: one outside the root or under `.compose` (which (b) leaves out), judged both as written and where it leads, so a `.compose` or outside link resolving into the root is still checked (r3-5). It fails if its path (lstat and followed), any symlink on the way to it (r3-5), its nearest existing ancestor when it is missing (a deletion during the run, r3-4), or any directory its recipe reads changed at or after the run start minus the racy window, because core hashes dependencies after parsing, so a recorded hash can postdate what it parsed. Otherwise it is used once and not cached (one `unstable:<repo>` warning).
  - **Dependency witness (r3-3).** `exists` records carry no kind, so a directory replaced by a file reads `exists:true` both times. At store time `cache_key.deps_witness` records, for every dependency (b) does not cover, its kind as written and followed, its link text and every symlink on the way to it; a read whose witness differs is invalid.
  - Residual risk: an edit reverted to the exact pre-run state while the producer ran goes undetected.
- **Known over-invalidation.** The design.md and plan.md a build writes before plan_gate change (b), so a prebuild that already finished misses at plan_gate (one still running is joined). A repo whose snapshot carries a null listing digest (core emits one for a missing directory) never caches. Stat keys on every tracked file mean a touch or a checkout that rewrites files misses once, and a missing outside dependency misses whenever anything else in its nearest existing directory changed during the run.

## Components

### `lib/codegraph/availability.js` (new)
- `detectCodegraph({ cwd, env }) → Promise<{ available, mode: 'cli'|null, command, version, reason, warnings[] }>`; memoized per (cwd, CLI choice, switches, install identity: the CLI file's stat plus `runtimeIdentity`). (switch-over)
- CLI = config `codegraph.smartmemory` ?? `env.COMPOSE_CODEGRAPH_SMARTMEMORY` ?? `smartmemory` on PATH (`locateCli`). A value with a `/` is a path relative to the project root.
- Probe: `<cli> --version` must parse and be >= 1.5.26 (1.5.25 is refused by name: known segfault on TypeScript repos), then `<cli> code bundle --help` must exit 0.
- Disabled by `codegraph.enabled === false` or `COMPOSE_CODEGRAPH=0`, and under `NODE_ENV=test` unless `COMPOSE_CODEGRAPH=1`.
- `warnOnce(key, message)` prints `[codegraph] …` once per process.
- `resetAvailabilityCache()` is the test seam.

### `lib/codegraph/snapshot.js` (new)
- `resolveRepos(projectRoot)`, `normalizeBundle(raw)`, `spawnProducer(…)`, `bundleArgv({ root, repo, out, exclude })`, `cliBundleArgs(…)`, `ensureSnapshot({ projectRoot, repo, availability, timeoutMs, producer? })`, `loadSnapshots({ projectRoot, … })`.
- Single flight: an in-process `Map<cacheDir, Promise>`, plus a cross-process `acquireDirLock(<repo dir>/.lock, { timeoutMs })` (`lib/dir-lock.js:84`). The cache is re-checked after the lock is taken.
- Timing goes to `<repo dir>/timings.jsonl` as `{ ts, fingerprint, cached, stored, mode, keyMs, depsMs, bundleMs, normalizeMs, totalMs, notStored?, entities, relations, complete }` (`keyMs` = (a)+(b), `depsMs` = (c)). Only the newest 3 snapshot files are kept.
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

### `lib/codegraph/bundle_fallback.py` (REMOVED 2026-10-09, switch-over)
- The Python producer that imported SmartMemory's indexer until CODE-BUNDLE-CLI-1 shipped. Deleted with its probe, spawn path and tests; the CLI (>= 1.5.26) is the only producer. Its envelope shape is now the CLI's (`bundle-contract.json`); `edge_state` is read from `relation.properties.edge_state`.

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
| `lib/codegraph/snapshot.js` | new | single-flight producer spawn, `normalizeBundle`, cache, timing |
| `lib/codegraph/cache-validity.js` | new (switch-over) | (a) HEAD, (b) working-tree state, (c) resolution dependencies incl. the members_sha256 recipe |
| `lib/codegraph/model.js` | new | indexes and callers |
| `lib/codegraph/reality-check.js` | new | name extraction, labels, boundary map, plan-gate entry |
| `lib/codegraph/prior-art.js` | new | concept match, design entry |
| `lib/codegraph/bundle_fallback.py` | removed (switch-over) | was the Python producer until CODE-BUNDLE-CLI-1 |
| `lib/build.js` | edit | plan_gate and explore_design hooks |
| `.gitignore` | edit | ignore `.compose/codegraph/` |
| `test/codegraph-golden.test.js` | new | committed-fixture golden (callers vs ground truth, reality check, prior art, normalizeBundle) |
| `test/codegraph-availability.test.js` | new | absent SM → warn-once no-ops |
| `test/codegraph-live.test.js` | new | live producer on a temp tree; skips without SM |
| `test/codegraph-snapshot.test.js` | new | cache validity through `ensureSnapshot`, single flight, producer log |
| `test/codegraph-cache-validity.test.js` | new (switch-over) | members_sha256 recipe vs Python values and vs the live CLI |
| `test/fixtures/codegraph/*.bundle.json.gz` | new | recorded slim bundles of the ground-truth files at the pinned SHAs |
| `test/fixtures/codegraph/README.md` | new | provenance and re-record command |
| `test/fixtures/codegraph/plan-fixture.md` | new | reality-check golden input |
| `CHANGELOG.md` | edit | entry |

## Out of scope (named so nobody assumes otherwise)
- Liveness / unwired-export checks (S1) and callers-of-X at design time (S2) are STRAT-CODEGRAPH-2. `model.callersOf` ships here because the golden needs it.
- Publishing to the SM server and HTTP semantic prior-art search.
- Incremental parsing beyond SmartMemory's own per-file parse cache.
