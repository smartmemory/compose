# COMP-TRIAGE-5 — Implementation Blueprint

Design: `docs/features/COMP-TRIAGE-5/design.md`. All file:line refs below verified against current code (Phase-4 seam research). Corrections from the design's assumed anchors are in the table.

## Corrections table (design assumption → reality)

| Design said | Reality | Correction |
|---|---|---|
| doc-reading is in `deriveProfile` (`triage.js:194`) | `deriveProfile` (`lib/triage.js:105`) is **pure** (takes precomputed `signals`). Doc-reading is in **`runTriage`** — candidate list `lib/triage.js:194`, read loop `:198-208` | Demote **`runTriage`** to refinement, not `deriveProfile`. |
| front-seam call at `lib/build.js:963` | `:963` is the triage block comment; gate `if (cfg.runsTriage && !opts.skipTriage && !opts.template)` at `:973`; actual call `runTriage(featureCode,{cwd,featuresDir})` at **`lib/build.js:983`**, before spec load (`:1017`) | Front seam = block `:963-1012`; invocation is `:983`. |
| complexity bug at `:997,1006` | CONFIRMED: `complexity: String(triageResult.tier)` at `lib/build.js:997` (createFeature) and `:1006` (putFeature); both write via `_buildProvider` directly, bypassing the `COMPLEXITIES` guard | Fix #1 stands. Same object also writes `profile` + `triageTimestamp`. |
| skip_if toggling `:1045-1075` | CONFIRMED: gate `:1045`, skippable `['prd','architecture','verification','report']` `:1053`, per-step `needs_${id}` → toggle `skip_if` `:1054-1066` | Reuse unchanged. |
| COMPLEXITIES enforced in feature-writer `:107-149` | `COMPLEXITIES = new Set(['S','M','L','XL'])` at `lib/feature-writer.js:60`; enforced **only** in `addRoadmapEntry` `:130-132` | Triage write never calls `addRoadmapEntry` → guard out of loop. Validate on the build write path. |
| phase source `server/compose-mcp-tools.js:836` | CONFIRMED live source, but it's a **server** module. Lib-native reader = `VisionWriter.findFeatureItem(code)` (`lib/vision-writer.js:389`) → `.lifecycle.currentPhase` | Use `VisionWriter.findFeatureItem` in `escalation.js` — no layer inversion. |
| fix `runsTriage` at `:103` | `lib/lifecycle-modes.js:104` (build `:66`, plan `:133`) | Off-by-one; v1 build-only wiring accurate. |
| gate signal for escalation exists | **Gap.** See Integration Gaps. | Escalation observer must be built. |

## Integration gaps (resolved in this blueprint)

1. **No escalation-trigger seam exists.** The three gate signals are computed but none triggers re-entry today. Resolution: add an escalation observer with **two trigger points** (below).
2. **Test gate is ship-time + advisory.** `deriveTestsPass` (`lib/test-bootstrap.js:561`) runs inside `executeShipStep` as local `testsPass` (`lib/build.js:2883`), surfaced only as the `tests_pass` attestation (`:3072`) and `test_count`/`pass_rate` envelope (`:3104`) — never as a blocking boolean. Resolution: surface a normalized `{gate:'test', passed}` from the ship-time summary and feed escalation. State plainly: the test-signal escalation fires end-of-pipeline.
3. **Review verdict IS observable (not a gap).** Normalized `clean` boolean (`contracts/review-result.json:11`) is reachable as `childResult.output.clean` (`lib/build.js:2174,2180`) and `synthesis.clean` (`:3335`). This is the mid-pipeline trigger.
4. **complexity bypass is real** (`contracts/feature-json.schema.json:25-31` permits `{S,M,L,XL}`-string OR number; the persisted `"0".."4"` string satisfies neither yet persists). Fix on the build write path.

## Component design

### C1 — `estimateScope(request, repoSignals)` — `lib/triage.js` (new export)

- Doc-free. Reuses module-privates: `extractFilePaths` (`:63`), `countTasks` (`:83`), `anyMatch` (`:95`), `SECURITY_PATTERNS` (`:33-44`), `CORE_PATTERNS` (`:46-54`). No new imports.
- Computes `signals` from `request` text + `repoSignals` (plausibly-touched file paths) **without** reading design/plan/blueprint.
- Returns `{tier, profile, lane, confidence, rationale}`.
  - `tier` (0–4) and `profile` via the same `deriveProfile(signals)` logic (`:105`) — reuse, do not fork.
  - `lane` mapped from tier: `0–1 → trivial`, `2 → standard`, `3–4 → complex`. Security/core hit forces min `standard`.
  - `confidence` ∈ `high|medium|low` from signal strength: explicit file paths + unambiguous verb → high; no paths / vague verb → low.
  - **Safety rule:** `confidence === 'low'` clamps `lane` up to at least `standard` (never `trivial`). Under-scoping is the only dangerous error.
- `runTriage` (`:188`) retained as the doc-reading **refinement** pass; may only **narrow** the lane (assert `refinedTier >= frontTier` or keep front). Widening is escalation's job only.

### C2 — Front-seam wiring — `lib/build.js` (~`:963-1012`)

- Before the existing `runTriage` call (`:983`), call `estimateScope(description, repoSignals)` so the lane is set **before** genesis phase (`explore_design`).
- Feed resulting `profile` into the existing skip_if toggling (`:1045-1066`) unchanged.
- Persist `{triageTier, lane, estimateSource:'front', complexity: tierToComplexity(tier), profile, triageTimestamp}` through the validated writer (C4), not the raw string.
- The later `runTriage` refinement (once docs exist) updates `estimateSource:'refined'`, narrow-only.

