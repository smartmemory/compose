# COMP-TRIAGE-5 — Implementation Plan

Blueprint: `docs/features/COMP-TRIAGE-5/blueprint.md` (Phase-5 verified, boundary map clean). TDD per slice — write the failing test first, watch it fail, implement, watch it pass. Runner: `node --test`.

## S01 — Front estimator primitives (`lib/triage.js`)

- [ ] `test/estimate-scope.test.js` (new): one-line edit request → `lane: 'trivial'`; low-confidence/ambiguous → clamps to `standard`; security/core path → ≥ `standard`. Fails first.
- [ ] `estimateScope(request, repoSignals)` (new export): doc-free; reuse `extractFilePaths`/`countTasks`/`anyMatch`/`SECURITY_PATTERNS`/`CORE_PATTERNS`; return `{tier, profile, lane, confidence, rationale}` via existing `deriveProfile` for tier/profile.
- [ ] `tierToComplexity(tier)` (new export): `0–1→S, 2→M, 3→L, 4→XL`.
- [ ] Safety clamp: `confidence === 'low'` ⇒ `lane` ≥ `standard`.
- [ ] `runTriage` refinement is narrow-only (never widens the front lane).
- **Gate:** `node --test test/estimate-scope.test.js` green.

## S02 — Validated feature-record fields (`lib/feature-writer.js`, `contracts/feature-json.schema.json`)

- [ ] `test/feature-fields.test.js` (new): `complexity` never persists outside `{S,M,L,XL}`; `triageTier` integer; regression asserting the old `String(tier)` bypass no longer reaches disk. Fails first.
- [ ] Add `lane`/`triageTier`/`estimateSource` to JSDoc (`:114-117`), validation (`:138-149`), assignment (`:179-182`).
- [ ] Extract `validateFeatureFields` shared helper; call it from both `addRoadmapEntry` and the build write path.
- [ ] Add the three keys to `contracts/feature-json.schema.json` (`:25-31` area).
- **Gate:** `node --test test/feature-fields.test.js` green.

## S03 — Escalation decision (`lib/escalation.js`)

- [ ] `test/escalation.test.js` (new): ladder `trivial→standard→complex`; `escalationCount >= 2` ⇒ `STOP`; re-entry phase resolved from a stubbed vision item. Fails first.
- [ ] `escalate(normalizedGate, currentLane, escalationCount)`: pure decision fn, returns `{nextLane, reEntryPhase}` or `STOP`; no I/O.
- **Gate:** `node --test test/escalation.test.js` green.

## S04 — Wiring + observer (`lib/build.js`)

- [ ] `test/triage-front-golden.test.js` (new): lean path skips design/blueprint, records files-inspected count << full lane. Fails first.
- [ ] `test/triage-escalation-golden.test.js` (new, load-bearing): looks-trivial-but-fails-test → auto-escalate → heavy phases run → pass. Fails first.
- [ ] Front-seam: call `estimateScope` before spec load (~`:983`); set lane before genesis; feed existing skip_if.
- [ ] Persist via `validateFeatureFields` (close the `:997/:1006` bypass); write `triageTier` + mapped `complexity` + `lane` + `estimateSource:'front'`.
- [ ] Escalation observer: review trigger (`childResult.output.clean` `:2174,2180` / `synthesis.clean` `:3335`); ship trigger (`deriveTestsPass(parseTestSummary(...))` surfaced as `{gate:'test',passed}`). On result → `escalate` → un-skip + re-enter; on `STOP` → checkpoint + human handoff.
- [ ] Re-entry phase via `VisionWriter.findFeatureItem(code).lifecycle.currentPhase`.
- **Gate:** both goldens green; full `node --test` suite green.

## Exit criteria (Phase 7)

- [ ] All five new test files green; full suite green (no regressions).
- [ ] E2E smoke (compose dev server) unaffected.
- [ ] Codex review loop → REVIEW CLEAN.
- [ ] Coverage sweep → TESTS PASSING.

## Parallelizable

S01, S02, S03 are independent (S02/S03 depend only on S01's symbol names, not runtime). S04 depends on all three. Run S01→(S02‖S03)→S04.
