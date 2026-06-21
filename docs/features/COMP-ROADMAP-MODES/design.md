# COMP-ROADMAP-MODES — Mode-Generalize the Lifecycle Data (keystone)

**Status:** DESIGN (Phase 1)
**Date:** 2026-06-21
**Feature:** COMP-ROADMAP-MODES (umbrella: COMP-ROADMAP)
**Complexity:** L

## Related Documents

- Epic anchor: `docs/plans/2026-06-21-roadmap-planning-model-design.md` (Decision 1 — `plan` lifecycle within compose; MODES is the keystone).
- Unblocks: COMP-ROADMAP-PLAN (the `plan` lifecycle v1), and downstream COMP-ROADMAP-PROVIDERS (the same generalization makes the ports pluggable).
- Prior art consumed: COMP-ROADMAP-GRAPH-2 (vision-store canonical projection), the tracker-provider layer (`lib/tracker/`), the `compose new` kickoff (`lib/new.js` + `pipelines/new.stratum.yaml`).

## Problem

Compose has exactly one lifecycle graph — the **build** graph — hard-coded into the lifecycle machinery. The runner pretends to have two modes (feature vs bug) but that branch only swaps *paths and the Stratum template*; the lifecycle **data** (the phase graph, the gate policy, the phase→status projection, the per-phase artifact maps) has **zero mode awareness**. To make `plan` a third lifecycle peer (the epic keystone), that data must become **mode-scoped** — keyed by `build | fix | plan` — with `build` reproducing today's behavior exactly. This same generalization is what later lets a provider back a surface (PROVIDERS), so MODES unblocks two downstream features at once.

A second, entangled problem surfaced during exploration: there are **five-plus competing "phase" vocabularies** in the codebase, and `lifecycle.currentPhase` is currently written as free-form pipeline step IDs. A mode-scoped graph cannot validate free-form values, so a bounded vocabulary-convergence is a prerequisite, not an optional extra.

## Current state (explorer-verified, 2026-06-21)

All line numbers below were verified against disk; where they differ from the epic anchor's citations, the anchor was stale.

### A. The build-locked lifecycle data

