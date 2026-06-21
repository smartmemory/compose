# COMP-ROADMAP-PLAN — The `plan` Product-Planning Lifecycle (v1)

**Status:** DESIGN (Phase 1 — review as a design/strategy doc, not shipped code)
**Date:** 2026-06-21
**Feature:** COMP-ROADMAP-PLAN · complexity XL · slice 2/8 of COMP-ROADMAP
**Depends on:** COMP-ROADMAP-MODES (shipped — the mode-keyed lifecycle registry)

## Related Documents

- Epic anchor: `docs/plans/2026-06-21-roadmap-planning-model-design.md` (Decision 1 = `plan` within compose; open questions #2 build-handshake contract and #3 phase-vocab consolidation are resolved here).
- Keystone prior art: `docs/features/COMP-ROADMAP-MODES/{design.md,blueprint.md,report.md}` (the registry this builds on; `report.md:48-56` is the deferred-follow-up list that bounds what `plan` still needs).
- Absorbed system: `lib/new.js` + `pipelines/new.stratum.yaml` (the `compose new` kickoff).
- Seam reference: the mode registry `lib/lifecycle-modes.js:117-138` (the `plan` SEED) and the build entry `lib/build.js#runBuild` (`:626`).

## Problem / what v1 delivers

Compose today is a **build** lifecycle that assumes you already know "build X." The owner wants the front half: "I want to build something" → "I want to build X" via framing, research, ideation, estimation, and convergence into a build-ready spec. `plan` is that lifecycle, a peer to `build`/`fix`, living **inside** compose (extractable later), native-state-only in v1 (no Linear/JIRA/Notion coupling).

**v1 delivers an end-to-end spine:** a real `compose plan "<intent>"` command that runs a gated framing → research → ideation → convergence flow and emits **build-ready feature(s)** — `docs/features/<code>/{feature.json, design.md}` — that `compose build <code>` consumes naturally. It absorbs `compose new` (one kickoff system, not two) and routes ideation through the existing ideabox rather than a new incubation store.

## Grounding — verified codebase reality (corrects the anchor + SKILL.md)

Three parallel explorations verified the seams. The load-bearing corrections:

1. **The `plan` mode is already a registry SEED** (`lib/lifecycle-modes.js:117-138`): graph `explore_design → plan → ship`, `phaseArtifacts:['design.md','plan.md']`, `edgeEvidence:{'explore_design->plan':'design.md'}`, `runner:{artifactRoot:'docs/plans', runsTriage:false, tracksFeatureJson:false, descriptionLoader:'plan', planInputs:'plan', defaultTemplate:'new'}`. It is **unconsumed** — "Not run by any CLI command yet" (`:115`). Adding a mode is **data-only** for registry/guard/artifact-metadata/status recognition (`resolveMode` accepts any registry key, `:147-152`).
2. **A runnable `plan` still needs real code**, not just registry data: a `compose plan` verb (`bin/compose.js` has none); `typeToMode` has no `plan` case (`server/vision-routes.js:226` → a plan item silently resolves to `build`); `vision-writer.js:285,294` hardcode `type: feature|bug`; and the server-side `ArtifactManager` is `features`-rooted (`server/artifact-manager.js`) so it cannot assess plan's own `docs/plans` artifacts.
3. **`--through <phase>` and `status.md` do not exist** anywhere in the codebase (the compose SKILL.md describes them aspirationally). Resume is **Stratum-flow-state only** (keyed by `flowId`; `lib/build.js:992,1041`). The handshake **cannot** rely on them.
4. **`compose new` writes non-canon output**: it hand-authors a `ROADMAP.md` markdown table (`new.stratum.yaml:122-153`) and `design.md`-only seeds (no `feature.json`), and creates a single project-level vision item (`lib/new.js:96-97`). The canon is `feature.json` → generated `ROADMAP.md` (`lib/feature-json.js:1-7`).
5. **The vision-store planning types `idea/decision/question/thread` are schema-only** (`server/vision-store.js:10`) — no code path creates them; only `feature`/`bug` items are produced. `plan` would be their first real producer.
6. **Estimation is three disconnected mechanisms**: `feature.json.complexity` (`S|M|L|XL` in the writer `lib/feature-writer.js:60`, but `low|medium|high` in the JSDoc `lib/feature-json.js:33` — a real enum mismatch), ideabox `effort|impact|priority`, and vision `priority|confidence`. Promote **drops** ideabox sizing (`bin/compose.js:2636-2644`).
7. **The build handoff seam is the feature folder + `feature.json`**, not `active-build.json` (which `runBuild` owns). Build's genesis is always `explore_design`, which *re-produces* `design.md` (`build.stratum.yaml:244-258`); there is no template that resumes from handed-in docs. Closest precedent: `compose gsd` hard-requires a pre-existing `blueprint.md` (`bin/compose.js:2234`).

## Approaches considered

### Approach A — Minimal re-home: `plan` = `compose new` made a real mode
Wire the seed `plan` mode to a `compose plan` verb pointing at the existing `new.stratum.yaml`, fix only the canon bug (scaffold writes `feature.json` via the typed writer instead of hand-authored ROADMAP rows). Smallest diff.
- **Pro:** tiny; reuses a proven pipeline; one new verb.
- **Con:** delivers no *new* planning capability (it's `compose new` renamed). Ideation stays inside the kickoff brainstorm (violates anchor Decision 4). No estimation, no build-handshake semantics. Under-delivers an XL feature.

### Approach B — Full lifecycle: rich interactive plan mode
A new `plan.stratum.yaml` with first-class phases (frame/research/ideate/discuss/estimate/converge), the first real producer of vision-store `idea/decision/question/thread` items with a `implements`/`informs` connection graph, a unified estimation engine reconciling all three mechanisms, and interactive discussion threads.
- **Pro:** the full vision; makes the schema-only types real.
- **Con:** large new surface (new phase names → new artifact schemas + templates + gate-policy that isn't mode-aware yet); the `idea/decision/question/thread` producer + connection-graph UI is a feature in itself; high risk for a single slice. Violates ship-narrow-first.

### Approach C — Pragmatic spine **(recommended)**
A real `compose plan` lifecycle that delivers the **end-to-end spine** with the rich interior deferred:
- Keep the seed's **3-phase graph** (`explore_design → plan → ship`) — reuses existing phase names, so `design.md`/`plan.md` already exist in `ARTIFACT_SCHEMAS` and gate policy already knows these phases (zero new schema/policy work). The conceptual steps (frame → research → ideate → converge → estimate) live as **pipeline steps inside the phases**, exactly as `build` packs execute/e2e/review/sweep inside its `implement` phase.
- **Ideation routes to the existing ideabox** (anchor Decision 4), not a new store. The ideabox already has a promote-to-`feature.json` path (`bin/compose.js:2601`).
- **Estimation = a thin reconciliation**: carry ideabox `effort`/`impact` → `feature.json.complexity` on promote, and fix the `S|M|L|XL` vs `low|medium|high` enum mismatch. No new estimation engine.
- **Build-handshake = the feature folder reaching a defined state** (see below). Build consumes it naturally.
- **Defer** the rich interior (first-class vision planning items + connection graph, interactive discussion threads, provider-coupled research) to flat follow-up features.

**Recommendation: C.** It is narrow-but-real: a working `compose plan` that demonstrably hands off to `build`, absorbs `compose new`, and consolidates on canon — without paying for the schema/policy/UI surface that B's rich interior demands. A is too thin for the owner's ask; B is too broad for one slice.

## The `plan` lifecycle (Approach C, concrete)

**Mode graph (keep the seed, give it plan semantics):**

| Phase | Plan-mode meaning | Pipeline steps inside | Terminal artifact | Gate |
|---|---|---|---|---|
| `explore_design` (genesis) | Framing + research + ideation | `frame` → `research` → `ideate` (writes candidates to the ideabox) | `design.md` (the product design + chosen feature shortlist) | human gate after |
| `plan` | Convergence + estimation + build-ready spec | `converge` (pick features) → `estimate` (size each) → `spec` (write `feature.json` + per-feature `design.md`) | `plan.md` (the planning narrative) + N × promoted `feature.json` | human gate after |
| `ship` (completable) | Finalize handshake; plan lifecycle COMPLETE | `handoff` (verify each feature is build-ready) | — | — |

**Pipeline alignment (required — not a reuse of `new`).** Phase tracking keys off the raw Stratum `stepId` (`lib/build.js:1200`, `lib/new.js:127`), so the pipeline's **top-level step IDs must equal the plan phaseOrder** (`explore_design`, `plan`, `ship`) — exactly how `build.stratum.yaml`'s steps map to build phases. `new.stratum.yaml`'s steps (`research/brainstorm/roadmap/scaffold`) do **not** align, so v1 ships a **new `pipelines/plan.stratum.yaml`** with phase-named top-level steps (the frame/research/ideate/converge/estimate/spec work lives as the agent prompts *within* those steps), and flips the seed `runner.defaultTemplate` from `'new'` → `'plan'` (a data change in `lib/lifecycle-modes.js:136`). Without this, server-backed transitions are rejected (`server/vision-routes.js:345`) and direct-mode phases are unknown (`server/status-snapshot.js:79`). `compose new` is re-pointed at this pipeline (its content is absorbed into the new steps).

- **Planning workspace** = `docs/plans/<plan-slug>/` (frame/research/ideation notes + `design.md` + `plan.md`) — matches the seed `artifactRoot`. **Output** = per-chosen-feature `docs/features/<code>/{feature.json, design.md}` written via the provider-backed typed writer (`addRoadmapEntry` + `persistFeatureRaw`; see the creation path under Q2), which resolves the absolute features dir, COMP-PATHS-EXTERNAL-safe.
- **1→N is supported** (like `compose new`): one planning session can converge to several PLANNED features, each independently buildable. The "build resumes from" handshake is per-feature.
- **Gates are the interactive-discussion surface in v1** — the existing `await_gate` mechanism already supports artifact preview + agent Q&A (`lib/new.js:175-238`). No new discussion-thread system.

## Resolved open question #2 — the build-handshake artifact contract

A feature is **build-ready from plan** when `docs/features/<code>/` contains:

1. **`feature.json`** with `status:'PLANNED'`, `complexity` (S|M|L|XL), and — to make `build`'s triage a cached no-op — **both** `profile` **and** `triageTimestamp` (triage skip checks `profile` present *and* `isTriageStale()` false, which requires `triageTimestamp`; `lib/build.js:753`, `lib/triage.js:242` — `profile` alone is insufficient). Plus a provenance marker **`plannedBy: '<plan-slug>'`** and any retained ideabox metadata (`impact`).
2. **`design.md`** — the plan-approved product/feature design.

**Creation path (explicit — provider-backed two-step write).** `addRoadmapEntry` persists only a limited field set and regenerates `ROADMAP.md` (`lib/feature-writer.js:124`); the extra fields need a second write. That second write must be **provider-backed** — `persistFeatureRaw()` (`lib/feature-writer.js:327`, dispatched to the active provider, e.g. `lib/tracker/github-provider.js:149`) — **not** raw `writeFeature()` (`lib/feature-json.js:68`), which is the local-file helper and would bypass provider state/audit on non-local trackers. So the `spec` step does: (a) `addRoadmapEntry` to create the row + canon entry, then (b) a provider-backed `persistFeatureRaw` update adding `profile`/`triageTimestamp`/`plannedBy`/`impact`. (Or extend the typed writer to accept these fields directly — blueprint decides; either way the path stays provider-aware.)

**How `build` consumes it (v1 — the natural handoff):** `compose build <code>` runs normally. The handoff is **not** automatic via `loadFeatureDescription` — that returns only the first non-heading line of `design.md` (`lib/build.js:4823-4835`), which for a metadata-first doc is `**Status:** ...`, not the design. So the seam is explicit: `build`'s `explore_design` step prompt is made **`plannedBy`-aware** — when `feature.json.plannedBy` is set, the step **loads the full existing `design.md` into context** and ratifies it ("a plan-approved design exists; review and refine only if needed, else approve") rather than writing from scratch (`build.stratum.yaml:244-258`). The gate then approves fast and proceeds to `blueprint`. This needs **no new template and no genesis change** — the cost is the `plannedBy`-conditional context-load + prompt branch in the `explore_design` step. `design.md` is the interface, but the interface must be read on purpose.

**Deferred refinement (follow-up):** a structural skip — `feature.json.handoff.fromPlan:true` selecting a `build-from-plan` template whose genesis is `blueprint` (the `gsd`-reads-`blueprint.md` precedent, `bin/compose.js:2234`). Cleaner long-term, but the natural handoff ships v1 without it. **Risk to guard against:** `explore_design` must not silently overwrite the plan-authored `design.md`; the ratify prompt + `plannedBy` check is the safeguard, and the blueprint phase verifies it.

## Resolved open question #3 — phase-vocabulary consolidation

Consolidate on **`lifecycle.currentPhase` + `lifecycle.mode`** as truth (already the post-MODES state; `lib/vision-writer.js:294`). `feature.json.phase` and `VisionStore.phase` stay secondary.

**Critical: the plan session item is NOT the produced features.** This is the load-bearing identity decision:
- The **plan session** is a single **vision item** (mode=`plan`, `tracksFeatureJson:false` per the seed runner) living against `docs/plans/<plan-slug>/`. It is *not* `feature.json`-backed (mirrors `compose new`'s `ensureFeatureItem`, `lib/new.js:96-97`). The plan lifecycle's phases/gates/`phaseToStatus` act on **this** item — so when plan reaches `ship`→`complete`, only the *plan session* is marked COMPLETE.
- The plan session's **deliverables** are N separate `docs/features/<code>/feature.json` (mode=`build`, `status:PLANNED`), written at the `spec` step via the typed writer. These stay **PLANNED** so `compose build <code>` can pick them up. **The plan lifecycle must never write the produced features to COMPLETE** — doing so would block `build` (a feature already COMPLETE is not built). The plan session item links to each produced feature (e.g. `implements`/`informs`), but their statuses are independent.
- **Do not introduce a new `plan` vision item *type* in v1, but the mode must be carried through the REST create/start contract — this is a required change, not a read-side confirm.** Today `_restEnsureFeatureItem(..., 'plan')` still creates `type:'feature'` (`lib/vision-writer.js:182`) and `/lifecycle/start` derives mode via `typeToMode(item.type)` where anything non-bug → `build` (`server/vision-routes.js:225,265`). So with the server up, a plan session item is **misclassified as build** unless v1 either (a) makes `/lifecycle/start` accept an explicit `mode:'plan'` (stamped on the item and honored over `typeToMode`), or (b) routes the plan session through the **direct** vision-writer path, bypassing REST. Blueprint picks one; a first-class `plan`/`idea`/`decision` item type is a deferred follow-up (Approach B territory).
- **Status projection must be skipped for the plan session (required gate, not tolerance).** Guarded REST lifecycles call `projectFeatureStatus()` unconditionally on start/advance/complete **and kill** (`server/vision-routes.js:284,359,445,563`), and that helper always writes `feature.json` by `featureCode` (`server/lifecycle-guard.js:162`). Because the plan session is `tracksFeatureJson:false` (no `feature.json`), v1 must **gate `projectFeatureStatus` on the runner's `tracksFeatureJson` flag** and skip it for plan mode — otherwise the plan session's start/advance/complete errors or writes a stray/foreign feature row. The produced *build-target* features get their PLANNED status from the `spec` step's provider write, never from plan's projection.

## What `compose new` stops doing (absorb plan)

`compose plan` becomes the single kickoff; `compose new` is re-pointed at the `plan` lifecycle (kept as an alias for muscle memory, like `bug-fix`). Specifically the kickoff **stops**:
1. Hand-authoring `ROADMAP.md` rows (`new.stratum.yaml:122-153`) — emit `feature.json` via the typed writer (canon).
2. Scaffolding `design.md`-only folders with no `feature.json` (`new.stratum.yaml:164-182`) — not buildable canon.
3. Generating feature ideation inside the `brainstorm` step — route through the ideabox (anchor Decision 4).
4. Creating a single project-level vision item (`lib/new.js:96-97`) — let per-feature items come from `seedFeatures` over the promoted `feature.json`s.
5. In-place YAML mutation for skip/review customization (`lib/new.js:68-78`) — fold into `plan`'s mode config.

## Estimation reconciliation (thin, v1)

- On ideabox-promote and on plan's `estimate` step, carry `effort`(S|M|L) → `feature.json.complexity`, and surface `impact` as a `feature.json` field (or ideabox linkage) rather than dropping it (`bin/compose.js:2636-2644`).
- **Fix the enum mismatch**: settle `complexity` on `S|M|L|XL` (the writer's enforced set, `lib/feature-writer.js:60`) and correct the JSDoc (`lib/feature-json.js:33`). No new sizing UI.

## Unproven assumptions / spikes (gate checkpoint)

1. **Server-side `ArtifactManager` root resolution.** It is `features`-rooted and cannot assess plan's `docs/plans` artifacts (a deferred MODES follow-up, `COMP-ROADMAP-MODES/report.md:53`). **v1 mitigation:** drive plan's gates off the Stratum pipeline's `ensure: file_exists(...)` against `docs/plans` paths (the `new.stratum.yaml` model), **not** the server-side ArtifactManager. Spike: confirm the guard/`projectFeatureStatus` path tolerates a `docs/plans`-rooted plan item without the server-side assess.
2. **Gate policy is not mode-aware** (`SETTINGS_DEFAULTS` knows build phases only, `vision-server.js:42`). v1 reuses the `explore_design`/`plan`/`ship` phase names, which *are* known — so this is sidestepped, not solved. Confirm no plan-specific gate default is needed for v1.
3. **`plan` item → mode resolution via the server path** (now a confirmed required change, see Q3 above): `/lifecycle/start` must honor an explicit `mode:'plan'` over `typeToMode`, or the plan session must use the direct vision-writer path. Blueprint resolves which; the runner reads `lifecycle.mode` once the item is correctly stamped.

## Explicitly deferred (flat follow-up features)

- First-class vision planning items (`idea/decision/question/thread`) + the `implements`/`informs` connection graph as a real producer (Approach B interior).
- Interactive discussion threads beyond the existing gate Q&A.
- Provider-coupled planning (Linear/JIRA import, Notion push) — anchor reserves these for COMP-ROADMAP-PROVIDERS.
- The structural `build-from-plan` skip-to-blueprint template (natural handoff ships v1).
- Server-side `ArtifactManager` mode-owned root resolution (shared with MODES follow-ups).

## Acceptance criteria (Phase 1 design gate)

- [ ] Approach selected (C) with the 3-phase mode graph and plan-mode semantics documented.
- [ ] Build-handshake artifact contract is concrete (feature.json fields + design.md + the natural-handoff consume path).
- [ ] Phase-vocabulary consolidation decided (lifecycle.currentPhase/mode; no new item type in v1).
- [ ] `compose new` absorption plan enumerated (the 5 "stops").
- [ ] Spikes/unproven assumptions listed for blueprint to resolve (ArtifactManager root, gate-policy, mode resolution).
- [ ] Deferred follow-ups carved out so v1 is narrow-but-real.
