# COMP-MODEL-AB — Implementation Plan

**Design:** `./design.md`
**Approach:** A (external runner). Compose-core change is two build flags; the rest
is new `lib/experiment-*.js` modules treating `compose build` as a black box.

## Contract (data shapes — the source of truth)

```jsonc
// experiment spec (input)
{ "id": str, "fixture": { "goal": str, "seedRepo": str|null, "seedRef": str|null },
  "configs": [ { "label": str, "implementer": agentStr, "reviewer": agentStr } ],
  "reps": int>=1, "judge": { "enabled": bool, "model": agentStr },
  "parallelism": int>=1, "buildTimeoutMs": int }

// per-run record (output: <expRoot>/runs/<runId>.json)
{ "runId": str, "configLabel": str, "rep": int,
  "metrics": {
    "cost":    { "tokensIn": int, "tokensOut": int, "calls": int, "wallMs": int, "usd": num|null },
    "outcome": { "completed": bool, "health": num|null, "testsPass": int|null, "testsTotal": int|null,
                 "filesChanged": int, "linesChanged": int },
    "process": { "reviewIters": int, "gateFailures": int, "retries": int, "escalations": int } },
  "judge": { "correctness": int, "clarity": int, "idiomaticity": int, "rationale": str } | null,
  "artifacts": { "diffPath": str, "logPath": str },
  "manifest": { "composeSha": str, "fixtureGoal": str, "seedRef": str|null, "startedAt": str, "endedAt": str } }

// aggregate (output: <expRoot>/results.json)
{ "experimentId": str, "configs": [ { "label": str, "nCompleted": int, "nTotal": int,
    "metrics": { "<metricPath>": { "median": num, "min": num, "max": num } } } ],
  "generatedAt": str }
```

## Steps

### S1 — Build flags `--implementer` / `--reviewer` (Compose-core seam)  (existing: `bin/compose.js`, `lib/build.js`)
- [ ] Parse `--implementer=<agentStr>` / `--reviewer=<agentStr>` in the `build` arg
      handler; thread into `runBuild` opts (`opts.implementer`, `opts.reviewer`).
- [ ] In `lib/build.js`, where `implementerAgent`/`reviewerAgent` are derived
      (`~1191`), let explicit opts override the `--codex`-derived defaults.
      `--codex` stays sugar for `implementer=codex, reviewer=claude::critical`.
- [ ] Validate each via `parseAgentString`; reject an unparseable string with a
      clear error. Mutual-exclusion error only on a *conflicting* `--codex` + explicit flag.
- [ ] **Verify live:** a build with `--implementer=claude::standard` emits
      `step_model` events carrying the Sonnet model id for implementer steps. Trace
      the interpolation path; do not assume a tiered string survives it.
- [ ] `--codex` byte-identical regression: existing codex-path tests stay green.
- [ ] Unit/integration test for flag parsing + override precedence + parse-rejection.

### S2 — Sandbox isolation  (new: `lib/experiment-sandbox.js`)
- [ ] `provision({ fixture, runId, expRoot }) → { workspace, env, cleanup }`.
- [ ] Greenfield: `git init` temp workspace. Seeded: clone/worktree at `seedRef`.
- [ ] `env` sets `COMPOSE_TARGET=<workspace>` so the build's data dir is isolated.
- [ ] **Vision isolation (acceptance gate):** ensure the sandbox build does NOT
      write vision-state to a live `:4001` — disable vision / inject the no-op
      `visionWriter` (see `test/build-resume.test.js`). Prove it: a sandbox build
      with `:4001` UP leaves live vision-state byte-identical.
- [ ] Write `manifest.json` (composeSha via `git rev-parse`, fixture, timestamps).
- [ ] `cleanup({ pruneWorkspace })` keeps the diff patch + records; optional tree prune.
- [ ] Error-harness test: provision failure surfaces cleanly.

### S3 — Metrics collection  (new: `lib/experiment-metrics.js`, `lib/experiment-pricing.js`)
- [ ] `collect({ sandbox, buildResult }) → { cost, outcome, process }` reading only
      sandbox artifacts (budget-ledger, build-history, build stream, `git diff --stat`).
- [ ] Reuse `parseTestSummary` for testsPass/testsTotal; read health from build result.
- [ ] `experiment-pricing.js`: static model→`$/1M` table; unknown model → `usd:null`.
- [ ] A crashed build still yields a record with `outcome.completed=false`.
- [ ] Unit tests over fixture artifact files (no live build needed for the math).

### S4 — LLM judge  (new: `lib/experiment-judge.js`)
- [ ] `judge({ diff, goal, judgeModel }) → { correctness, clarity, idiomaticity, rationale }`.
- [ ] Dispatch via the existing agent runner (`stratum.runAgentText` or the
      structured agent path) pinned to `judgeModel`; structured rubric output.
- [ ] Failure → return `null` (degrade, never throw up the stack).
- [ ] Test: judge failure path degrades to null; happy path returns structured scores.

### S5 — Orchestrator  (new: `lib/experiment.js`)
- [ ] Load + validate spec (fail-closed validations from design).
- [ ] Expand run matrix (fixture × configs × reps) → ordered run list with stable runIds.
- [ ] Run with bounded concurrency = `spec.parallelism`; each run:
      provision → headless build (`--implementer`/`--reviewer`, isolated env, timeout)
      → collect metrics → judge → write `runs/<runId>.json`.
- [ ] Resilient: one failed run does not abort the experiment.
- [ ] Unit test: matrix expansion count + labels; concurrency cap respected.

### S6 — CLI verb + report  (existing: `bin/compose.js`; new: `lib/experiment-report.js`)
- [ ] `compose experiment <spec.json> [--prune-workspaces]` → calls `lib/experiment.js`.
- [ ] `aggregate(runs[]) → results.json` (median/spread, nCompleted/nTotal per config).
- [ ] `render(results) → report.md` (configs×metrics table, winner-per-metric,
      caveats block: N, variance, judge-bias).
- [ ] Unit tests: aggregation math (median/spread, partial-N), report renders.

### S7 — Golden flow + docs  (new test; existing `CHANGELOG.md`, `ROADMAP` via canon)
- [ ] Golden flow: trivial real fixture, 2 configs, reps=1, real isolated backends;
      assert results+report populated AND live vision-state unchanged.
- [ ] `CHANGELOG.md` entry in the implementing commit.
- [ ] Sample experiment spec at `docs/features/COMP-MODEL-AB/example-experiment.json`.

## Execution / review

- Codex implements per step; Opus + an independent Codex adversarial pass review
  each slice. Loop until the targeted tests + full compose suite are green and
  review is clean. Commit direct to compose `main` (no co-author lines).
- Pre-push runs the full suite — `:4001` must be DOWN for the push (coordinate as
  this session already did).
