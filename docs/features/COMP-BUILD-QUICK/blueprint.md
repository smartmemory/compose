# COMP-BUILD-QUICK — Implementation Blueprint

All references verified live against the codebase 2026-06-17. Companion to `design.md` (corrections table C1–C4).

## Corrections confirmed (Phase 5 verification)

| Ref | Verified |
|---|---|
| `extractFlowName` prioritizes `workflow.name` (build.js:332-350) | ✅ `build.stratum.yaml` declares `workflow.name: build` (line 12). Keep `workflow.name: build` + main flow `build` in the quick file → runner sees identical flow name; only steps differ. **Zero flow-name coupling.** |
| `resolveTemplatePath('build-quick', cwd)` → `pipelines/build-quick.stratum.yaml` (build.js:582-596) | ✅ Project-local resolution; file just needs to exist. |
| Triage auto-skips with explicit template (build.js:737 `!isBugMode && !opts.skipTriage && !opts.template`) | ✅ `--quick` sets a template → no triage. |
| `executeShipStep` never reads `plan.md`; ship is git-based (build.js:2367-2640) | ✅ Missing `plan.md` in quick mode is safe. `plan_completion` ensure + agent plan_items text are dead for the in-process ship path. |
| Hard-coded step couplings: only `execute`/`docs`/`ship` (build.js:1315,1091) + `skippableSteps` (build.js:798, generic) | ✅ All three present in quick flow. Omitted steps (prd/architecture/blueprint/verification/plan) are not special-cased. |
| `blueprint:` inputs are defensive optional reads (build.js:1201,1877,4226 `?? ''`) | ✅ Repointing review inputs to design artifact is safe. |

## Edit 1 — `pipelines/build-quick.stratum.yaml` (NEW)

Copy `build.stratum.yaml` verbatim, then:

- **Header comment** + `workflow.description`: relabel "Quick feature build (design → implement → ship)". **Keep `workflow.name: build`** (O1 resolution).
- **Keep all sub-flows** unchanged: `review_check`, `parallel_review`, `coverage_check`, `test_review` (these ARE the preserved Phase-7 enforcement).
- **Main flow `build` steps — DELETE:** `prd`, `architecture`, `blueprint`, `verification`, `plan`, `plan_gate`, `report`.
- **Main flow steps — KEEP & REWIRE:**
  - `explore_design` (unchanged) → `design_gate` (`on_approve: decompose`, was `prd`)
  - `decompose`: `depends_on: [design_gate]` (was `[plan_gate]`); intent → "Read the design doc at docs/features/{featureCode}/design.md and decompose it into independent tasks…" Add escalation guardrail sentence (see Edit 4).
  - `execute`: unchanged (`depends_on: [decompose]`)
  - `review`: `inputs.blueprint: "$.steps.explore_design.output.artifact"` (was `$.steps.blueprint…`)
  - `codex_review`: same blueprint repoint
  - `coverage`: unchanged (`depends_on: [codex_review]`)
  - `test_review`: blueprint repoint; `depends_on: [coverage]` unchanged
  - `docs`: `depends_on: [test_review]` (was `[report]`)
  - `ship`: `depends_on: [docs]` unchanged; intent line "Read … plan.md … acceptance criteria" → "design.md" (cosmetic — build.js owns ship)
  - `ship_gate`: unchanged

## Edit 2 — `bin/compose.js` build dispatch (lines 1926-2040)

- After `const skipTriage = …includes('--skip-triage')` (line 1972), add:
  `const quick = filteredArgs2.includes('--quick')`
- Conflict guards (after existing `abort && isBatch` check, ~line 1980):
  - `quick && templateName` → error "`--quick` and `--template` are mutually exclusive" → exit 1
  - `quick && isBatch` → error "`--quick` cannot be combined with --all/prefix/multi (single feature only)" → exit 1
- In the single-build branch (line 2028-2039), before `runBuild`:
  `if (quick) singleOpts.template = 'build-quick'`
- Add `--quick` line to the usage block (~line 1993).

## Edit 3 — `.claude/skills/compose/SKILL.md`

- **Mode Selection** section: add a row/note for `/compose build --quick <feature-ref>` — small additive work (one flag + a test), collapses to design → implement → ship, single gate, Phase-7 enforcement preserved. Symmetric to fix mode's Quick path (note the honest asymmetry: fix's is a triage decision, build's is a flag selecting the `build-quick` pipeline).
- **Partial Execution / Lifecycle (build mode)** section: document the 3-phase collapse and that prd/architecture/blueprint/verification/plan are omitted, not self-skipping.

## Edit 4 — Escalation guardrail (in Edit 1's `decompose` + `explore_design` intent)

Add to both step intents: "If during this step the work proves multi-file, cross-cutting, or in need of architecture/PRD, STOP and recommend the user re-run with full `compose build` (no `--quick`) rather than under-scoping."

## Edit 5 — Tests — `test/build-quick.test.js` (NEW)

- `--quick` sets `template: 'build-quick'` in singleOpts (parse-level assertion; mirror existing CLI-parse tests).
- `--quick --template X` → exits non-zero (conflict).
- `--quick --all` / prefix → exits non-zero (batch conflict).
- `build-quick.stratum.yaml` parses as YAML, `extractFlowName` returns `build`, and the main `build` flow contains exactly the kept step IDs and none of the dropped ones.

Check existing CLI-parse test patterns first (`test/*.test.js` referencing `bin/compose.js` arg parsing) and mirror them. If CLI parse isn't unit-tested directly, assert at the pipeline level (YAML structure + extractFlowName) and add a focused parse test for the conflict guards.

## Edit 6 — `CHANGELOG.md`

Entry under today's date: `COMP-BUILD-QUICK: compose build --quick` — trimmed build lifecycle (design → implement → ship), new `pipelines/build-quick.stratum.yaml`, `--quick` flag mutually exclusive with `--template`/batch, SKILL.md docs, escalation guardrail.
