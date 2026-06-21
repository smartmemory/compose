# COMP-ROADMAP-MODES — Implementation Blueprint

**Status:** BLUEPRINT (Phases 4-5, verified)
**Feature:** COMP-ROADMAP-MODES (umbrella: COMP-ROADMAP)
**Design:** `docs/features/COMP-ROADMAP-MODES/design.md`

## Related Documents

- Design: `docs/features/COMP-ROADMAP-MODES/design.md`
- Epic anchor: `docs/plans/2026-06-21-roadmap-planning-model-design.md`
- Boundary Map validator: `lib/boundary-map.js` (`validateBoundaryMap`)

## Verification Table (Phase 5)

Every design file:line anchor was read against the real source by 5 parallel verifiers. **46 VERIFIED, 0 stale lines, 1 value-WRONG (corrected below).**

| Surface | Refs | Result |
|---|---|---|
| Guard core (`server/lifecycle-guard.js`) | 8 | All VERIFIED at exact lines (`BASE_TRANSITIONS:31`, `SKIPPABLE:45`, `TERMINAL:48`, `buildPhaseGraph:57`, `edgePredicates:89`, `resourceId:108`, `phaseToStatus:124`, `ensureGuard:262`, `guardedTransition:296`). |
| Artifact manager (`server/artifact-manager.js`) | 7 | All VERIFIED (`PHASE_ARTIFACTS:13`, `ARTIFACT_SCHEMAS:29`, invariant `:66`, ctor `:149`, `assess:153`). +2 uncited call sites found. |
| Creation seam + routes (`lib/vision-writer.js`, `server/vision-routes.js`) | ~12 | All VERIFIED. `_restEnsureFeatureItem:167` / `_directEnsureFeatureItem:256` already receive `mode`; complete-gate `'ship'` at `:452`. |
| Runner (`lib/build.js`, `bin/compose.js`) | ~16 | All VERIFIED. Full `isBugMode` inventory extracted (14 fall-through + 7 bug-specific). |
| Vocab readers (`lib/staleness.js`, `server/status-snapshot.js`, `server/policy-evaluator.js`, ...) | 6 | 5 VERIFIED. **1 WRONG:** `PHASE_ORDER` value. |

## Corrections Table (spec assumption → verified reality)

| # | Design assumption | Verified reality | Blueprint adjustment |
|---|---|---|---|
| C1 | `staleness.js PHASE_ORDER` = `[explore_design, blueprint, plan, build, done]` (5) | Real array is **6 entries incl. `ship`** and uses a *different vocabulary* (`build`/`done` aliases) than the registry `phaseOrder` (`:15-22`) | **MODES leaves `staleness.PHASE_ORDER` untouched** (deferred, C10) — converging it isn't a no-regression source-swap. |
| C2 | Artifact manager: "startup invariant becomes per-mode" | The invariant (`:66`) runs at **module load** — splitting maps per-mode risks a startup crash. `PHASE_ARTIFACTS` is **module-private**; only `ARTIFACT_SCHEMAS` is exported (1 consumer). | **Option (b):** keep both maps + the invariant **global and untouched**; `mode` is a constructor arg that **filters** the assess/scaffold iteration to the mode's `phaseArtifacts` subset. Lower risk. |
| C3 | 2 `ArtifactManager` construction sites | **3** sites (`vision-routes.js:759`, `compose-mcp-tools.js:754`, `compose-mcp-tools.js:760`) + an independent `Object.keys(ARTIFACT_SCHEMAS)` iteration at `compose-mcp-tools.js:749`. | S03 updates all 3 ctor sites + the bare iteration. |
| C4 | `buildPhaseGraph` "already takes a transitions arg" → drop-in for any mode | True, but it **hardcodes `ship → complete` by literal name** (`:67`). A mode whose pre-terminal phase isn't `ship` silently loses its completion edge. | S02: registry carries `completablePhase` (default `ship`); `buildPhaseGraph` reads it instead of the literal. |
| C5 | Creation seam = the two `vision-writer` ensure fns | The **REST path delegates persistence to the `/lifecycle/start` route handler** (`vision-routes.js:255`), which builds the lifecycle object server-side. Genesis `'explore_design'` is hardcoded in **both** files. | S04 stamps `mode` + per-mode genesis at **all 3** construction sites (direct fresh-create `:281`, direct UI-repair `:264`, route handler). Mode is **derived from the item** (its kind), not a new request param. |
| C6 | feature.json write gated at 1 site (`:882`) | **4 sites** (`:882` start, `:1077` rollback, `:2130` complete, `:2150/:2167` killed/failed). | S05 folds all 4 under one `MODE_CONFIG.tracksFeatureJson` flag. |
| C7 | Runner mode enters at the `:634` coercion | Mode enters via **3 scopes**: `runBuild` coercion (`:634`), `startFresh`'s own `mode` param (`:4618`), and `context.mode` read directly in the main loop (`:1457`) + `executeShipStep` (`:2478`, a separately-exported fn). | S05's `resolveMode`/registry must be reachable from all 3 scopes. |
| C8 | `KNOWN_PHASES` "must match LIFECYCLE_PHASE_LABELS in constants.js" (its comment) | **No such symbol exists** anywhere; `KNOWN_PHASES` is hand-maintained, and its unknown-phase guard runs *before* the terminal branches (so `complete`/`killed` must stay in the set). | S06 derives it as union of every mode's `phaseOrder` **∪ `terminal`**; fixes the stale comment. |
| C9 | Runtime mode vocabulary == registry vocabulary | Runtime persists/branches on **`feature|bug`** (`active-build.json`, `build-routes.js`, runner) while the registry is **`build|fix|plan`**. | `resolveMode` normalizes both; `active-build.json` + the HTTP/CLI boundary stay byte-identical; `lifecycle.mode` stores the canonical key. See "Mode vocabulary compatibility contract". |
| C10 | S06 readers can select per-mode ordering/policy | `checkStaleness(featureDir, currentPhase)` and `evaluatePolicy(...)` are **not** passed `mode`; callers pass none. Per-mode selection would need signature widening (an S05 dependency). | S06 derives registry **unions** (no mode threading, no signature change); per-mode selection deferred to PLAN. Keeps S06 buildable from S01 alone. |

