# COMP-ROADMAP-MODES — Implementation Plan (TDD)

**Status:** PLAN (Phase 6)
**Blueprint:** `docs/features/COMP-ROADMAP-MODES/blueprint.md` (slices S01-S07, Boundary Map validated)

Each slice is **test-first**: write the failing test, watch it fail for the right reason, implement, watch it pass, run the full affected suite before marking done (`superpowers:test-driven-development` + `superpowers:verification-before-completion`). The **non-negotiable invariant**: `build` and `fix` behavior is byte-identical to today — golden tests (S07) and per-slice assertions guard it.

## Build order & parallelism (from Boundary Map topology)

```
S01 (registry) ──┬─→ S02 (guard) ──→ S04 (routes + creation seam)
                 ├─→ S03 (artifacts)
                 ├─→ S05 (runner MODE_CONFIG)
                 └─→ S06 (KNOWN_PHASES)
                          all ─────────→ S07 (golden + 4th-mode proof)
```

S01 lands first (everything consumes it). S02/S03/S05/S06 are independent given S01 (parallelizable). S04 needs S02. S07 is the final integration net. **Incremental-builds rule:** after each slice, `npm run build`/targeted suite must stay green — the dev server runs inside this app; a broken guard kills the terminal.

## Tasks

### T1 — S01 registry (`lib/lifecycle-modes.js` new, `test/lifecycle-modes.test.js` new)
- [ ] Test: `LIFECYCLE_MODES.build.transitions` deep-equals current `BASE_TRANSITIONS`; `.skippable`/`.terminal` equal `SKIPPABLE`/`TERMINAL`; `.phaseArtifacts` equals `Object.values(PHASE_ARTIFACTS)`.
- [ ] Test: `resolveMode` maps `feature→build, bug→fix, build→build, fix→fix, plan→plan, undefined→build, garbage→build`.
- [ ] Test: accessors (`genesisOf`, `completablePhaseOf`, `transitionsOf`, `skippableOf`, `phaseOrderOf`, `artifactsOf`, `terminalOf`) return the right per-mode data; unknown mode → build.
- [ ] Implement registry (pure data: build verbatim, fix = today's bug data, plan = minimal seed) + accessors.

### T2 — S02 guard (`server/lifecycle-guard.js`, extend `test/lifecycle-guard*.test.js`)
- [ ] Test: `resourceId(fc, root, 'build')` === legacy `compose:<hash>:<fc>` (byte-identical); `resourceId(fc, root, 'fix')` === `compose:<hash>:fix:<fc>`.
- [ ] Test: `buildPhaseGraph(transitions, 'build')` reads `completablePhase` ('ship') → produces today's graph; a mode with a different completable phase wires `X→complete`.
- [ ] Test: back-compat shims `BASE_TRANSITIONS`/`SKIPPABLE`/`TERMINAL`/`phaseToStatus` still export and equal build data; all 4 `_testOnly_*` seams preserved.
- [ ] Implement: thread `mode='build'` default through `resourceId`/`ensureGuard`/`guardedTransition`/`buildPhaseGraph`/`edgePredicates`; shims source from `LIFECYCLE_MODES.build`.

### T3 — S03 artifacts (`server/artifact-manager.js`, `server/compose-mcp-tools.js`, extend artifact tests)
- [ ] Test: `new ArtifactManager(root)` (no mode) and `(root, 'build')` both assess all 6 artifacts (byte-identical); maps + startup invariant untouched (module imports without throwing).
- [ ] Test: a mode whose `phaseArtifacts` is a subset assesses only that subset.
- [ ] Implement: constructor `(featureRoot, mode='build')`; `assess`/`scaffold` iterate `artifactsOf(#mode)`; update the **3** ctor sites + the bare `Object.keys` iteration to source mode (`build` default).

### T4 — S04 routes + creation seam (`server/vision-routes.js`, `lib/vision-writer.js`, extend route/lifecycle tests)
- [ ] Test: a fresh feature stamps `lifecycle.mode = 'build'`; a bug stamps `'fix'`; legacy item (no mode) resolves `'build'` at read-time.
- [ ] Test: advance/skip legality + complete gate + genesis derive from the registry; build flow unchanged end-to-end.
- [ ] Implement: stamp `lifecycle.mode` at the 3 creation sites (direct writer uses threaded mode arg; route uses `typeToMode(item.type)`); replace genesis/`'ship'`/`TRANSITIONS`/`SKIPPABLE` literals with registry lookups keyed by `item.lifecycle.mode ?? 'build'`. Do NOT write `lifecycle.currentPhase` into `feature.json`.

### T5 — S05 runner (`lib/build.js`, `bin/compose.js`, extend runner tests)
- [ ] Test: `resolveMode(opts.mode)` 3-valued; build & bug runs are byte-identical (dir resolution, triage gating, the 4 feature.json writes, planInputs shape, audit labels).
- [ ] Test: `runBuild({mode:'plan'})` threads `plan` through to `active-build`/lifecycle without running feature triage or bug-specific machinery.
- [ ] Implement: `MODE_CONFIG = getMode(mode).runner`; drive the 14 fall-through sites from `cfg`; keep the 7 bug-specific positive checks intact; preserve the absolute/relative dir split. No new CLI command.

### T6 — S06 KNOWN_PHASES (`server/status-snapshot.js`, extend snapshot test)
- [ ] Test: derived `KNOWN_PHASES` ⊇ today's hand-list (superset → no regression); includes `complete`/`killed`; terminal items still recognized.
- [ ] Implement: derive `KNOWN_PHASES` = union of every mode's `phaseOrder` ∪ `terminal`; fix the stale `LIFECYCLE_PHASE_LABELS` comment.

### T7 — S07 golden + 4th-mode proof (`test/lifecycle-modes-golden.test.js` new)
- [ ] Golden: a build flow and a bug flow exercise guard registration + artifact assess + status projection identically to a recorded baseline.
- [ ] 4th-mode proof: register a throwaway `demo` mode as **data only**, assert guard + artifact + status work through the public seams, remove it — proving a new mode is a data-only change.

## Exit criteria (Phase 7 gate)
- [ ] All 7 tasks' tests green; full `node --test` suite (with `--test-timeout=90000`) green.
- [ ] E2E smoke: dev server starts, a build lifecycle advances through the guard unchanged.
- [ ] Codex review loop → REVIEW CLEAN. Coverage sweep → TESTS PASSING.
- [ ] `build`/`fix` byte-identical invariant proven (golden).
