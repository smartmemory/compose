# COMP-PIPE-EDIT Wave 1 — Wiring, Contract Editor, Template Save

**Status:** Design (Phase 1). Wave 1 of the epic's remainder (-3, -4, -7), built on
the shipped foundation (-1 canvas, -2 inspector, save round-trip).
**Covers:** COMP-PIPE-EDIT-3 (dependency wiring), -4 (contract editor), -7
(template save). Wave 2 (-6 YAML sync, -5 sub-flows) is separate.
**Date:** 2026-06-20

## Related Documents
- Foundation: `docs/features/COMP-PIPE-EDIT-1/design.md` (model, canvas, save).
- Sibling stubs: `docs/features/COMP-PIPE-EDIT-4/design.md`, `.../COMP-PIPE-EDIT-7/design.md`.
- Model lib: `src/lib/pipeline-model.js`. Backend: `server/pipeline-routes.js`.

## What exists (reused)
- `useVisionStore` editor slice (load/select/update/add/rename/delete/save).
- `PipelineEditorCanvas.jsx` — cytoscape, selected-flow nodes + `depends_on`
  edges, `tap`/`cxttap`, synthetic element ids, `relayout()`.
- `StepInspector.jsx` — edits step fields incl. `output_contract` dropdown sourced
  from `model.contracts` + `TaskGraph`.
- `POST /api/pipeline/save` — in-place YAML Document mutation of flow steps.
- `validateFlow` — cycle detection + reference integrity (already covers a
  `depends_on` cycle).
- Contracts shape: `contracts: { <Name>: { <field>: { type, values?, optional? } } }`.

## COMP-PIPE-EDIT-3 — Dependency wiring

The inspector does **not** edit `depends_on` today; the canvas only *renders* it.
Wiring makes `depends_on` editable on the canvas.

- **Connect interaction: a toolbar "Connect" toggle (no new dependency).** In
  connect mode, tapping a source node then a target node adds the edge; a second
  tap on the same node cancels. This is chosen over adding `cytoscape-edgehandles`
  to keep the lean-deps stance from -1 and because the wiring *logic* (not the
  drag gesture) is the load-bearing, testable part. The spec's "drag from port to
  port" intent — create `depends_on` edges visually with invalid-feedback — is met.
  (Alternative noted for the gate: `cytoscape-edgehandles` for true drag handles.)
- **Edge semantics:** an edge source→target means "target `depends_on` source"
  (data-flow order, matching the existing render at PipelineEditorCanvas
  `toElements`). Connecting producer→consumer calls
  `addDependency(consumerId, producerId)`.
- **Invalid-connection feedback:** before applying, reject self-edge, duplicate
  edge, and any edge that **would create a cycle** (`wouldCreateCycle` in the
  model lib, a pure DFS check) or reference a missing step. Rejected attempts
  flash the offending node/edge and surface a transient message; nothing mutates.
- **Edge deletion:** `cxttap` on an edge → confirm → `removeDependency`.
- **Auto-layout:** re-run the existing dagre `relayout()` after a successful wire.
- **Model lib (new, pure):** `addDependency(model, flow, stepId, depId)`,
  `removeDependency(model, flow, stepId, depId)`, `wouldCreateCycle(model, flow,
  stepId, depId)`. Store actions wrap these + `reactiveModel` + revalidate.

## COMP-PIPE-EDIT-4 — Contract editor

A panel to define/edit the spec's `contracts:` block; new contracts flow straight
into the inspector's `output_contract` dropdown (already sourced from
`model.contracts`).

- **`ContractEditor.jsx` (new):** lists `model.contracts` (excluding the reserved
  `TaskGraph` — see below); add contract (unique name), rename, delete, and
  per-contract field rows (name, `type` select [string|number|boolean|array|object],
  optional `values` CSV, `optional` flag). Follows `ItemFormDialog` widgets + tokens.
- **Contract references span the whole spec, not just steps (design-gate
  correction).** A contract name is referenced in three places:
  `step.output_contract` (normalized flow steps), `flows.<name>.output`, and
  `functions.<name>.output` (both live in the model's `_doc` passthrough —
  confirmed in `pipelines/build-quick.stratum.yaml`). So:
  - `renameContract(model, old, new)` rewrites **all three**: every flow step's
    `output_contract` AND `_doc.flows.*.output` AND `_doc.functions.*.output`.
  - `deleteContract(model, name)` is **blocked** (`{ok:false,reason}`) when ANY of
    those three still reference it.
