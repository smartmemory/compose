# COMP-OUTCOME-ENUM-1: PhaseResult outcome vocabulary

**Status:** COMPLETE (72e2cbd, 2026-09-17)

**Created:** 2026-09-16

**Phase:** Phase 2 (prompt object shape + schema enum) SHIPPED 2026-09-17; synonym adapter deferred behind the harvest falsifier below

## Problem statement

The engine contract accepts only `complete | skipped | failed`, but ordinary build-step agents have returned completion synonyms. Stratum rejects those results before the step's `ensure` checks and Compose then pays for another full dispatch. The host-portability audit classifies this as loud cost/latency degradation (SD09 and G6), not a silent pass (`docs/features/COMP-HOST-PORTABILITY-1/report.md:149`, `docs/features/COMP-HOST-PORTABILITY-1/report.md:222`).

## A. Contract locations

The exact `PhaseResult.outcome` enum is declared in five shipped YAML specs:

| Spec | Definition |
|---|---|
| Compose full build | `pipelines/build.stratum.yaml:12-19` |
| Compose quick build | `pipelines/build-quick.stratum.yaml:49-56` |
| Compose GSD | `pipelines/gsd.stratum.yaml:12-19` |
| Stratum full build | `../stratum/pipelines/build.stratum.yaml:12-19` |
| Stratum legacy quick build | `../stratum/pipelines/build-quick.stratum.yaml:37-43` (v0.3 object syntax, same three values) |

Other Compose pipeline contracts use the same enum under mode-specific result names: `BugFixResult` and `ShipResult` (`pipelines/bug-fix.stratum.yaml:53-72`), `ContentResult` (`pipelines/content.stratum.yaml:38-46`), `RefactorResult` and `ShipResult` (`pipelines/refactor.stratum.yaml:41-59`), and `ResearchResult` (`pipelines/research.stratum.yaml:35-41`). These are in scope for a contract-aware adapter even though the measured failures are `PhaseResult` failures.

`contracts/*.json` and `../stratum/ts/contracts/*.json` contain no `PhaseResult` definition. `contracts/task-result.json:8-15` is a separate contract whose `status` enum is `passed | failed`; it is not the PhaseResult boundary.

The contract is not to be widened. `complete | skipped | failed` remains the canonical wire vocabulary.

## B. What every shipped step tells the agent

### Runtime prompt assembly

For current v1 Compose flows, Stratum supplies `readyStep.do`; Compose resolves the local `out:` contract into an **object** of `output_fields` and constructs `stepDispatch` (`lib/build.js:487-527`, `lib/build.js:4920-4933`). `buildStepPrompt` includes the step's `do:` text as `## Intent`, but emits `## Expected Output` only when `output_fields` is an **array** (`lib/step-prompt.js:67-115`). Because the real build path supplies an object, that section is absent.

`runAndNormalize` then appends a JSON schema (`lib/result-normalizer.js:380-399`, `lib/inject-schema.js:11-20`). The ordinary-step path does not attach a contract closure (`lib/build.js:4923-4932`), and the flat converter recognizes primitives only; `complete|skipped|failed` therefore becomes unconstrained `{}` (`lib/result-normalizer.js:56-85`). A direct prompt construction using the measured `explore_design` shape produced `"outcome": {}`. Thus, for affected ordinary steps, the allowed enum is stated only in the server-checked contract, not in the prompt the agent sees.

Consumer fanout is different: it carries the full contract closure (`lib/build.js:603-614`, `lib/build.js:1700-1709`), and the closure-to-schema converter preserves pipe enums (`lib/result-normalizer.js:104-145`). The measured failures are ordinary PhaseResult steps, not `TaskResult` fanout items.

`gate-prompt.js` is unrelated to agent result formatting: it prompts the human for `approve | revise | kill` gate decisions (`lib/gate-prompt.js:19-31`, `lib/gate-prompt.js:237-300`).

### Exhaustive shipped-step inventory

The table records each step in `compose/pipelines`, `stratum/pipelines`, and the preset flows. “Schema only” means the `do:` text has no explicit return clause but an `out:` contract still drives structured extraction. Gates and subflow calls do not dispatch a direct step-agent prompt at that point.

