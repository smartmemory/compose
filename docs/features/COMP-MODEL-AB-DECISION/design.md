# COMP-MODEL-AB-DECISION — Substitution Decision Layer

**Status:** PLANNED (umbrella). Parent: COMP-MODEL-AB (the measurement engine, COMPLETE).

## Goal

Turn the A/B *engine* into a *decision tool*. For each candidate config (cheaper/faster model, different tuning parameters, or different workflow) standing in for a champion config, quantify the **quality delta** and the **cost/speed delta** with known confidence — so we can state: "swap X→Y, save N cost, lose M quality," and know which substitutions are safe and what the tradeoffs are.

## What the engine (COMP-MODEL-AB) already gives

Runs the same fixture across configs in isolated sandboxes; captures cost (tokens/usd/calls/wall), outcome (completed/health/tests/files/lines), process (review iters/gate/retries/escalations), and an opt-in LLM-judge quality score; aggregates median+spread with N-completed per cell → results.json + report.md. This is the honest measurement substrate. It is necessary but not sufficient for the decision.

## Gaps to close (each a candidate child feature)

1. **Fixture suite (COMP-FIXTURE-SUITE).** One fixture estimates quality on one goal. A trustworthy quality *level* needs a representative benchmark set across task types × difficulty. Today: one fixture per spec.

2. **Workflow + tuning as config dimensions (COMP-EXPERIMENT-DIMS).** The engine varies only the model string (`provider::tier`). It cannot independently vary tuning params (effort/temperature — tier bundles them) or pipeline/workflow variants. "Model A on workflow X vs model B on workflow Y" must become expressible.

3. **Calibrated judge (COMP-JUDGE-CALIBRATION).** Substitution confidence rests entirely on the judge. v1's judge is opt-in, single-model, single-pass. Needs a multi-judge panel and/or anchoring to human/reference scores, or the deltas are noise.

4. **Substitution frontier report (COMP-SUBSTITUTION-FRONTIER).** "Replace the *best* model" implies a champion and Δ-vs-champion. The engine is descriptive (per-config metrics); this adds a baseline designation, Δquality/Δcost, and a Pareto frontier flagging dominated configs and efficient swaps. Headline deliverable.

5. **Confidence (COMP-EXPERIMENT-CONFIDENCE).** Reps + spread are the foundation, but a substitution call needs "Y is within X% of champion at C confidence." Add significance/confidence framing on top of the rep data.

## Sequencing

Frontier report (4) is the headline and can be drafted against the current single-fixture engine. Fixture suite (1) and dimensions (2) widen coverage. Judge calibration (3) and confidence (5) make the numbers trustworthy enough to act on. Order by what unblocks a first real substitution recommendation.