- **`model.contracts` must be deep-copied on load and explicitly serialized
  (design-gate correction).** `specToModel` shallow-copies `contracts` and
  `modelToSpecObject` does **not** emit `contracts` at all — so contract edits
  would split-brain (nested leaks via shared refs; add/rename/delete dropped).
  Fix: `specToModel` deep-copies `contracts`; a new `serializeContracts(model)` is
  the single source for writing them.
- **Persistence (backend change):** extend `POST /api/pipeline/save` to also write
  the top-level `contracts` block via in-place Document merge — `doc.setIn(['contracts',
  name], …)` per changed/added contract, `deleteIn` per removed, leaving untouched
  contracts (and their comments) alone (the per-key merge pattern from
  `mergeStepNode`). The reserved `TaskGraph` is never written. Because contract
  rename also edits `_doc.flows.*.output`/`_doc.functions.*.output`, the save must
  re-emit those changed scalar nodes too (they are not in the step model).
- **`TaskGraph` rule (design-gate correction):** `TaskGraph` is a reserved
  built-in (`spec.py`), yet a legacy spec (`build-quick`) defines it verbatim and
  the inspector injects it as a built-in dropdown option. Rules: the contract
  editor **hides/locks `TaskGraph`** (not addable, renamable, or deletable); a
  legacy `contracts.TaskGraph` is preserved verbatim via `_doc` passthrough but
  never surfaced as editable; the inspector dropdown **dedups** `TaskGraph` (don't
  add the built-in option when the spec already defines it); and `addContract`
  rejects the name `TaskGraph`.

## COMP-PIPE-EDIT-7 — Template save

The foundation's save edits the *existing* file. -7 adds "save the current canvas
as a **new** template" that shows up in the existing `TemplateSelector`.

- **Discoverability constraint:** `TemplateSelector` lists `/api/pipeline/templates`,
  which is gated on a real `metadata:` YAML **key** (the shipped specs' comment
  headers are invisible to it). So a saved template MUST emit a real `metadata:`
  key with at least `id`. (This is intentional — new templates opt into
  discoverability the comment-header specs never had.)
- **`POST /api/pipeline/save-as-template` (new):** body `{ filename, model,
  metadata: { id, label?, description?, category? } }`. Steps: basename/traversal-
  safe `filename` ending `.stratum.yaml`; **refuse if the file already exists**
  (create-only; editing existing is `/save`); **refuse if `metadata.id` collides
  with any existing spec's `metadata.id`** (design-gate correction — the template
  system keys on `metadata.id`, used as both the `/templates/:id/spec` resolver key
  and the `TemplateSelector` React key/selection token; duplicate ids load
  ambiguously). Serialize the full spec object — `modelToSpecObject(model)` for
  version/flows PLUS `serializeContracts(model)` for the `contracts` block (since
  `modelToSpecObject` alone omits contracts) — with a real `metadata:` key
  prepended; `YAML.parse` gate; write. Return `{ ok, file }`.
- **UI:** a "Save as template" toolbar action opens a small dialog (filename + id +
  label) and on success refreshes the spec list. `TemplateSelector` picks it up
  automatically on next fetch.

## Testing strategy (match repo runners; no Playwright)

- **Model lib (node):** `addDependency`/`removeDependency`/`wouldCreateCycle`
  (incl. cycle rejection, self/dup rejection); `addContract`/`renameContract`
  (rewrites `output_contract` refs)/`deleteContract` (blocked when referenced).
- **Backend (node, golden):** save persists an edited `contracts` block while
  preserving untouched contracts + comments + flows; `save-as-template` writes a
  new discoverable file (real `metadata:` key, appears via `/api/pipeline/templates`)
  and refuses overwrite + traversal.
- **Store + UI (Vitest):** wiring actions add/remove deps with cycle guard;
  contract actions mutate + revalidate + hand back a fresh model ref; save-as-template
  posts the right payload. Inspector dropdown reflects a newly-added contract.

## Risks
- **Connect-mode vs drag UX** — connect-mode is leaner/testable; if true drag is
  wanted, `cytoscape-edgehandles` is the swap (gate decision).
- **Contracts comment preservation** — like steps, only changed contracts are
  mutated in place; a brand-new contract is appended. Golden test asserts
  untouched contracts keep their comments.
- **save-as-template metadata** — emitting a real `metadata:` key (vs the shipped
  comment style) is deliberate and required for TemplateSelector visibility;
  documented so it isn't mistaken for an inconsistency.
