# COMP-MODEL-AB — Sandboxed model A/B experiment harness

**Status:** DESIGN (approved 2026-06-26) — implementation pending
**Owner:** compose
**Mode:** build

## Related Documents
- Plan: `./plan.md`
- Seams reused: `server/model-tiers.js` (tier→model), `server/project-root.js`
  (`COMPOSE_TARGET` isolation), `lib/build.js` (`resolveAgentConfig`,
  `implementerAgent`/`reviewerAgent`, `budget-ledger`, `build-history`), the
  `--codex` flag in `bin/compose.js`.

## Why

We want to answer "which LLM model builds software best through Compose?"
empirically: run the **same** dev example through the Compose build pipeline with
**different model configs** (implementer model now, reviewer model soon, a full
model×settings matrix eventually) and capture metrics for A/B analysis.

Compose already plumbs model selection: the agent string `provider:template:tier`
resolves a concrete model via `model-tiers.js` (`critical`→Opus, `standard`→Sonnet,
`fast`→Haiku; `codex`→GPT-5). What is missing is (1) a thin CLI seam to set the
implementer/reviewer agent strings per build, and (2) an external harness that runs
the same fixture across configs in **isolated sandboxes** and aggregates metrics.

## Approach (chosen: A — external runner)

Treat `compose build` as a black box invoked once per `(fixture × config × rep)`.
A new `lib/experiment.js` orchestrator provisions an isolated sandbox per run,
invokes a headless build with the run's implementer/reviewer agent strings,
scrapes metrics from that sandbox's artifacts, optionally runs an LLM-judge over
the produced diff, and aggregates across repetitions into a results dataset and a
comparison report. The only change to Compose core is two new build flags.

Rejected: (B) in-pipeline experiment mode — entangles the build pipeline and makes
the shared-state isolation problem harder; (C) `--codex`-only wrapper — only two
configs, never reaches Opus-vs-Sonnet.

## Components

```
compose experiment <experiment.json>          # new CLI verb (bin/compose.js)
  └─ lib/experiment.js                          # orchestrator
       ├─ load + validate spec → expand run matrix (fixture × configs × reps)
       ├─ per run (bounded by spec.parallelism):
       │    ├─ lib/experiment-sandbox.js   → provision isolated workspace + data dir
       │    ├─ invoke `compose build` headless w/ --implementer/--reviewer + isolated env
       │    ├─ lib/experiment-metrics.js   → collect cost / outcome / process
       │    └─ lib/experiment-judge.js     → LLM-judge the produced diff (optional)
       ├─ write per-run records → <expRoot>/runs/<runId>.json
       └─ lib/experiment-report.js → aggregate across reps → results.json + report.md
```

All new modules are `lib/experiment-*.js`. Each has one purpose and a typed
interface so it is testable in isolation:
- **experiment.js** — matrix expansion, run scheduling (bounded concurrency),
  top-level orchestration. Depends on the other four.
- **experiment-sandbox.js** — `provision(fixture, runId) → { workspace, env, cleanup }`.
  Pure I/O; no knowledge of models or metrics.
- **experiment-metrics.js** — `collect(sandbox, buildResult) → { cost, outcome, process }`.
  Reads sandbox artifacts only; no LLM calls.
- **experiment-judge.js** — `judge(diff, goal, judgeModel) → { scores, rationale }`.
  The only LLM-calling module besides the build itself.
- **experiment-report.js** — `aggregate(runs[]) → results` and `render(results) → md`.
  Pure functions over the run records.

## Experiment spec (user-authored, fixture-agnostic)

