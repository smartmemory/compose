# COMP-PIPE-EDIT-4 — Contract Editor

**Status:** Design (Phase 1). Part of Wave 1.
**Shared architecture:** `docs/features/COMP-PIPE-EDIT-3/design.md` (Wave 1 umbrella).

Define/edit the spec's `contracts:` block in a schema form. New contracts flow
straight into the step inspector's `output_contract` dropdown (already sourced
from `model.contracts`). See the umbrella doc for the full design.

## Acceptance Criteria
- [ ] `ContractEditor.jsx` lists contracts (excluding reserved `TaskGraph`) and
      supports add / rename / delete and per-field edit (name, `type`, optional
      `values`, `optional`).
- [ ] `renameContract` rewrites contract refs in ALL three sites: step
      `output_contract`, `flows.<name>.output`, and `functions.<name>.output`.
- [ ] `deleteContract` is blocked (with reason) while ANY of those three still
      references it.
- [ ] `TaskGraph` is locked: not addable/renamable/deletable; rejected as a new
      name; deduped in the inspector dropdown when a spec already defines it.
- [ ] `specToModel` deep-copies `contracts`; `serializeContracts` is the single
      writer; `POST /api/pipeline/save` persists the block in place, preserving
      comments on untouched contracts.
- [ ] A newly added contract appears in the inspector dropdown immediately.
