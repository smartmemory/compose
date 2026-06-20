# COMP-PIPE-EDIT-5 — Sub-flow Support (Collapse / Expand)

**Status:** Design (Phase 1). Wave 2 of the epic (with -6). The most complex
feature of the epic.
**Date:** 2026-06-21

## Related Documents
- Foundation: `docs/features/COMP-PIPE-EDIT-1/design.md`. Sibling: `.../COMP-PIPE-EDIT-6/design.md`.
- Sub-flow semantics ground truth: `pipelines/build.stratum.yaml` (`parallel_review`,
  `review_check`), `stratum-mcp/src/stratum_mcp/spec.py`, `…/executor.py`.

## How sub-flows actually work (from exploration)

- A **flow-step** is any step with a `flow:` key (`spec.py _step_type`); the model
  already sets `kind:'flow'` and carries `flow` in `_extra`.
- A sub-flow is a normal `flows.<name>` entry with an explicit **input declaration**
  `input: { <field>: {type, optional?} }` and a **single output** `output: <Contract>`.
  Example: `parallel_review.input` has `task/blueprint/diff/...`; `output: ReviewResult`.
- The parent flow-step supplies the sub-flow's `$.input` scope via its `inputs:` map
  (resolved in the parent scope), and the child's single returned object becomes the
  parent step's output (`$.steps.<flowStepId>.output`).
- **Ports therefore mean:** input ports = keys of `flows.<name>.input`; **exactly one
  output port** = the `output:` contract. There is no multi-output sub-flow.
- Step refs (`depends_on`, parallel `source`, inputs `$.steps.<id>`) are **flow-local**
  (`spec.py` X2). Nothing crosses a flow boundary except via the parent step's
  `inputs:` (in) and the single `output:` (out).
- Validation gaps to honor: spec.py does **not** check that a `flow:` ref resolves to
  an existing flow, and there is **no flow→flow cycle check**. So a collapse op must
  create the flow and the flow-step atomically and avoid self/cyclic refs itself.

## Goals
- **Collapse:** select a group of steps in the current flow and extract them into a new
  named sub-flow, replacing them with one flow-step that invokes it.
- **Expand:** open a sub-flow to edit its internals.
- **Ports visible:** the collapsed flow-step node shows its input fields and output
  contract.

## Decisions (scope — design-gate input)

1. **Constrained collapse: single-entry / single-exit (SESE), dependency-contiguous.**
   The selection must form a contiguous region with **at most one outbound producer**
   (the one grouped step whose output is consumed outside). This is required because a
   sub-flow has exactly **one** `output:` — a multi-output group cannot be represented
   without synthesizing a merge step. Non-contiguous or multi-output selections are
   **rejected with a clear reason**, not auto-merged. (The unconstrained version needs
   merge-step synthesis + multi-port modeling the runtime can't express.)
2. **Expand = switch to the sub-flow**, reusing the existing flow-switcher
   (`listEditableFlows` + the flow picker). No in-canvas compound collapse/expand and
   **no new cytoscape extension** — the canvas already renders one flow at a time, so a
   collapsed sub-flow is simply a `kind:'flow'` node, and "expand to edit internals" is
   selecting that flow. Lowest-risk, reuses everything.
3. **Ports rendered as text**, not real handles: extend `stepLabel` for `kind:'flow'`
   nodes to list the sub-flow's `input` keys and `output` contract. (Real port handles
   are out of scope; the wiring model is the parent `inputs:` map.)

## Architecture

### Boundary rewiring (the hard part) — `collapseToSubflow` (pure, model lib)
`collapseToSubflow(model, flowName, stepIds, newFlowName)` → `{ ok, reason? }`:
1. **Validate SESE** (reject with reason otherwise):
   - `stepIds` all in `flowName`, `newFlowName` unique across `model.flows`/`_doc.flows`,
     not equal to `flowName` (no self-ref).
   - Compute boundary edges over the **full** flow-local reference graph — the same
     fields `stepRefs` covers: `depends_on`, inputs `$.steps.<id>`, parallel `source`,
     AND gate routes `on_fail`/`on_approve`/`on_revise`/`on_kill` (design-gate
     correction — these are flow-local scalar refs too and must not be ignored):
     - **inbound** = ref from a selected step to a NON-selected step.
     - **outbound** = ref from a NON-selected step to a selected step.
   - **Only `depends_on` and inputs-`$.steps` boundary edges are rewireable**
     (depends_on → the flow-step's `depends_on`/ordering; inputs-`$.steps` → a sub-flow
     `input` port). **A boundary edge via `source` or any gate route is REJECTED**
     (design-gate correction): Stratum's `source` parser only accepts `$.steps.<id>`
     (it cannot be rewritten to `$.input.*`), and gate routes are intra-flow control
     transfer that cannot cross a flow boundary. Reject with a precise reason naming
     the offending edge.
   - Require **at most one distinct selected step** appears as an outbound producer
     (single output). Reject if two different selected steps are consumed outside.
   - Require the selection be contiguous (no outside step sits "between" selected
     steps on a path that re-enters the selection — i.e. removing the group leaves a
     valid DAG). Reject otherwise.