| Spec | Steps and actual return instruction |
|---|---|
| `pipelines/bug-fix.stratum.yaml:126-267` | `reproduce` BugFixResult summary; `diagnose` trace evidence; `bisect` skipped object on skip; `scope_check` scope/reference object; `fix` BugFixResult summary/reference count; `test` `{passing,summary,failures}`; `verify` BugFixResult summary; `retro_check` fix-chain fields; `ship` ShipResult summary. |
| `pipelines/build-quick.stratum.yaml:96-349` | `review` canonical ReviewResult; `run_tests` `{passing,summary,failures}`; `explore_design` “return PhaseResult”; `design_gate` gate; `decompose` `{tasks}`; `execute` fanout `{outcome,summary,files_changed}`; `execute_merge` gate; `review_triage` `{tasks}` with lens fields; `review_lenses` canonical ReviewResult; `review_lenses_gate` gate; `review_merge` schema only; `review_gate` gate; `codex_review`/`coverage` subflows; `test_review` advisory text only; `docs` “Return PhaseResult”; `ship` PhaseResult plus plan/files/commit; `ship_gate` gate. |
| `pipelines/build.stratum.yaml:59-384` | Same review/coverage/build instructions as quick, plus `prd`, `architecture`, `blueprint`, `plan`, and `report` each say only “Return PhaseResult”; `verification` says “Return a complete PhaseResult” but never names the three allowed strings (`pipelines/build.stratum.yaml:107-187`, `pipelines/build.stratum.yaml:198-384`). |
| `pipelines/content.stratum.yaml:78-121` | `research` ContentResult summary; `draft` artifact path; `review` `{clean,summary,findings}`; `publish` schema only. |
| `pipelines/coverage-sweep.stratum.yaml:65-76` | `sweep` `{passing,summary,failures}`. |
| `pipelines/gsd.stratum.yaml:45-112` | `decompose_gsd` `{tasks}`; `execute` fanout `{outcome,summary,files_changed}`; `execute_merge` gate; `ship_gsd` PhaseResult with files/commit. |
| `pipelines/new.stratum.yaml:43-106` | `research` ResearchResult; `brainstorm` BrainstormResult; `review_gate` gate; `roadmap` RoadmapResult; `roadmap_gate` gate; `scaffold` ScaffoldResult. |
| `pipelines/plan.stratum.yaml:57-156` | `explore_design` artifact/features; `plan_design_gate` gate; `plan` artifact/created; `plan_converge_gate` gate; `ship` handed-off codes. |
| `pipelines/refactor.stratum.yaml:100-174` | `snapshot` RefactorResult summary; `analyze` structured summary; `plan` schema only; `execute` modification summary; `test` `{passing,summary,failures}`; `review` `{clean,summary,findings}`; `ship` ShipResult summary. |
| `pipelines/research.stratum.yaml:60-91` | `gather` ResearchResult summary; `analyze` structured summary; `report` artifact/summary. |
| `pipelines/review-fix.stratum.yaml:104-141` | `execute` ExecuteResult summary/empty findings; `review` ReviewResult schema only; `review_gate` gate. |
| `../stratum/pipelines/build.stratum.yaml:59-372` | Mirrors the full Compose build: PhaseResult steps say only “Return PhaseResult” (verification says “complete PhaseResult”); non-PhaseResult steps use the same shapes; gates/subflows dispatch no direct prompt. |
| `../stratum/pipelines/new.stratum.yaml:38-101` | Mirrors Compose `new`: four result-contract instructions and two gates. |
| `../stratum/pipelines/plan.stratum.yaml:55-161` | Legacy v0.3 `intent:` form: artifact/features, artifact/created, handed-off codes, with two gates. No outcome enum applies. |
| `../stratum/pipelines/build-quick.stratum.yaml:92-421` | Legacy v0.3 `intent:`/`output_contract:` form. `explore_design` requests only the artifact path; `docs` has no result wording; `ship` requests plan/files/commit. The enum exists in `PhaseResult` but is not stated in those intents (`../stratum/pipelines/build-quick.stratum.yaml:230-252`, `../stratum/pipelines/build-quick.stratum.yaml:350-413`). This file does not pass through the current v1 `do:` prompt path; no current Compose code inspected here proves a legacy runtime injects the enum. |
| `presets/team-fable-astra.stratum.yaml:96-241` | `plan` TaskGraph; `execute` TaskResult with verification; `execute_merge` gate; `verify` VerifyResult; `review` ReviewFindings; `assess` WaveDecision; `assess_gate` gate; `ship` ShipResult. Its `outcome` fields are plain `string`, not the PhaseResult enum (`presets/team-fable-astra.stratum.yaml:22-69`). |
| `presets/team-feature.stratum.yaml:65-137` | `decompose` TaskGraph schema only; `execute` `{outcome,summary,files_changed}`; `execute_merge` gate; `verify` VerifyResult schema only. `TaskResult.outcome` is plain `string` (`presets/team-feature.stratum.yaml:34-46`). |
| `presets/team-research.stratum.yaml:68-122` | `plan` ResearchTaskList schema only; `explore` ExplorerFindings schema only; `synthesize` ResearchResult schema only. |
| `presets/team-review.stratum.yaml:68-136` | `triage` TriageResult schema only; `review_lenses` canonical clean/findings wording; `merge` ReviewResult schema only; `review_gate` gate. |