| Structure | Location | What's build-locked |
|---|---|---|
| `BASE_TRANSITIONS` | `server/lifecycle-guard.js:31` | The forward phase adjacency map (`explore_design → … → ship`). One flat const, no mode dimension. |
| `SKIPPABLE` / `TERMINAL` | `server/lifecycle-guard.js:45` | Skippable set `{prd,architecture,report}` and terminal set `{complete,killed}`. Build-only. |
| `buildPhaseGraph(transitions = BASE_TRANSITIONS)` | `server/lifecycle-guard.js:57` | Assembler. **Already takes a `transitions` arg** (the seam), but every caller passes none. Bakes in the universal `ship→complete` and `*→killed` edges. |
| `edgePredicates(featureRelDir)` | `server/lifecycle-guard.js:89` | Per-edge evidence: `explore_design→blueprint` needs `design.md`, `blueprint→verification` needs `blueprint.md`, `plan→execute` needs `plan.md`. Build edge names, no mode. |
| `phaseToStatus(phase)` | `server/lifecycle-guard.js:124` | **The real phase→status projection** (anchor's `vision-server.js:42` cite was stale). `complete→COMPLETE`, `killed→KILLED`, else `IN_PROGRESS`. |
| `resourceId(featureCode, workspaceRoot)` | `server/lifecycle-guard.js:108` | Guard id `compose:<sha256(root)[:12]>:<featureCode>`. **No mode component** → two modes on one feature collide on one ledger. |
| `ensureGuard(...)` | `server/lifecycle-guard.js:262` | The single chokepoint that registers `buildPhaseGraph()` + `edgePredicates(...)` with no mode argument. |
| `PHASE_ARTIFACTS` | `server/artifact-manager.js:13` | Phase→filename map (6 build phases). Anchor's `:12` was one line off. Stale "derived from contracts/lifecycle.json" comment — **that file no longer exists**. |
| `ARTIFACT_SCHEMAS` | `server/artifact-manager.js:29` | Per-file validation schema. **Startup invariant (`:66`) hard-throws** unless its keys === `PHASE_ARTIFACTS` values — the two maps are welded. |
| `ArtifactManager.assess()` | `server/artifact-manager.js:153` | Iterates *all* `ARTIFACT_SCHEMAS` keys → every feature assessed against all 6 build artifacts. Instantiated mode-blind at `vision-routes.js:759` and `compose-mcp-tools.js:754`. |
| `SETTINGS_DEFAULTS.phases` | `server/vision-server.js:42` | Phase→default gate policy (gate/flag/skip). Build phase list; note it lists `plan` as a *phase*. |
| `evaluatePolicy()` | `server/policy-evaluator.js:23` | Gate-policy lookup keyed by phase only (`settings.policies[phase]`). The returned `mode` here is the *gate* axis (gate/flag/skip) — a different axis from the lifecycle mode. |
| Runner mode coercion | `lib/build.js:634` | `const mode = opts.mode === 'bug' ? 'bug' : 'feature'` — binary; a third value collapses to `feature`. ~15 `isBugMode` sites + ~6 `context.mode==='bug'` sites downstream. |
| `startFresh` planInputs | `lib/build.js:4632` | 2-way ternary building the Stratum plan envelope. |
| CLI fix dispatch | `bin/compose.js:2221` | The only non-default pair: `{template:'bug-fix', mode:'bug'}`. |
| `compose new` | `lib/new.js:111` (`runNew`) | A **wholly separate runner** with its own dispatch loop, gate handling, validate-stripping, questionnaire, `--from-idea`. Does *not* go through `runBuild`. |

### B. The split phase vocabularies

| # | Vocabulary | Source | Values |
|---|---|---|---|
| A | `VisionStore.phase` (board taxonomy) | `server/vision-store.js:13` `VALID_PHASES` | `vision, specification, planning, implementation, verification, release` |
| B | `lifecycle.currentPhase` (lifecycle) | written raw in `lib/vision-writer.js:300`, `lib/build.js:1186` | the loaded pipeline's step IDs (`explore_design…ship`; `diagnose/fix` for bug; `child:step` composites) |
| C | `inferPhase` (scan) | `server/feature-scan.js:103` | returns **board taxonomy** from on-disk artifacts; feeds A |
| D | `PHASE_ORDER` (staleness) | `lib/staleness.js:15` | `explore_design, blueprint, plan, build, done` — uses `build`/`done` nothing else emits |
| E | `feature.json.phase` (roadmap heading) | `lib/checkpoint/checkpoint-writer.js:41` | the ROADMAP section title string |

`feature-validator.js:484` (`CONTRADICTORY_PHASE_CLAIM`) already documents the A-vs-B split and is currently **dormant** (feature.json carries no `lifecycle.currentPhase` yet). `feature-scan.js:497/504` sets A and B to *different* vocabularies in the same loop iteration — the divergence is baked in at item creation.

## Design

### Core: a mode-keyed lifecycle registry as the single source of truth

Introduce one module — **`lib/lifecycle-modes.js`** — that exports `LIFECYCLE_MODES`, a table keyed by `build | fix | plan`. `lib/` (not `server/`) so both the server layer (`server/lifecycle-guard.js`, `server/artifact-manager.js`, `server/vision-routes.js`) and the lib layer (`lib/build.js`, `lib/staleness.js`) import it without a layer inversion. It becomes the new source of truth that the dead `contracts/lifecycle.json` comment used to point at.

```js
// lib/lifecycle-modes.js  (shape — finalized in blueprint)
export const LIFECYCLE_MODES = {
  build: {
    transitions: { explore_design: ['prd','architecture','blueprint'], /* …verbatim BASE_TRANSITIONS… */ },
    skippable:   ['prd','architecture','report'],
    terminal:    ['complete','killed'],
    genesis:     'explore_design',          // start node
    shipPhase:   'ship',                     // phase that may → complete
    phaseArtifacts: { explore_design:'design.md', prd:'prd.md', /* … */ },
    artifactSchemas: { 'design.md': {…}, /* … */ },
    edgeEvidence: { 'explore_design->blueprint': ['design.md'], /* … */ },
    statusProjection: { complete:'COMPLETE', killed:'KILLED', '*':'IN_PROGRESS' },
    phaseOrder:  ['explore_design','prd','architecture','blueprint','verification','plan','execute','report','docs','ship'],
  },
  fix:  { /* diagnose → fix → … → ship; data parity for the existing bug flow (see Scope) */ },
  plan: { /* minimal seed graph — COMP-ROADMAP-PLAN refines (see Scope) */ },
};
```

The `build` entry holds **today's data verbatim**. This is the non-negotiable invariant: with `mode='build'` every consumer must behave byte-identically to today, proven by golden tests. The `fix` and `plan` entries are present for registry completeness and forward use; **MODES does not change how bug items are assessed or projected today** (today's bug flow registers no guard and its artifact assessment is degenerate — MODES preserves that exactly; the `fix` entry is exercised only by the registry-level tests, not wired into the live bug path).