```json
{
  "id": "impl-model-shootout",
  "fixture": {
    "goal": "Build a URL-shortener REST API with tests",
    "seedRepo": null,            // null = greenfield (git init empty temp dir);
                                 // path/url+ref = clone/worktree at a pinned ref
    "seedRef": null
  },
  "configs": [
    { "label": "opus-impl",   "implementer": "claude::critical", "reviewer": "codex" },
    { "label": "sonnet-impl", "implementer": "claude::standard", "reviewer": "codex" },
    { "label": "codex-impl",  "implementer": "codex",            "reviewer": "claude::critical" }
  ],
  "reps": 3,                     // configurable N; aggregate reports median + spread
  "judge": { "enabled": true, "model": "claude::critical" },
  "parallelism": 2,
  "buildTimeoutMs": 1800000
}
```

Validation (fail-closed): unique config labels, every agent string parses via
`parseAgentString`, `reps >= 1`, `parallelism >= 1`, judge model (if enabled) is
NOT one of the configs under test (bias guard — warn, do not hard-fail).

## Model seam (the only Compose-core change)

Add to `compose build` (in `bin/compose.js`, threaded into `runBuild` opts):
- `--implementer=<agent-string>` — sets the implementer role agent string.
- `--reviewer=<agent-string>` — sets the reviewer role agent string.

`--codex` becomes sugar for `--implementer=codex --reviewer=claude`
(keep `--codex` working byte-identically — it is exercised across the suite).
Precedence: explicit `--implementer`/`--reviewer` override `--codex`; mutual-
exclusion error only if both `--codex` and a *conflicting* explicit flag are given.
Note: the reviewer default for `--codex` is plain `claude` (not `claude::critical`);
the mutual-exclusion check in `bin/compose.js` uses `reviewer !== 'claude'`.
Absent → today's defaults (`claude` implementer, `codex` reviewer). The strings
flow through the existing `implementerAgent`/`reviewerAgent` → pipeline
interpolation → `resolveAgentConfig` → `model-tiers` path unchanged.

**Implementation MUST trace** how `implementerAgent` (today a bare `'claude'`/
`'codex'`) becomes the interpolated step agent string, and confirm a tiered string
like `claude::critical` survives interpolation and reaches `resolveAgentConfig`
intact. Do not assume — verify with a real headless build emitting `step_model`.

## Sandbox isolation (the risky part — verify, do not assume)

Each run is fully isolated so runs never cross-contaminate and can run parallel:

1. **Workspace.** Greenfield fixture → fresh `git init` in a temp dir under
   `<expRoot>/runs/<runId>/workspace`. Seeded fixture → `git clone`/worktree of
   the seed at the pinned ref. Never the live repo.
2. **Data dir.** Set `COMPOSE_TARGET=<workspace>` for the build process so
   `getDataDir()` resolves to `<workspace>/.compose/data` — per-run build-history,
   budget-ledger, active-build. Verified primitive (`server/project-root.js`).
3. **No shared server writes.** `COMPOSE_TARGET` isolates the data dir but a build
   can still PATCH vision-state to a live `:4001` (this session's documented
   landmine: server-up vs server-down builds diverge and pollute shared state).
   The sandbox build MUST run with vision writes disabled / pointed at the sandbox
   (the no-op `visionWriter` pattern from `test/build-resume.test.js`). This is an
   acceptance gate, not an assumption: a sandbox build with the live `:4001` UP
   must leave the live vision-state byte-identical.
4. **Provenance.** Each run writes a `manifest.json`: config, reps index, Compose
   git SHA, fixture goal/seed ref, start/end timestamps — so runs are reproducible
   and attributable.
5. **Cleanup.** Keep `runs/<runId>/` artifacts (diff, build log, metrics). Optional
   `--prune-workspaces` removes the working tree after metrics are collected,
   keeping the diff patch.

## Metrics (all four axes)

Per run, `experiment-metrics.js` produces:
- **Cost / efficiency** — tokens in/out per model and call count (from
  `budget-ledger`), wall-clock (harness timing), derived `$` via a model→price
  table (`lib/experiment-pricing.js`, a small static table; unknown model → null
  cost, not a crash).
- **Outcome / correctness** — `completed` (reached COMPLETE?), final health score
  (already computed by the build), test pass rate + count (reuse `parseTestSummary`),
  files/lines changed (`git diff --stat` of the sandbox).