2. **Build the sub-flow:** create `model.flows.push({name:newFlowName, steps:[…moved]})`
   AND inject `model._doc.flows[newFlowName] = { input:{…}, output:<Contract|null>, steps:[] }`
   (the serializer iterates `_doc.flows` — a new flow MUST be injected there).
   - For each distinct inbound external producer ref, mint an input field
     `in_<n>` (or a name derived from the producer), set
     `_doc.flows[newFlowName].input[field] = {type:'string'}` (best-effort type), and
     **rewrite the selected steps' refs** to `$.input.<field>` (reuse `rewriteStepsPath`
     style; this is the first **cross-flow** rewrite helper — net-new).
   - The single outbound producer's `output_contract` (if any) becomes
     `_doc.flows[newFlowName].output`.
3. **Replace in the parent flow:** remove the selected steps; insert one flow-step
   `{ id:newFlowName (or unique), kind:'flow', _extra:{flow:newFlowName},
   inputs:{ <field>: "$.steps.<producer>.output…" }, depends_on:[…outside producers…] }`
   at the position of the first removed step. Outbound consumers' refs to the grouped
   producer are rewritten to the flow-step id; plain `depends_on` into the group →
   flow-step `depends_on`.
4. **`modelToSpecObject` fix:** today it only emits flows present in `doc.flows`; a
   collapse adds to `_doc.flows` so it is emitted. Verify new-flow round-trip.

### Serializer / save — collapse needs a SPEC-WIDE save (design-gate correction)
- A collapse touches **two** flows (the parent, now holding the flow-step, and the
  brand-new sub-flow), but today the client saves only `editorSelectedFlow` and the
  server's `flowsToWrite` is that single flow. So a collapse-then-save would persist
  only the parent and the new sub-flow would exist **only in memory**. Collapse must
  therefore latch the shared `editorSaveScope='spec'` (see -6) so the next save omits
  `flowName` and the server writes every model flow. The latch persists until
  save/reload, so a later single-flow edit can't revert to a flow-scoped save that
  drops the new sub-flow.
- The new flow won't exist on disk, so the save's per-flow step merge must **create**
  a missing `flows.<name>` node (steps + `input` + `output`) rather than only mutating
  existing flows (Wave 1's save handles existing flows + contracts; new-flow creation
  is the -5 server addition). `modelToSpecObject` must likewise emit the new flow
  (it injects into `_doc.flows`, which the serializer iterates).

### UI
- **Collapse:** multi-select steps on the canvas (shift-tap to add to a selection set),
  a "Collapse to sub-flow" toolbar action prompting for the new flow name; on reject,
  surface the reason. On success, switch nothing (stay in parent; the group is now one
  node) and relayout.
- **Expand:** a flow-step node gets an "open" affordance (double-tap or an inspector
  button) that sets `editorSelectedFlow` to the sub-flow.
- Disabled for read-only (v0.1) specs.

## Non-Goals
- Multi-output sub-flows / automatic merge-step synthesis (rejected, not built).
- In-canvas compound expand/collapse rendering (use the flow-switcher).
- Flow→flow cycle *execution* concerns beyond refusing a self-referential collapse.

## Testing strategy (node + Vitest)
- **Model lib (pure):** `collapseToSubflow` happy path (SESE group → new flow with
  input ports + single output + parent flow-step; refs rewritten); rejects multi-output;
  rejects non-contiguous; rejects duplicate/self flow name; `modelToSpecObject` emits
  the new flow.
- **Server golden:** save a model with a newly-collapsed sub-flow → re-read → the new
  `flows.<name>` exists with steps/input/output, the parent flow-step references it,
  untouched flows preserved.
- **Store + UI (Vitest):** collapse action validates + surfaces rejection reasons;
  expand switches the selected flow.

## Risks
- **Cross-flow rewrite is net-new** (all existing ref logic is flow-local) — highest-risk
  area; covered by table-driven model tests.
- **Type inference for input ports** is best-effort (`{type:'string'}`); the user can
  refine via the (sub-flow's own) editing. Documented.
- **Atomic flow+flow-step creation** — a flow-step pointing at a missing flow passes
  spec validation but breaks at runtime; `collapseToSubflow` always creates both.