**Back-compat exports.** `lifecycle-guard.js` keeps exporting `BASE_TRANSITIONS`, `SKIPPABLE`, `TERMINAL`, `buildPhaseGraph`, `edgePredicates`, `phaseToStatus` — but now as thin shims resolving to `LIFECYCLE_MODES.build`. External importers (`vision-routes.js:53`, `status-snapshot.js`, etc.) keep working unchanged; new code uses the mode-aware accessors. This makes the refactor strictly additive at the module boundary.

### Threading `mode` through the seams

1. **Guard** (`lifecycle-guard.js`): add `mode` params to `resourceId`, `ensureGuard`, `guardedTransition`, `edgePredicates`; `buildPhaseGraph` is called with `LIFECYCLE_MODES[mode]`. The graph assembler reads `genesis`/`shipPhase`/`terminal` from the mode entry rather than baking them in, so a non-`ship`-terminating `plan` graph is expressible.

2. **`resourceId` migration sidestep (key decision):** `resourceId(fc, root, mode='build')` returns the **unchanged** `compose:<hash>:<fc>` when `mode==='build'`, and the namespaced `compose:<hash>:<mode>:<fc>` otherwise. Existing build guards keep their exact id → **zero migration, zero orphaning** for in-flight build lifecycles; new modes get their own namespace.

3. **Mode is stamped at creation; read-time default `build` is a legacy-only fallback (key decision, corrected after gate):** the lifecycle object gains a `mode` field, written at the **item-creation seam** where lifecycles are born — `lib/vision-writer.js` `_restEnsureFeatureItem` (`:167`) and `_directEnsureFeatureItem` (`:256`), both of which **already receive a `mode` argument** (today used only to set the item `type`). Stamping `lifecycle.mode` there covers every newly created item of every mode. Resolvers read `lifecycle.mode ?? 'build'`, where the `?? 'build'` is purely a **legacy fallback** for pre-existing items — all of which are build — so no write migration is required. *Correction vs the first draft:* `/lifecycle/start` (`vision-routes.js:246`) is the **wrong** anchor — it accepts only `featureCode` and refuses items that already have a lifecycle. Creation is the right seam; a new non-build item must be stamped there or it would silently misread as `build` and run the wrong graph.

4. **Artifact manager** (`artifact-manager.js`): constructor takes `mode` (or resolves the item's lifecycle kind); `assess()`/`scaffold()` iterate `LIFECYCLE_MODES[mode].phaseArtifacts` instead of all schemas. The startup invariant becomes **per-mode** (each mode's `artifactSchemas` keys === its `phaseArtifacts` values). Both call sites (`vision-routes.js:759`, `compose-mcp-tools.js:754`) resolve mode first. **Caveat (gate finding):** the artifact *root* stays `features`-rooted in v1 — both call sites instantiate against `featuresPath`/`resolveProjectPath('features')` while the bug flow writes under `docs/bugs/<code>` (`build.js:661`, ships from that root `:2478`). Mode-keying the artifact *metadata* (which docs a mode expects) does **not** by itself make `fix`/`plan` real artifact peers; that additionally requires the mode descriptor to own **root resolution**, which is deferred (see Scope). v1 mode-keys metadata only and asserts bug-item assessment is unchanged.

5. **Route layer** (`vision-routes.js`): replace `const TRANSITIONS = BASE_TRANSITIONS` (`:219`) with a per-item-mode lookup; `advance`/`skip`/`kill`/`complete` resolve the item's mode graph. The `complete` handler's hard-coded `!== 'ship'` gate (`:452`) and `start`'s hard-coded `'explore_design'` genesis (`:256`) become `mode.shipPhase` / `mode.genesis`. The guard graph stays a **superset** of route legality per mode (the existing invariant, now per-mode).