**Unchanged-and-good design claims (confirmed):** the mode-keyed registry is the right abstraction; `resourceId` byte-identical-for-build (omit mode segment) prevents cross-mode ledger collision with zero migration; back-compat shims are safe (only 2 importers; **no external caller** consumes `buildPhaseGraph`/`edgePredicates`/`resourceId`/`phaseToStatus` directly, so their signatures can change); read-time `mode ?? 'build'` is sound (no lifecycle object persists `mode` today); board taxonomy (`VALID_PHASES`, `inferPhase`) correctly deferred; `CONTRADICTORY_PHASE_CLAIM` stays dormant **iff** MODES does not persist `lifecycle.currentPhase` into `feature.json` (S04/S05 must not).

## The registry (S01) — single source of truth, pure data

`lib/lifecycle-modes.js` exports `LIFECYCLE_MODES`, keyed `build | fix | plan`. It holds **declarative data only** (no function refs — `lib/build.js` imports it, not vice-versa, so loaders stay in the runner keyed by a string):

```js
LIFECYCLE_MODES = {
  build: {
    transitions: { /* …BASE_TRANSITIONS verbatim… */ },
    skippable: ['prd','architecture','report'],
    terminal: ['complete','killed'],          // universal; kept shared
    genesis: 'explore_design',
    completablePhase: 'ship',                  // was the hardcoded ship→complete (C4)
    phaseArtifacts: ['design.md','prd.md','architecture.md','blueprint.md','plan.md','report.md'],
    edgeEvidence: { 'explore_design->blueprint':'design.md', 'blueprint->verification':'blueprint.md', 'plan->execute':'plan.md' },
    phaseOrder: ['explore_design','prd','architecture','blueprint','verification','plan','execute','report','docs','ship'],
    runner: { artifactRoot:'features', runsTriage:true, tracksFeatureJson:true, descriptionLoader:'feature', planInputs:'feature', defaultTemplate:'build' },
  },
  fix:  { /* diagnose→fix→…→ship; runner: artifactRoot:'docs/bugs', runsTriage:false, tracksFeatureJson:false, descriptionLoader:'bug', planInputs:'bug', defaultTemplate:'bug-fix' — DATA MATCHES TODAY'S BUG BEHAVIOR; not newly guarded */ },
  plan: { /* minimal seed: explore_design→plan→ship; runner defaults; PLAN refines */ },
};
// accessors: resolveMode(raw) → 'build'|'fix'|'plan'; getMode(mode); genesisOf(mode); completablePhaseOf(mode); phaseOrderOf(mode); transitionsOf(mode); skippableOf(mode); artifactsOf(mode); terminalOf(mode)
```