Conclusion: none of the affected ordinary PhaseResult `do:` clauses spells out `complete | skipped | failed`, and the current prompt/schema assembly also fails to add it. The server contract is the first place the exact vocabulary is enforced.

## C. Reproduction and measured offending results

The requested command was run from `stratum/ts` exactly as written:

```text
cd stratum/ts && npx tsx src/cli/stratum.ts learn harvest --root /Users/ruze/reg/my/forge/compose
```

It did not reach the CLI in this sandbox because `npx` tried to fetch `tsx` from npm and failed with `EPERM` connecting to `127.0.0.1:8118`; there is no local `node_modules/.bin/tsx`. The already-built, read-only equivalent succeeded:

```text
cd stratum/ts && node dist/cli/stratum.js learn harvest --root /Users/ruze/reg/my/forge/compose
```

Output: `616 failure records`, `1203 clusters`, `5 durable`, `2 for this project`. Its outcome cluster reports 9 Compose-root failures across 8 runs, with words `exists`, `short_circuited_existing_approved_design`, and `success`; 6 of 9 have a later successful attempt.

Parsing the same `~/.stratum/ts/flows/*.json` failure events for the exact enum-rejection signature gives the controller's 23 occurrences across the two requested repo roots:

| Repo root | Step | Returned words | Count |
|---|---|---|---:|
| Compose | `explore_design` | `success` x6, `exists` x1, `short_circuited_existing_approved_design` x1 | 8 |
| Compose | `docs` | `success` x1 | 1 |
| Stratum | `explore_design` | `success` x3, `revised` x1 | 4 |
| Stratum | `blueprint` | `done` x1, `approved` x1 | 2 |
| Stratum | `verification` | `pass` x1, `success` x1 | 2 |
| Stratum | `plan` | `success` x3, `revised` x2, `done` x1 | 6 |
| **Total** | | `success` x14, `revised` x3, `done` x2, `approved` x1, `pass` x1, `exists` x1, long short-circuit token x1 | **23** |

All 14 Stratum-root occurrences and 6 of the 9 Compose-root occurrences have a later successful result event: 20 confirmed paid redispatch recoveries. Representative raw evidence is in `/Users/ruze/.stratum/ts/flows/13fd190e-2c4c-44b3-85cf-b41245d962e9.json:325-330` (`explore_design: success`), `/Users/ruze/.stratum/ts/flows/64f8c243-f1a0-4660-9c2c-db48e0dc3615.json:553-616` (`verification: pass`, `plan: success`), and `/Users/ruze/.stratum/ts/flows/0a98dd5f-e2c0-49af-afa4-df940f7283c8.json:335-340` (short-circuit token).