6. **Runner** (`lib/build.js`): replace the binary coercion (`:634`) with a validated 3-value mode. The refactor is **surgical, not wholesale**: only the `!isBugMode` sites that *fall through to feature behavior* (triage `:739`, feature.json writes `:882`, itemDir `:661`, description loader `:836`, planInputs `:4632`) are lifted into a small `MODE_CONFIG` descriptor (`itemDir`, `runsTriage`, `writesFeatureJson`, `descriptionLoader`, `planInputs`, `defaultTemplate`, `flowName`) so a third mode never inherits feature behavior by accident. The genuinely bug-*specific* `mode==='fix'` checks (e.g. `loadBugDescription`, bug audit dir) stay as-is — they're already correct for build/fix and plan won't reach them. `build`/`fix` entries reproduce today's behavior exactly; `plan` is a data-add. **No user-facing `compose plan` CLI command in MODES** — `runBuild` merely *accepts and threads* `mode:'plan'`; the `compose plan` command and its runner behavior are COMP-ROADMAP-PLAN's deliverable. MODES proves the threading with a test, not a hollow command.

7. **Gate policy** (`policy-evaluator.js`): make the lookup mode-aware (`settings.policies[mode]?.[phase] ?? settings.policies[phase]`) with the flat form as fallback, so existing configs are unaffected and a mode can set its own defaults.

### Bounded vocabulary convergence (the prerequisite cleanup)

In scope (**read-side lifecycle-phase consumers only — the write path is deliberately untouched**, per gate finding):
- `lifecycle.currentPhase` is declared the **single lifecycle-phase READ truth**, and its legal values per mode are the registry's `phaseOrder`.
- Converge the divergent *lifecycle* orderings onto the registry: `staleness.js:15 PHASE_ORDER` derives from `LIFECYCLE_MODES[mode].phaseOrder`; `status-snapshot.js` `KNOWN_PHASES` likewise. The `build`/`done` aliases disappear.
- Make these readers **robust to unknown/composite values**: child-flow composites (`child:step`, `lib/new.js:331`) and `ship_gate`-style values that aren't graph nodes are handled gracefully (treated as not-yet-ordered, matching today's `indexOf === -1`, but now documented and intentional rather than accidental).
- **Do NOT rewrite `updateItemPhase`'s write behavior.** That writer is shared with the deferred `compose new` (`lib/new.js:127, :331`) and is itself non-uniform — the REST path swallows invalid transitions (`vision-writer.js:205`), the direct path raw-writes step IDs (`:300`). Normalizing *what gets written* would entangle MODES with `compose new` and a writer-unification refactor. Splitting lifecycle-phase updates from generic step-progress updates is filed as its own follow-up (`COMP-ROADMAP-MODES-WRITER` — a prerequisite PLAN may pull in), **not** MODES.

Explicitly **deferred** (UI-coupled, separable):
- Retiring the `VisionStore.phase` board taxonomy (vocabulary A) and re-vocabularying `inferPhase` (C). These feed the **ideabox board grouping** (`vision-routes.js:1083`, `compose-mcp-tools.js:174/229`) — a UI concern. MODES leaves A/C as a *projection* surface and does not change their values. Filed as a follow-up (`COMP-ROADMAP-MODES-VOCAB` or folded into PLAN).

## Scope

**In scope (MODES v1):**
- [ ] `lib/lifecycle-modes.js` registry with `build` (verbatim), `fix` (data parity), `plan` (seed).
- [ ] Mode threaded through guard, artifact manager, route layer, runner, gate policy.
- [ ] `resourceId` byte-identical for build; read-time `mode ?? 'build'` default (no write migration).
- [ ] Lifecycle object persists `mode`, stamped at the creation seam (`_restEnsureFeatureItem`/`_directEnsureFeatureItem`); read-time `?? 'build'` legacy fallback.
- [ ] Runner `MODE_CONFIG` replacing the fall-through-dangerous binary ternaries; `runBuild` accepts+threads `mode:'plan'` (no user-facing CLI command).
- [ ] Bounded vocabulary convergence (lifecycle-phase consumers).
- [ ] Golden tests proving `build` and `fix` behavior is byte-identical; a test proving a 4th mode is a data-only add.

