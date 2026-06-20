# Implementation Plan — COMP-PIPE-EDIT-1/-2 Foundation

Design: `docs/features/COMP-PIPE-EDIT-1/design.md` (+ `-2/design.md`). REVIEW CLEAN.
Order is dependency-driven: pure logic → backend → store → UI → wiring. TDD per
task. Runners: node `--test` for lib/server, Vitest for UI. No Playwright.

## T1 — Pure model lib `src/lib/pipeline-model.js` (new)

- [ ] `specToModel(parsedDoc)` → `{ version, flows[], contracts{}, _doc }`; flow
      identity `(flowName, id)`; reads `workflow.steps` else `flows.<name>.steps`
      (all versions); `functions` only as function-only fallback.
- [ ] `flowSteps(model, flowName)` → normalized steps `{ id, kind, agent,
      function, intent, inputs{}, output_contract, ensure[], retries,
      depends_on[], on_fail, _extra{} }` (`_extra` = skip_if/type/gate-routes/
      parallel fields/reasoning_template, preserved untouched).
- [ ] `listEditableFlows(parsedDoc)` → flow names with a non-empty steps[].
- [ ] `modelToSpecObject(model)` → plain object (used by fallback serializer).
- [ ] `validateFlow(model, flowName)` → `{ errors[], warningsByStepId{} }`:
      unique id in flow; cycle (DFS over depends_on); `output_contract` ∈
      contracts ∪ {TaskGraph} ∪ {none}; every ref field
      (depends_on/on_fail/on_approve/on_revise/on_kill/source) resolves in-flow.
- [ ] `renameStep(model, flowName, oldId, newId)` rewrites all ref fields.
- [ ] `canDeleteStep(model, flowName, id)` → blocks if any ref field elsewhere
      points at `id`; `deleteStep` errors when blocked.
- [ ] Tests `test/pipeline-model.test.js`: inverse on multi-flow fixtures;
      validateFlow table (dup id, dangling each-ref-field, unknown contract,
      cycle, valid); rename rewrites; delete-orphan blocked.

## T2 — Backend endpoints `server/pipeline-routes.js` (existing)

- [ ] `GET /api/pipeline/specs` → readdir `pipelines/*.stratum.yaml`, each
      `{ file, version, flows: [name…] }` (filename-keyed; no metadata reliance).
- [ ] `POST /api/pipeline/save` body `{ file, model }`:
      basename-validate `file` exists in pipelines dir (path-traversal-safe);
      `YAML.parseDocument(currentFileText)`; apply selected flow's step edits in
      place (preserve metadata comment + untouched flows/fields); `String(doc)`;
      `YAML.parse` to gate; `writeFileSync`. Return `{ ok, file }`.
- [ ] Golden test `test/pipeline-save.test.js`: load `build.stratum.yaml`
      (multi-flow, duplicate `review` id), identity edit, save to a temp copy,
      re-read → assert all flows/subflows unchanged, `review` stays per-flow,
      `# metadata:` header survives, `isolation: none`/gate routes byte-preserved.

## T3 — Store slice `src/components/vision/useVisionStore.js` (existing)

- [ ] State: `editorSpecFile`, `editorModel`, `editorSelectedFlow`,
      `editorSelectedStep`, `editorDirty`, `editorErrors`.
- [ ] Actions via `apiCall`: `loadSpecForEdit(file)`, `selectFlow(name)`,
      `selectStep(id)`, `updateStep(id, patch)`, `addStep()`, `deleteStep(id)`,
      `renameStep(oldId,newId)`, `saveSpec()` (POST, clears dirty). Re-run
      `validateFlow` after each mutation → `editorErrors`.
- [ ] Tests: mutations set dirty + revalidate; saveSpec posts and clears dirty
      (mock `apiCall`); deleteStep-orphan surfaces error not mutation.

## T4 — `src/components/vision/PipelineEditorCanvas.jsx` (new)

- [ ] cytoscape + cytoscape-dagre (`cytoscape.use`), `LR` layout, render selected
      flow's steps as nodes (multi-line wrapped label id/agent/intent) + directed
      depends_on edges. `tap`→selectStep, `cxttap`→deleteStep(confirm). Tokens +
      `cn()`. Re-render from model on change.

## T5 — `src/components/vision/StepInspector.jsx` (new, COMP-PIPE-EDIT-2)

- [ ] Side panel (SettingsPanel structure, ItemFormDialog widgets): id, agent,
      intent, inputs (kv rows), output_contract (select contracts+TaskGraph+none),
      ensure (rows), retries (number), on_fail (select). Each edit → updateStep /
      renameStep. Inline errors from `editorErrors`.
- [ ] Vitest: renders selected step; edit calls updateStep; invalid → inline error.

## T6 — `src/components/vision/PipelineEditor.jsx` (new)

- [ ] View: spec picker (`GET /api/pipeline/specs`), flow picker
      (`listEditableFlows`), toolbar (Add step, Save [disabled unless dirty &&
      no errors], re-layout), canvas (T4), inspector (T5). v0.1 → read-only banner.

## T7 — View registration (3-touch)

- [ ] `src/App.jsx`: `case 'pipeline-editor'` rendering `<PipelineEditor/>`.
- [ ] `src/components/cockpit/viewTabsState.js`: add `'pipeline-editor'` to
      `DEFAULT_MAIN_TABS`.
- [ ] `src/components/cockpit/ViewTabs.jsx`: `TAB_META['pipeline-editor']`
      (label "Pipeline Editor", icon).

## Phase 7 closeout

- [ ] Full test suite green (node `--test --test-timeout=90000`, Vitest).
- [ ] E2E smoke: model+store round-trip exercised in tests (no Playwright).
- [ ] Codex review loop until REVIEW CLEAN.
- [ ] Coverage sweep until TESTS PASSING.
- [ ] Phase 9 docs (CHANGELOG, journal, set -1/-2 status), Phase 10 ship.
