> **PARKED 2026-10-24 (owner via s1-chat, ledger `4f7c3fd7a`): experiment closed.** The re-run on fixed scoring was declined, no further paid runs, the routing table stays as is. Final readout: `reports/discriminate.md`. The tag fix (branch `comp-model-ab-tagfix-1`) merges as hygiene only.

# COMP-MODEL-AB-DECISION — Implementation Plan (Shape B, the evidence loop)

> **OWNER PICK 2026-10-20 (via s1-chat): Shape B, the evidence loop, "measure who's best at what".** Reason (owner's words and
> shapes.md's Recommendation): forge has no measured wait that A or C removes, and B alone measures decision quality, which the data
> shows is missing; A's sandbox and C's council become dimensions B tests. The three Falsifiers are kept as **standing flags** in the
> plan. No owner date: pace comes only from `estimate.py`.
> (Copied from `/Users/ruze/reg/my/forge/docs/features/FORGE-NEXT-SHAPE-1/shapes.md:3-7`.)

**Status:** PLAN (FORGE-NEXT-PLAN-1, 2026-10-20, Claude Opus). Round-1 review NOT CLEAN (F1-F10); fix round 1 applied 2026-10-20 (20 units,
was 18), awaiting round-2 review. Shape is fixed; this plan maps, sizes and orders it.

**Paths.** Relative to `/Users/ruze/reg/my/forge` unless absolute. **`$F` = `compose/docs/features/COMP-MODEL-AB-DECISION`** (this folder).

## Related Documents

- Design (what to build): `/Users/ruze/reg/my/forge/compose/docs/features/COMP-MODEL-AB-DECISION/design.md`
- Shape pick (why this shape): `/Users/ruze/reg/my/forge/docs/features/FORGE-NEXT-SHAPE-1/shapes.md` (OWNER PICK, `## Shape B`, Falsifiers)
- Engine (the spine, shipped): `/Users/ruze/reg/my/forge/compose/docs/features/COMP-MODEL-AB/plan.md` (its `## Contract`), commit `b46e7070`
- Resolver (the one router): `/Users/ruze/reg/my/forge/compose/docs/features/COMP-MODEL-ROUTE/design.md`, `progress.md`
- Contracts this plan creates: G1 writes `$F/stage-run-contract.json`, `$F/archetype-contract.json`, `$F/registry-contract.json`; J1 writes
  `$F/judge-contract.json`; A1 writes `$F/assembly-contract.json`. Later extensions are each the extending unit's first checkbox (`## Units`).
- Round-1 review: `/Users/ruze/reg/my/SmartMemory/smart-memory-ops/units/FORGE-NEXT-PLAN-1/review.md`
- Unit report: `/Users/ruze/reg/my/SmartMemory/smart-memory-ops/units/FORGE-NEXT-PLAN-1/report.md`

## Buckets (from the shape; every unit below sits in exactly one)

| Bucket | What it holds here |
|---|---|
| **fixed** | the engine (`compose/lib/experiment*.js`), one receipts corpus (the dispatch ledger), one resolver (COMP-MODEL-ROUTE), the registry that stores the matrix |
| **swappable** | stage fixtures + their hidden oracles (one plugin family), config dimensions (model, effort, workflow) |
| **adapter** | fleet stamps as a prior, cost receipts into the matrix, matrix into the resolver's input |
| **one-off** | judge calibration (multi-judge panel + human anchor set) |

---

## Prior art checked

Every child was grepped before any unit was cut (`read-dont-recall.md` rule 2). What was run, what was found, and what the plan does
with it. Rows marked *(fix round 1)* were added after the round-1 review; their evidence is in the unit report's `## Fix round 1`.

| Child / surface | Checked | Found | Plan consequence |
|---|---|---|---|
| Engine run model | `grep -n "export\|^function\|^async function" compose/lib/experiment*.js`; read `experiment.js:51-539` | Engine runs a **whole `compose build`** per run (`realHeadlessBuild`, `experiment.js:255-292`, spawns `compose build EXP-FIXTURE --implementer --reviewer`). Spec has `fixture{goal,seedRepo,seedRef}`, `configs[{label,implementer,reviewer}]`, `reps`, `judge`, `parallelism` (`experiment.js:51-147`). A build-runner injection seam exists (`opts._runBuild`, `experiment.js:465`). No notion of stage, archetype or oracle. | Isolated stage runs are **new**: one stage-run mode added to the engine through its existing run seam (G2). Whole-build mode stays, and is what end-to-end validation uses. No second harness. |
| Metric vector | read `experiment-metrics.js:188-264`, `experiment-report.js:105-160` | `cost{tokensIn,tokensOut,calls,wallMs,usd}`, `outcome{completed,health,testsPass,testsTotal,filesChanged,linesChanged}`, `process{reviewIters,gateFailures,retries,escalations}`; `usd` is the history record's own `cost_usd` or `null` (COMP-COST-OWNER S3, `6ce20b68`). `aggregate()` gives median/min/max per config. `experiment-pricing.js` no longer exists (`ls compose/lib/experiment*`). | Reuse the vector unchanged for whole-build runs. Stage runs add one `metrics.stage` block (accuracy + canary + mechanism + oracleError) and take cost from receipts, not from a new pricing table. |
| Receipts corpus | `grep -n "kind\|usage\|tokens\|usd" compose/lib/dispatch-ledger.js` | `dispatch` events carry `site, agent, model, effort_intended, effort_executed, tokens_in, tokens_out, tokens_total, usd, usd_source, duration_ms, step_id` (`dispatch-ledger.js:62-67`). `site` is a **closed enum** (`DISPATCH_SITES`, `dispatch-ledger.js:39-43`), no experiment site. The judge already dispatches with `telemetry:{site:'judge', project_cwd}` (`experiment-judge.js:124`). | The dispatch ledger is the one receipts corpus. Stage runs add one site value (`experiment-stage`) and read their cost from their sandbox's ledger. Per-step attribution in end-to-end runs reads the same rows by `step_id` (R2). |
| Per-step history | read `build-history.js:85-102` | `projectHistorySteps` keeps only `id, status, agent, durationMs` per step: **no per-step tokens or cost**, contrary to design.md:58 ("build-history per-step ... input_tokens/output_tokens/cost_usd"). `step_model` stream events exist (`build.js:1867,5589`). | Per-step attribution joins dispatch-ledger rows on `step_id` instead of build history. design.md:58 is stale on this point (Findings in the report). |
| COMP-STAGE-GRADING (archetypes, oracles, registry) | `grep -rli "registry.json\|mutation\|precision\|planted\|canary\|mechanism_engaged\|signed.*uplift\|bootstrap\|pareto"` over `compose/lib compose/server stratum/ts/src`; `grep -n "stryker\|mutation" compose/package.json stratum/ts/package.json`; `ls compose/docs/features \| grep STAGE-GRAD` | No archetype, oracle, registry, uplift or Pareto code anywhere (`registry.json` hits are stratum's guard store, unrelated; `mutation` hits are state mutation). No mutation-testing dependency. No feature folder. | Archetypes, registry and uplift are new. Mutation scoring uses **pre-built hidden mutant patches** in the fixture, not a new dependency. |
| COMP-PIPELINE-ASSEMBLY | read `stratum/docs/features/STRAT-AGENT-INTERP/design.md:1-30`, `STRAT-AGENT-INTERP-TS/feature.json`; `grep -n agent stratum/ts/src/ir/schema.ts`; read `compose/lib/pipeline-profiles.js:68-100`, `compose/pipelines/build.profiles.json` | **STRAT-AGENT-INTERP shipped in the Python engine and was retired at the TS cutover**; its TS successor `STRAT-AGENT-INTERP-TS` is `PLANNED`; the TS IR declares `agent: z.enum(AGENT_TYPES)` (`schema.ts`, 4 sites). design.md:9 ("plugs straight into a runnable spec") is therefore stale. **But** the shipped compose profiles sidecar (`pipelines/build.profiles.json`, keyed by step id, applied by `loadPipelineProfiles`, `build.js:2231`) already maps step → `provider:template:tier`, and COMP-MODEL-ROUTE Decision 2 reads it as the `preset` source. | Assembly (A1) emits an **assembly artifact** whose `profiles` member is a sidecar in the shipped shape, plus role flags for the role-bound steps. Tier/model changes within a literal-provider step need nothing new. A provider change on a literal step (for example a Codex winner mapped to `plan`) needs STRAT-AGENT-INTERP-TS, so v1 refuses it with `ASSEMBLY_PROVIDER_CHANGE` and keeps the champion. Codex winners reach the pipeline only through the role-bound steps (implementer, reviewer) as role flags. *(Rewritten fix round 1: Codex is now a candidate, `### Owner change`.)* |
| Resolver | read COMP-MODEL-ROUTE `design.md:43-74,105-136,326-407,408-443`; `progress.md:600-666`; `grep -n "export" compose/lib/model-router.js` | One resolver: `manual → learned → preset → default` (Decision 2). `routingTable()` returns an empty `s1a-empty-v1` table (`model-router.js:112`): the learned source is not live. Learned evidence is defined as ledger acceptance only (Decision 8). Q3 (repair floor) still OPEN, made answerable by `routing.mode: shadow` (progress.md:664-666). COMP-FABLE-CALIBRATE killed as superseded (progress.md:236-243). Roadmap row 153 `PARTIAL`. | The matrix enters the resolver **as a preset sidecar**, the source the resolver already reads. Feeding the matrix into Decision 8's learned source would amend a decided design: not planned (`## Unclassified`). No unit touches the router or Q3. |
| Model / effort axis | read `compose/server/model-tiers.js:1-40`, `compose/lib/agent-string.js:1-42,91-131`, `stratum/ts/src/config/models.default.toml:35-41` | Tier names bind model AND effort together: claude `critical` = opus-5-5/xhigh, `standard` = opus-5-5/medium, `fast` = sonnet-5-5/medium, `coordinator` = opus-5-5/high. Effort comes only from the tier catalog (`agent-string.js:113-120`). Fable (`claude-fable-5-1`) is in the catalog's model list but no tier points at it. | A cell is keyed by the **resolved** `{provider, modelID, effort}` plus the catalog digest, never the tier name (a catalog edit re-points tiers). D1 adds explicit model and effort pins so Fable and effort sweeps are reachable. |
| COMP-JUDGE-CALIBRATION | read `compose/lib/experiment-judge.js:1-42,120-150`; `ls stratum/ts/src/judge/`; headers of `STRAT-JUDGE-JEV-1`, `STRAT-TS-JUDGE-TOOL`; `grep -rli "inter-rater\|multi-judge"` | One judge model, fixed rubric `{correctness, clarity, idiomaticity}` 1-10, degrades to `null` on any failure; bias guard only **warns** when the judge is a config under test (`experiment.js:119-127`). Stratum's judge kernel (`judged.ts`) routes `stakes` to OpenAI models from `catalog.judge`. STRAT-JUDGE-JEV-1 `PARKED`; STRAT-TS-JUDGE-TOOL `DESIGN`. No multi-judge or agreement code. COMP-BENCH-4 (judge stddev < 2) `PLANNED`, never built. | Extend `experiment-judge.js` to a panel with per-archetype rubrics (J1). Do not use stratum's `judged.ts` (OpenAI-routed; Codex/OpenAI judge runs stay closed: `### Owner change`). Judges are a Claude panel (Q3 ANSWERED); panel size is Q6. |
| COMP-REALWORLD-FIXTURE | `ls compose/docs/features \| grep -i "REALWORLD\|COMP-BENCH"`; read `docs/features/COMP-BENCH/design.md:1-12`, `ROADMAP.md:87` rows | No REALWORLD folder. COMP-BENCH-1..5 all `PLANNED`, folders hold only `feature.json`; COMP-BENCH has its own planned runner (BENCH-3). The engine already supports a seeded fixture (`fixture.seedRepo/seedRef`, `experiment-sandbox.js:72`). | The end-to-end fixture is a seeded engine fixture plus a hidden oracle. COMP-BENCH is not a second harness (shapes.md:54-55); its seed repo is at most an alternate end-to-end fixture (`## Unclassified`). |
| COMP-EXPERIMENT-DIMS | `grep -rn "effort\|temperature" compose/lib/experiment*.js compose/lib/agent-string.js` | Engine passes only agent strings; effort appears only in the judge's resolved config. No temperature anywhere. Workflow variant = which pipeline file the sandbox copies (`_scaffoldSandboxProject` hard-codes `pipelines/build.stratum.yaml`, `experiment.js:224-229`). | D1 makes `{model, effort, workflow}` an ingredient set on a config. Temperature is dropped (no connector exposes it today; unverified for Claude CLI, so not planned). |
| Fleet prior | `python3 ~/.claude/scripts/estimate.py stats --project all --by-author-model` | `opus: first-pass CLEAN 17/38 (45%) n=54 as_of 2026-10-20T07:44`; `sonnet: 19/48 (40%) n=171 as_of 2026-10-20T07:48`. Author stage only, no unit kind. forge `status/units.json` has 4 rows with `author_model`. | Imported as `state: "prior"` rows for the `implement` archetype only, never pooled with measured cells (P1). |
| Checkpoint / reuse *(fix round 1)* | `grep -rn "runKey\|reuseRecord\|skipExisting" compose/lib`; read `experiment.js:484-518`, `experiment-sandbox.js:72-88` | None. The loop dispatches every descriptor; `provision` mkdirs + mkdtemp on every run. The only checkpoint prior art is gsd run-state (`gsd-state.js:3`), not shaped for run records. The round-1 plan wrongly described record reuse as existing behaviour (review F8). | **New, owned by B1:** `runKey` reuse/retry before `provision`, with a partial-failure dispatch-count probe. |
| Run budget / stop *(fix round 1)* | `grep -n "maxUsd\|usdCap\|budget" compose/lib/experiment*.js`; read `build.js:1507-1528`, `stratum-mcp-client.js:220-283,311-320,335-409`, `experiment.js:271` | No experiment budget. `_costCeiling` is a pipeline **gate hold** (`WAVE_COST_CEILING_EXCEEDED` at a named gate), not a running kill. Cancel seams exist: `agentRun` takes `opts.signal` → `cancellationId` (`stratum-mcp-client.js:335-409`); the build runner SIGKILLs at timeout (`experiment.js:271`). An errored or aborted dispatch still writes a ledger row with `outcome: error` (`stratum-mcp-client.js:311-320` → `appendEvent`, `:220-283`). | **New, owned by B1:** one budget meter and stop rule over the existing cancel seams. Partial receipts come from the ledger with no new code. |
| Stratum client lifecycle *(fix round 1)* | read `gsd.js:194-196`, `new.js:118-119,269`, `build.js:4001-4002`, `compose/bin/compose.js:2670`, `experiment.js:407`, `stratum-mcp-client.js:185-199` | Pattern: `ownsStratum = !opts.stratum`, `connect(resolveStratumMcpConnection(cwd))`, close in `finally`. The CLI calls `runExperiment(specPath, { pruneWorkspaces })` with no client, so today's judge path (`if (spec.judge.enabled && stratum)`, `experiment.js:407`) is dead from the CLI too. `buildAgentRunRequest` forwards `sandboxMode` (Codex needs `workspace-write` to edit). | **G2 owns** the client inside `runExperiment` (copy of the pattern); the CLI stays unchanged and its judge path revives as a side effect. |
| Sandbox pipeline + profiles *(fix round 1)* | read `experiment.js:224-229`, `build.js:2188-2241` | The scaffold copies only the pipeline yaml; the profiles loader returns `{}` on ENOENT; `requirePipelineSidecar` throws only for execution-config sidecars, and `build.profiles.json` has only strings. So **every experiment build today runs without `build.profiles.json`**: `review_lenses` loses `read-only-reviewer`, `blueprint`/`ship` lose `claude::critical`. | **D1** copies the pipeline AND its sidecar into each sandbox (fixes the gap; default = shipped pair). V1's champion is the shipped pipeline + sidecar + default roles. |
| Role precedence and step agents *(fix round 1)* | read `build.js:4177-4178,4215-4222`; `pipelines/build.stratum.yaml:66,241,343`; `pipelines/bug-fix.stratum.yaml:201-203`; `ls compose/pipelines/` | Defaults: implementer `claude`, reviewer `codex`. A role flag carrying template/tier replaces the sidecar entry of every `$.input.<role>_agent` step; a bare provider keeps the sidecar's template/tier; literal-agent steps take only the sidecar. Role-bound steps: `execute` fan-out (implementer), `review` in the `review_check` subflow and `test_review` (reviewer). Literal `claude` steps: `explore_design`, `plan`, `blueprint`, `review_lenses` and others. The build pipeline has no test-authoring step. bug-fix: `diagnose`/`fix`/`test` are literal `claude`, and there is **no `bug-fix.profiles.json`**. | A1's stage → target map and V1's participating stages (implement, review) follow from this. Precedence is written into `stage-run-contract.json` by D1. |
| Digest helper + catalog *(fix round 1)* | read `pipeline-profiles.js:180-184`; `models.default.toml:9,12,29,39` | `profilesDigest` (canonical sha256) exists. Claude models: opus-5-5, haiku-5-5, haiku-4-5, fable-5-1, sonnet-5-5 (`:12`); `codex.standard` = gpt-6.1-sol/high (`:29`); Claude default sonnet-5-5 (`:9`). The shipped bug-fix `fix` step is literal `claude` with no profile, so it runs sonnet-5-5 with effort unpinned: **not exactly** `claude::fast` (sonnet-5-5/medium). | Reuse the canonical-sha256 helper for `runKey`/`compatKey`/digests. G5 declares `claude::fast` the reference arm and records the effort difference. The model list makes a 3-judge Claude panel "of models not under test" unsatisfiable without Haiku: Q6. |

---

## Structure

### Steps and dependencies (edge list: `A -> B` means B needs A)

```
G1 -> G2, G3, G4            (the only parallel group after G1)
G2 -> B1                    (same file experiment.js, after the stage path exists)
G2, G3, G4, B1 -> G5
G5 -> G6, G7, G8, R1, R2, D1, P1, J1, A1   (every post-skeleton branch waits on G5)
D1 -> R1                    (R1's calibration needs D1's sidecar copy; review r2 R2-2)
J1 -> G9, G10
G9, G10 -> J2
G6, G7, G8 -> M1
M1 -> A1                    (A1 consumes M1's measurement decisions; review r2 R2-1, R2-3)
M1, A1, D1, R1, R2 -> V1
```

Acyclic: every edge points from a lower layer to a higher one. Layers:
`G1 | G2 G3 G4 | B1 | G5 | G6 G7 G8 R2 D1 P1 J1 | G9 G10 M1 R1 | J2 A1 | V1` (20 units). R1 sits after G2 transitively (through G5), so the
archetype dispatch it extends is settled before it starts.

**Loader ownership (G2 vs G3).** G2 does NOT create `compose/lib/archetypes/index.js`. It loads archetypes through
`opts._loadArchetype ?? (await import('./archetypes/index.js')).loadArchetype` (a dynamic import taken only on stage specs, so legacy specs
never touch the file), and its tests inject fake archetypes. G3 owns `compose/lib/archetypes/index.js` (new). G2 refuses `runner: "build"`
archetypes with `ARCHETYPE_RUNNER_UNSUPPORTED` until R1 lifts that refusal.

Short names map to unit IDs in `## Units`.

### Hub contracts (most dependents)

| Contract | Written by | Read by (cited in the unit's file list) |
|---|---|---|
| `$F/stage-run-contract.json`: runner discriminator, spec extension, per-run record (`metrics.stage`, `artifacts`), `budget`, `runKey` | G1; extended by D1 (`ingredients`, precedence) and R2 (`metrics.steps[]`) | G2, B1, G3, G5, G6-G10, R1, R2, D1, M1, V1: **14 of 20** |
| `$F/registry-contract.json`: row shape, admission, `compatKey`, uplift, `latest`, catalog rule, promotion/demotion | G1 | G4, G5, P1, M1, A1, J2, V1, plus G6-G10 whose runs become rows: **12 of 20** |
| `$F/archetype-contract.json`: the stage-archetype plugin interface + fixture unit + hidden rule | G1 | G2, G3, G6-G10, R1: **8** |
| `$F/judge-contract.json`: panel spec + result; anchors index, owner/panel scores, calibration result | J1 (new); extended by J2 | G9, G10, J2: **3** |
| `$F/assembly-contract.json`: objectives, selection rule, assembly artifact | A1 (new) | V1 |
| COMP-MODEL-AB `## Contract` (shipped spec / run record / results shapes) | existing | G2, G4, B1, R1, R2, V1 |
| `pipelines/build.profiles.json` shape (resolver's preset input) | existing | D1, A1, V1 |
| dispatch-ledger `dispatch` event (`dispatch-ledger.js:62-67`) | existing | G2, B1, R2, V1 |

The registry row and the stage-run record are the hubs: a wrong shape breaks every later unit, so G1 is contract-only and is reviewed before
G2-G4 start.

### Same-interface clusters

- **The six isolated stage archetypes are one plugin family**: each is `{id, stage, runner, judged, buildInput, prompt, oracle, canary,
  mechanismEngaged, version}` (`$F/archetype-contract.json`) over one shared scenario (design.md:36). G3 (debug, built with the loader),
  G6 (review), G7 (test-authoring), G8 (implement), G9 (plan), G10 (design). Once G3 has proven the interface, G6-G8 are bounded Sonnet units
  against a locked contract.
- `end-to-end` (R1) implements the same archetype interface with `runner: "build"` instead of `runner: "stage"`, so the oracle side is
  shared and only the runner differs (G1's discriminator).
- Two adapters share the registry's write path: P1 (fleet prior rows) and G4 (measured rows).

### Critical path

`G1 -> G2 -> B1 -> G5 -> {G6 | G7 | G8} -> M1 -> A1 -> V1` (8 units; A1 joined the chain in plan review r2). Parallel branches: G3 and G4
beside G2/B1; R2, D1 -> R1 beside G6-G8 and M1; the judge branch (J1 -> G9, G10 -> J2) and P1 are **off** the critical path because the first assembled pipeline uses the champion
for the two subjective stages (see V1).

### Controller-serial vs agent hours

- **Controller-serial:** G1 contract review before fan-out; adjudicating the G5 skeleton (does the cell spread?); the owner's decision after
  G5's readout on which proposed runs in `## Run budget` start; Q6 before J1; the human anchor scoring in J2 (owner time, unmeasured).
- **Agent hours:** 20 authoring units (`## Pace`). **Model-run wall time is separate** and not in any `estimate.py` figure: G5 is 9 stage
  runs at parallelism 1; V1 is up to 4 whole builds at `buildTimeoutMs` 30 min default each (`experiment.js:103`).

---

## Convergence

| Unit | Bucket | Why that bucket |
|---|---|---|
| G1 COMP-STAGE-GRADING-1 contracts | fixed | storage + run-record shapes of the engine and registry |
| G2 COMP-STAGE-GRADING-2 stage-run mode | fixed | engine extension through its run seam |
| G3 COMP-STAGE-GRADING-3 scenario seed + archetype loader + `debug` | swappable | first fixture/oracle of the plugin family (the loader rides with it) |
| G4 COMP-STAGE-GRADING-4 registry writer, admission, signed uplift | fixed | the matrix store |
| B1 COMP-STAGE-GRADING-12 run budget + checkpoint/retry | fixed | engine run control (stop rule, reuse of passed runs) |
| G5 COMP-STAGE-GRADING-5 walking-skeleton live cell | fixed | acceptance run of the engine + registry end to end |
| G6 COMP-STAGE-GRADING-6 `review` | swappable | fixture + oracle |
| G7 COMP-STAGE-GRADING-7 `test-authoring` | swappable | fixture + oracle |
| G8 COMP-STAGE-GRADING-8 `implement` | swappable | fixture + oracle |
| G9 COMP-STAGE-GRADING-9 `plan` | swappable | fixture + oracle (rubric) |
| G10 COMP-STAGE-GRADING-10 `design` | swappable | fixture + oracle (rubric) |
| P1 COMP-STAGE-GRADING-11 fleet prior | adapter | fleet stamps as a prior |
| M1 COMP-STAGE-GRADING-13 objective matrix measurement | fixed | acceptance run of the engine + registry over every objective stage |
| R1 COMP-REALWORLD-FIXTURE-1 end-to-end fixture | swappable | fixture + oracle (build runner) |
| R2 COMP-REALWORLD-FIXTURE-2 per-step attribution | adapter | cost receipts into the matrix |
| V1 COMP-REALWORLD-FIXTURE-3 assembled vs champion | fixed | acceptance run of engine + resolver input end to end |
| A1 COMP-PIPELINE-ASSEMBLY-1 matrix → assembly artifact | adapter | matrix into the resolver's preset input |
| D1 COMP-EXPERIMENT-DIMS-1 ingredient set + sandbox workflow | swappable | dimensions |
| J1 COMP-JUDGE-CALIBRATION-1 judge panel | one-off | judge calibration |
| J2 COMP-JUDGE-CALIBRATION-2 anchor set + calibration run | one-off | judge calibration |

20 units, 20 classified. Three things that fit no bucket are in `## Unclassified`, not forced.

---

## Units

### Table

| # | ID | Repo | Bucket | Deps | Model | Security | Live runs (see `## Run budget`) |
|---|---|---|---|---|---|---|---|
| G1 | COMP-STAGE-GRADING-1 | compose (docs) | fixed | none | Sonnet | no | 0 |
| G2 | COMP-STAGE-GRADING-2 | compose | fixed | G1 | Opus (`hard:` engine seam + receipts join + client lifecycle) | no | 0 |
| G3 | COMP-STAGE-GRADING-3 | compose | swappable | G1 | Opus (`hard:` first plugin of the family, sets the interface) | no | 0 (fake runner) |
| G4 | COMP-STAGE-GRADING-4 | compose | fixed | G1 | Sonnet | no | 0 |
| B1 | COMP-STAGE-GRADING-12 | compose | fixed | G2 | Sonnet | no | 0 |
| G5 | COMP-STAGE-GRADING-5 | compose (run + report) | fixed | G2, G3, G4, B1 | Sonnet | no | 9 stage runs (APPROVED) |
| G6 | COMP-STAGE-GRADING-6 | compose | swappable | G5 | Sonnet | no | 1 calibration (proposed) |
| G7 | COMP-STAGE-GRADING-7 | compose | swappable | G5 | Sonnet | no | 1 calibration (proposed) |
| G8 | COMP-STAGE-GRADING-8 | compose | swappable | G5 | Sonnet | no | 1 calibration (proposed) |
| G9 | COMP-STAGE-GRADING-9 | compose | swappable | J1 | Sonnet | no | 1 calibration + 3 panel calls (proposed) |
| G10 | COMP-STAGE-GRADING-10 | compose | swappable | J1 | Sonnet | no | 1 calibration + 3 panel calls (proposed) |
| P1 | COMP-STAGE-GRADING-11 | compose | adapter | G5 | Sonnet | no | 0 |
| M1 | COMP-STAGE-GRADING-13 | compose (run + report) | fixed | G6, G7, G8 | Sonnet | no | 27 stage runs, +9 if debug cannot reuse G5 (proposed) |
| R1 | COMP-REALWORLD-FIXTURE-1 | compose | swappable | G5, D1 | Sonnet | no | 1 calibration build (proposed) |
| R2 | COMP-REALWORLD-FIXTURE-2 | compose | adapter | G5 | Sonnet | no | 0 |
| A1 | COMP-PIPELINE-ASSEMBLY-1 | compose | adapter | G5, M1 | Sonnet | no | 0 |
| D1 | COMP-EXPERIMENT-DIMS-1 | compose | swappable | G5 | Sonnet | no | 0 |
| J1 | COMP-JUDGE-CALIBRATION-1 | compose | one-off | G5 (and Q6 answered) | Sonnet | no | 0 |
| J2 | COMP-JUDGE-CALIBRATION-2 | compose (run + report) | one-off | G9, G10 | Sonnet | no | 36 panel calls + 1 Opus anchor-author helper (proposed) |
| V1 | COMP-REALWORLD-FIXTURE-3 | compose (run + report) | fixed | M1, A1, D1, R1, R2 | Sonnet | no | 2 required + 2 optional builds (proposed) |

"Proposed" means the run is planned and budgeted but **does not start** until the owner approves it after G5's readout (`### Owner answers`
Q4). Only G5's 9 runs are approved.

No unit is security-tagged: none touches auth, tenancy, secrets, export policy or billing. Every live-run unit runs a **leak gate**
(below), because experiment runs dispatch Claude and Codex with a sandbox `cwd` and STRAT-CLAUDE-SANDBOX (enforced isolation) is still
`PLANNED` (`stratum/docs/features/STRAT-CLAUDE-SANDBOX/README.md:3`).

**Common to every unit:**
- Tests use the engine's injected seams (`opts._runBuild`, and G2's `opts._stratumFactory` / `opts._loadArchetype`), so **no test makes a
  model call**.
- Contract files are cited by exact path in each unit's file list and never restated in prose. A unit that extends a contract does so as its
  **first checkbox**: it edits the contract, appends a `_changelog` line (unit id + date), and adds one valid example record; its consumers
  start only after it lands (the graph enforces this).
- `compose/CHANGELOG.md` (existing) updated in the same commit; no `ROADMAP.md` or `feature.json` hand edits.
- Live-run units run from a detached job (`detach_job.py`) through the shipped experiment CLI entry (`compose/bin/compose.js:2653-2670`).
  Reuse of passed runs and the stop rule are **B1's code** (not shipped today): a restart re-dispatches only failed, missing or budget-skipped
  runs (`no-redundant-rework.md`).
- Run units list produced files as `(new, produced)`: records under `$F/experiments/<id>-exp/runs/` are kept locally; sandbox workspaces
  may be pruned.

**Leak gate (every live-run unit):** before the run, record `git -C /Users/ruze/reg/my/forge/compose status --porcelain` and the same for
`stratum`; after it, diff both. Any new entry outside the experiment root fails the unit and is reported by path. It covers the Codex runs
too.

### G1 COMP-STAGE-GRADING-1: the three contracts (docs only)

Files: `$F/stage-run-contract.json` (new), `$F/archetype-contract.json` (new), `$F/registry-contract.json` (new). Each carries `_source`
(this plan), `_roadmap` (`COMP-MODEL-AB-DECISION`) and `_changelog[]` (first line: G1 + date).

- [ ] `stage-run-contract.json` **runner discriminator**: (a) `fixture.archetype` absent → legacy whole build, today's shape
      (`configs[{label, implementer, reviewer}]`), no oracle; (b) archetype with `runner: "stage"` → every config has `candidate` (agent
      string) and no `implementer`/`reviewer`, one `agentRun` per run; (c) archetype with `runner: "build"` → every config has `implementer`
      and `reviewer` and no `candidate`, whole build, then the archetype oracle after `collect`. Named refusals: `ARCHETYPE_UNKNOWN`,
      `CONFIG_SHAPE_MISMATCH`, `ARCHETYPE_RUNNER_UNSUPPORTED`, `JUDGED_STAGE_CLAUDE_ONLY`.
- [ ] Per-run record additions: `metrics.stage {accuracy: 0..1|null, oracle, oracleVersion, canaryOk: bool, mechanismEngaged: bool,
      oracleError: str|null, detail: object}`; `candidateResolved {provider, modelID, effort, catalogDigest}`; `artifacts {outputPath,
      transcriptPath|null, diffPath, logPath}` (rubric and review oracles read `outputPath`). `metrics.cost` for a stage run is the sum of the
      sandbox's dispatch-ledger rows with `site: "experiment-stage"` (`dispatch-ledger.js:62-67`), `usd: null` if any row's `usd` is null.
- [ ] `budget` section (B1 implements): spec `budget {maxRuns, perRunTimeoutMs, maxUsdTotal|null, maxTokensTotal, perRunTokenAssume}`,
      required on every archetype spec (`BUDGET_REQUIRED`), optional on legacy specs; per-run `budget {stoppedBy: null|"timeout"|"maxRuns"|
      "maxUsdTotal"|"maxTokensTotal", spentUsd, spentTokens}`; unstarted runs recorded as `skipped: "BUDGET_STOP"`.
- [ ] `runKey` section (B1 implements): sha256 (canonical JSON) over {config label, `candidate` or `implementer`+`reviewer`, `ingredients`,
      `pipelineDigest` and `profilesDigest` (sha256 of the workflow's pipeline file and sidecar CONTENTS, null when absent; review r2
      R2-5. Per `stage-run-contract.json#/rules/digests` (G1 fix round 1): the pipeline YAML is hashed as raw bytes, so a formatting-only edit
      re-runs its cells; the JSON sidecar is hashed as canonical JSON. G1 review r2 R2-4), archetype id + version, `fixtureDigest`, `oracleVersion`, `catalogDigest`, rep}; the terminal / retry / mismatch rules stated in B1.
- [ ] `archetype-contract.json`: plugin interface `{id, stage, runner: "stage"|"build", buildInput(workspace, scenario) -> void,
      prompt(scenario) -> str, oracle(workspace, hidden, artifacts) -> {accuracy, detail}, canary(workspace) -> bool,
      mechanismEngaged(workspace, transcript) -> bool, judged: bool, version}` (`judged` is true for design and plan, the rubric/panel
      stages); fixture unit `{context, task, gold, task_type}` (design.md:27); the rule
      that `hidden` (golden tests, planted bugs, mutants, answer keys) is never copied into the workspace before the oracle runs; any change to
      an oracle or its hidden material bumps `version` (which is the `oracleVersion`). An oracle that cannot run (hidden suite fails to start)
      sets `oracleError` and `accuracy: null`, never `accuracy: 0`.
- [ ] `registry-contract.json`: `registry.json` with `version`, `rows[]`, `latest{<stage>: {<compatKey>: {<cellKey>: rowId}}}`. Row
      `{rowId, stage, cellKey, compatKey, ingredients {provider, modelID, effort, workflow}, catalogDigest, fixtureId, fixtureDigest,
      archetypeVersion, oracleVersion, state: "triaged"|"measured"|"prior", triageReason: null|"LOW_N"|"LOW_ADMISSION"|"JUDGED_UNPROMOTED"|
      "INCOMPATIBLE"|"JUDGE_DRIFT", nAttempted, nAdmitted, vector {accuracy, tokensIn, tokensOut, usd, wallMs, reliability} (each {median,
      min, max}, over admitted runs), uplift {championCellKey, delta, ci95: [lo, hi], method: "bootstrap", resamples, seed} | null,
      upliftNullReason: str|null, promotion: object|null, sourceRunIds[], experimentId, generatedAt}`; `cellKey` = stage + resolved
      ingredients (never a tier name).
- [ ] `registry-contract.json` **admission** (F5): a run is admitted iff `outcome.completed === true`, no `_error`, not `skipped`,
      `metrics.stage.oracleError === null`, `accuracy` numeric, `canaryOk === true`, `mechanismEngaged === true`. A row is `measured` iff its
      stage is objective AND nAdmitted ≥ 3 AND nAdmitted / nAttempted ≥ 2/3; otherwise `triaged` with a `triageReason`. Rows of the judged
      stages (design, plan) are always written `triaged` / `JUDGED_UNPROMOTED` until promoted.
- [ ] `registry-contract.json` **compatibility**: `compatKey` = sha256(stage, archetypeVersion, fixtureDigest, oracleVersion). Uplift is
      computed only within one `compatKey`, and the champion must be `measured` in it, else `uplift: null`, `upliftNullReason:
      "NO_COMPATIBLE_CHAMPION"`. A newer compatKey never mixes with an older one; prior rows are never in `latest`. **Catalog rule:** assembly
      uses only rows whose `catalogDigest` equals the current catalog's, unless an explicit digest is named (`STALE_CATALOG` otherwise).
- [ ] `registry-contract.json#measurementDecision` (review r2 R2-3; written by M1, read by A1 and V1): file
      `{version, experimentIds[], decisions: [{stage, compatKey, championCellKey, decision: "measured"|"noSignal", reason: null|
      "NO_UPLIFT"|"CALIBRATION_OUT_OF_RANGE"|"FLAG4_SPREAD", evidence {calibrationRunId, upliftRowId|null, flag4: object|null}}], generatedAt}`.
      One worked example with one `measured` and one `noSignal` decision.
- [ ] `registry-contract.json#promotion`: evidence `{calibrationReport, panelModels[], judgeCatalogDigest, gatePassed: true, agreement}`
      accepted by `promoteRows(registry, {rowIds, evidence})`; `demoteRows(registry, {rowIds, reason: "JUDGE_DRIFT"})` for Standing flag 7.
      A `prior` row may never be uplift input, champion, in `latest`, or selectable by assembly.
- [ ] Worked examples, each valid against its schema: one `debug` stage run record, one `runner: "build"` record, one `measured` row with an
      uplift block, one `triaged` `LOW_N` row, one promotion evidence object.
- Oracle: a `node -e` command loads each file as JSON and validates every example against its schema (command and output pasted in the
  report).
- Sizing: one Sonnet author, docs only. Every field is given above; the author transcribes and makes the examples validate.

### G2 COMP-STAGE-GRADING-2: stage-run mode in the engine, with its own Stratum client

`hard:` this is the spine's seam, the receipts join and the live client lifecycle; a wrong join silently corrupts every cell.

Files: `compose/lib/experiment.js` (existing), `compose/lib/experiment-stage.js` (new: stage runner; no archetype loader file),
`compose/lib/dispatch-ledger.js` (existing: add `experiment-stage` to `DISPATCH_SITES`), `compose/lib/stratum-mcp-client.js` (existing,
read-only use: `StratumMcpClient`, `resolveStratumMcpConnection`), `compose/test/experiment-stage.test.js` (new), `compose/CHANGELOG.md`
(existing). Contracts: `$F/stage-run-contract.json`, `$F/archetype-contract.json`. `compose/bin/compose.js` is **unchanged** by G2
(`compose.js:2670` keeps calling `runExperiment(specPath, { pruneWorkspaces })`).

- [ ] `validateSpec` implements G1's runner discriminator and refuses by name: `ARCHETYPE_UNKNOWN`, `CONFIG_SHAPE_MISMATCH` (a stage config
      with `implementer`, a build config with `candidate`, a stage spec with no `candidate`), and `ARCHETYPE_RUNNER_UNSUPPORTED` for any
      `runner: "build"` archetype (R1 lifts it), and `JUDGED_STAGE_CLAUDE_ONLY` for a non-Claude candidate on a `judged: true` archetype
      (`### Owner change`, ~09:0x line).
- [ ] Archetypes load via `opts._loadArchetype ?? (await import('./archetypes/index.js')).loadArchetype`, imported only for stage specs. G2
      creates no file under `compose/lib/archetypes/`.
- [ ] A stage spec runs each config as: provision sandbox (existing `provision`) → `archetype.buildInput` → ONE
      `stratum.agentRun(provider, prompt, {modelID, effort, cwd, telemetry:{site:'experiment-stage', project_cwd: workspace}})` →
      `archetype.oracle` → record per contract, including `artifacts {outputPath, transcriptPath|null, diffPath, logPath}`. Codex candidates
      dispatch with `sandboxMode: "workspace-write"` (forwarded by `buildAgentRunRequest`, `stratum-mcp-client.js:185-199`).
- [ ] **Client lifecycle (F6):** `runExperiment` creates and connects a `StratumMcpClient` when the spec needs one (stage archetype, or
      `judge.enabled`) and `opts.stratum` is absent, and closes it in `finally` (pattern: `gsd.js:194-196`, close as in `new.js:118-119,269`).
      Test seam `opts._stratumFactory` returns a fake with connect/close counters; tests assert exactly one connect and one close, including
      when a run throws. A passed `opts.stratum` is never closed by the engine. This also revives the CLI's judge path (`experiment.js:407`),
      noted in the CHANGELOG.
- [ ] Cost is read from the sandbox's `.compose/data/dispatch-ledger.jsonl` (`readEvents`, `dispatch-ledger.js:303`), not from the
      agentRun return value.
- [ ] `candidateResolved` is filled from `resolveAgentConfig` (`agent-string.js:105`) plus the catalog digest. Table row:
      `codex::standard` resolves to `{provider: codex, modelID: gpt-6.1-sol, effort: high}` read from the catalog, not hard-coded.
- [ ] An oracle that throws produces a kept record with `metrics.stage.oracleError` set and `accuracy: null` (test row).
- [ ] A spec **without** `fixture.archetype` takes today's path unchanged: all existing engine tests stay green
      (`node --test test/experiment-model-ab.test.js test/experiment-orchestrator.test.js test/experiment-wave2.test.js`; 89 `test(`/`it(`
      lines today by `grep -c`) and `test/dispatch-ledger.test.js` stays green.
- [ ] Negative control: the stage test goes RED if cost is taken from the fake agentRun return instead of the ledger.
- Oracle: `node --test test/experiment-stage.test.js` with a fake archetype and a fake stratum client; zero model calls.

### G3 COMP-STAGE-GRADING-3: shared scenario seed, archetype loader, `debug` archetype

`hard:` first member of the plugin family; its shape is what G6-G10 copy.

Files: `compose/test/fixtures/stage-grading/notes-server/` (new: the mini MCP notes server over SQLite, design.md:36, with its golden suite;
small, target under ~400 LOC + tests), `compose/test/fixtures/stage-grading/hidden/debug/` (new: planted bug patch + failing repro +
hidden full suite), `compose/lib/archetypes/index.js` (new: `loadArchetype(id)`, keyed by archetype id; G3 owns this file),
`compose/lib/archetypes/debug.js` (new), `compose/test/archetype-debug.test.js` (new), `compose/CHANGELOG.md` (existing). Contracts:
`$F/archetype-contract.json`, `$F/stage-run-contract.json`.

- [ ] The notes server passes its own golden suite with the bug patch reverted (fixture self-test).
- [ ] `debug.buildInput` writes code with the planted bug + the failing repro only; the hidden suite is not in the workspace.
- [ ] `debug.oracle` returns `accuracy 1` only when the repro is green AND the hidden full suite is green, else `0`, with which failed in
      `detail`; a hidden suite that cannot start sets `oracleError`, `accuracy: null`.
- [ ] `canary` is true only if the diff touches a file; `mechanismEngaged` is true only if the repro test was executed in the transcript or
      the workspace test log.
- [ ] Table-driven test, one row per oracle outcome: untouched workspace (canary false, 0), repro green + suite red (0), repro green + suite
      green (1), repro red (0), hidden suite crash (oracleError). Fed with canned workspaces, no model.
- [ ] `loadArchetype` refuses an unknown id with `ARCHETYPE_UNKNOWN` and returns `debug`; G2's dynamic import resolves it (one test).
- Oracle: `node --test test/archetype-debug.test.js`.

### G4 COMP-STAGE-GRADING-4: registry writer, admission, signed uplift, promotion

Files: `compose/lib/experiment-registry.js` (new), `compose/lib/experiment-report.js` (existing: call the writer after `aggregate`),
`compose/test/experiment-registry.test.js` (new), `compose/CHANGELOG.md` (existing). Contracts: `$F/registry-contract.json`,
`$F/stage-run-contract.json` (records read).

- [ ] `writeRegistry(results, runs, {registryPath, champion})` appends or replaces rows per `registry-contract.json`, applying the
      admission and `measured`/`triaged` rules exactly; `latest` points at the newest `measured` row per stage / compatKey / cellKey; writes are
      atomic (temp file + rename).
- [ ] Signed uplift vs the champion cell within one compatKey: delta of median accuracy with a 95% bootstrap interval (seeded, so reruns are
      byte-identical); `uplift: null` with `upliftNullReason` when either arm is not `measured` or the champion is absent from the compatKey.
- [ ] `promoteRows` and `demoteRows` per `registry-contract.json#promotion`.
- [ ] Re-running with the same run records leaves `registry.json` byte-identical (no duplicate rows).
- [ ] Negative-control table test, one row each: canary false (not admitted); mechanism false (not admitted); accuracy null (not admitted);
      oracleError set (not admitted); 2 of 3 admitted → `triaged LOW_N`; 3 of 5 admitted → `triaged LOW_ADMISSION`; incompatible champion →
      `uplift: null NO_COMPATIBLE_CHAMPION`; an unpromoted judged row is not selectable (asserted through the selection helper A1 imports);
      promotion with `gatePassed: false` refused; a `prior` row never in `latest`.
- Oracle: `node --test test/experiment-registry.test.js` over canned run records, including a CI row checked against a hand computation.

### B1 COMP-STAGE-GRADING-12: run budget and checkpoint/retry

Files: `compose/lib/experiment.js` (existing), `compose/lib/experiment-stage.js` (existing after G2: pass the per-run `AbortSignal` to
`agentRun`), `compose/lib/experiment-budget.js` (new), `compose/bin/compose.js` (existing: `--rerun <runId|failed|all>` on the experiment
command), `compose/test/experiment-budget.test.js` (new), `compose/CHANGELOG.md` (existing). Contract: `$F/stage-run-contract.json`
(`budget`, `runKey`).

- [ ] **Checkpoint (F8).** Before `provision`, compute `runKey` per the contract. A record with an equal runKey that is terminal (no
      `_error`, not `skipped`, not budget-stopped; a model timeout IS terminal) is reused with no dispatch; `_error` and `skipped` records are
      retried; a runKey mismatch moves the old record to `<runId>.json.prev-<epoch>` and reruns. `--rerun failed` also reruns timeouts;
      `--rerun all` reruns everything; `--rerun <runId>` reruns one.
- [ ] **Budget (F7).** `budget` is required on every archetype spec (`BUDGET_REQUIRED`) and optional on legacy specs. Before each dispatch,
      stop starting runs when dispatched == `maxRuns`, or the USD meter ≥ `maxUsdTotal` (the USD meter is used only while every receipt so far
      has a `usd`), or the token meter ≥ `maxTokensTotal`; a run with no usable receipt counts as `perRunTokenAssume` tokens. Running runs are
      not killed by the total cap (live units run at parallelism 1, so overshoot is at most one run). Per-run hard stop = `perRunTimeoutMs`:
      stage runs abort through the `AbortSignal` → agentRun cancel seam (`stratum-mcp-client.js:335-409`); builds use the existing SIGKILL
      (`experiment.js:271`). Partial ledger rows are kept (an aborted dispatch still writes `outcome: error`). Each record carries `budget
      {stoppedBy, spentUsd, spentTokens}`; unstarted runs are written `skipped: "BUDGET_STOP"` and are retried by the checkpoint rule.
- [ ] Probe (dispatch counts, fake runner): a 3-run stage spec whose fake fails run 2 once → the restart dispatches exactly 1; a second
      restart dispatches 0; `--rerun all` dispatches 3; a changed `oracleVersion` dispatches 3.
- [ ] Budget table test, one row each: maxRuns reached; token meter reached with a null-usd receipt counted at `perRunTokenAssume`; USD meter
      ignored once any receipt lacks usd; timeout aborts (signal observed by the fake) and the record is terminal with `stoppedBy: "timeout"`;
      archetype spec without `budget` refused.
- [ ] Legacy specs without `budget` behave as today (existing engine tests green).
- Oracle: `node --test test/experiment-budget.test.js`; zero model calls.

### G5 COMP-STAGE-GRADING-5: walking skeleton, one real cell (see `## Walking skeleton`)

Files: `$F/experiments/skeleton-debug.json` (new spec), `$F/experiments/registry.json` (new, produced), `$F/experiments/skeleton-debug-exp/runs/`
(new, produced), `$F/reports/skeleton.md` (new). Contracts: `$F/stage-run-contract.json`, `$F/registry-contract.json`.

- [ ] Spec: archetype `debug`, three candidates (`claude::fast` = sonnet-5-5/medium, `claude::standard` = opus-5-5/medium, `codex::standard`
      = gpt-6.1-sol/high; `### Owner change`), `reps: 3`, 9 runs, `parallelism: 1`, `budget {maxRuns: 9, perRunTimeoutMs: 900000,
      maxUsdTotal: null, maxTokensTotal: 9000000, perRunTokenAssume: 1000000}` (plan defaults, unmeasured; the owner may change them).
- [ ] Champion = `claude::fast` as the reference arm. The report records that the shipped `bug-fix.stratum.yaml` step `fix` is literal
      `claude` with no profile entry, so it runs sonnet-5-5 with effort **unpinned** (`models.default.toml:9`), not exactly sonnet/medium.
- [ ] Every run record is **admitted per `registry-contract.json`**, or the report names each non-admitted run and the admission field that
      failed (non-null is not enough: `canaryOk` and `mechanismEngaged` must be true). `metrics.cost` is receipts-derived (`usd` may be null only
      with `usd_source` explaining why).
- [ ] `registry.json` holds 3 rows for stage `debug` and, for each of the two non-champion rows, an `uplift` block or `uplift: null` with its
      reason; it validates against `registry-contract.json`.
- [ ] Report (the owner's readout, `### Owner answers` Q4): runs done, seat minutes, API-equivalent `$` per stage run (per run `usd`, tokens,
      `wallMs`), what one matrix cell looks like, the cost of one whole-app build from existing compose build history / receipts quoted with
      source and `n` (or "no data"), whether the cells spread more than the oracle's own noise (Standing flag 4), the budget meter readings, and
      the leak gate result.
- Oracle: the registry validation command from G1 plus the leak gate.

### G6 COMP-STAGE-GRADING-6: `review` archetype (planted bugs, F1 score)

Files: `compose/lib/archetypes/review.js` (new), `compose/test/fixtures/stage-grading/hidden/review/` (new: one diff on the notes server
with N planted bugs + M correct changes, and the answer key), `compose/test/archetype-review.test.js` (new), `compose/CHANGELOG.md`
(existing). Contracts: `$F/archetype-contract.json`, `$F/stage-run-contract.json`.

- [ ] Input is the diff + code; the answer key stays hidden. Findings are read from `artifacts.outputPath` and matched to planted bugs by
      file + line window (tolerance stated in the archetype `version`).
- [ ] `accuracy` = F1 over the planted set; precision and recall in `detail`.
- [ ] `mechanismEngaged` = the output lists at least one finding referencing a changed file.
- [ ] Table test rows: all found (F1 1), none found (0), only false positives, half found; canned outputs, no model.
- [ ] Calibration (a proposed run, dispatched by the forge lane only after the owner approves post-readout runs): 1 champion run must score
      > 0 and < 1 (headroom both ways, design.md:65); if not, adjust N/M, bump `version`, record it. M1 waits on this record.
- Oracle: `node --test test/archetype-review.test.js` + the calibration record.

### G7 COMP-STAGE-GRADING-7: `test-authoring` archetype (mutation kill rate)

Files: `compose/lib/archetypes/test-authoring.js` (new), `compose/test/fixtures/stage-grading/hidden/test-authoring/mutants/` (new: K
pre-built mutant patches of the notes server), `compose/test/archetype-test-authoring.test.js` (new), `compose/CHANGELOG.md` (existing).
Contracts: `$F/archetype-contract.json`, `$F/stage-run-contract.json`.

- [ ] Input is correct code without its tests; the model writes tests.
- [ ] Oracle: the model's tests must pass on the correct code (else `accuracy 0`); then kill rate = fraction of the K mutants on which
      they fail. No mutation-testing dependency is added.
- [ ] `mechanismEngaged` = at least one test file was written and executed.
- [ ] Table rows: tests fail on correct code (0), kill none, kill all, kill half.
- [ ] Calibration (proposed run, as G6): 1 champion run strictly between 0 and 1.
- Oracle: `node --test test/archetype-test-authoring.test.js` + calibration record.

### G8 COMP-STAGE-GRADING-8: `implement` archetype (hidden golden suite)

Files: `compose/lib/archetypes/implement.js` (new), `compose/test/fixtures/stage-grading/hidden/implement/` (new: canonical design + plan +
skeleton, hidden golden suite), `compose/test/archetype-implement.test.js` (new), `compose/CHANGELOG.md` (existing). Contracts:
`$F/archetype-contract.json`, `$F/stage-run-contract.json`.

- [ ] `accuracy` = hidden golden suite pass fraction; the existing judge (`experiment-judge.js`) adds `detail.judge` when the spec enables
      it, and never enters `accuracy`.
- [ ] Table rows: 0%, partial, 100%, build error (0 with reason).
- [ ] Calibration (proposed run, as G6): 1 champion run strictly between 0 and 1.
- Oracle: `node --test test/archetype-implement.test.js` + calibration record.

### G9 COMP-STAGE-GRADING-9: `plan` archetype (rubric; Claude-only candidates)

Files: `compose/lib/archetypes/plan.js` (new), `compose/test/fixtures/stage-grading/hidden/plan/` (new: canonical design + rubric of
must-cover items, sequencing rules, AC checks), `compose/test/archetype-plan.test.js` (new), `compose/CHANGELOG.md` (existing). Contracts:
`$F/archetype-contract.json`, `$F/stage-run-contract.json`, `$F/judge-contract.json`.

- [ ] The objective half (each rubric item covered: string/heading match, dependency order valid against the rubric's DAG, every AC is a
      checkbox) is computed without a model from `artifacts.outputPath`; the subjective half goes to the J1 panel.
- [ ] `accuracy` = rubric fraction; panel agreement in `detail`; `accuracy: null` when the panel disagrees beyond `disagreementMax`.
- [ ] Rows from this archetype are written `triaged` / `JUDGED_UNPROMOTED` until J2 promotes them (asserted).
- [ ] Candidates on this stage are Claude only (C=2; `### Owner change`, ~09:0x line); `plan` declares `judged: true`, so G2's `validateSpec`
      refuses a Codex candidate with `JUDGED_STAGE_CLAUDE_ONLY` (test row).
- [ ] Table rows over canned plans: complete, missing items, wrong order, prose AC.
- [ ] Calibration (proposed run): 1 champion run + its panel calls; recorded, not gated (the gate is J2).
- Oracle: `node --test test/archetype-plan.test.js` (panel faked).

### G10 COMP-STAGE-GRADING-10: `design` archetype (rubric; Claude-only candidates)

Files: `compose/lib/archetypes/design.js` (new), `compose/test/fixtures/stage-grading/hidden/design/` (new: goal + constraints, rubric of
must-address decisions), `compose/test/archetype-design.test.js` (new), `compose/CHANGELOG.md` (existing). Contracts:
`$F/archetype-contract.json`, `$F/stage-run-contract.json`, `$F/judge-contract.json`.

- [ ] `accuracy` = fraction of must-address decisions the panel marks addressed; `null` above `disagreementMax`.
- [ ] Rows written `triaged` / `JUDGED_UNPROMOTED` until J2 promotes; Claude-only candidates (as G9).
- [ ] Table rows over canned design docs: all addressed, half, none, off-topic.
- [ ] Calibration (proposed run): 1 champion run + its panel calls.
- Oracle: `node --test test/archetype-design.test.js` (panel faked).

### P1 COMP-STAGE-GRADING-11: fleet prior import

Files: `compose/lib/experiment-prior.js` (new), `compose/test/experiment-prior.test.js` (new), `compose/CHANGELOG.md` (existing). Contract:
`$F/registry-contract.json`.

- [ ] Reads `python3 ~/.claude/scripts/estimate.py stats --project all --by-author-model` output (captured text, passed in) and writes
      `state: "prior"` rows for stage `implement`, `vector.accuracy` = first-pass CLEAN fraction, with `as_of` and `n` kept.
- [ ] Prior rows never set `latest`, never feed uplift or assembly (asserted).
- [ ] Parse failure refuses by name; it never writes a partial row.
- Oracle: `node --test test/experiment-prior.test.js` over the two lines quoted in `## Prior art checked`.

### M1 COMP-STAGE-GRADING-13: objective matrix measurement gate (run + report)

Run unit, dispatched by the forge lane **after the owner approves its runs** post-readout. It produces the accepted two-arm rows that A1's
live selection and V1 need (review F2).

Files: `$F/experiments/matrix-review.json`, `$F/experiments/matrix-test-authoring.json`, `$F/experiments/matrix-implement.json` (new specs),
`$F/experiments/<id>-exp/runs/` (new, produced), `$F/experiments/registry.json` (existing after G5), `$F/reports/matrix-objective.md` (new), `$F/experiments/matrix-decisions.json` (new, produced).
Contracts: `$F/stage-run-contract.json`, `$F/registry-contract.json` (`#measurementDecision`).

- [ ] Each spec: C=3 (sonnet-5-5/medium, opus-5-5/medium, `codex::standard`), `reps: 3`, `parallelism: 1`, a `budget` per `## Run budget`.
      Each spec names its stage's champion arm: the candidate whose resolved agent is closest to the shipped step's resolved agent (implement →
      implementer role default `claude`; review → reviewer role default `codex`, `build.js:4177-4178`), with the residual difference recorded
      (as G5 does for `fix`; the exact resolution of a bare role provider is read by the author, unverified here).
- [ ] `debug` reuses G5's 9 records through B1's runKey when the compatKey matches (no dispatch); otherwise its 9 runs are re-dispatched and
      counted.
- [ ] Oracle: G1's registry validation passes, and per objective stage (debug, review, test-authoring, implement) there are ≥ 3 admitted runs
      per arm for the champion and each candidate in one compatKey; the report prints, per stage, `uplift` or its null reason.
- [ ] **No-signal rule:** a stage whose uplift is null, whose calibration was outside (0,1), or which trips Standing flag 4 is marked
      `noSignal` in the report. A1 keeps the champion on a `noSignal` stage; V1 excludes it from the prediction; if both V1 stages (implement,
      review) are `noSignal`, V1 does not run and the readout goes to the owner.
- [ ] The decisions are written to `$F/experiments/matrix-decisions.json`, valid against `registry-contract.json#measurementDecision`
      (one entry per objective stage); the report renders them, it is not their source.
- [ ] Leak gate clean.

### R1 COMP-REALWORLD-FIXTURE-1: end-to-end fixture (build runner)

Files: `compose/lib/archetypes/end-to-end.js` (new, `runner: "build"`), `compose/test/fixtures/stage-grading/hidden/end-to-end/` (new:
graded acceptance criteria + hidden tests for "build the notes server from the goal"), `compose/lib/experiment.js` (existing: lift
`ARCHETYPE_RUNNER_UNSUPPORTED`; the whole-build path calls the archetype oracle after `collect` when the archetype's runner is `build`),
`compose/lib/archetypes/index.js` (existing after G3: register `end-to-end`), `compose/test/archetype-end-to-end.test.js` (new),
`compose/CHANGELOG.md` (existing). Contracts: `$F/archetype-contract.json`, `$F/stage-run-contract.json`.

- [ ] Input is the goal only (no canonical upstream artifacts, design.md:49); configs use `implementer`/`reviewer` per the discriminator.
- [ ] `accuracy` = fraction of graded acceptance criteria met (hidden tests + build success); judge in `detail` only.
- [ ] The whole-build path with no archetype is unchanged (existing engine tests green).
- [ ] Calibration (proposed run, after D1 has landed so the sandbox carries the shipped sidecar): 1 champion build must score strictly
      between 0 and 1 (design.md:65); record its `usd` and `wallMs` (they set the build cap in `## Run budget`).
- Oracle: `node --test test/archetype-end-to-end.test.js` with a fake build runner + the calibration record.

### R2 COMP-REALWORLD-FIXTURE-2: per-step attribution in end-to-end runs

Files: `$F/stage-run-contract.json` (existing after G1), `compose/lib/experiment-metrics.js` (existing),
`compose/test/experiment-metrics-steps.test.js` (new), `compose/CHANGELOG.md` (existing).

- [ ] **First:** extend `$F/stage-run-contract.json` with `metrics.steps[] {stepId, model, effort, tokensIn, tokensOut, usd, wallMs}`,
      `stepsIncomplete: bool` and `stepsMissing: int`; `_changelog` line + one valid example record.
- [ ] `collect` adds `metrics.steps[]` by grouping the sandbox dispatch-ledger rows on `step_id` (not build history, which has no per-step
      tokens: `build-history.js:89-102`); `effort` comes from `effort_executed` (null stays null).
- [ ] Sum over steps equals the run's `cost` totals within rounding, or the record carries `stepsIncomplete: true` with `stepsMissing`
      counted.
- [ ] Rows with no `step_id` are counted under `stepId: null`, never dropped.
- Oracle: `node --test test/experiment-metrics-steps.test.js` over a canned ledger.

### A1 COMP-PIPELINE-ASSEMBLY-1: matrix → assembly artifact

Files: `$F/assembly-contract.json` (new), `compose/lib/experiment-assemble.js` (new), `compose/bin/compose.js` (existing: `compose experiment
assemble <registry.json> --objective <max-accuracy-under-usd|accuracy-per-usd> [--usd-cap N] [--catalog-digest D] --decisions <matrix-decisions.json> --out <path>`),
`compose/test/experiment-assemble.test.js` (new), `compose/CHANGELOG.md` (existing). Contracts: `$F/registry-contract.json`,
`$F/assembly-contract.json`. Starts after M1 (graph edge, review r2 R2-1); tests use canned registries and canned decision files; its live use is inside V1.

- [ ] **First:** write `$F/assembly-contract.json` (`_source`, `_roadmap`, `_changelog[]`): the two objectives, the selection rule below,
      tie order, refusal codes, and the artifact `{profiles, roles {implementer, reviewer}, perStep [{step, rowId, decision}], bugFixProfiles
      (labelled unvalidated), objective, usdCap, catalogDigest, significant}`.
- [ ] **Eligible rows:** only `measured` rows that are admitted per `registry-contract.json`, whose champion is `measured` in the same
      compatKey, and whose `catalogDigest` equals the current catalog's (or the one named by `--catalog-digest`, else `STALE_CATALOG`). `prior`
      and `triaged` rows (including unpromoted design/plan rows) are never eligible. A stage whose `--decisions` entry (`registry-contract.json#measurementDecision`) is `noSignal` keeps the
      champion; a canned case where rows otherwise qualify as `measured` but the decision is `noSignal` proves champion retention.
- [ ] **Stage → target map**, read from the pipeline file (literal agent vs `$.input.*_agent`): implement → implementer role (`execute`);
      review → reviewer role (`review` in `review_check`, `test_review`) plus the sidecar entry `review_lenses` (Claude only: keep the
      `read-only-reviewer` template, change the tier); plan → `plan`, `blueprint`; design → `explore_design` (all in `build.stratum.yaml`);
      debug → `diagnose`, `fix` and test-authoring → `test` (in `bug-fix.stratum.yaml`). A step id missing from the pipeline refuses by name.
- [ ] Role-bound winners become role flags; literal-step winners become sidecar entries (preserve the template, replace the tier). A cell
      with no matching catalog tier refuses `ASSEMBLY_NO_TIER`. A provider change on a literal step refuses `ASSEMBLY_PROVIDER_CHANGE`
      (naming STRAT-AGENT-INTERP-TS) and keeps the champion for that step.
- [ ] **Objectives (F9).** Per stage per candidate: a = row `vector.accuracy.median`; c = row `vector.usd.median`, null if any admitted run's
      usd is null, and c ≤ 0 is treated as unknown. `max-accuracy-under-usd --usd-cap N`: the cap is for the **whole assembled pipeline per
      run**: Σc over participating stages ≤ N, maximize Σa (equal weights), exhaustive over candidate combinations (≤ 3^6), unknown-cost
      candidates ineligible; infeasible → `ASSEMBLY_CAP_INFEASIBLE` naming the cheapest known total. `accuracy-per-usd`: per stage, max a/c;
      unknown c ineligible; a stage with no eligible candidate keeps the champion (`COST_UNKNOWN`); more than 20% null-usd rows among the
      candidate rows considered → refuse `COST_AXIS_UNKNOWN` (Standing flag 6, now in the AC). Ties: higher a, then lower c, then champion,
      then cellKey. Latency is excluded in v1 (stated in the contract). The artifact marks `significant: false` where a chosen non-champion's
      `uplift.ci95` contains 0.
- [ ] **Precomputed oracle** (stages implement and review, champion S on both; a / c):
      implement S .60/.40, O .80/1.20, X .75/.50; review S .50/.20, O .70/.90, X .65/null.
      (1) `--usd-cap 1.50`: the per-stage affordable winners O+O total 2.10 > cap; the correct team is **implement X, review O**, Σa 1.45,
      Σc 1.40. (2) `accuracy-per-usd`: implement S = 1.5 ties X = 1.5 → higher a → **X**; review X ineligible → **S** (2.5); null share
      1/6 = 17% < 20%. (3) `--usd-cap 0.50` → `ASSEMBLY_CAP_INFEASIBLE` (cheapest 0.60). (4) Tie: with review S and O both .70/.20 → champion
      **S** under either objective. (5) Set review O usd null too → 2/6 = 33% → `COST_AXIS_UNKNOWN`. (6) Any c = 0 → treated unknown.
- [ ] Output: `--out <path>` writes the artifact and, beside it, `<stem>.profiles.json` (the `profiles` member as a standalone sidecar that
      D1's `workflow.profiles` can name). `profiles` is validated by the shipped `normalizePipelineProfiles` (`pipeline-profiles.js:68`), so
      the resolver reads it as its `preset` source unchanged; the test includes a sidecar the validator accepts and one it must refuse.
      `perStep[]` records each step's registry `rowId` and decision. `bugFixProfiles` is labelled unvalidated (no shipped
      `bug-fix.profiles.json` exists).
- Oracle: `node --test test/experiment-assemble.test.js` (cases 1-6 above + refusals + validator accept/refuse).

### D1 COMP-EXPERIMENT-DIMS-1: ingredient set and per-config workflow in the sandbox

Files: `$F/stage-run-contract.json` (existing after G1), `compose/lib/experiment.js` (existing: `_scaffoldSandboxProject`,
`experiment.js:224-229`), `compose/lib/experiment-stage.js` (existing after G2), `compose/test/experiment-dims.test.js` (new),
`compose/CHANGELOG.md` (existing).

- [ ] **First:** extend `$F/stage-run-contract.json` with `configs[].ingredients {model?, effort?, workflow?: {pipeline, profiles|null}}`,
      the cellKey rule (resolved ingredients), and the **precedence rules**: role defaults implementer `claude`, reviewer `codex`
      (`build.js:4177-4178`); a role flag carrying template/tier replaces the sidecar entry of every `$.input.<role>_agent` step, a bare provider
      keeps the sidecar's template/tier, literal-agent steps take only the sidecar (`build.js:4215-4222`). `_changelog` line + one example.
- [ ] `model` pins a catalog model id (makes Fable reachable); `effort` overrides the tier's effort; unknown model ids and efforts refuse
      via the catalog, never pass through.
- [ ] `workflow` copies the named pipeline **and its profiles sidecar** into each sandbox. Default = the shipped `pipelines/build.stratum.yaml`
      + `pipelines/build.profiles.json`. This fixes today's gap (experiment builds run without the sidecar: `## Prior art checked`); existing
      engine tests stay green or are updated with the reason stated in the commit, and the CHANGELOG names the behaviour change.
- [ ] B1's runKey takes the workflow's `pipelineDigest` and `profilesDigest` (contents, not paths; review r2 R2-5). Probe: edit a sidecar
      in place at the same path and re-run; only the configs using it redispatch, valid siblings are reused (dispatch count asserted).
- [ ] The sandbox record carries `profilesDigest` of the sidecar it ran with (`pipeline-profiles.js:180-184`), or null.
- [ ] `cellKey` reflects the resolved ingredients (two configs differing only in effort get two cells; test row).
- [ ] Workflow values for STRAT-PROOF rails on/off, council (COMP-COUNCIL-1) and sandbox (STRAT-CLAUDE-SANDBOX) are data rows added when
      those features exist; this unit ships the axis, not those rows.
- Oracle: `node --test test/experiment-dims.test.js` (fake build runner asserts the sidecar file is present in the sandbox and its digest
  recorded).

### V1 COMP-REALWORLD-FIXTURE-3: assembled vs homogeneous champion (first validated pipeline)

Files: `$F/experiments/e2e-validate.json` (new spec), `$F/experiments/assembly-v1.json` and `$F/experiments/assembly-v1.profiles.json`
(new, produced by A1's CLI), `$F/experiments/e2e-validate-exp/runs/` (new, produced), `$F/reports/e2e-validate.md` (new). Contracts:
`$F/stage-run-contract.json`, `$F/assembly-contract.json`, `$F/registry-contract.json#measurementDecision` (reads
`$F/experiments/matrix-decisions.json`).

- [ ] Participating stages = **implement and review only** (the stages the build pipeline exercises through swappable targets). debug and
      test-authoring (bug-fix pipeline) and design/plan (champion until J2) are **excluded from the prediction**. A participating stage that M1
      marked `noSignal` in `matrix-decisions.json` is also excluded (a canned noSignal case proves it); if both are, V1 does not run and goes to the owner (M1 no-signal rule).
- [ ] Champion config = the shipped pipeline + its sidecar (D1's default workflow) + default roles written explicitly (implementer `claude`,
      reviewer `codex`, `build.js:4177-4178`; so the champion's review uses Codex). Assembled config = `workflow {pipeline:
      build.stratum.yaml, profiles: assembly-v1.profiles.json}` + `roles` from the assembly artifact.
- [ ] Two required builds on R1's fixture at `reps: 1` (design.md:22): champion and assembled. Two optional builds (owner budget answer):
      homogeneous opus (roles + sidecar tiers set to opus-5-5) and homogeneous Codex (Codex in role-bound steps only; literal steps stay
      Claude).
- [ ] **Receipts check (F3):** for every exercised step, the sandbox dispatch-ledger rows' `(model, effort_executed)` (via R2's
      `metrics.steps[]`) equal the assembly's intent, else V1 fails naming the step. A null `effort_executed` is reported `effortUnverified`,
      never a pass.
- [ ] Report: end-to-end `accuracy`, `usd`, `wallMs` per build; `metrics.steps[]` per build; **predicted vs actual gap** (sum of the
      participating stages' chosen uplift vs the measured end-to-end delta, design.md:49).
- [ ] States plainly that reps=1 cannot separate a small win from noise, and what n would.
- Oracle: every record valid against `stage-run-contract.json`; receipts check passes; leak gate clean.

### J1 COMP-JUDGE-CALIBRATION-1: judge panel

Files: `$F/judge-contract.json` (new), `compose/lib/experiment-judge.js` (existing), `compose/test/experiment-judge-panel.test.js` (new),
`compose/CHANGELOG.md` (existing). Contract: `$F/judge-contract.json`. Starts after Q6 is answered.

- [ ] **First:** write `$F/judge-contract.json` (`_source`, `_roadmap`, `_changelog[]`): panel spec `{models[], rubric {items[], scale},
      disagreementMax}` (panel size ≥ 2, a spec field, per Q6) and result `{perJudge[], median, agreement, nullItems[]}`.
- [ ] `judge` accepts the panel spec and a per-archetype rubric; returns per-judge scores, the median, and agreement (max − min per item).
- [ ] The current single-judge call keeps its output shape (existing judge tests green).
- [ ] A judge that is also a candidate in the same experiment **refuses** in panel mode (today it only warns, `experiment.js:119-127`).
      Judges are Claude models only (`### Owner change`: no Codex judges).
- [ ] Above `disagreementMax` an item scores `null` and is listed in `nullItems`.
- Oracle: `node --test test/experiment-judge-panel.test.js` with a fake stratum client.

### J2 COMP-JUDGE-CALIBRATION-2: anchor set, calibration run, promotion

Files: `$F/judge-contract.json` (existing after J1), `$F/calibration/anchors/` (new: 6 design + 6 plan artifacts of known quality, 2 strong,
2 middling, 2 weak each, written by an Opus helper against the rubric), `$F/calibration/anchors/index.json` (new),
`$F/calibration/owner-scores.json` (new, owner-filled), `$F/calibration/panel-scores.json` (new, produced),
`$F/experiments/registry.json` (existing after G5), `$F/reports/judge-calibration.md` (new). Contracts: `$F/judge-contract.json`,
`$F/registry-contract.json`.

- [ ] **First:** extend `$F/judge-contract.json` with the anchors index `{anchors [{id, archetype, path, intendedTier:
      "strong"|"middling"|"weak"}]}`, the owner-scores and panel-scores shapes, and the calibration result; `_changelog` line + examples.
- [ ] The panel scores all 12 anchors; the report gives rank agreement with the owner's scores per archetype.
- [ ] Gate: the panel ranks strong > middling > weak on at least 5 of 6 anchors per archetype. If it passes, J2 calls G4's `promoteRows`
      with evidence matching `registry-contract.json#promotion` for that archetype's rows; if not, the rows stay `triaged`.
- [ ] The owner's scoring is one sitting after the skeleton readout (`### Owner answers`), logged as owner time.
- Oracle: the report's agreement table recomputed by a one-line `node -e` from `owner-scores.json` and `panel-scores.json`; the registry
  still validates after promotion.

---

## Walking skeleton

The smallest path to **one real matrix cell end to end**: G1 → (G2, G3, G4 in parallel) → B1 → G5.

| Required by the brief | Where it comes from |
|---|---|
| one stage | `debug` (G3): near-binary, objective oracle, cheapest to author |
| the models | three candidates (owner change): `claude::fast` (sonnet-5-5/medium, the reference arm), `claude::standard` (opus-5-5/medium), `codex::standard` (gpt-6.1-sol/high), resolved and recorded per cell |
| one fixture | the notes-server seed + one planted bug (G3) |
| the metric vector | `metrics.stage.accuracy` (G2/G3) + receipts-derived tokens/usd/wallMs (G2) + `outcome.completed`/retries (existing) |
| stored in the registry shape | `$F/experiments/registry.json` written by G4 with admission applied, validated against `registry-contract.json` |
| bounded and restartable | B1's budget (9 runs, timeout, token cap) and runKey reuse |

Nothing fans out (G6-G8, R1, R2, D1, P1, J1, A1, and through them M1, G9, G10, J2, V1) before G5's registry validates and the leak gate is
clean; the dependency table enforces it. Then the order is set by what unblocks the first assembled-and-validated pipeline: the three
remaining objective archetypes (G6, G7, G8) → M1, with R1, R2, D1 and A1 in parallel → V1. The judge branch (J1 → G9, G10 → J2) and P1 run
beside it and raise trust and coverage afterwards.

Known risk the skeleton exposes on purpose: a near-binary oracle may give every model `1` on every rep. That is a valid cell and a fail
of Standing flag 4, and the skeleton report says so instead of tuning the bug until models separate.

---

## Pace

From `estimate.py`, never recalled (re-run 2026-10-20 over the corrected 20-unit graph):

- `python3 ~/.claude/scripts/estimate.py plan <20-unit graph> --like forge --name COMP-MODEL-AB-DECISION`:
  `ESTIMATE COMP-MODEL-AB-DECISION P50 8h P80 15h chain 8 units 20 width 6 basis forge n=35 as_of 2026-10-20T01:10` (re-run by forge-e0
  after plan review r2 added D1 -> R1 and M1 -> A1);
  `agent-hours 4.5h (20 units x 0.2h dispatch->author_done p50)`; `chain 8 units, 8 rounds at width 6`.
- Critical-path authoring: 8 units on the chain (G1 → G2 → B1 → G5 → G6|G7|G8 → M1 → A1 → V1).
- **Measured overhead, separately** (`estimate.py waits --project forge`, as_of 2026-10-20T06:31): queue idle p50 0m (n=18), authoring
  p50 12m (n=36), test-slot wait p50 2m (n=20), landing wait p50 24m (n=36), post-land review p50 0m (n=3, unreadable).
  `estimate.py stats --project forge`: dispatch→landed p50 0.9h p80 1.9h, review rounds p50 2, n=35, as_of 2026-10-20T01:10.
- **Not in any figure:** model-run wall time for G5, M1, V1, J2 and the calibration runs (measured first in G5; V1 alone can be up to 4
  builds at a 30-minute default timeout each), owner time for J2's anchor scoring and for the post-readout run decision, and the time to
  answer Q6. The forge basis is mostly small units; G2 and G3 are larger than the median forge unit, so the authoring P50 is likely low for
  them (unverified until they are stamped). M1 and V1 are run units whose authoring is small but whose wait is model-run time.

No calendar date is given.

---

## Run budget

**One stop rule (B1).** Every archetype spec carries `budget {maxRuns, perRunTimeoutMs, maxUsdTotal|null, maxTokensTotal,
perRunTokenAssume}`. The engine stops *starting* runs when dispatched == `maxRuns`, or the USD meter reaches `maxUsdTotal` (used only while
every receipt so far has a `usd`), or the token meter reaches `maxTokensTotal` (a run with no usable receipt counts as `perRunTokenAssume`).
Running runs are not killed by the total cap; live units run at parallelism 1, so overshoot is at most one run. The **per-run hard stop is
the timeout** (stage: AbortSignal → agentRun cancel; build: the existing SIGKILL). Partial ledger rows are kept; unstarted runs are recorded
`skipped: "BUDGET_STOP"` and retried on restart. This replaces the round-1 wording that mixed a "2x ceiling" with a "hard stop".

**G5 values (APPROVED run count; values are plan defaults, unmeasured, the owner may change them):** `maxRuns 9`, `perRunTimeoutMs 900000`,
`maxUsdTotal null`, `maxTokensTotal 9000000`, `perRunTokenAssume 1000000`, `parallelism 1`.

**Later caps** (set only after the owner approves runs post-readout), three separate budgets:
- **bootstrap (review r2 R2-4):** the first calibration of each kind has no receipt to derive from. R1's calibration build and the first
  G9/G10 panel calls run under explicit USD / token / timeout limits that the owner's post-readout decision supplies and that are written
  into those specs before dispatch (null-USD fallback: the token limit). Every later cap below derives from the receipts those runs leave.
- **stage runs:** `maxUsdTotal` = approved runs × 2 × G5's max per-run usd; if any G5 usd is null, the token meter at approved runs × 2 × G5's
  max per-run tokens instead.
- **whole builds:** 2 × R1's calibration build usd per build (token fallback as above from R1's receipts).
- **panel calls:** 2 × the max judge-call usd from the G9/G10 calibration.

**Candidates** (`### Owner change`): Codex `codex::standard` is a candidate only on objectively scored stages. **C=3 on objective stages**
(sonnet-5-5/medium, opus-5-5/medium, codex::standard); **C=2 on judged stages** (design, plan: the two Claude candidates). The owner's word
"build" is read as the `implement` stage plus the `end-to-end` builds; under the narrower reading (end-to-end only), M1's implement matrix
drops to C=2, 6 runs instead of 9 (−3 stage runs), and nothing else changes.

**One run table** (the units table's "Live runs" column is the same numbers):

| Unit | Runs | Models | Status | Notes |
|---|---|---|---|---|
| G1-G4, B1, P1, R2, A1, D1, J1 | 0 | none | — | fake runners only |
| G5 skeleton | 9 stage runs | C=3 × reps 3, `debug` | **APPROVED** | sets the per-run `$`/token figures every later cap uses |
| G6, G7, G8 | 1 calibration each (3 stage runs) | champion | proposed | headroom check, 0 < accuracy < 1 |
| G9, G10 | 1 calibration each (2 stage runs) + 6 panel calls | champion + panel (3 judges assumed; Q6 may make it 2 → 4 calls) | proposed | recorded, gated later by J2 |
| R1 | 1 build | champion | proposed | after D1 lands; sets the build cap |
| M1 | 27 stage runs (review, test-authoring, implement × C=3 × reps 3) | C=3 | proposed | debug reuses G5's 9 via B1 when the compatKey matches, else +9 |
| V1 | 2 builds required, +2 optional | champion, assembled; optional homogeneous opus and homogeneous Codex (role-bound steps only) | proposed | reps 1 (design.md:22); champion's reviewer is Codex (`build.js:4178`) |
| J2 | 12 anchors × 3 judges = 36 panel calls | panel | proposed | + 1 Opus anchor-author helper (not an engine run) |

**In-graph totals:** 9 + 3 + 2 + 27 = **41 stage runs (9 approved)**, **3-5 whole builds** (R1 + V1), **42 panel calls** (6 + 36).
**Later, outside the graph:** judged-stage matrix fill for design + plan at C=2 × reps 3 = 12 stage runs + 36 panel calls, only after J2
promotes; Standing flag 4's escalation reps 3 → 5 = +6 stage runs per objective stage at C=3. A future Fable candidate (after D1, Q2) is not
budgeted.

---

## Standing flags

Checked at **every weekly readout** (Friday) and recorded in this plan's progress notes. The three Falsifiers are copied verbatim from
`shapes.md:96-104`; their window is "7 days after SESSION-MGMT-1's `f19-live-check.md` has all 4 boxes ticked". On 2026-10-20 that file does
not exist (`find /Users/ruze/reg/my/forge /Users/ruze/reg/my/SmartMemory/smart-memory-ops/units -name f19-live-check.md` returned nothing),
so the window has not opened; the flags are read weekly anyway and acted on once it opens.

1. **Pick A** if `grep '"manual-items"' ~/.claude/logs/dispatch.log` shows open ≥1 for 30+ min of
   ticks on 3+ days, the item's queue note naming no unattended-safe run (Claude needing isolation).
   Quota, admission, cap, collision or host-load holds do not count.
   - Command: `grep '"manual-items"' ~/.claude/logs/dispatch.log | tail -n 400`, then the queue note of each open item.
     Reading 2026-10-20: 2072 lines, the last two show `open: 1`; the 30-min/3-day test and the queue-note test were not run (window shut).
2. **Against B** if `python3 ~/.claude/scripts/estimate.py stats --project all --by-author-model`
   separates one stage decision: 30+ judged landings per model on one unit kind, non-overlapping 95%
   intervals on first-pass CLEAN. Today: opus 17/36, sonnet 19/43, author stage only, no kind.
   - Command as written. Reading 2026-10-20: opus 17/38, sonnet 19/48, no unit kind, so not separated.
3. **Throughput shape instead** if `estimate.py waits --project forge` shows dispatch→landed p50
   over 4h with landing wait the largest stage (n≥30), as 2.0 does.
   - Command: `python3 ~/.claude/scripts/estimate.py waits --project forge` plus `estimate.py stats --project forge`.
     Reading 2026-10-20: dispatch→landed p50 0.9h (n=35), landing wait p50 24m (n=36), so not tripped.

Added by this plan's analysis:

4. **Cells do not spread.** For any stage, the candidates' accuracy intervals overlap AND each arm's own min-max range is at least as wide as
   the gap between medians. Command: `node -e` over `$F/experiments/registry.json` printing per stage `uplift.ci95` (contains 0 → flag).
   Checked after every matrix run and weekly. Action: raise reps 3 → 5 once (budgeted above); if it persists, the stage is `noSignal` under
   M1's rule; on 3 of 4 objective stages, report to the owner that per-stage selection has no signal at this fixture size.
5. **Prediction gap.** After V1: if the measured end-to-end delta has the opposite sign to the summed per-stage uplift of the participating
   stages, granular grading is not predicting the whole (design.md:49). Command: the V1 report's gap line. Action: owner readout before any
   second assembly.
6. **Cost unknown.** Share of stage-run records with `metrics.cost.usd: null`. Command: `node -e` over the run records. Over 20% means the
   cost axis cannot drive the objective; enforced in code by A1 (`COST_AXIS_UNKNOWN` on `accuracy-per-usd`), monitored here weekly.
7. **Judge drift.** J2's anchor agreement re-run on any judge model change (catalog digest differs from J2's `judgeCatalogDigest`). Below
   the J2 gate → G4's `demoteRows` returns the design/plan rows to `triaged` / `JUDGE_DRIFT`.

---

## Unclassified

Not forced into a bucket:

1. **The recurring matrix re-fill** (re-running cells when the catalog digest or an archetype version changes, and the later judged-stage
   fill for design/plan after J2). The first objective fill is now a unit (M1); the recurring cadence is an operating cadence of the fixed
   engine, not a build piece. Recommendation: a standing operation owned by the forge lane, triggered by a catalog digest change or a new
   archetype version, budgeted per `## Run budget` and B1's stop rule; not a unit.
2. **Matrix as a `learned` source in COMP-MODEL-ROUTE.** Decision 8 defines learned evidence as ledger acceptance only, and the learned
   table is empty (`model-router.js:112`). Using matrix cells there would amend a decided resolver design. Not planned; A1 feeds the
   resolver through the `preset` source it already reads. Re-file only if V1 shows assembled pipelines winning and the owner wants routing
   to pick cells per dispatch.
3. **COMP-BENCH seed repo as an alternate end-to-end fixture** (shapes.md:54-55). COMP-BENCH-1..5 are all `PLANNED` with no content. It
   would be a second R1-style fixture; nothing in this plan needs it. Left out until R1 exists and a second fixture is wanted.

---

## Questions

For the owner (via s2-coord → s1-chat). Each has a recommendation. Q1-Q5 are answered (blocks below); Q6 is open.

1. **Codex as a measured candidate? ANSWERED: yes, on objectively scored stages only.** Codex `codex::standard` (gpt-6.1-sol/high) is a
   candidate on debug, review, test-authoring, implement and the end-to-end builds (C=3); design and plan stay Claude-only (C=2); judges
   stay a Claude panel. Pointer: `### Owner change` (both bullets). *Provenance: the original recommendation here was "no Codex candidates in
   v1" (Codex closed to reviews 2026-10-19); the owner reversed it 2026-10-20 ~08:4x ("add codex") and limited it ~09:0x ("do not bother
   scoring codex on design and planning yet").*
2. **Which Claude candidates? ANSWERED:** sonnet-5-5/medium vs opus-5-5/medium (`### Owner answers`), joined by codex::standard on objective
   stages (`### Owner change`). Still the recommendation, not approved: add Fable (`claude-fable-5-1`) as a further candidate only after D1,
   and leave Haiku out as a candidate (fleet rule: never Haiku).
3. **Who judges design/plan? ANSWERED:** a Claude panel of models not under test, gated by J2's human anchor set (`### Owner answers`). Its
   size is not satisfiable as written: see Q6.
4. **Run budget cap. ANSWERED:** G5 only, 9 stage runs (`### Owner answers` Q4, count per `### Owner change`); everything else is decided
   after G5's readout. `## Run budget` lists the proposed post-readout runs and the stop rule for that decision.
5. **Leak gate vs STRAT-CLAUDE-SANDBOX. ANSWERED:** proceed behind the before/after `git status` leak gate (`### Owner answers` Q5).
6. **Judge panel size (new, fix round 1; decide before J1, blocks J1 only, not G1-G5).** With sonnet-5-5 and opus-5-5 under test, the only
   Claude models left are fable-5-1 and two Haiku models (`stratum/ts/src/config/models.default.toml:12`), and the fleet bars Haiku, so a
   3-model Claude panel "of models not under test" cannot be formed. **Recommendation:** J1 makes panel size a spec field (minimum 2) and the
   panel is Fable 5.1 plus Haiku 5.5 as a **judge only** (never a candidate or author), gated by J2's anchor set, which measures judge
   quality directly. Alternative: a Fable-only single judge, gated by J2.

### Owner answers (2026-10-20 08:2x, via s1-chat; recorded by forge-e0)

- **Q4: skeleton only, 6 runs.** Run G5 (C=2 x reps 3, `debug`) and nothing else live. G5's readout to the owner gives: runs done, seat
  minutes, API-equivalent `$` per stage run, what one experiment result (one matrix cell) looks like, and the cost of one **whole-app build**.
  The skeleton runs no build, so the build figure comes from existing compose build history / receipts (per-step `cost_usd`,
  `durationMs`, tokens; design.md "Gap to close"), quoted with its source and `n`, or "no data". **The rest of the 51/4/42 budget (G6-G10
  calibrations, the campaign, R1, V1, J2) is decided after that readout; no live run beyond G5's 6 starts without it.**
- **Q5: default accepted.** Live runs go ahead before STRAT-CLAUDE-SANDBOX behind the before/after `git status` leak gate; any leak stops them.
- **Q1-Q3: accepted as recommended.** No Codex candidates; v1 = sonnet-5-5/medium vs opus-5-5/medium; 3-judge Claude panel of models not
  under test. J2's ~12-item human anchor set goes to the owner as **one short file to score after the skeleton readout, not before**.

### Owner change (2026-10-20 ~08:4x, direct in forge-e0's tab; supersedes Q1 and the Q4 run count above)

- **Q1 reversed: "add codex".** Codex `codex::standard` (gpt-6.1-sol/high, `stratum/ts/src/config/models.default.toml:29`) is a measured
  candidate. v1 candidates: sonnet-5-5/medium, opus-5-5/medium, codex::standard (C=3). The engine already takes `codex::<tier>`
  (`compose/lib/agent-string.js:23`, `compose/server/model-tiers.js:48`). Judges stay a Claude panel of models not under test. Rule exception
  recorded in `no-claude-coding.md` (named use only; no Codex authoring, fix rounds, plans or judges).
- **Skeleton = 9 stage runs** (owner pick: 3 models x reps 3, `debug`), replacing the 6. Same readout before anything else; G5's units and
  `## Walking skeleton` / `## Run budget` read C=3 wherever they say two models. Later stages' budgets (decided after the readout) scale with C=3.
- G5's leak gate covers the Codex runs too (Codex has its own sandbox; the before/after `git status` check still applies).
- **Owner, 2026-10-20 ~09:0x (direct in forge-e0's tab): "do not bother scoring codex on design and planning yet."** Codex is a candidate
  only on stages with automatic (objective) scoring: debug, review, test-authoring, build. The judged stages (design, plan) stay
  Claude-only candidates until the owner says otherwise. Reason raised by a side agent: a Claude-only judge panel may favour Claude over
  Codex on judged work. The G5 skeleton (debug only) is unaffected.
