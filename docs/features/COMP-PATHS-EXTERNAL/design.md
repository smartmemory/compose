# COMP-PATHS-EXTERNAL — Design / Scope

**Status:** COMPLETE — shipped 2026-06-15 (S1–S3; Codex design-gate + 4-round impl-review applied) · **Complexity:** L · Owner: compose.

> **Implementation deviations from this design (recorded at ship):**
> 1. **D6c — the guard stays repo-relative, NOT absolute.** The design imagined making the MCP-enforcement guard resolve guarded paths to absolute. Implementation showed that would *break* the guard's match against repo-relative `git status`. The guard correctly stays workspace-relative; relocated canon is out of its scope by construction and that gap is surfaced with a **visible warning** at ship (full coverage = `COMP-PATHS-EXTERNAL-1`). The real D7 bug was `build.js` `resolveItemDir` re-rooting an absolute config — fixed.
> 2. **D6b — null-SHA sentinel instead of a nullable field.** A commit-less completion stamps git's null-SHA (40 zeros, schema-valid) rather than a nullable `commit_sha`, avoiding a persisted-schema change. `completion_id` is derived distinctly for the null case (`<code>:nocommit:<ts>-<seq>`) to avoid aliasing.
> 3. **`files_changed` kept repo-relative** (design said "accept absolute") — absolute is a path-safety hazard and no caller needs it (the commit-less path passes `[]`).

> **Codex design-gate (2026-06-15) — incorporated:** (1) `featuresDir` is a *relative-to-cwd* contract through core helpers (`feature-json.js`, `feature-write-guard.js`) and their callers — absolute bases need an API migration, not wrapper-only (→ Decision 7). (2) Ship/completion are coupled: the non-git early-return (`build.js:2242`) precedes the completion/status-flip (`build.js:2421`), and staging + MCP-enforcement (`build.js:2285`, `mcp-enforcement.js:64,122`, `feature-write-guard.js:87`) assume one repo-relative namespace — external/non-git builds would write artifacts but never flip to COMPLETE (→ revised Decision 6). (3) Some server routes serve an *alternate* root yet read the global cached config (`vision-routes.js:169`, `vision-utils.js:73`) — the resolver needs an explicit `(root, config)` form (→ Decision 1). (4) Sweep list was incomplete: add `feature-scan.js:626`, `feature-write-guard.js:87`. Implementation is sliced (below) so the core ask ships before the heavy ship/enforcement rework.

> Let a workspace point its **artifact paths** (ROADMAP, features, journal, context, ideabox) at a folder — or a separate repo — outside the workspace root, e.g. a shared `smart-memory-docs`. The `.compose/` control room (config + state) stays put; only the artifacts-on-the-wall relocate. Reads/writes/render/validate work anywhere; cross-repo **auto-commit** is explicitly out of v1 (fast-follow `COMP-PATHS-EXTERNAL-1`).

## Related Documents
- Parent roadmap row: `ROADMAP.md` → `COMP-PATHS-EXTERNAL`
- Fast-follow: `COMP-PATHS-EXTERNAL-1` (cross-repo auto-commit of external artifacts)
- Touches the path-resolution introduced by COMP-MCP-MIGRATION-2 (`lib/project-paths.js`)

## Goal
A product whose code lives in many repos (e.g. `smart-memory-core`, `smart-memory-service`, …) keeps **one** roadmap + feature folder in a dedicated docs repo (`smart-memory-docs`). From any workspace you can run Compose and have it read/write that shared roadmap + features (and journal/context/ideabox) at the external location, without copying artifacts into every repo.

## Problem (verified in source 2026-06-15)
Artifact locations are resolved **three incompatible ways** across the codebase:

1. **Hardcoded literals**, config ignored entirely:
   - `ROADMAP.md`: `join(root,'ROADMAP.md')` in ~11 sites — `roadmap-gen.js:210,516`, `build-all.js:34`, `feature-validator.js:115`, `feature-writer.js:241,731`, `followup-writer.js:512`, `roadmap-graph/collect.js:65`, `get-roadmap.js:59`, `migrate-roadmap.js:34`, `feature-write-guard.js:87`.
   - `docs/features`: `join(root,'docs','features')` (or literal `docs/features/...`) in ~7 sites that bypass `paths.features` — `vision-server.js:267`, `drift-axes.js:358`, `session-routes.js:143`, `design-routes.js:450`, `checkpoint-writer.js:78,124`, `gsd.js:65`, `feature-scan.js:626`.
   - `journal-writer.js:37` `JOURNAL_DIR='docs/journal'`.
   - **Relative-`featuresDir` API contract** (deeper than literals): `feature-json.js` (`readFeature`/`writeFeature`/`listFeatures`/`updateFeature`) and `feature-write-guard.js:87` take a *relative* `featuresDir` and `join(cwd, …)` — absolute overrides resolve to `<cwd>/abs`. See Decision 7.
