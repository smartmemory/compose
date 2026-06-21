# COMP-ROADMAP-PLAN — Implementation Report

**Status:** IMPLEMENTED (v1) — automated verification complete; one live-run acceptance item open
**Date:** 2026-06-22
**Commits:** `ef0b514` (design) · `fe4116f` (blueprint) · `34afc71` (plan) · `970995a` (Batch 1) · `ea0314b` (Batch 2) — all on `main`, not yet pushed

## Related Documents
- Design: `docs/features/COMP-ROADMAP-PLAN/design.md`
- Blueprint: `docs/features/COMP-ROADMAP-PLAN/blueprint.md`
- Plan: `docs/features/COMP-ROADMAP-PLAN/plan.md`
- Epic anchor: `docs/plans/2026-06-21-roadmap-planning-model-design.md`

## 1. Summary

Shipped the `plan` product-planning lifecycle — a peer to `build`/`fix` inside compose. `compose plan "<intent>"` runs a gated frame → research → ideate → converge → handoff flow and emits build-ready `docs/features/<code>/{feature.json, design.md}` that `compose build <code>` consumes by ratifying (not rewriting) the plan-authored design. Native-state-only, ideation routed to the existing ideabox.

## 2. Delivered vs Planned

All 8 blueprint work units + the 16-task plan landed:

| Unit | Delivered |
|---|---|
| S1 | `pipelines/plan.stratum.yaml` (phase-named steps explore_design/plan/ship, projectName/intent inputs); `compose plan` verb with `PLAN-<slug>` derivation; `defaultTemplate` flip; runInit seeds the pipeline |
| S2 | `mode` forwarded on both `/lifecycle/start` posts; start handler prefers `req.body.mode` |
| S3 | `projectFeatureStatus` gated on `tracksFeatureJson` at all 5 sites (plan session never writes a feature row) |
| S4 | `addRoadmapEntry` persists `profile`/`triageTimestamp`/`plannedBy`/`impact` (provider-backed); `isTriageStale` excludes `feature.json` from its own scan; MCP schema advertises the 4 fields |
| S5 | `applyPlannedByRatify` — build `explore_design` ratifies a plan-authored design |
| S6 | `complexity` JSDoc corrected to `S\|M\|L\|XL` |
| S7 | `_featureRelDir` mode-aware (plan → `docs/plans`; build keeps `paths.features`) |
| S8 | `shouldInterceptShip` gates the `ship`/`executeShipStep` interception on `mode !== 'plan'` |

## 3. Architecture Deviations

- **`--code` flag instead of positional `<CODE>`.** The blueprint floated `compose plan <CODE> "<intent>"`; the implementation uses `--code PLAN-X` (unambiguous parsing vs. positional intent words). Documented in the verb usage.
- **Spec-step write via the `add_roadmap_entry` MCP tool** (not a new CLI). Function-level pass-through already carries the handshake fields; the MCP `inputSchema` now advertises them. See the open acceptance item below.

## 4. Key Implementation Decisions

- **The plan session is a separate non-`feature.json`-backed vision item; its outputs are separate PLANNED features** — so plan completing never marks the produced features COMPLETE (which would block `build`). Enforced by `tracksFeatureJson:false` + the S3 projection gate.
- **The build-handshake is the feature folder reaching a defined state** (`feature.json` with `plannedBy`/`profile`/`triageTimestamp` + `design.md`). Build's `explore_design` ratifies it — no new template, no genesis change.
- **`triageTimestamp` ordering**: the spec step writes `design.md` first, stamps `triageTimestamp` after; `isTriageStale` excludes `feature.json` so its own mtime can't self-invalidate the cache.

## 5. Test Coverage

- **35 new tests** (TDD): registry/guard (8), server mode-stamp + projection (10), writer + triage (8), ratify (5), golden flow (4), CLI guard paths (4).
- **Golden flow** (`test/roadmap-plan-golden.test.js`): the produce → consume handshake with real backends (fs, provider, registry, guard, the real pipeline YAML) — the LLM agent is the only layer not exercised.
- **Full suite green**: 4369 node + 564 vitest-ui + 100 vitest-tracker = **5033 tests, 0 failures**.
- **Codex review**: design (4 rounds), blueprint (5 rounds), implementation (3 rounds) — all to REVIEW CLEAN; 14 design/blueprint seams + 6 implementation bugs caught and fixed.

## 6. Files Changed

`pipelines/plan.stratum.yaml` (new), `bin/compose.js`, `lib/build.js`, `lib/feature-json.js`, `lib/feature-writer.js`, `lib/lifecycle-modes.js`, `lib/triage.js`, `lib/vision-writer.js`, `server/compose-mcp.js`, `server/lifecycle-guard.js`, `server/vision-routes.js` + 7 new test files.

## 7. Known Issues & Tech Debt

- **OPEN — live acceptance run.** A real `compose plan "<intent>"` run (live agents through the two human gates) has not been executed. The automated tests cover every wired seam except LLM agent execution. The one assumption a live run validates: **whether a runBuild-spawned `claude` agent has the `add_roadmap_entry` MCP tool** for the spec step. It should (spawned agents inherit the user MCP config), but if not, the spec step needs a CLI fallback (a small follow-up). **Recommended acceptance gate: one live `compose plan` smoke.**
- **paths.features in agent prompts.** The plan prompts use `docs/features/<CODE>` as the default, consistent with the pre-existing convention in `build.stratum.yaml` (all its prompts hardcode `docs/features`). Repos that override `paths.features` rely on the agent reading the config — the prompts were hardened to say so, but a fully config-driven prompt is shared tech debt with `build`.

## 8. Lessons Learned

- Impl-level Codex review caught 6 real bugs the 5033-test suite did not — all in CLI control flow (resume/abort code derivation, usage guard, flag-value parsing) and runtime wiring (ship-step `created` input). Review loops on the implementation, not just the blueprint, earn their cost.
- The shipped MODES registry already had a `plan` seed and `mode='plan'` was already threaded through `runBuild` — most of the "data-only" claim held; the real work was the CLI verb, the server REST contract, and the guard/writer seams.

## 9. Deferred (separate follow-up features)
- Estimation carry-through from the ideabox on promote (effort/impact → feature.json).
- First-class `idea/decision/question/thread` vision items + connection graph.
- The structural `build-from-plan` skip-to-blueprint template.
- Server-side `ArtifactManager` mode-owned root resolution (assess path).