Accessors default to `build` for unknown/missing input — that IS the legacy fallback.

### Mode vocabulary compatibility contract (resolves blueprint gate finding)

The **runtime vocabulary is `feature|bug`** (the runner coercion `build.js:634`, `active-build.json`'s persisted `mode`, `build-routes.js` validation `feature|bug|new|all|gsd`), while the **registry vocabulary is `build|fix|plan`**. `resolveMode(raw)` is the single normalization chokepoint and maps **both**: `feature→build`, `bug→fix`, `build→build`, `fix→fix`, `plan→plan`, `undefined→build`. No-regression rules:
- **Persistence is byte-identical:** `active-build.json` keeps persisting the existing token (`feature`/`bug`) verbatim (`build.js:4641` unchanged); resume reads it unchanged. MODES persists no new token there.
- **The HTTP/CLI boundary is byte-identical:** `server/build-routes.js` validation and the `bin/compose.js` build dispatch are **not touched** by MODES (no `plan` command yet — that's PLAN). So no new token enters the API/CLI surface.
- **`lifecycle.mode` stores the canonical registry key** (`build`/`fix`/`plan`) — it is a brand-new field, so there is no back-compat shape to preserve; resolvers read it via `resolveMode`.
This keeps every existing `mode === 'bug'` check and persisted value working while the registry uses canonical keys internally.

## Per-slice change plan

### S01 — Registry module (new)
`lib/lifecycle-modes.js`. `build` entry extracted **verbatim** from the current consts (must deep-equal them — tested). `fix` entry mirrors today's bug behavior (data only, not wired to a guard). `plan` is a minimal seed. Pure data + accessors. No importers yet.

### S02 — Guard mode-threading (`server/lifecycle-guard.js`)
- `resourceId(featureCode, workspaceRoot, mode='build')` → `compose:<hash>:<featureCode>` when `mode==='build'` (byte-identical), else `compose:<hash>:<mode>:<featureCode>`.
- `buildPhaseGraph(transitions, mode='build')` reads `completablePhase` from the registry (C4) instead of literal `'ship'`.
- `edgePredicates(featureRelDir, mode='build')` returns the mode's `edgeEvidence`.
- `ensureGuard(featureCode, currentPhase, workspaceRoot, mode='build')` and `guardedTransition({…, mode='build'})` thread `mode` to the above.
- Keep `BASE_TRANSITIONS`/`SKIPPABLE`/`TERMINAL`/`phaseToStatus` exported as **back-compat shims** sourced from `LIFECYCLE_MODES.build` (importers `vision-routes.js`, `compose-mcp-tools.js` unchanged). Preserve all 4 `_testOnly_*` seams.
- `phaseToStatus` unchanged (build/fix/plan all terminate in `complete`/`killed`).

### S03 — Artifact manager mode-scoping (`server/artifact-manager.js`) — option (b)
- Constructor `(featureRoot, mode='build')`; private `#mode`. Maps + invariant **untouched** (C2).
- `assess()`/`scaffold()` iterate `artifactsOf(#mode)` (subset of `ARTIFACT_SCHEMAS` keys) instead of all keys. `build` → all 6 (byte-identical). `assessOne`/`getTemplate`/`getSchema` stay keyed off the global `ARTIFACT_SCHEMAS` (unchanged).
- Update **3** ctor sites (C3) to resolve mode from the item's lifecycle (`vision-routes.js:759` reads `item.lifecycle`; the two MCP tools `compose-mcp-tools.js:754,:760` gain a `mode` input, default `build`) + the bare `Object.keys` iteration at `:749`.

### S04 — Route layer + mode persistence (`server/vision-routes.js`, `lib/vision-writer.js`)
- Stamp `lifecycle.mode = resolveMode(...)` at **all 3** creation sites (C5). The mode **source** differs by path: the two direct-writer sites (`vision-writer.js:281` fresh, `:264` repair) use the `mode` arg the ensure fns **already receive** (threaded from `runBuild` via `build.js:843`); the server-up `/lifecycle/start` handler (`vision-routes.js:255`) — which gets no mode in its body — uses `typeToMode(item.type)` (`feature→build`, `bug→fix`). For build/fix these two sources agree (item.type↔runner mode). **`plan` needs no new item kind in MODES** (vision-store has only `feature|bug`): the carrier is the already-threaded `mode` arg + the new `lifecycle.mode` field, so the moment PLAN's runner passes `mode:'plan'` it stamps correctly. Wiring plan's *route-side* creation carrier is PLAN's job; MODES ships the mechanism + build/fix wiring.
- Genesis: replace literal `'explore_design'` with `genesisOf(mode)` at those sites + the route's 6 genesis literals.
- Replace `const TRANSITIONS = BASE_TRANSITIONS` (`:219`) usage in advance/skip with a per-item-mode lookup (`transitionsOf(item.lifecycle.mode ?? 'build')`); `skip` uses `skippableOf(mode)`.
- Complete handler: replace literal `'ship'` gate (`:452,474,482,490,491`) with `completablePhaseOf(mode)`.
- `guardedTransition`/`ensureGuard` calls pass `item.lifecycle.mode ?? 'build'`.
- **Do not** write `lifecycle.currentPhase` into `feature.json` (keeps `CONTRADICTORY_PHASE_CLAIM` dormant). Note in prose the pre-existing server-down `_directUpdateItemPhase` validation gap (out of scope).

### S05 — Runner `MODE_CONFIG` (`lib/build.js`, `bin/compose.js`)
- Replace coercion `:634` with `const mode = resolveMode(opts.mode)` (3-value) + `const cfg = getMode(mode).runner`. `isBugMode` derived where still needed for bug-specific positive checks.
- Drive the 14 fall-through-dangerous sites from `cfg`: `resolveItemDir:661` and `executeShipStep:2478` from `cfg.artifactRoot` (preserve the absolute-vs-relative split; `executeShipStep` reads `context.mode`); triage `:739` from `cfg.runsTriage`; description loader `:836` from `cfg.descriptionLoader`; the **4** feature.json writes (`:882,:1077,:2130,:2150/:2167`) from `cfg.tracksFeatureJson` (C6); `startFresh` planInputs `:4632` from `cfg.planInputs` (C7); audit dir labels `:2346/:2359` from `cfg.artifactRoot` (fixes the pre-existing `'docs/features'` hardcode).
- Keep the 7 bug-specific positive checks (`mode==='bug' && context.bug_code`, lines `:1457,:1481,:1520,:1939,:2034,:2056`) intact — plan never reaches them.
- **No user-facing `compose plan` CLI.** `runBuild` merely accepts+threads `mode:'plan'`; the `bin/compose.js` build dispatch is unchanged. (PLAN owns the command.)

### S06 — `KNOWN_PHASES` recognizer derived from the registry (`server/status-snapshot.js`)
The read-side convergence is deliberately narrowed to the **one reader that converges no-regression without `mode`**: the `KNOWN_PHASES` recognizer.
- `KNOWN_PHASES` derived as the union of every mode's `phaseOrder` **∪ `terminal`** (C8). It MUST keep `complete`/`killed`, since the unknown-phase guard in `status-snapshot.js` runs *before* the terminal branches; deriving from `phaseOrder` alone (which excludes them) would make terminal items render "unrecognized phase" (gate finding). The derivation must be a **superset of today's hand-list** (S07 asserts this) — recognizing *more* phases is purely additive and cannot regress build. Fix the stale `LIFECYCLE_PHASE_LABELS` comment (no such symbol exists).
- **Deferred out of MODES (gate findings C10):**
  - `lib/staleness.js PHASE_ORDER` — it uses a *different, coarser* vocabulary (`build`/`done` aliases) than the registry's lifecycle `phaseOrder`, so sourcing it from the registry would *change* the list (not a no-regression swap), and `checkStaleness(featureDir, currentPhase)` isn't passed `mode`. Left untouched; staleness convergence is its own cleanup (PLAN, once plan artifacts/staleness exist).
  - `server/policy-evaluator.js evaluatePolicy` — mode-aware policy needs a `mode` value the function doesn't receive (only `settings`, `stepId`, `{toPhase, fromPhase}`; its caller passes none). Left **byte-identical**; mode-namespaced policy is deferred to when mode is threaded.
- **No write-path changes** (`updateItemPhase` untouched).

### S07 — Golden tests + 4th-mode proof
- Golden: a build flow and a bug flow produce byte-identical lifecycle/guard/artifact/status behavior vs a recorded baseline.
- Registry: `build` entry deep-equals the legacy consts; per-mode `artifactsOf ⊆ ARTIFACT_SCHEMAS keys`; `resourceId('X', root, 'build')` === legacy id.
- 4th-mode proof: add a throwaway `demo` mode as **data only**, assert guard registration + artifact assess + status projection work for it through the public seams, then remove it — proving a new mode is a data-only change.

## File Plan

| File | Action | Notes |
|---|---|---|
| `lib/lifecycle-modes.js` | new | The mode-keyed registry + accessors (S01). |
| `server/lifecycle-guard.js` | refactor | Thread `mode`; back-compat shims; `completablePhase` (S02). |
| `server/artifact-manager.js` | refactor | Constructor `mode`; filter assess/scaffold; maps+invariant untouched (S03). |
| `server/vision-routes.js` | refactor | Per-item-mode legality; stamp mode; genesis/terminal from registry; 3 ctor mode-sourcing (S03/S04). |
| `lib/vision-writer.js` | refactor | Stamp `lifecycle.mode` + per-mode genesis at the 2 direct creation sites (S04). |
| `server/compose-mcp-tools.js` | modify | 2 `ArtifactManager` ctor sites + bare `Object.keys` iteration take `mode` (S03). |
| `lib/build.js` | refactor | `MODE_CONFIG` from registry; lift 14 fall-through sites; keep bug-specific (S05). |
| `bin/compose.js` | modify | `runBuild` accepts `mode:'plan'`; no new command (S05). |
| `server/status-snapshot.js` | modify | `KNOWN_PHASES` derived union ∪ terminal; fix stale comment (S06). |
| `test/lifecycle-modes.test.js` | new | Registry + accessor unit tests (S01/S07). |
| `test/lifecycle-modes-golden.test.js` | new | Build/fix byte-identical golden + 4th-mode proof (S07). |

## Boundary Map

### S01: Mode registry (pure data + accessors)
Produces:
  lib/lifecycle-modes.js → LIFECYCLE_MODES (const)
  lib/lifecycle-modes.js → resolveMode, getMode, genesisOf, completablePhaseOf, transitionsOf, skippableOf, phaseOrderOf, artifactsOf, terminalOf (function)
Consumes: nothing

### S02: Guard mode-threading
Produces:
  server/lifecycle-guard.js → resourceId, ensureGuard, guardedTransition, buildPhaseGraph, edgePredicates (function)
Consumes:
  from S01: lib/lifecycle-modes.js → LIFECYCLE_MODES (const)
  from S01: lib/lifecycle-modes.js → transitionsOf, completablePhaseOf (function)

### S03: Artifact manager mode-scoping
Produces:
  server/artifact-manager.js → ArtifactManager (class)
  server/compose-mcp-tools.js → toolAssessFeatureArtifacts, toolScaffoldFeature (function)
Consumes:
  from S01: lib/lifecycle-modes.js → artifactsOf, resolveMode (function)

### S04: Route layer + mode persistence
Produces:
  server/vision-routes.js → TRANSITIONS (const)
  lib/vision-writer.js → _directEnsureFeatureItem (function)
Consumes:
  from S01: lib/lifecycle-modes.js → genesisOf, completablePhaseOf, transitionsOf, skippableOf (function)
  from S02: server/lifecycle-guard.js → guardedTransition, ensureGuard (function)

### S05: Runner MODE_CONFIG
Produces:
  lib/build.js → runBuild, resolveItemDir, executeShipStep, startFresh (function)
Consumes:
  from S01: lib/lifecycle-modes.js → resolveMode, getMode (function)

### S06: KNOWN_PHASES recognizer (read-side)
Produces:
  server/status-snapshot.js → KNOWN_PHASES (const)
Consumes:
  from S01: lib/lifecycle-modes.js → phaseOrderOf, terminalOf (function)

### S07: Golden tests + 4th-mode proof
Produces: nothing
Consumes:
  from S01: lib/lifecycle-modes.js → LIFECYCLE_MODES (const)
  from S02: server/lifecycle-guard.js → resourceId, guardedTransition (function)
  from S03: server/artifact-manager.js → ArtifactManager (class)
  from S05: lib/build.js → runBuild (function)