2. **Config-aware but `join`-based** (`config.paths?.x || 'default'` then `join(cwd, rel)`): `vision-utils.js:75` (journal), `build.js:666` (context), `ideabox-routes.js:44,55`, `bin/compose.js` (ideabox). `path.join(root, '/abs')` yields `root/abs` — **`join` silently corrupts an absolute override.**
3. **Duplicated default tables**: `project-root.js` `DEFAULT_CONFIG.paths`, `feature-validator.js:54` `DEFAULT_PATHS`, `project-paths.js` `DEFAULT_FEATURES_DIR`, plus inline `|| 'docs/journal'` literals. No single source of truth; they already disagree (some omit `context`/`ideabox`).

Net: even the *existing* `paths.features` override is only half-honored, and nothing supports a path that escapes the root or is absolute.

## What already exists (foundation — do NOT rebuild)
- **`lib/project-paths.js`** — `loadFeaturesDir(cwd)` (returns a relative string), `loadExternalPrefixes(cwd)`. The natural home for the shared resolver; already imported by lib consumers (`xref-sync.js`).
- **`server/project-root.js`** — `loadProjectConfig()` (cached), `resolveProjectPath(key)` = `join(getTargetRoot(), paths[key] ?? default)`. The server entry point; switches `join`→shared resolver.
- **The `paths` block** in `.compose/compose.json` (today: `docs, features, journal, context, ideabox`). We add **`roadmap`**.

## Locked decisions

