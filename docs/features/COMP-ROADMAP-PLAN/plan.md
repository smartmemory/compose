# COMP-ROADMAP-PLAN — Implementation Plan

**Status:** PLAN (Phase 6 — ordered TDD task breakdown)
**Date:** 2026-06-21

## Related Documents
- Design: `docs/features/COMP-ROADMAP-PLAN/design.md`
- Blueprint: `docs/features/COMP-ROADMAP-PLAN/blueprint.md` (work units S1-S8, Boundary Map, verification table)

## Strategy

TDD per task (write the failing test first, watch it fail, implement, watch it pass). Real backends — no mocks (per testing hierarchy: golden flow + error harness + contract tests). The work splits into a **produce side** (a runnable `compose plan` that emits build-ready features and passes the guard) and a thin **consume side** (build ratifies a plan-authored design). Order is dependency-driven; independent tasks are flagged parallelizable.

## Task graph

### Group A — registry + guard plumbing (foundation; parallelizable)
- [ ] **T1 (S6):** Fix `lib/feature-json.js:33` JSDoc `low|medium|high` → `S|M|L|XL`. Contract test asserting the documented enum matches `COMPLEXITIES` (`feature-writer.js:60`). *(trivial, no dep)*
- [ ] **T2 (S7):** Make `_featureRelDir` mode-aware in `server/lifecycle-guard.js:246` — branch like `resolveItemDir`: config-backed `paths.features` when `artifactRoot==='features'`, literal root for `docs/bugs`/`docs/plans`; thread `mode` from `ensureGuard:289`. **Tests first:** (a) build-mode evidence still resolves `paths.features` override (regression guard); (b) plan-mode resolves `docs/plans/<code>/design.md`; (c) bug-mode resolves `docs/bugs/<code>`. *(dep: none)*
- [ ] **T3 (S8):** Gate the `stepId==='ship'` interception in `lib/build.js:1206` on `mode !== 'plan'`. **Tests first:** (a) build & bug still hit `executeShipStep`; (b) plan `ship` runs as a normal agent step. *(dep: none)*
- [ ] **T4 (S1a):** Flip `lib/lifecycle-modes.js:136` `defaultTemplate` `'new'`→`'plan'`. Registry test that `getMode('plan').runner.defaultTemplate==='plan'`. *(dep: none)*

### Group B — server mode-stamp + projection (depends on A2)
- [ ] **T5 (S2):** Forward `mode` on both `/lifecycle/start` POSTs in `lib/vision-writer.js:175,192`; prefer `req.body.mode` over `typeToMode` at `server/vision-routes.js:265`. **Tests first:** REST-created plan item starts with `lifecycle.mode==='plan'` (both the create path and the existing-item repair path). *(dep: none, but pairs with T6)*
- [ ] **T6 (S3):** Gate `projectFeatureStatus` on `getMode(modeOf(item)).runner.tracksFeatureJson` at all 5 call sites (`vision-routes.js:289,361,401,445,565`). **Tests first:** a plan-session start/advance/kill does NOT write a `feature.json`; a build feature still projects status. *(dep: T5 for the mode to be correct)*

### Group C — the writer (the handshake producer; depends on A1)
- [ ] **T7 (S4a):** Extend `addRoadmapEntry`'s whitelist (`lib/feature-writer.js:124-138`) to accept `profile`/`triageTimestamp`/`plannedBy`/`impact`, persisted via the provider-backed `createFeature`. **Tests first:** golden write produces a `feature.json` with all fields + a regenerated ROADMAP row; provider path (not raw `writeFeature`). *(dep: T1)*
- [ ] **T8 (S4b):** Exclude `feature.json` from `isTriageStale`'s folder scan (`lib/triage.js:263`). **Tests first:** (a) a feature with `profile`+`triageTimestamp` and an untouched `design.md` is NOT stale; (b) a newer `design.md` IS stale; (c) normal-triage golden path still skips. *(dep: none)*

### Group D — the pipeline + CLI (the spine; depends on A, B, C)
- [ ] **T9 (S1b):** Author `pipelines/plan.stratum.yaml` — `workflow.name: plan`, `flows.plan`, `input:{projectName,intent}`, top-level step IDs `explore_design`/`plan`/`ship`, steps interpolate `$.input.projectName`/`$.input.intent`, gates via `ensure: file_exists(docs/plans/<code>/...)`. Absorb research/brainstorm→`explore_design` (ideation routed to ideabox), converge/estimate/spec→`plan` (calls T7 per feature), handoff→`ship`. *(dep: T4, T7)*
- [ ] **T10 (S1c):** Add `'plan.stratum.yaml'` to `runInit`'s copy list (`bin/compose.js:568`); add source preset. *(dep: T9)*
- [ ] **T11 (S1d):** New `compose plan "<intent>"` verb (`bin/compose.js`, near `:2120`) — `PLAN-<slug>` derivation (dedup), always passes `opts.description=intent`, `--resume` cross-mode guard, `runBuild(planCode,{template:'plan',mode:'plan',description})`. **Tests first:** verb derives a stable code, dispatches with mode plan, refuses cross-mode resume. *(dep: T9, T10)*

### Group E — build consumes (the ratify half)
- [ ] **T12 (S5):** Load `feature.json` early in `runBuild`; apply the `plannedBy`-ratify `explore_design` intent rewrite in the `specYaml` mutation section (`lib/build.js:799-837`), **independent** of the `buildProfile||vocabOn` gate (`:811`). **Tests first:** a `plannedBy` feature's build mutates the explore_design intent to ratify-not-rewrite; a normal feature is unchanged. *(dep: none, but verified by the golden flow)*

### Group F — golden flow + sweeps (Phase 7 steps 2-4)
- [ ] **T13 (golden flow / E2E):** `compose plan "build a widget"` → asserts `docs/plans/PLAN-*/` workspace + `docs/features/<code>/{feature.json(PLANNED, profile, triageTimestamp, plannedBy), design.md}` + ROADMAP row + plan session item `mode:plan` not projected to a feature row → then `compose build <code>` ratifies the existing design (no clobber) and advances to blueprint. Real backends.
- [ ] **T14:** Codex review loop on the implementation diff (till REVIEW CLEAN).
- [ ] **T15:** Coverage sweep (edge/error paths: bad intent, dup code, guard-disabled, server-up vs direct path) till TESTS PASSING.
- [ ] **T16:** Full `node --test` suite green before merge.

## Parallelization
- Group A (T1-T4) fully parallel. Group B (T5-T6) parallel with C (T7-T8). D depends on A+C; E (T12) independent until the golden flow. Suggested batches: **A‖** → **(B‖, C‖)** → **D** → **E** → **F**.

## Acceptance criteria (Phase 7 exit)
- [ ] `compose plan "<intent>"` runs end-to-end, emits build-ready `feature.json`+`design.md`, plan session not mis-projected, guard passes on `docs/plans`.
- [ ] `compose build <plan-code>` ratifies the plan design without rewriting it.
- [ ] Build & bug modes unchanged (guard root, ship interception, triage staleness regressions all covered).
- [ ] Golden flow green; Codex REVIEW CLEAN; coverage sweep TESTS PASSING; full suite green.
