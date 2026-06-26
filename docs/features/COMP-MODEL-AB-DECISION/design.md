# COMP-MODEL-AB-DECISION — Substitution Decision Layer

**Status:** PLANNED (umbrella). Parent: COMP-MODEL-AB (the measurement engine, COMPLETE).

## Goal

Turn the A/B *engine* into a *decision tool*. For each candidate config (cheaper/faster model, different tuning parameters, or different workflow) standing in for a champion config, quantify the **quality delta** and the **cost/speed delta** with known confidence — so we can state: "swap X→Y, save N cost, lose M quality," and know which substitutions are safe and what the tradeoffs are.

## What the engine (COMP-MODEL-AB) already gives

Runs the same fixture across configs in isolated sandboxes; captures cost (tokens/usd/calls/wall), outcome (completed/health/tests/files/lines), process (review iters/gate/retries/escalations), and an opt-in LLM-judge quality score; aggregates median+spread with N-completed per cell → results.json + report.md. This is the honest measurement substrate. It is necessary but not sufficient for the decision.

## Gaps to close (each a candidate child feature)

1. **One realistic fixture (COMP-REALWORLD-FIXTURE).** Not a benchmark matrix and not N reps — a single high-fidelity *real-world application-creation* task, run **once per model config (reps=1)**. Golden-flow philosophy: one comprehensive end-to-end build exercises a model the way real usage does, so the fixture's *realism* (not breadth or repetition) is the signal. Deliverable is the authored fixture itself. The engine already supports `reps`; we simply set `reps=1`.

2. **Workflow + tuning as config dimensions (COMP-EXPERIMENT-DIMS).** The engine varies only the model string (`provider::tier`). It cannot independently vary tuning params (effort/temperature — tier bundles them) or pipeline/workflow variants. "Model A on workflow X vs model B on workflow Y" must become expressible.

3. **Calibrated judge (COMP-JUDGE-CALIBRATION).** Substitution confidence rests entirely on the judge. v1's judge is opt-in, single-model, single-pass. Needs a multi-judge panel and/or anchoring to human/reference scores, or the deltas are noise.

4. **Substitution frontier report (COMP-SUBSTITUTION-FRONTIER).** "Replace the *best* model" implies a champion and Δ-vs-champion. The engine is descriptive (per-config metrics); this adds a baseline designation, Δquality/Δcost, and a Pareto frontier flagging dominated configs and efficient swaps. Headline deliverable.

5. **~~Confidence from reps~~ — dropped.** With one run per model there is no rep-based statistics. Trust in a substitution comes from (a) the fixture being a faithful real-world build (#1) and (b) a calibrated judge (#3), not from N. No separate statistics feature.

## Sequencing

Frontier report (4) is the headline and runs against the single realistic fixture. The fixture (1) and config dimensions (2) define what's being compared; judge calibration (3) makes the quality numbers trustworthy enough to act on. Order by what unblocks a first real substitution recommendation.