The Compose dispatch ledger exists at `.compose/data/dispatch-ledger.jsonl`, but the authoritative invalid-enum value and recovery relation are in the Stratum flow events harvested above.

## D. Normalization seam

The existing seam is `runAndNormalize`: it extracts the final JSON into `result` (`lib/result-normalizer.js:906-931`), then `build.js` wraps that object as `{output: result}` and calls `stratum_step_done` (`lib/build.js:5524-5558`). A normalization function placed immediately after extraction is therefore before both strict contract validation and `ensure` evaluation, while remaining downstream of the agent response.

1. **Contract-loosening argument:** rewriting an invalid producer value can hide prompt/producer defects, and words such as `approved` or `revised` are ambiguous outside a typed PhaseResult context.
2. **Adapter argument:** when and only when the declared `outcome` type is exactly `complete|skipped|failed`, translating a fixed observed completion vocabulary to canonical `complete` is boundary adaptation; the server contract and its rejection of every unknown remain unchanged.
3. **Guardrail:** do not map arbitrary strings, do not touch `failed`/`skipped`, do not apply to plain `outcome: string`, and keep the original contract strict.

## Decision

Choose **(2) normalize a fixed, small synonym set at the adapter seam before the ensure check while leaving the contract untouched**.

Map exactly these measured PhaseResult completion values to `complete`: `success`, `done`, `approved`, `pass`, `revised`, `exists`, and `short_circuited_existing_approved_design`. Apply the mapping only when the dispatch declares `outcome: complete|skipped|failed` (from either ordinary `output_fields` or a closure root). Unknown values must still reach Stratum unchanged and fail normally.

Why this option: the prompt is currently deficient, but prompt-only repair cannot guarantee that a probabilistic producer will never use a synonym. The adapter is one narrow Compose boundary, covers both repos' measured failures, prevents the costly retry deterministically, and does not change any pipeline contract or Stratum validator. Prompt/schema alignment is useful follow-up hardening, but it is not required to remove this retry and has a wider shipped-prompt oracle surface.

## TDD implementation plan (Codex Phase 1 proposal — superseded by the adjudication below; Phase 2 executed instead)

1. Add a failing regression in `test/result-normalizer.test.js` using the measured object shape with `outcome: "success"` and `output_fields.outcome: "complete|skipped|failed"`; assert the result delivered toward `stepDone` is canonical `complete` and only one `agentRun` occurred.
2. Add negative cases proving an unknown value is unchanged and a plain `outcome: string` contract is not adapted.
3. Implement the scoped mapping in `lib/result-normalizer.js` immediately after JSON extraction.
4. Add a Compose `CHANGELOG.md` entry under `[Unreleased]`.
5. Run only the touched test plus the existing shipped-spec oracle tests located by `shipped` / `pipelines/`, per the feature instruction.

## Controller adjudication (2026-09-16)

Codex's Phase 1 evidence is accepted and was verified against source: `lib/step-prompt.js:106` gates the
`## Expected Output` section on `Array.isArray(output_fields)` while `lib/build.js:4930` passes the object
`outputContract.outputFields` (`result-normalizer.js:200` documents it as `Record<string,string>`), so the
section is dead on the real build path; and the flat converter (`lib/result-normalizer.js:56-85`) renders
`complete|skipped|failed` as `{}`. **Its Decision (2) is overruled on ordering.** A synonym map at the seam
would hide the fact that agents are never shown the enum — a dead path under a green suite, and a contract
loosening in disguise. Minimal-first:

- **Phase 2 (now):** make the agent see the enum. Accept the object shape in `buildStepPrompt` (render
  `outcome (complete|skipped|failed)`), and make the flat schema converter emit `"enum": [...]` for `a|b|c`
  type strings so the injected JSON schema constrains the field. Regression tests use the measured
  `explore_design` dispatch shape. No contract, spec, or Stratum change.
- **Deferred (falsifier):** the synonym adapter ships only if, after the prompt fix, a fresh
  `stratum learn harvest --root compose` over new builds still shows `outcome` synonym rejections. Check:
  `cd stratum/ts && npx tsx src/cli/stratum.ts learn harvest --root /Users/ruze/reg/my/forge/compose`.