- **Process friction** — # review/fix-loop iterations, # gate failures, # retries,
  # escalations (from `build-history` + build stream events:
  `build_step_done`, `violations`, `step_model`).
- **Quality judgment** — `experiment-judge.js` runs a held-fixed judge model over
  `(goal, diff)` against a rubric (correctness / clarity / idiomaticity, 1–10
  each + one-line rationale), returning structured scores. The judge model is held
  constant across all configs and should not be a config under test. Judge failure
  degrades to `judge: null` for that run; it never aborts the experiment.

A run that crashes still yields a record: `outcome.completed=false` plus whatever
partial cost/process data exists. Failed runs are first-class data, not gaps.

## Results & report

- **Per-run record** `<expRoot>/runs/<runId>.json`:
  `{ runId, configLabel, rep, metrics:{cost,outcome,process}, judge, artifacts:{diffPath,logPath}, manifest }`.
- **Aggregate** (`results.json`): grouped by config, across reps — success rate
  (k/N completed), and for each numeric metric the median + min/max spread. Never
  average across a failed run's missing fields silently; report N-completed per cell.
- **Report** (`report.md`): a configs × metrics comparison table, winner-per-metric
  marked, with an explicit caveats block (N, observed variance, judge-bias note).
  `results.json` is the machine artifact; `report.md` is the human one. (An HTML
  view can reuse the existing milestone-report machinery later — out of scope v1.)

## Sequencing

- **v1 (this feature)** — `--implementer`/`--reviewer` flags + `compose experiment`
  + sandbox isolation + all-axis metrics (incl. judge) + `results.json`/`report.md`
  + tests. Implementer-model A/B is the headline; reviewer-model varies too because
  the seam is symmetric.
- **v2** — settings matrix (reasoning effort / thinking / prompt variant) as
  additional config dimensions (your option 4), and an HTML report view.

YAGNI for v1: no live cockpit visualization, no distributed/remote runners, no
auto-tuning/hill-climb over configs, no statistical significance testing beyond
median + spread.

**v1 known limitations:**
- `testsTotal`/`testsPass` in `outcome` are `null` on failed, aborted, or thrown
  builds even if tests ran before the failure. `_extractShipTestMetrics` only fires
  on the success path (ship completes + `testSummary.parsed=true`). Callers should
  treat null test metrics on `completed=false` runs as expected, not a data gap.

## Testing (per testing hierarchy)

- **Golden flow** — one trivial real fixture (e.g. "write a function `add(a,b)`
  with a passing test"), 2 configs, reps=1, run end-to-end against **real isolated
  backends** (real build in a real sandbox; nothing about the build mocked). Assert:
  `results.json` has both configs with every metric field populated, `report.md`
  renders the comparison table, and the live `:4001` vision-state is unchanged
  (isolation gate).
- **Error harness** (table-driven) — sandbox provision failure; build crash
  mid-run (record `completed=false`, metrics still written); judge failure
  (degrades to null); invalid spec (unique labels, agent-string parse, reps>=1);
  parallelism cap respected.
- **Unit** — matrix expansion (fixture×configs×reps count + labels), aggregation
  math (median/spread, N-completed), `$` cost derivation incl. unknown-model→null.

## Acceptance criteria

- [ ] `compose build --implementer=claude::standard` runs a build whose `step_model`
      events show the Sonnet model id for implementer steps (seam verified live).
- [ ] `--codex` remains byte-identical to pre-change behavior.
- [ ] `compose experiment <spec>` runs the full matrix in isolated sandboxes and
      writes `results.json` + `report.md`.
- [ ] A sandbox build with the live `:4001` UP leaves live vision-state byte-identical.
- [ ] All four metric axes are populated for a completed run; a crashed run yields
      a `completed=false` record, not a gap.
- [ ] Judge failure degrades to `judge:null` without aborting the experiment.
- [ ] Golden flow + error harness + unit tests green; full compose suite green.
