# COMP-PIPE-EDIT-6 — Bidirectional YAML Sync + Conflict Resolution

**Status:** Design (Phase 1). Wave 2 of the epic (with -5). Builds on the shipped
foundation + Wave 1.
**Date:** 2026-06-21

## Related Documents
- Foundation: `docs/features/COMP-PIPE-EDIT-1/design.md`. Wave 1: `.../COMP-PIPE-EDIT-3/design.md`.
- Sibling: `docs/features/COMP-PIPE-EDIT-5/design.md`.

## Premise correction (design-gate input)

The roadmap text says "Edit YAML in Docs view → canvas updates." **That premise is
false:** `DocsView.jsx` is markdown-only (its tree comes from `GET /api/files` →
`listMarkdownFiles`, `*.md` only), it never lists or opens `pipelines/*.stratum.yaml`,
and the file-watcher (`server/file-watcher.js`) watches `docs/`, `features/`,
`.compose/data/` — **not `pipelines/`**. There is no existing surface where a user
edits spec YAML as text. So -6 builds its **own** YAML pane inside `PipelineEditor`,
and "external edit → canvas updates" is realized via a new `pipelines/` watch, not
the Docs view.

## Goals

1. **In-editor YAML pane** — a text view of the current spec, bidirectional with
   the canvas: canvas/inspector edits update the pane live; editing the pane updates
   the model (and thus canvas/inspector).
2. **Conflict resolution** — detect when the on-disk file diverged from what the
   editor loaded (another writer, or the user editing the file externally) and
   resolve it explicitly (reload vs overwrite) instead of silent last-write-wins.
3. **External-change awareness** — when the open spec changes on disk, the editor
   reacts (auto-reload if clean, banner if dirty).

## Non-Goals
- Reusing/!editing specs in the Docs view (false premise; out).
- A rich code editor (CodeMirror/Monaco) — the house idiom is a styled `<textarea>`
  (DocsView/StepInspector); no new dependency.
- Full comment-preserving round-trip *through the pane* (see Limitations).

## Architecture

### YAML pane (`src/components/vision/YamlPane.jsx`, new)
- A monospace `<textarea>` (DocsView idiom) bound to a serialized view of the model.
- **Model → text (live):** `YAML.stringify(modelToSpecObject(model))` augmented with
  `serializeContracts(model)` (both already exported, pure, currently unused). This
  is **comment-stripped** — it is an editing projection, not the persisted artifact.
  Recompute when `editorModel` changes UNLESS the pane is the active editor (avoid
  clobbering mid-type).
- **Text → model (on edit, debounced ~300ms):** `YAML.parse(text)` → `specToModel`
  → replace the model. Because the pane is **spec-wide** while the rest of the editor
  is flow-scoped (design-gate correction), this path must also:
  - **Reconcile `editorSelectedFlow`:** if the pane renamed/removed the selected flow,
    re-point it to the first editable flow (`listEditableFlows`), else `validateFlow`
    runs on a vanished flow and `/save` later errors.
  - **Validate spec-wide:** run `validateFlow` over **every** editable flow (not only
    the selected one) and aggregate into `editorErrors`, since a pane edit can break
    any flow.
  - then `set({ editorModel: reactiveModel(model), editorDirty: true })`.
  A parse error routes through `_surfaceEditorError` (inline, model unchanged) — the
  load path (`loadSpecForEdit`) reused.
- Mounted as a third panel mode via the existing toolbar-toggle idiom (`panel`
  state: `inspector | contracts | yaml`).

### Conflict detection (server + store)
- **`GET /api/pipeline/spec`** also returns `hash` (sha-256 of the file text). The
  editor stores it as `editorSpecHash` at load (next to `editorSpecFile`).
- **`POST /api/pipeline/save`** accepts optional `baseHash`. Before writing, it
  hashes the freshly-read disk text (it already reads `diskText`); if `baseHash` is
  present and differs, it returns **409** `{ error, conflict:true, currentHash }`
  WITHOUT writing. A `force:true` bypasses (overwrite). On a successful write it
  returns the new `hash` so the editor updates `editorSpecHash`.
- **Store:** `saveSpec` sends `baseHash: editorSpecHash`. On 409 it does NOT clear
  dirty; it sets a `editorConflict` state. The UI offers **Reload** (re-fetch,
  discard local edits) or **Overwrite** (re-save with `force:true`).
