---
date: 2026-06-26
session_number: 83
slug: model-ab-harness-review-rounds
summary: COMP-MODEL-AB shipped — sandboxed model A/B harness; 4 review rounds caught metric bugs the fake-runner tests hid
feature_code: COMP-MODEL-AB
closing_line: The fake artifact is the comfortable lie; the real path is the only thing worth measuring.
---

# Session 83 — COMP-MODEL-AB

**Date:** 2026-06-26
**Feature:** `COMP-MODEL-AB`

## What happened

We resumed a prior session whose flush note said COMP-MODEL-AB was "done and verified, just ship." It wasn't. The human asked to keep Codex in the loop and to maximize Codex's share of the work, so Opus orchestrated and verified while a Codex agent did the implementation.

The first Codex adversarial review immediately found that the harness's core metric axes were wrong on real builds — and the existing tests passed only because they injected a FAKE build runner that hand-wrote the exact artifact shapes the metrics code expected. The fakes were a comfortable lie. Four review rounds followed, each surfacing distinct, real defects that the test suite structurally could not catch:

- R1: empty diff (the real build commits during ship, so `git diff HEAD` is empty on success); process-axis counters keyed on stream events the build never emits; testsPass never populated; runId sanitization collisions.
- R2: `.compose/` bookkeeping contaminating the diff/stat; testsPass STILL null because the real build only computes counts internally.
- R3: the testsPass fix was wired to the GENERIC step path, but the real build INTERCEPTS the ship step and `continue`s before it — so the capture never ran on a real build. Twice the fix targeted a path the fake-runner masked. Fixed with a shared `_extractShipTestMetrics` helper on both ship paths, plus a build-level test that exercises the real intercepted-ship → history assembly.
- R4: seeded fixtures could carry stale/tracked `.compose/` state into the run (silently-wrong A/B numbers); resolved with an rmSync clean-slate per run. Failure-path test-null documented as a v1 limitation.

Final independent gate: REVIEW CLEAN. Full suite 4351/4351; pre-push gate green; pushed 338622a; COMP-MODEL-AB → COMPLETE.

Aside threads with the human clarified the bigger picture: the `--implementer`/`--reviewer` seam is the move OFF the hardcoded claude/codex duality toward configurability, but the provider set is still hard-gated to two connectors. The OpencodeConnector is fully built (it was the original codex backend) but currently benched — re-wiring it (T2-F5-OPENCODE-DISPATCH) plus extending the agent-string grammar is the real path to "any model."

## What we built

COMP-MODEL-AB sandboxed model A/B experiment harness:
- lib/agent-string.js (M) — validateAgentString, KNOWN_PROVIDERS, KNOWN_TIERS
- bin/compose.js (M) — --implementer/--reviewer flags + `compose experiment` verb
- lib/build.js (M) — opts.implementer/reviewer override; _extractShipTestMetrics helper persisting test_count/pass_rate to build-history on both the intercepted-ship and generic step paths (additive)
- lib/experiment-sandbox.js (new) — isolated per-run workspace (COMPOSE_TARGET + COMPOSE_PORT=19997 dead port); greenfield git-init or seeded clone; .compose/ gitignored AND rmSync clean-slate
- lib/experiment-metrics.js (new) — cost/outcome/process axes; baseline-diff filesChanged/linesChanged; real stream-signal process axis; reads test_count/pass_rate from history
- lib/experiment-pricing.js, lib/experiment-judge.js (new)
- lib/experiment.js (new) — validateSpec/expandMatrix/runExperiment (injectable runBuild), baseline commit, baselineFailed flag
- lib/experiment-report.js (new) — aggregate (median+spread, N-completed/cell) + render
- docs/features/COMP-MODEL-AB/{design.md (M), example-experiment.json (new)}
- tests (new/M): experiment-model-ab, experiment-wave2, experiment-orchestrator, build-history

## What we learned

1. Fake-runner tests that hand-write artifact shapes test the harness against its own assumptions, not against reality. Every real metric bug here was invisible to a green suite because the fake fabricated exactly what the metrics code wanted. When a consumer reads another component's output, at least one test must exercise the REAL producer path (or a faithful seam of it), or the wiring can be wrong in a way no assertion catches.
2. Independent adversarial review earns its keep precisely when the suite is green. Four rounds, four distinct real defects, zero red tests. The same-agent self-report twice claimed a fix worked when it didn't — the independent pass caught it both times.
3. A fix can target the wrong code path and still pass tests. The ship step is intercepted and `continue`s before the generic path; the capture lived on the generic path. The fake runner masked it. Lesson: when wiring into a pipeline, verify which branch the real input actually flows through before placing the hook.
4. For a measurement tool, silently-wrong numbers are worse than a crash. The seeded-fixture stale-history read would have reported another run's metrics as this run's. Clean-slate the sandbox state per run.
5. Opus-orchestrates / Codex-implements worked well under "maximize codex use" — but the teammate agent lagged a full round near the end and re-reported stale state. When a delegated agent stops advancing on a small, fully-specified change, do it directly rather than burn rounds; verification ownership stays with the orchestrator regardless.

## Open threads

- [ ] T2-F5-OPENCODE-DISPATCH: unbench the OpencodeConnector (add to VALID_AGENT_TYPES, route in factory.py + parallel_exec.py) and extend the agent-string grammar to carry an arbitrary provider_id/model_id — the real path to "any model" configurability beyond the hard-gated claude/codex pair.
- [ ] v1 limitations to revisit if they bite: process.retries counts top-level steps only (child/parallel completions emit retries:0); cost.calls = stepCount not raw model invocations; testsPass/testsTotal null on failed/aborted/thrown builds.
- [ ] Live end-to-end run of `compose experiment` with a real spec across model configs (all verification so far is via injected fake runners + unit assertions on real artifact shapes; no real multi-config build sweep has been executed).

---

*The fake artifact is the comfortable lie; the real path is the only thing worth measuring.*
