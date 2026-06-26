# COMP-MODEL-AB-DECISION — Heterogeneous Pipeline Assembly

**Status:** PLANNED (umbrella). Parent: COMP-MODEL-AB (the measurement engine, COMPLETE).

## Goal

Assemble an **optimal heterogeneous pipeline**: route each pipeline stage to the model that is strongest at *that task type*, and know the cost/quality tradeoff of doing so. The earlier "replace the champion with a cheaper model wholesale" question is just the degenerate case where every stage uses the same model — so this goal subsumes it.

The infrastructure to *act* on the answer already exists: STRAT-AGENT-INTERP made each pipeline step's `agent:` independently interpolatable, so a per-stage model map (design→A, implement→B, review→C) plugs straight into a runnable spec. The deliverable of this work is therefore an **assembled, runnable heterogeneous pipeline config**, not a verdict on a page.

## Approach — grade granularly to *choose*, validate end-to-end to *trust*

Two layers that compose:

1. **Granular per-task-type grading** → a **model × stage capability matrix**. Task types are aligned to real pipeline stages (design/plan, implement, review, test-authoring, debug, ship), not difficulty tiers. Read down each column to pick the per-stage winner. Each stage uses its **strongest available oracle**, which is more trustworthy than one holistic judge over a whole build:
   - **review** — seed known bugs, score detection precision/recall (objective)
   - **debug** — failing repro fixed? (near-binary)
   - **test-authoring** — mutation / coverage score (objective-ish)
   - **implement** — tests pass + judge
   - **design/plan** — calibrated rubric (the one genuinely subjective stage)

2. **End-to-end validation on one realistic fixture** → run the *assembled* heterogeneous pipeline against the homogeneous champion on a single high-fidelity real-world app-creation build (reps=1). This confirms the assembled pipeline actually wins and captures **handoff effects** that isolated grading cannot see (a strong design from A may be cheaper for B to implement; a weak design poisons everything downstream).

## Children

- **COMP-STAGE-GRADING** — the model × stage capability matrix: per-stage task definitions + per-stage oracles; emits each model's quality/cost per stage. The core measurement.
- **COMP-PIPELINE-ASSEMBLY** — turn the matrix into a heterogeneous per-step spec (pick per-stage winners under a cost/quality objective), wired through STRAT-AGENT-INTERP so the output is a runnable pipeline. The headline deliverable.
- **COMP-REALWORLD-FIXTURE** — one high-fidelity real-world app-creation fixture, reps=1, in the user's idiom (AI-native, agentic, MCP/streaming, real backend, golden-flow tested). Recast as the **end-to-end validation harness** for the assembled pipeline (champion vs heterogeneous). Graded by acceptance criteria for partial credit; calibrated so the champion clears it with headroom (results must spread — all-pass and all-fail both yield no signal).
- **COMP-JUDGE-CALIBRATION** — multi-judge / human-anchored scoring for the subjective stages (design/plan) so the matrix is trustworthy.
- **COMP-EXPERIMENT-DIMS** — make tuning params (effort/temperature) and workflow variants first-class config dimensions alongside the model string, so a stage's "best spec" can include params/workflow, not just a model.

## Sequencing

COMP-STAGE-GRADING (matrix) is the foundation — it's what makes per-stage selection possible. COMP-PIPELINE-ASSEMBLY consumes it to emit the heterogeneous spec. COMP-REALWORLD-FIXTURE validates the assembled pipeline end-to-end. Judge calibration and config dimensions raise the trust/coverage of the matrix. Order by what unblocks a first assembled-and-validated heterogeneous pipeline.