### C3 — `lib/escalation.js` (new module)

- `escalate(normalizedGate, currentLane, escalationCount)` where `normalizedGate = {gate:'review'|'test', passed:boolean}`.
- Ladder: `trivial → standard → complex`. On a failed gate, return `{nextLane, reEntryPhase}`; un-skip the phases the lower lane skipped; set `reEntryPhase` to the earliest un-skipped phase (design/blueprint).
- `reEntryPhase` derived from current phase via `VisionWriter.findFeatureItem(code).lifecycle.currentPhase` (`lib/vision-writer.js:389`).
- **Bound:** `escalationCount >= 2` → return `STOP` (human handoff). Ties to `idea_budget_ceilings`; prevents the DeepSWE retry-loop blowup.
- Pure decision function (no I/O) so it is unit-testable in isolation; the runBuild loop performs the un-skip + re-entry side effects.

### C4 — Validated feature-record writes — `lib/feature-writer.js` + `contracts/feature-json.schema.json`

- New fields: `lane` (`trivial|standard|complex`), `triageTier` (integer 0–4), `estimateSource` (`front|refined|escalated`).
- Add to: JSDoc (`:114-117`), type-validation block (`:138-149`), field assignment (`:179-182`), and `contracts/feature-json.schema.json:25-31` (add keys).
- Extract the `COMPLEXITIES`/field validation into a shared helper callable from **both** `addRoadmapEntry` and the `lib/build.js` triage write path (`:983-1010`), closing the bypass.
- `tierToComplexity(tier)`: `0–1→S, 2→M, 3→L, 4→XL`, written through the guard. Raw tier goes to `triageTier`.

### C5 — Escalation observer — `lib/build.js` runBuild loop

- **Review trigger (mid-pipeline, Phase 7):** when the review loop exhausts its cap without `clean` (observe `childResult.output.clean` `:2174,2180` / `synthesis.clean` `:3335`), emit `{gate:'review', passed:false}` → `escalate(...)`.
- **Test trigger (ship, Phase 10):** surface `deriveTestsPass(parseTestSummary(...))` (`lib/test-bootstrap.js:561/536`, computed at `lib/build.js:2883`) as `{gate:'test', passed}` → `escalate(...)`.
- On `{nextLane, reEntryPhase}`: set `estimateSource:'escalated'`, un-skip, re-enter. On `STOP`: write checkpoint + surface to human (reuse the bug-mode checkpoint pattern where practical).

## File Plan

| File | Action | Notes |
|---|---|---|
| `lib/triage.js` | edit | add `estimateScope`, `tierToComplexity`; demote `runTriage`/`deriveProfile` to narrow-only refinement |
| `lib/feature-writer.js` | edit | add `lane`/`triageTier`/`estimateSource` fields + shared `validateFeatureFields` |
| `lib/escalation.js` | new | `escalate` bounded ladder decision function |
| `lib/build.js` | edit | front-seam call ~`:983`; validated write (close complexity bypass); escalation observer (review `.clean` + ship test signal) |
| `contracts/feature-json.schema.json` | edit | add `lane`/`triageTier`/`estimateSource` keys |
| `test/estimate-scope.test.js` | new | S01 front-estimator tests |
| `test/feature-fields.test.js` | new | S02 contract test (complexity bypass regression) |
| `test/escalation.test.js` | new | S03 ladder + bound tests |
| `test/triage-front-golden.test.js` | new | S04 lean-path golden |
| `test/triage-escalation-golden.test.js` | new | S04 escalation golden |

## Boundary Map

### S01: front estimator primitives
Produces:
  lib/triage.js → estimateScope, tierToComplexity (function)

Consumes: nothing (leaf node)

### S02: validated feature-record fields
Produces:
  lib/feature-writer.js → validateFeatureFields (function)

Consumes:
  from S01: lib/triage.js → tierToComplexity

### S03: escalation decision
Produces:
  lib/escalation.js → escalate (function)

Consumes: nothing (leaf node)

Wiring (S04, prose — no new symbols): `lib/build.js` calls `estimateScope` + `tierToComplexity` (S01) at the front seam, persists through `validateFeatureFields` (S02), and invokes `escalate` (S03) from the review/ship gate observer. The `{gate, passed}` signal shape, the ship-time-vs-mid-pipeline trigger timing, and the narrow-only refinement invariant are prose invariants, not Boundary Map entries.

## Slice order

- **S01:** `estimateScope` + `tierToComplexity` + lane/confidence + safety clamp (pure, `lib/triage.js`). Tests first.
- **S02:** feature.json new fields + shared `validateFeatureFields` + schema; fix the complexity bypass. Contract test.
- **S03:** `lib/escalation.js` pure decision function + bounded ladder. Unit tests.
- **S04:** front-seam wiring (`build.js:983`) + escalation observer (review + ship). Golden + escalation-golden tests.

Topology holds: only `from S##` reference is S02→S01 (earlier slice); S01, S03 are leaves.

## Test plan (node:test, `test/`, house style per `test/triage.test.js`)

- `test/estimate-scope.test.js` — front-seam: one-line edit → trivial lane, skips derived; low-confidence → standard clamp; security path → ≥ standard.
- `test/feature-fields.test.js` — contract: `complexity` never written outside `{S,M,L,XL}`; `triageTier` integer; regression for the `:997/:1006` bypass.
- `test/escalation.test.js` — ladder trivial→standard→complex; bound at 2 → STOP; re-entry phase from vision item.
- `test/triage-front-golden.test.js` — golden: lean path skips design/blueprint, records files-inspected count << full lane.
- `test/triage-escalation-golden.test.js` — **load-bearing:** looks-trivial-but-fails-test → auto-escalate → heavy phases run → pass.