- **Spec-wide save via a latched scope (design-gate correction):** a YAML-pane edit
  (like a collapse) can touch any/all flows, but `saveSpec` posts only
  `editorSelectedFlow`. Use a persistent `editorSaveScope` state (`'flow' | 'spec'`):
  load/save/reload resets it to `'flow'`; **any spec-wide mutation (a YAML-pane edit OR
  a collapse) latches it to `'spec'` and it stays there until the next save or reload.**
  This is stronger than "last editor was the pane" — a later single inspector edit must
  not silently revert to flow-scoped save and drop the other flows' changes. `saveSpec`
  omits `flowName` when scope is `'spec'` (server writes every model flow). Shared with -5.
- **Buffer must be flushed before save/overwrite (design-gate correction):** the pane
  intentionally allows `text !== model` mid-debounce and on parse error. Saving in
  that state would persist the stale model, not the visible buffer — a data-loss path.
  So **save/overwrite is blocked while the pane buffer is pending or unparseable**; the
  user must let it flush (valid parse → model) first, surfaced inline.

### External-change awareness (file-watch) — channel + path corrected (design-gate)
- Extend `server/file-watcher.js startWatching` to also watch the pipelines dir with
  a `*.stratum.yaml` filter (the watcher's `watchDir` already takes a `fileFilter`,
  used for `active-build.json`).
- **Channel:** `fileChanged` today is broadcast on `/ws/files` and only `Canvas.jsx`
  listens there; `useVisionStore` is on `/ws/vision`. So emit a **dedicated
  `specChanged` message on the vision WS** (the channel the editor store is actually
  connected to) rather than relying on `/ws/files`. Handle it in
  `visionMessageHandler.js`/the store.
- **Path shape:** `watchDir` broadcasts a **prefixed relative path** (`<prefix>/<file>`),
  but `editorSpecFile` is a **bare filename** — a `path === editorSpecFile` check would
  never match. Compare on `basename(path)` (and the pipelines prefix), not equality.
- **Behavior:** on a `specChanged` for the open spec, recompute the disk hash; if the
  editor is **clean**, auto-reload (refresh model + hash); if **dirty**, set
  `editorConflict` (banner: "This spec changed on disk") with Reload/Overwrite.

## Limitations (documented)
- **Editing via the YAML pane loses provenance for renames.** Re-deriving the model
  from pane text resets `_doc` and drops `_renamedFrom` hints. The save still
  re-reads the disk Document and merges by id, so comments on *unchanged* steps and
  unsurfaced fields survive; but a step **renamed purely in the pane** is seen by the
  merge as delete-old + add-new, losing that step's disk-only comments. Canvas/
  inspector renames (which set `_renamedFrom`) are unaffected. Surfaced to the user.
- **The pane is comment-stripped.** Authoritative persistence stays the model→server
  Document merge (comment-preserving); the pane is an editing projection.

## Testing strategy (node + Vitest; no Playwright)
- **Server:** `GET /spec` returns a stable `hash`; `/save` with a stale `baseHash`
  returns 409 without writing; `force:true` overwrites; success returns the new hash.
- **Watcher:** a `*.stratum.yaml` change under `pipelines/` broadcasts a `specChanged`
  message on the vision WS (NOT `fileChanged` on `/ws/files`).
- **Store:** pane text→model replace reconciles `editorSelectedFlow`, validates
  spec-wide, and latches `editorSaveScope='spec'`; parse error surfaces + leaves model
  intact; saveSpec sends baseHash and omits flowName when scope is `'spec'`, sets
  `editorConflict` on 409; a `specChanged` for the open clean spec reloads, for a dirty
  spec sets conflict; save is blocked while the pane buffer is pending/unparseable.
- **YamlPane (Vitest):** renders serialized model; an edit calls the store; an invalid
  edit shows the parse error.

## Risks
- **Live model↔text loops** (model change re-renders pane mid-edit). Mitigated by a
  "pane is active editor" guard + debounce, mirroring controlled-input patterns.
- **Hash churn** — serialization differences mean the pane text won't byte-match disk;
  the hash is computed on the on-disk file only (load + save), never on pane text, so
  it stays a true disk-divergence signal.
