# COMP-ROADMAP-MODES — Implementation Report

**Status:** COMPLETE
**Feature:** COMP-ROADMAP-MODES (umbrella: COMP-ROADMAP) — the keystone
**Design:** `design.md` · **Blueprint:** `blueprint.md` · **Plan:** `plan.md`

## Summary

Mode-generalized Compose's build-locked lifecycle data into a single mode-keyed registry (`lib/lifecycle-modes.js`, keyed `build | fix | plan`), and threaded `mode` through the guard, artifact manager, route layer, runner, and the status recognizer. The `build` entry reproduces the prior hard-coded data verbatim, so build behavior is byte-identical; the same holds for the bug (fix) path. Adding a fourth lifecycle is now a **data-only change** (proven by a test that injects a throwaway `demo` mode and exercises it through every public seam). This unblocks COMP-ROADMAP-PLAN and the pluggable integration ports (COMP-ROADMAP-PROVIDERS).

## Delivered vs Planned

| Slice | Planned | Delivered |
|---|---|---|
| S01 registry | mode-keyed registry, build verbatim | ✅ `lib/lifecycle-modes.js` + accessors; build deep-equals legacy (pinned) |
| S02 guard | thread mode; resourceId byte-identical for build | ✅ resourceId/ensureGuard/guardedTransition/buildPhaseGraph/edgePredicates mode-aware; `completablePhase` from registry |
| S03 artifacts | option (b): ctor mode, maps+invariant untouched | ✅ `ArtifactManager(root, mode)` filters via shared `artifactKeysForMode`; 3 ctor sites + MCP empty-fallback mode-capable |
| S04 routes + creation | stamp mode; per-item-mode legality | ✅ `lifecycle.mode` stamped at direct writer + `/lifecycle/start`; advance/skip/complete resolve per-item mode |
| S05 runner | MODE_CONFIG over the fall-through sites | ✅ `cfg = getMode(mode).runner` drives dir/triage/feature.json/description/planInputs/template; 7 bug-specific checks intact |
| S06 KNOWN_PHASES | derive recognizer from registry | ✅ `KNOWN_PHASES = union(phaseOrder ∪ terminal)`, superset of legacy |
| S07 golden + 4th-mode | no-regression contract + data-only proof | ✅ build-surface golden + `demo`-mode proof |

**Scope changes vs the original design (all tightened via gates):** no user-facing `compose plan` CLI (threading-only); vocabulary convergence narrowed to `KNOWN_PHASES` only (staleness ordering + policy mode-awareness deferred); artifact root resolution deferred; per-mode genesis-at-creation reverted to preserve byte-identical bug behavior.

## Architecture Deviations

- **resourceId migration sidestep:** build keeps the legacy id `compose:<hash>:<code>` (no mode segment); only non-build modes get `compose:<hash>:<mode>:<code>`. Zero migration, zero orphaned in-flight build guards.
- **Read-time mode default:** resolvers read `lifecycle.mode ?? 'build'`; legacy items (all build) need no write migration.
- **`resolveMode` recognizes any registry key:** adding a mode requires no edit to `resolveMode` (legacy `feature→build`/`bug→fix` aliases preserved) — this is what makes a new mode purely data.
- **Two definitions, test-pinned:** the legacy consts in `lifecycle-guard.js` (`BASE_TRANSITIONS`/`SKIPPABLE`/`TERMINAL`) remain as compatibility exports; the registry holds a verbatim copy; S01 pins them deep-equal so they cannot drift.

## Key Implementation Decisions

1. **Keep `isBugMode` as a derived flag** (`mode === 'fix'`) so the 7 bug-specific positive checks (`mode==='bug' && bug_code`) stayed untouched; only the feature-default *fall-through* gates were lifted to `cfg` flags.
2. **Artifact option (b):** the global `ARTIFACT_SCHEMAS` map + its module-load invariant are untouched; `mode` filters the iteration. A mode with empty `phaseArtifacts` falls back to all keys — exactly today's bug-item assessment.
3. **`completablePhase` in the registry** replaced the literal `ship→complete` edge, so a mode terminating elsewhere is expressible.

## Test Coverage

- New: `lifecycle-modes.test.js` (14), `lifecycle-modes-golden.test.js` (4), `artifact-manager-modes.test.js` (5), `build-modes.test.js` (3), plus added cases in `lifecycle-guard.test.js` (+4 mode tests), `lifecycle-routes.test.js` (+2), `status-snapshot.test.js` (+2).
- Full node suite **4360 pass / 0 fail**; UI (Vitest) **564/0**; tracker **100/0**. The byte-identical invariant is the cross-component integration check and passes across the whole suite.
- Codex implementation review: **REVIEW CLEAN** (2 rounds; 4 findings → 2 fixed, 2 confirmed deferrals).

## Files Changed

Source (8): `lib/lifecycle-modes.js` (new, +213), `server/lifecycle-guard.js`, `server/artifact-manager.js`, `server/compose-mcp-tools.js`, `server/vision-routes.js`, `server/status-snapshot.js`, `lib/vision-writer.js`, `lib/build.js`. Tests (7). Total +906 / −96.

## Known Issues & Tech Debt (deferred follow-ups)

These are **intentional MODES boundaries**, each a named follow-up:

- **COMP-ROADMAP-PLAN** — the `plan` lifecycle behavior + `compose plan` command + the route-side `plan` item carrier (vision-writer/route only stamp `feature`/`bug` today; a plan item via the server path currently resolves to `build`).
- **Mode-owned artifact root resolution** — `ArtifactManager` and the guard's `_featureRelDir` stay `features`-rooted; `fix`/`plan` assess/scaffold/evidence the wrong tree until the mode descriptor owns root resolution.
- **COMP-ROADMAP-MODES-WRITER** — `updateItemPhase` write-side unification (split lifecycle-phase from step-progress updates); needed before staleness-ordering convergence.
- **Per-mode genesis-at-creation + fix/plan UI phase labels** — creation currentPhase stays `explore_design`; the cockpit (`DashboardView`, `constants.js`) and `vision-server.js` settings rows only know build phases.
- **Policy mode-awareness** — `evaluatePolicy` stays phase-keyed (no `mode` threaded to it yet).

## Lessons Learned

1. **The keystone's hardest constraint was no-regression, not the abstraction.** Most effort went into proving `build`/`fix` byte-identical — back-compat shims, resourceId-for-build, read-time defaults, and keeping `isBugMode` derived.
2. **Gates kept narrowing scope correctly.** Each Codex round (design ×2, blueprint ×3, impl ×2) removed over-reach: hollow CLI, write-path entanglement, dead config, and a genuine byte-identical violation (the bug-genesis change). Self-adversarial drafting caught some; gates caught the rest.
3. **A "more correct" change can still be a regression.** The bug genesis `explore_design→reproduce` was semantically better but broke byte-identical bug behavior (UI consumers) for a transient, overwritten value — reverting was right.
4. **Verification before implementation paid off.** The 5-surface verifier found the artifact invariant runs at module-load (option b), 3 ctor sites not 2, and the `ship→complete` literal coupling — all of which shaped the plan before any code.
