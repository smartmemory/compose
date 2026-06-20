# COMP-PIPE-EDIT-7 — Template Save

**Status:** Design (Phase 1). Part of Wave 1. (The foundation already shipped the
save-to-*existing*-file round-trip; this adds save-as-*new*-template.)
**Shared architecture:** `docs/features/COMP-PIPE-EDIT-3/design.md` (Wave 1 umbrella).

Save the current canvas as a new pipeline template in `pipelines/` so it appears
in the existing `TemplateSelector` for future builds. See the umbrella doc.

## Acceptance Criteria
- [ ] `POST /api/pipeline/save-as-template` writes a NEW `pipelines/<file>.stratum.yaml`
      from `modelToSpecObject(model)` + `serializeContracts(model)` with a real
      `metadata:` key (id required).
- [ ] Refuses to overwrite an existing file; basename/traversal-safe.
- [ ] Refuses a `metadata.id` that collides with an existing spec's id (the
      template system keys on `metadata.id`, not filename).
- [ ] The saved template appears in `TemplateSelector` (it lists
      `/api/pipeline/templates`, which is gated on a real `metadata.id`).
- [ ] A "Save as template" toolbar action collects filename + id + label and
      refreshes the spec list on success.