1. **One default table, one resolver (pure core, no fs).**
   New `lib/paths-core.js` (pure):
   - `DEFAULT_PATHS = { docs:'docs', roadmap:'ROADMAP.md', features:'docs/features', journal:'docs/journal', context:'docs/context', ideabox:'docs/product/ideabox.md' }` — **the** single source of truth.
   - `resolvePathValue(root, value, fallbackKey) → absolute path`:
     ```
     const v = (typeof value === 'string' && value.length) ? value : DEFAULT_PATHS[fallbackKey];
     return path.isAbsolute(v) ? path.normalize(v) : path.resolve(root, v);   // resolve, NOT join
     ```
     Handles in-root (`docs/features`), `../`-escaping (`../smart-memory-docs/features`), and absolute (`/abs/...`). Always returns an absolute, normalized path.
   Convenience readers live in `lib/project-paths.js` (lib, reads the file) and delegate to the pure core: `resolveRoadmapPath(root)`, `resolveFeaturesPath(root)`, `resolveJournalPath(root)`, `resolveContextPath(root)`, `resolveIdeaboxPath(root)`, `resolveDocsPath(root)` — **all return absolute paths.** `server/project-root.js`'s `resolveProjectPath(key)` calls the same pure core with its already-loaded (cached) config value, so server and lib can never diverge and the server keeps its cache.
   **Alternate-root form (Codex finding 3).** Some server routes serve a workspace *other* than the bound `getTargetRoot()` — `vision-routes.js:169` and `vision-utils.js:73` resolve artifacts for an arbitrary `projectRoot` but currently read the **process-global cached** `loadProjectConfig()` (which describes the *bound* target, not the route's root). So the readers must also expose an explicit `*FromConfig(root, config)` form (and these call sites must load the config for *their* root, e.g. `loadComposeConfig(root)`, not the global cache). The pure core is already `(root, value, key)`; this is about feeding it the right config. Cache-fed singleton form stays for the common bound-target path.

2. **Sweep every consumer to the resolver.** Replace all three patterns above with the appropriate `resolve*Path()` call. Delete the duplicated default tables (`feature-validator.js:54`, `project-paths.js DEFAULT_FEATURES_DIR`, `project-root.js DEFAULT_CONFIG.paths`) in favor of importing `DEFAULT_PATHS` from `paths-core.js`. Replace every `join(cwd, rel)` over an artifact path with the absolute-returning reader (kills the absolute-override corruption).

3. **Default-identity contract (the safety guarantee).** When a key is absent or set to its default, the resolved absolute path is **byte-identical** to today's hardcoded result for every key. No migration, no drift for existing workspaces. This is a test (per key), not just a claim — mirrors the COMP-MIGRATE "byte-identical when unset" posture.

4. **`.compose/` never relocates.** Config, state/data, `vision-state.json`, breadcrumbs, ledgers stay at the workspace root (`getTargetRoot()`). Only the artifacts move. **Documented consequence:** with an external `features` dir, canon (`feature.json`) is remote while its `vision-state.json` projection stays local at the root — the projection is rebuilt from canon, so this is consistent, not contradictory.

5. **Safe display relativization.** `vision-server.js:459` (`filePath.slice(root.length+1)`) and `design-routes.js:450` (hardcoded `docs/features/...` relative for display) assume artifacts live under root. Replace with a shared `relForDisplay(root, abs)` = `path.relative(root, abs)`, falling back to the absolute path when the result starts with `..` (escapes root). Cosmetic-only; prevents broken/garbled paths in the UI and audit rows.

6. **The ship boundary — git-repo-aware, not root-aware; and completion is decoupled from the commit.** The workspace root is **not** assumed to be a git repo — it often isn't (forge-top: `.compose/` + `ROADMAP.md` live there, dir untracked, product repos nested *inside*). This decision has two halves, both surfaced by the Codex gate:

   **6a. Per-file git case for the COMMIT.** Each artifact falls into one of three cases, decided **per file** by the git repo that actually contains it (`git rev-parse --show-toplevel` from the file's own directory), never by comparing against the workspace root:
   - **(i) Same repo as the build's code changes** → staged & committed by ship, as today.
   - **(ii) A *different* git repo** (e.g. `smart-memory-docs`) → write it, log one line: `📝 wrote ROADMAP.md in <repo> — commit it there (Compose does not auto-commit other repos in v1)`. Never staged here; never claimed committed.
   - **(iii) No git repo at all** (forge-top's untracked ROADMAP) → write it, nothing to commit, info-level at most. Normal, not an error.

   **6b. Completion/status-flip must NOT be gated on a workspace-repo commit (Codex finding 2 — the load-bearing fix).** Today `executeShipStep` early-returns at `build.js:2242` when the agent cwd is not a git repo, *before* the commit-bound completion record at `build.js:2421` (which is itself gated on `sha && featureCode`). Consequence as-is: a build whose code is non-git, or whose ROADMAP/feature.json are external, writes artifacts but **never flips the feature to COMPLETE and never records completion** — a silent correctness hole. v1 must record completion and flip status **even when there is no workspace-repo commit**. Concretely: the status-flip/completion path is reachable on all three cases above (with a synthesized/absent `sha` for cases ii/iii), so the lifecycle advances whether or not a local commit happened. The completion record's `commit` field becomes optional/nullable when no local commit was made. **(Codex plan-gate:) this is not a `build.js`-only change — `lib/completion-writer.js` is itself commit-bound: it requires a full `commit_sha` (`:154`), derives `completion_id` from it (`:265`), and rejects non-repo-relative `files_changed` (`:173`). The writer contract must change first (nullable `commit_sha`; sha-less `completion_id` derivation; accept absolute `files_changed`), then `build.js` calls it on every ship exit path.**

   **6c. MCP-enforcement + write-guard must be resolution-aware (Codex finding 2, second half).** The staging filter (`build.js:2285`), the guarded-path scan (`mcp-enforcement.js:64,122`), and `feature-write-guard.js:87` all match guarded paths (`ROADMAP.md`, `feature.json`, featureDir) as **repo-relative strings** — an absolute external path does **not** "fall out cleanly," it silently fails to match and an external ROADMAP/feature.json edit escapes the guard (or, in block mode, is wrongly rejected). The guard must resolve guarded paths via the same resolver and match on resolved-absolute identity, so external artifacts are recognized as guarded exactly like in-root ones. `feature-write-guard.js`'s `{features, roadmap}` map switches from `join(cwd, …)` to the resolvers.

   - Cross-repo auto-commit (run `git -C <repo> add <owned paths> && commit`, with safety for unrelated dirty files) is **`COMP-PATHS-EXTERNAL-1`**, a deliberately separate ticket.

7. **`featuresDir`/`roadmap` are relative-path API contracts in core helpers — migrate the contract, not just the call sites (Codex finding 1).** `lib/feature-json.js` (`readFeature`/`writeFeature`/`listFeatures`/`updateFeature`, default param `featuresDir='docs/features'`) and `lib/feature-write-guard.js` take a **relative-to-cwd** features dir and `join(cwd, featuresDir, …)`. `..`-escaping survives `join`, but an **absolute** base yields `<cwd>/abs/…` — wrong. Downstream callers pass `loadFeaturesDir(cwd)` (relative) straight through (`xref-sync.js:103`, `roadmap-graph/collect.js:31`, `triage.js:240`, …). Migration:
   - Core helpers resolve their base through the shared core (`isAbsolute(dir) ? dir : resolve(cwd, dir)`) instead of `join(cwd, dir)` — back-compat for relative callers, correct for absolute/escaping. Default param stays `'docs/features'`.
   - Migrate downstream callers from the relative `loadFeaturesDir(cwd)` to the absolute `resolveFeaturesPath(cwd)` (audit every caller; the relative reader is retired or kept only for genuine display needs).
   - This is the API-migration slice; treat it as a contract change with its own tests, not a literal sweep.

## Non-goals (YAGNI)
- Cross-repo auto-commit of external artifacts → `COMP-PATHS-EXTERNAL-1`.
- Multi-workspace concurrency on a **shared** external features dir (two repos writing the same `feature.json` → last-writer-wins). File as a follow-up if it bites; v1 trusts single-writer-at-a-time.
- Making `compose build` edit sibling **code** repos (the "docs repo is the workspace" inversion) — a much larger build-pipeline change, not this ticket.
- Relocating `.compose/` itself (state/config). Out of scope by decision 4.
- Path-jailing / sandboxing the configured paths — it is the operator's own config; we resolve and trust it (we surface unreachable-parent errors, below, but do not restrict which locations are reachable).

## Implementation slices
Sequenced so the core ask ships before the heavy ship/enforcement rework. Each slice is independently testable and leaves the app working.

- **S1 — Resolver core + default table.** `lib/paths-core.js` (pure), `lib/project-paths.js` readers (incl. `*FromConfig(root,config)` alternate-root form), `server/project-root.js` delegation + `roadmap` default, `relForDisplay`. Delete duplicated default tables. *No behavior change yet — pure plumbing with the default-identity test as the gate.*
- **S2 — Sweep read/write/render/validate/scaffold consumers + the `featuresDir` API migration (Decision 7).** All roadmap/features/journal/context/ideabox sites; `feature-json.js` + `feature-write-guard.js` contract change; alternate-root routes (`vision-routes.js:169`, `vision-utils.js:73`); `compose init`/schema/docs; validation via shared readers. **After S2, managing a relocated roadmap/features (CRUD + render + validate + scaffold) fully works** — this is the core ask.
- **S3 — Ship/completion/enforcement git-awareness (Decisions 6a/6b/6c).** Per-file git case for the commit; decouple completion/status-flip from the workspace-repo commit; resolution-aware MCP-enforcement + write-guard. **Highest risk** (touches the build lifecycle + guard model). If `compose build` *from* a relocated workspace isn't needed day-1, S3 can be deferred behind S1+S2 without blocking the core ask.
- **Fast-follow — `COMP-PATHS-EXTERNAL-1`:** cross-repo auto-commit.

## Acceptance criteria
**S1**
- [ ] `lib/paths-core.js` (new): pure `DEFAULT_PATHS` (all 6 keys incl. `roadmap`) + `resolvePathValue(root, value, key)`; no `fs` import.
- [ ] `lib/project-paths.js`: `resolveRoadmapPath/resolveFeaturesPath/resolveJournalPath/resolveContextPath/resolveIdeaboxPath/resolveDocsPath` (absolute) + `*FromConfig(root, config)` alternate-root form, delegating to `paths-core`.
- [ ] `server/project-root.js`: `resolveProjectPath(key)` delegates to `paths-core.resolvePathValue` using the cached config; gains the `roadmap` default.
- [ ] Duplicated default tables removed (`feature-validator.js:54`, `project-paths.js DEFAULT_FEATURES_DIR`, `project-root.js DEFAULT_CONFIG.paths`); all import `DEFAULT_PATHS`.
- [ ] `relForDisplay(root, abs)` helper.

**S2**
- [ ] `.compose/compose.json` schema/docs: `paths.roadmap` documented (default `ROADMAP.md`); `compose init` scaffolds it alongside the existing `context`/`ideabox` keys (`bin/compose.js:413`).
- [ ] All ~11 hardcoded `ROADMAP.md` sites use `resolveRoadmapPath` (incl. `feature-write-guard.js:87`).
- [ ] All ~7 hardcoded `docs/features` sites use `resolveFeaturesPath` (incl. `feature-scan.js:626`); `journal-writer.js:37` `JOURNAL_DIR` const replaced.
- [ ] **Decision 7 — API migration:** `feature-json.js` helpers resolve their base (`isAbsolute? dir : resolve(cwd,dir)`); callers migrated from relative `loadFeaturesDir(cwd)` to absolute `resolveFeaturesPath(cwd)` (`xref-sync.js:103`, `roadmap-graph/collect.js:31`, `triage.js:240`, …, audited).
- [ ] `journal`, `context`, `ideabox` consumers use their resolvers (incl. `join`→`resolve` fixes at `vision-utils.js:75`, `build.js:666`, `ideabox-routes.js`, `bin/compose.js`).
- [ ] Alternate-root routes (`vision-routes.js:169`, `vision-utils.js:73`) use `*FromConfig(root, loadComposeConfig(root))`, not the global cache.
- [ ] `vision-server.js:459` + `design-routes.js:450` + `feature-scan.js:626` use `relForDisplay`.
- [ ] `compose validate` / `validate_project` resolve via the shared readers. A not-yet-created artifact dir is **fine** — writers `mkdir -p` the resolved path. Validation errors only when a configured path is malformed or its **parent** is unreachable, naming the resolved absolute path.

**S3**
- [ ] Ship decides per-file by containing git toplevel: same-repo → commit; different repo → write + "commit it there" log; no repo → write silently. No crash on an absolute external `featureDir` or a non-git workspace root.
- [ ] **Completion decoupled from commit (Decision 6b):** `completion-writer.js` accepts a nullable `commit_sha`, derives `completion_id` without the sha, and accepts absolute `files_changed`; then feature status flips to COMPLETE / completion is recorded even with no workspace-repo `sha` (cases ii/iii).
- [ ] **Resolution-aware guard (Decision 6c):** `mcp-enforcement.js` (`scanGuarded`) + `feature-write-guard.js` match guarded paths on resolved-absolute identity, so an external `ROADMAP.md`/`feature.json` is recognized as guarded.

## Testing (per the project hierarchy)
- **Golden flow (external dir):** workspace whose `paths.{roadmap,features,journal,context,ideabox}` point to an external temp dir → `scaffold_feature` → `set_feature_status` → render roadmap → `validate_project` → `get_roadmap`; assert every artifact is created/read **in the external dir** and the workspace root stays clean of them.
- **Default-identity (per key):** with the keys unset, each `resolve*Path()` returns a path byte-identical to the legacy hardcoded value (table test over all 6 keys).
- **Resolver unit table:** in-root (`docs/features`), `../`-escaping (`../sib/features`), absolute (`/tmp/x/features`), empty/whitespace → fallback — for `resolvePathValue`.
- **Absolute-override regression:** a site previously using `join(cwd, rel)` returns the correct absolute path (not `root/abs`) when given an absolute override. **Includes the `feature-json.js` API** — `readFeature/writeFeature/listFeatures` with an absolute `featuresDir` land in the external dir, not `<cwd>/abs`.
- **Alternate-root config:** a `*FromConfig(root, config)` reader resolves against the *passed* root/config, not the process-global bound target (regression for the `vision-routes.js:169` multi-workspace path).
- **Git-boundary (three cases):** (i) artifact in the build's own repo → staged & committed; (ii) artifact in a *different* repo → written, "commit it there" logged, excluded from staging, no throw; (iii) **workspace root not git-tracked** (forge-top shape) → artifacts written, ship commits nothing and does **not** throw on the missing `.git`.
- **Completion without commit (Decision 6b):** a build whose features/roadmap are external (or whose root is non-git) **still flips the feature to COMPLETE** and records completion with a null `commit` — the regression Codex flagged.
- **Enforcement guard (Decision 6c):** an external `feature.json`/`ROADMAP.md` edit is recognized as a guarded path (block/log mode behaves identically to in-root).
- **Display:** `relForDisplay` returns a clean relative for in-root paths and the absolute for escaping paths.

## Provenance
Requested 2026-06-15 (ruze): "allow ROADMAP and feature folder root to be in a different folder from root/top, e.g. `smart-memory-docs`" → expanded in-session to all artifact paths; git shape locked to option **(A)** (write + log, no cross-repo auto-commit in v1).
