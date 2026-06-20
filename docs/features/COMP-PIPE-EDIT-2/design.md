# COMP-PIPE-EDIT-2 — Step Inspector

**Status:** Design (Phase 1). Part of the Visual Pipeline Editor foundation.
**Shared architecture:** see `docs/features/COMP-PIPE-EDIT-1/design.md` — the
inspector is designed and built together with the canvas and save round-trip.

## Scope

The inspector is the side panel that edits the step selected on the canvas. It
reads the selected step from the in-memory model (`useVisionStore.editorModel`)
and writes changes back via `updateStep(id, patch)`.

### Fields (controlled, following `ItemFormDialog.jsx` widget patterns)

- `id` — text. Renaming rewrites references in other steps across **all**
  reference fields — `depends_on`, `on_fail`, gate routes
  `on_approve`/`on_revise`/`on_kill`, and parallel `source` — even those carried
  in `_extra` and not directly editable here, so a rename never orphans a real
  reference. Deleting a step that is still referenced by any of these is blocked
  with a validation error.
- `agent` — text, `provider:template:tier` grammar (`lib/agent-string.js`).
- `intent` — multiline textarea.
- `inputs` — key-value rows (add/remove); values are JSONPath strings (`$.input.x`).
- `output_contract` — `<select>` populated from `Object.keys(model.contracts)` +
  built-in `TaskGraph` + "(none)".
- `ensure` — list of expression strings (add/remove rows).
- `retries` — number input.
- `on_fail` — `<select>` of the other step ids + "(none)".

Fields this milestone does not surface (`type`, `skip_if`, parallel-dispatch,
gate routes `on_approve`/`on_revise`/`on_kill`) are preserved untouched via the
model's `_extra` passthrough and are out of scope here.

### Live validation

As-you-type (debounced), driven by `validateFlow` from `src/lib/pipeline-model.js`:
unique id within the flow, all reference fields
(`depends_on`/`on_fail`/`on_approve`/`on_revise`/`on_kill`/`source`) resolve to
steps in the same flow, `output_contract` exists, no dependency cycle. Errors
render inline beneath the offending field and as a badge on the corresponding
canvas node.

## Non-Goals

- Creating/editing contracts (that is COMP-PIPE-EDIT-4) — the dropdown only
  consumes contracts already defined in the spec.
- Authoritative Stratum semantic validation (Python) — client-side structural
  checks only this milestone.

## Acceptance Criteria

- [ ] Selecting a canvas node populates the inspector with that step's values.
- [ ] Editing any field updates the model (`editorDirty` becomes true) and the
      node label re-renders.
- [ ] `output_contract` dropdown lists the spec's contracts + `TaskGraph`.
- [ ] Renaming a step id updates referencing `depends_on`/`on_fail`.
- [ ] An invalid value (dup id, dangling ref, unknown contract, cycle) shows an
      inline error and a node badge, live.
- [ ] Inspector field widgets and styling match `ItemFormDialog`/`SettingsPanel`
      (Tailwind tokens, `cn()`).
