# COMP-PIPE-EDIT-1 / -2 — Visual Pipeline Editor Foundation

**Status:** Design (Phase 1). Foundation milestone of the COMP-PIPE-EDIT epic.
**Covers:** COMP-PIPE-EDIT-1 (Step canvas) + COMP-PIPE-EDIT-2 (Step inspector), plus a save-to-disk round-trip (the core of -7) pulled forward by explicit user decision.
**Date:** 2026-06-20

## Related Documents
- Epic roadmap rows: `COMP-PIPE-EDIT-1..7` in `ROADMAP.md` (all PLANNED after the 2026-06-20 reconciliation of -3..-7's false COMPLETE).
- Sibling design: `docs/features/COMP-PIPE-EDIT-2/design.md` (inspector specifics; shares this architecture).
- Authoritative step schema: `stratum-mcp/src/stratum_mcp/spec.py` (`parse_and_validate`, `SCHEMAS`).

## Problem

The COMP-PIPE-EDIT epic builds a visual editor for Stratum pipeline specs
(`pipelines/*.stratum.yaml`). Today these are hand-edited YAML. The only UI
touching pipelines is `src/components/vision/PipelineView.jsx`, which is a
**read-only status tracker for the compose lifecycle** (research → design →
blueprint → implement) sourced from static constants — not an editor for
arbitrary specs. There is no canvas, no per-step editing, and no write path to
`pipelines/`.

This milestone delivers the foundation the rest of the epic builds on: a canvas
that renders a real spec's steps as nodes (-1), an inspector that edits a
selected step's fields (-2), and a save path that writes the edited spec back to
disk preserving its `# metadata:` header (core of -7, included by decision).

## Goals

- Load a selected `pipelines/*.stratum.yaml` spec into an editable in-memory model.
- Render steps as canvas nodes (id, agent/function, intent preview) with
  `depends_on` edges, auto-laid-out.
- Add a step (toolbar) and delete a step (node context action).
- Click a node → inspector side panel with editable fields, validated live.
- Save the edited model back to its **resolved source file** in `pipelines/`
  (the filename the editor loaded, not an id-inferred path), preserving the
  metadata comment block, with server-side parse validation before write.

## Non-Goals (deferred to later epic features)

- Drag-to-connect dependency wiring via ports — **COMP-PIPE-EDIT-3**. (This
  milestone edits `depends_on` via the inspector, and *renders* edges, but does
  not create them by dragging between ports.)
- Schema-form contract editor — **COMP-PIPE-EDIT-4**. (Inspector consumes the
  spec's existing contracts as a dropdown; it does not create/edit contracts.)
- Sub-flow collapse/expand — **COMP-PIPE-EDIT-5**.
- Bidirectional canvas↔YAML live sync + conflict resolution — **COMP-PIPE-EDIT-6**.
  (We provide a one-way read-only YAML preview, model → YAML, not bidirectional.)
- Save-as-new-template into the TemplateSelector — remainder of **-7**. (We save
  back to the *existing* file; "save as new template" is separate.)
- Full Stratum semantic validation (cycles/refs via Python) — see Validation.

## Decisions (from design dialogue)

1. **Canvas library: reuse cytoscape + cytoscape-dagre** (already dependencies,
   consistent with `GraphView.jsx`/`GraphRenderer.jsx`). No react-flow. To stay
   lean we avoid extra cytoscape plugins (`node-html-label`, `cxtmenu`,
   `edgehandles`): rich node content uses **native multi-line wrapped labels**,
   context-delete uses the native `cxttap` event, add-step uses a plain HTML
   toolbar. Trade-off accepted: more custom editor code vs. a purpose-built node
   editor.
2. **Persistence: save-to-disk now.** A new `POST` endpoint serializes the model
   back to its resolved source file in `pipelines/` (see Backend). This pulls
   -7's core (and the metadata-preservation risk) into the foundation so the
   feature round-trips end-to-end and is verifiable.

## Architecture

### Layering — pure logic separated from the canvas

The cytoscape canvas is hard to unit-test. The load-bearing logic is therefore
extracted into a **pure, framework-free module** so it is testable without a
browser or a rendered graph:

```
src/lib/pipeline-model.js          (new, pure)
  specToModel(parsedDoc)            -> { version, flows[], selectedFlow, contracts{}, _doc }
  flowSteps(model, flowName)        -> normalized steps[] for one flow
  modelToSpecObject(model)          -> plain JS object ready for serialization
  validateFlow(model, flowName)     -> { errors[], warningsByStepId{} }   (structural)
  listEditableFlows(parsedDoc)      -> flow names with an editable steps[] (excludes subflows-only)
```

- **Flow-scoped model (design-gate correction).** Real v0.3 specs are
  **multi-flow** documents: `build.stratum.yaml` has a `review_check` subflow AND
  a main `build` flow, and the step id `review` exists in *both*. A flat
  `steps[]` keyed by `id` would collide ids and erase flow boundaries on save.
  So the model is **flow-scoped**: step identity is `(flowName, id)`. The editor
  edits **one selected flow at a time** (a flow picker in the toolbar); the
  canvas renders that flow's steps; all other flows and subflows are preserved
  byte-for-meaning untouched via `_doc` passthrough. `workflow.steps` (v0.2/v0.3
  single-flow specs like `new`) is treated as one synthetic flow.
- **Steps location (corrected):** steps live at `workflow.steps` (if present)
  else `flows.<name>.steps` for **all** versions — confirmed in
  `server/pipeline-routes.js:62-84` (`extractSteps`). `functions:` holds reusable
  function *definitions*, not steps; it is only a last-resort fallback for
  function-only specs. (The earlier "v0.1 = functions-as-steps" assumption was
  wrong.)
- **Normalized step shape** (internal): `{ id, kind, agent, function, intent,
  inputs{}, output_contract, ensure[], retries, depends_on[], on_fail, _extra{} }`.
  `_extra` carries fields this milestone does not surface for editing (`skip_if`,
  `type`, gate routes `on_approve`/`on_revise`/`on_kill`, parallel-dispatch
  `source`/`max_concurrent`/`isolation`/`require`/`merge`/`intent_template`,
  `reasoning_template`) so they survive round-trip untouched.
- **Version handling:** v0.2 and v0.3 are fully editable. v0.1 specs are **not
  validated by Stratum** (`IR_UNKNOWN_VERSION`); they load **read-only with a
  banner** this milestone. Editing fidelity is guaranteed only for v0.2/v0.3.

### Frontend

- **New view `pipeline-editor`**, registered via the established 3-touch
  convention: a `case 'pipeline-editor'` in the `CockpitView` switch
  (`src/App.jsx`), `'pipeline-editor'` added to `DEFAULT_MAIN_TABS`
  (`src/components/cockpit/viewTabsState.js`), and a `TAB_META` entry
  (`src/components/cockpit/ViewTabs.jsx`).
- **`PipelineEditor.jsx`** (new): top-level view. A **spec picker**, a **flow
  picker** (which flow in the spec to edit), the cytoscape canvas, a toolbar (Add
  step, Save, re-layout), and a right-hand inspector.
  - **Spec discovery is file-based, not metadata-based (design-gate correction).**
    `loadTemplates` (`pipeline-routes.js:26-55`) only surfaces specs that have a
    real `metadata:` YAML *key* with an `id`; but the shipped specs store
    `metadata` as a leading `#` **comment** (or omit it, e.g. `new`), so plain
    `YAML.parse` returns `undefined` for it and they never appear in
    `/api/pipeline/templates`. The editor therefore lists raw spec **files** via
    a new `GET /api/pipeline/specs` (readdir of `pipelines/*.stratum.yaml`,
    returning `{ file, version, flows[] }`), keyed by **filename**. It loads spec
    text via `GET /api/pipeline/templates/:id/spec` where the existing resolver
    matches on filename/`_file`, then parses with the `yaml` package
    (`YAML.parseDocument`) and builds the model with `specToModel`.
- **`StepCanvas.jsx`** (new): wraps a cytoscape instance (mirrors the lifecycle
  pattern in `GraphRenderer.jsx` — `cytoscape.use(cytoscapeDagre)`, dagre `LR`
  layout). Renders **only the selected flow's** steps. Nodes carry `{ id, label }`
  with a multi-line label (`id\n agent \n intent…`); directed edges from each
  step's `depends_on`. Emits `onSelectStep(id)` on `tap`, `onDeleteStep(id)` on
  `cxttap` (with a confirm). Re-renders from the model; the model is the single
  source of truth, not cy.
- **`StepInspector.jsx`** (new, COMP-PIPE-EDIT-2): structural model follows
  `SettingsPanel.jsx` (persistent side panel); field widgets follow
  `ItemFormDialog.jsx` (controlled inputs, `setForm(p => ({...p, k:v}))`).
  Fields: `id` (text), `agent` (text, `provider:template:tier`), `intent`
  (textarea), `inputs` (key-value rows, add/remove), `output_contract` (select:
  `Object.keys(model.contracts)` + built-in `TaskGraph` + "(none)"), `ensure`
  (string-list rows), `retries` (number), `on_fail` (select of other step ids +
  "(none)"). Each change calls the store's `updateStep`. Per-field validation
  messages come from `validateModel`, shown inline ("live validation as you type",
  debounced ~200ms).
- **State:** extend `useVisionStore` with an editor slice:
  `editorSpecId`, `editorModel`, `editorDirty`, `editorErrors`, and actions
  `loadSpecForEdit(id)`, `updateStep(id, patch)`, `addStep()`, `deleteStep(id)`,
  `saveSpec()`. Writes go through the store's existing `apiCall` helper, matching
  the `updateItem`/`updateSettings` convention.

### Backend

- **`GET /api/pipeline/specs`** (new): readdir of `pipelines/*.stratum.yaml`,
  returns `[{ file, version, flows[] }]` so the editor can list and pick specs by
  filename regardless of the metadata-comment discoverability gap.
- **`POST /api/pipeline/save`** in `server/pipeline-routes.js` (the file already
  imports `yaml` and `writeFileSync`, and resolves `getPipelinesDir`). Body:
  `{ file, model }` — `file` is the resolved **source filename** the editor
  loaded (NOT inferred from any `id`; filenames and metadata ids can diverge, and
  the read path already tracks the real `_file`, `pipeline-routes.js:40,145`).
  Steps:
  1. Resolve `pipelines/<file>`; reject with 400 if `file` is not an existing
     `*.stratum.yaml` in the pipelines dir (path-traversal-safe basename check).
     This endpoint edits existing specs only; create-new is out of scope.
  2. Re-read the on-disk file as a `YAML.parseDocument`, apply the model's flow
     edits in place (Serialization below) — last-write-wins; concurrent-edit
     conflict resolution is COMP-PIPE-EDIT-6.
  3. **Validate** the serialized text by `YAML.parse` (server has no Stratum
     client today — `stratumClient: null`). Reject on parse error before any write.
  4. `writeFileSync` the result. Return `{ ok, file }`.
- Read endpoints are unchanged. The draft approve/reject flow is untouched.

### Serialization & the metadata trap

`metadata` is a **leading YAML comment block** (`# metadata:`), not a key — and
the JS loader does a plain `YAML.parse` with no comment-stripping, so it never
reads it (correcting an earlier assumption). The comment header is therefore
**not** a discoverability mechanism in this codebase (discovery is by filename,
via the new `/api/pipeline/specs`). It is still real authored content that a save
**MUST NOT destroy**. A naive `YAML.parse` → `YAML.stringify` round-trip silently
drops all comments. Safeguard:

- **Mutate in place via the `yaml` Document API.** Server parses the original
  file with `YAML.parseDocument`, applies only the selected flow's step edits to
  the corresponding nodes in the document tree, and `String(doc)` to serialize —
  this retains the metadata comment header, body comments, key ordering, and any
  fields the editor never touches. The model's `_doc`/`_extra` passthrough means
  unsurfaced flows, subflows, and step fields are never lost.
- **Fallback** (if a given edit can't be expressed as an in-place Document
  mutation): capture the original leading comment lines as a raw string and
  re-prepend them to `YAML.stringify(modelToSpecObject(model))` — preserves the
  metadata header but loses body comments, logged as a known limitation.

The blueprint (Phase 4) pins the mechanism; the design constraint is: **a save
MUST preserve the `# metadata:` header and all untouched flows/fields, verified
by a golden round-trip test.**

### Validation

- **Client (live, this milestone):** `validateFlow` — unique step ids within the
  flow, `output_contract` exists in the spec's contracts (or is `TaskGraph`), no
  `depends_on` cycle (DFS), and **every step-reference field resolves to a step
  in the same flow**. The reference fields scanned are the full set, not just the
  editable ones (design-gate correction): `depends_on`, `on_fail`, gate routes
  `on_approve`/`on_revise`/`on_kill`, and parallel-dispatch `source` — even
  though the inspector only *edits* `depends_on`/`on_fail`, the others exist in
  real specs and a delete/rename must not silently orphan them.
- **Rename / delete reference integrity (design-gate correction):** renaming a
  step id rewrites **all** of the above reference fields across the flow's steps
  (including those carried in `_extra`). A delete that would orphan a reference
  in any of those fields is **blocked with a validation error** rather than
  producing an unrepairable spec (the inspector doesn't surface gate/source
  fields to fix by hand this milestone).
- Findings surfaced inline in the inspector and as node badges on the canvas.
- **Server (gate before write):** YAML parseability only (no Stratum client in
  server context). Full semantic validation through the Stratum subprocess is a
  follow-up (`stratum-client.js` exposes no `validate` yet) — out of scope,
  noted as a gap.

## Testing strategy

Match the repo's runners (node test + UI Vitest); **no Playwright** (none in the
repo). Testability comes from the pure-logic split:

- **Golden round-trip (server):** for each shipped v0.2/v0.3 spec — including the
  multi-flow `build.stratum.yaml` — load → `specToModel` → an identity edit on
  one flow → Document-mutate save → re-read → assert: every flow and subflow is
  unchanged, the duplicated step id (`review` in both `review_check` and `build`)
  stays in its correct flow, the `# metadata:` header survives, and untouched
  step fields (gate routes, `source`, `isolation: none`) are byte-preserved. This
  is the core capability test.
- **Unit (`pipeline-model.js`):** `specToModel`/`modelToSpecObject` inverse on
  multi-flow fixtures; `validateFlow` table-driven (duplicate id, dangling
  `depends_on`/`on_fail`/gate-route/`source`, unknown contract, cycle, valid);
  rename rewrites all ref fields; delete-that-orphans is blocked.
- **Store actions:** `addStep`/`deleteStep`/`updateStep` mutate the model and set
  `editorDirty`; `saveSpec` POSTs and clears dirty (mock `apiCall`).
- **Inspector (UI Vitest):** renders fields from a selected step, an edit calls
  `updateStep`, an invalid value shows the inline error.
- Canvas pixel-drag is **not** unit-tested; its logic lives in the pure model and
  store actions which are.

## Risks

- **Round-trip fidelity** is the central risk — arbitrary specs must survive
  load→edit→save without losing fields, ordering-sanity, or the metadata header.
  Mitigated by `_extra`/`_passthrough` passthrough, the Document-API approach,
  and the golden round-trip test gating each shipped spec.
- **`isolation: none`** appears in a shipped v0.3 spec but is absent from the
  `spec.py` enum — the inspector (when it later surfaces parallel fields) and any
  validation must treat `none` as real. Not surfaced this milestone (in `_extra`).
- **cytoscape is not a node editor** — rich nodes and future port wiring (-3) are
  more custom code than react-flow would be. Accepted per decision; this design
  keeps cy as a *render+select* surface and the model as truth to contain it.

## Design-gate corrections (Codex, 2026-06-20)

A Codex review of this design (grounded in the real code) corrected five
assumptions, all folded in above:

1. **Flat model → flow-scoped model.** v0.3 specs are multi-flow with duplicate
   step ids across flows (`review` in `build`'s `review_check` subflow and main
   flow); identity is now `(flowName, id)` and editing is one-flow-at-a-time.
2. **Reference integrity widened.** Rename/delete/validate now cover
   `on_approve`/`on_revise`/`on_kill` and parallel `source`, not just
   `depends_on`/`on_fail`; orphaning delete is blocked.
3. **Metadata is a comment, ignored by the loader** — it is preserved on save but
   is *not* a discoverability mechanism; discovery is filename-based via the new
   `/api/pipeline/specs`.
4. **Steps live at `workflow.steps`/`flows.<name>.steps` for all versions** —
   the "v0.1 = functions-as-steps" assumption was wrong (`functions:` is
   definitions; `extractSteps` confirms).
5. **Save targets the resolved source `_file`**, not an `id`-inferred path.
