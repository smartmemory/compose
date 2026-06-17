# COMP-BUILD-QUICK — Design

**Status:** DESIGN (Phase 1) — reconciles `plan.md` (scoping doc, 2026-06-07) against the codebase as of 2026-06-17.
**Feature:** `compose build --quick` — a trimmed build lifecycle for small-but-real additive work.

## Goal (unchanged from plan.md)

Give build mode a symmetric "quick" path so a one-flag-plus-test change stops paying full 16-step lifecycle tax. Collapse to **design → implement → ship**, single design gate, with all Phase-7 enforcement (TDD, verification-before-completion, review loop, coverage sweep) preserved. Gates remain; only phase *count* shrinks. Explicitly NOT OpenSpec's no-gates model.

## Corrections Table (blueprint discipline — plan.md assumptions vs. on-disk reality)

| # | plan.md assumption | Reality on disk | Consequence for design |
|---|---|---|---|
| C1 | "`/compose fix --quick` already implements path-selection + a collapsed flow — mirror its `--quick` flag handling in `bin/compose.js`." | **No `--quick` flag exists** anywhere. `grep -i quick bin/compose.js` → 0 matches. `compose fix` (bin/compose.js:2041) runs the full `bug-fix.stratum.yaml`; fix's "Quick path" is a **SKILL.md triage decision**, not a CLI flag. | There is no `--quick` flag to mirror. The real mirror is the **`--template` mechanism**. |
| C2 | "The full build flow is `compose_feature` (4 Stratum steps)." | The CLI build flow is **`pipelines/build.stratum.yaml`** (16 steps). `compose_feature` is the abstract template embedded in SKILL.md for the *interactive* skill, never executed by the CLI. | Trim `build.stratum.yaml`, not `compose_feature`. |
| C3 | "Mirror fix-mode's `--quick` flag handling." | `compose build` already resolves `pipelines/<template>.stratum.yaml` generically via `resolveTemplatePath` (build.js:582-596) and `extractFlowName` (build.js:332). Fix dispatches via `{ template: 'bug-fix', mode: 'bug' }`. | `--quick` → `singleOpts.template = 'build-quick'`. Existing pattern, ~6 lines. |
| C4 | (implicit) trimming steps may break the runner. | `build.js:737` skips triage when `opts.template` is set. `skippableSteps` (build.js:798) is generic. `blueprint:` inputs are defensive optional reads (`response.inputs?.blueprint ?? ''`, build.js:1201/1877/4226). `stepId === 'execute'|'docs'|'ship'` are the only hard-coded step couplings — all present in the quick flow. | A pipeline that *omits* prd/architecture/blueprint/verification/plan is safe, **provided** the quick flow is named so `extractFlowName` resolves it (see Open Question O1). |

**None of these corrections kill the feature.** They correct the *mechanism* (template-based, not a mythical flag) and the *target* (`build.stratum.yaml`, not `compose_feature`). The deliverable — both a CLI surface and SKILL.md docs — is unchanged and all of plan.md's acceptance criteria remain achievable.

## Approach

Three surfaces, smallest coherent slice:

### 1. New pipeline: `pipelines/build-quick.stratum.yaml`

Trim `build.stratum.yaml` to the quick lifecycle. **Keep** (with sub-flows `parallel_review`, `review_check`, `coverage_check`, `test_review` intact — they ARE the preserved Phase-7 enforcement):

```
explore_design → design_gate → decompose → execute
  → review → codex_review → coverage → test_review → docs → ship → ship_gate
```

**Drop:** `prd`, `architecture`, `blueprint`, `verification`, `plan`, `plan_gate`.

**Rewiring required (because blueprint/plan are gone):**
- `decompose` source: reads `design.md` (was the plan). Its intent points at the design artifact.
- `review` / `codex_review` / `test_review` `blueprint` input: repoint `$.steps.blueprint.output.artifact` → `$.steps.explore_design.output.artifact` (the design doc becomes the review reference).
- `decompose` `depends_on`: `[design_gate]` (was `[plan_gate]`).
- `execute` `depends_on`: `[decompose]` (unchanged).

### 2. CLI flag: `bin/compose.js` build dispatch

- Parse `--quick` from `filteredArgs2`.
- When set (single build only): `singleOpts.template = 'build-quick'`.
- Mutually exclusive with `--template` (explicit conflict error) and with batch (`--all`/prefix/multi) — quick is single-feature only.
- Add `--quick` to the usage block.

### 3. SKILL.md docs

- **Mode Selection** table: add the `--quick` build path note, symmetric to fix's Quick path, with the honest framing that both are opt-in collapses (one a triage decision, one a flag).
- **Partial Execution** / lifecycle section: document `compose build --quick` and its 3-phase collapse.
- Add a **guardrail note**: if mid-`--quick` the work proves multi-file / needs architecture, surface and offer to escalate to full `compose build` rather than silently under-scope.

### 4. Tests + CHANGELOG

- Flag parsing test (`--quick` → `template: 'build-quick'`; conflict with `--template`; rejected with batch).
- Pipeline validity: `build-quick.stratum.yaml` passes `stratum_validate` and `extractFlowName` resolves it.
- CHANGELOG entry in the ship commit.

## Open Questions

- **O1 (flow naming):** `extractFlowName` returns the flow whose key === templateName, else the *first* flow key. In `build.stratum.yaml` the first key is `review_check` (a sub-flow). So the quick file's **main flow must be named `build-quick`** (matching the template) so it resolves, OR keep the main flow last-and-named. Decision: name the main flow `build-quick`. Verify in blueprint that no build.js path assumes the literal flow name `build` (step IDs are referenced, not the flow name — low risk).
- **O2 (escalation guardrail depth):** v1 = a documented prompt instruction in the `explore_design`/`decompose` steps ("if this is multi-file or needs architecture, stop and recommend full build"). A hard programmatic gate is out of scope for v1.

## Non-Goals (from plan.md)

- Not OpenSpec's no-gates model. Not a replacement for full `compose build`. Not the broad IDEA-15 simplicity audit.

## Acceptance Criteria (from plan.md, corrected for C1/C3)

- [ ] `compose build --quick <ref>` parses in `bin/compose.js` → selects `template: 'build-quick'` (the real mirror of fix's `template: 'bug-fix'` dispatch, **not** a fix `--quick` flag — which does not exist)
- [ ] `pipelines/build-quick.stratum.yaml`: trimmed flow `explore_design → design_gate → decompose → execute → review → codex_review → coverage → test_review → docs → ship → ship_gate`
- [ ] Phase-7 enforcement preserved: review (parallel + codex), coverage sweep, test_review sub-flows unchanged; TDD intent in `execute`
- [ ] Single design gate; prd/architecture/blueprint/verification/plan/plan_gate omitted (not just self-skipping)
- [ ] SKILL.md Mode Selection + Partial Execution document the `--quick` build path
- [ ] Guardrail: escalation-to-full-build note in the quick-flow design/decompose intents
- [ ] `--quick` mutually exclusive with `--template` and batch builds
- [ ] CHANGELOG.md entry in the same commit
```
