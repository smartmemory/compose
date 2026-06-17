# COMP-BUILD-QUICK — Implementation Report

**Status:** COMPLETE (shipped 2026-06-17, commit `16ef85f`)
**Built via:** the full `/compose build` lifecycle (ironically — `--quick` builds its own report-skipping path, so this report is written after the fact to satisfy the completion contract; see Lessons Learned).

## 1. Summary

Added `compose build --quick`: a trimmed build lifecycle (**design → implement → ship**, single design gate) symmetric to fix mode's Quick path, so small-but-real additive work stops paying full 16-step lifecycle tax. The phases `prd`, `architecture`, `blueprint`, `blueprint-verification`, `plan`, `plan_gate`, and `report` are omitted (not just self-skipping). Phase-7 enforcement — parallel + Codex review loop, coverage sweep, generated-test review, per-task TDD — is preserved verbatim. Explicitly NOT OpenSpec's no-gates model.

## 2. Delivered vs Planned

| Acceptance criterion (from plan.md / design.md) | Delivered |
|---|---|
| `compose build --quick <ref>` parses in bin/compose.js → trimmed flow | ✅ `--quick` → `template: 'build-quick'` |
| Trimmed Stratum flow (design → implement → ship) | ✅ `pipelines/build-quick.stratum.yaml` |
| Phase-7 enforcement preserved | ✅ review/codex_review/coverage/test_review sub-flows byte-identical |
| Single design gate; full-lifecycle phases omitted | ✅ prd/architecture/blueprint/verification/plan/plan_gate/report dropped |
| SKILL.md documents the `--quick` build path | ✅ Mode Selection + Build Quick path section |
| Escalation guardrail | ✅ in explore_design + decompose intents |
| `--quick` mutually exclusive with `--template` + batch | ✅ conflict guards before auto-init |
| CHANGELOG entry in same commit | ✅ |

## 3. Architecture Deviations

The plan's central instruction — "mirror the `--quick` flag handling fix mode already has" — rested on a **false premise**: there is no `--quick` flag in fix mode (`compose fix` runs the full `bug-fix.stratum.yaml`; fix's Quick path is a SKILL.md *triage decision*). The real mirror is the existing `--template` mechanism. The design was corrected accordingly (corrections table C1–C4 in design.md).

`workflow.name` was kept as `build` (not `build-quick`) so `lib/build.js` (`extractFlowName`, the `execute`/`docs`/`ship` step-id couplings) sees an identical flow — only the step list differs. This eliminated all flow-name coupling risk.

## 4. Key Implementation Decisions

- **Trim, don't rewrite.** `build-quick.stratum.yaml` is `build.stratum.yaml` with steps deleted and two input refs repointed (`decompose` reads design.md; `review`/`codex_review`/`test_review` blueprint inputs → `$.steps.explore_design.output.artifact`). Sub-flows are byte-identical.
- **`--quick` is sugar for `template: 'build-quick'`**, single-feature only, mutually exclusive with `--template` and batch. Guards fire before auto-init (deterministic, no filesystem).
- **Provisioning:** added build-quick to the init seed list, and made the build auto-init `--quick`-aware (re-seeds when missing) with the resolved `buildCwd` threaded through `runInit` so subdir invocations seed the workspace root (both found by Codex review).

## 5. Test Coverage

`test/build-quick.test.js` — 15 tests: pipeline structure (kept/dropped steps, rewired inputs, guardrail presence), `resolveTemplatePath`, init seeding, and CLI conflict guards. Full node suite green (3920); `vite build` green.

## 6. Files Changed

`pipelines/build-quick.stratum.yaml` (new), `bin/compose.js`, `.claude/skills/compose/SKILL.md`, `docs/cli.md`, `CHANGELOG.md`, `ROADMAP.md`, `docs/features/COMP-BUILD-QUICK/{design,blueprint,feature.json}`, `test/build-quick.test.js`.

## 7. Known Issues & Tech Debt

- **`--quick` features always trip `MISSING_COMPLETION_REPORT`.** The quick lifecycle omits the report phase by design, but `feature-validator.js:576` flags every COMPLETE feature without `report.md`. Either the validator should exempt `--quick`-built features, or `--quick`'s ship step should emit a lightweight report. Filed as a follow-up consideration. (This very report was hand-written to close the warning.)

## 8. Lessons Learned

1. **Gates earned their keep.** The design gate caught the false-premise mirror; the Codex review loop (3 rounds → CLEAN) caught two real provisioning bugs (missing pipeline in upgraded workspaces; subdir re-seed targeting the wrong root). Neither was visible from the happy path.
2. **A "quick" feature isn't necessarily a small one.** The feature to *add* the quick path spanned a new pipeline, CLI wiring, provisioning, docs, and tests — more than the one-flag-plus-test work it's designed to accelerate.
3. **Mirror the real mechanism, not the described one.** "Mirror fix's `--quick`" assumed a flag that didn't exist; the actual reusable pattern was `--template`. Verify the thing you're told to copy exists before copying it.