**Deferred (not MODES):**
- The full `plan` lifecycle behavior, `compose plan` UX, absorbing `compose new` → **COMP-ROADMAP-PLAN**.
- Giving `fix` a *registered guard graph* (today the bug flow registers no guard — keeping it unguarded is the no-regression choice; the `fix` registry entry is used for status/artifact projection only).
- Retiring the board taxonomy / re-vocabularying `inferPhase` (UI follow-up).
- Provider/port pluggability (**COMP-ROADMAP-PROVIDERS**).
- Backfill migration stamping `mode` onto legacy lifecycle objects (read-time default covers v1; legacy items are all build).
- **Mode-owned artifact root resolution** (so a non-build mode's docs live under its own root). v1 keeps the `features`-rooted `ArtifactManager`; `fix`/`plan` artifact metadata is registry data only. The consuming feature wires root resolution (PLAN for `plan`; a fix follow-up for `fix`).
- **Writer unification** (`updateItemPhase` write-side normalization / splitting lifecycle-phase from step-progress updates) → `COMP-ROADMAP-MODES-WRITER` follow-up.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `build` behavior regresses | Back-compat shim exports + `resourceId` unchanged for build + golden tests asserting byte-identical build/fix flows. |
| Guard graph / route legality drift per mode | Keep the superset invariant **per mode**; a unit test asserts every route-legal edge exists in that mode's guard graph. |
| Startup invariant crash when maps split | Make the `ARTIFACT_SCHEMAS===PHASE_ARTIFACTS` invariant per-mode; test it for all three modes at import. |
| `plan` token overload (already a build *phase* name) | The registry keys are modes; the `plan` *phase* lives only inside the build mode's graph. Document the two axes; lint for accidental cross-use. |
| ~15 `isBugMode` sites fall through to feature behavior for a 3rd mode | Lift into `MODE_CONFIG`; `build`/`fix` entries byte-identical; no silent fall-through (explicit per-mode values). |
| Legacy `currentPhase` free-form values rejected by a stricter graph | v1 does **not** validate `currentPhase` against the graph for legacy items; read-time `mode ?? 'build'` + unchanged build graph keeps them valid. Composite normalization is additive. |
| Dormant `CONTRADICTORY_PHASE_CLAIM` validator wakes up | MODES does **not** start writing `lifecycle.currentPhase` into `feature.json`, so the validator stays dormant. |

## Implementation slices (preview for blueprint/plan)

1. **S1 — Registry module.** `lib/lifecycle-modes.js` with the three mode entries; `build` extracted verbatim from current consts. Pure data + accessors. Unit tests: per-mode invariant, build-entry equals legacy consts.
2. **S2 — Guard mode-threading.** `resourceId`/`ensureGuard`/`buildPhaseGraph`/`edgePredicates`/`phaseToStatus` take `mode`; back-compat shims. Build path byte-identical.
3. **S3 — Artifact manager mode-scoping.** Constructor mode; per-mode invariant; both call sites resolve mode.
4. **S4 — Route layer + mode persistence.** Stamp `lifecycle.mode` at the creation seam (`_restEnsureFeatureItem`/`_directEnsureFeatureItem`); per-item-mode legality in advance/skip/kill/complete; `genesis`/`shipPhase` resolved from the registry. (Not `/lifecycle/start` — see Design §3.)
5. **S5 — Runner `MODE_CONFIG`.** Lift the fall-through-dangerous binaries; validated 3-value mode; `runBuild` threads `mode:'plan'`. No CLI command (PLAN owns it).
6. **S6 — Vocabulary convergence (read-side only).** Converge `staleness`/`status-snapshot` orderings onto the registry; make readers robust to unknown/composite `currentPhase` values. No write-path changes.
7. **S7 — Golden tests + 4th-mode proof.** End-to-end build + fix unchanged; a throwaway `demo` mode added as data only, exercised, removed.

(Topology: S2–S4 depend on S1; S5 depends on S1; S6 depends on S1; S7 depends on all.)

## Open questions (for the gate)

1. **`fix` registry entry — data parity only, or wire its guard?** Recommendation: data-parity only in v1 (no new gating), to hold the no-regression line. Revisit when PLAN lands.
2. **`plan` seed graph shape.** A minimal `explore_design → plan → ship/complete`, or richer? Recommendation: minimal seed clearly marked "PLAN refines," sufficient for the 4th-mode proof, not a commitment.
3. **Vocabulary convergence depth.** Confirm deferring the board-taxonomy retirement (A/C) is acceptable for the keystone, or whether PLAN needs it converged first. Recommendation: defer — the board feeds ideabox UI, orthogonal to lifecycle generalization.
