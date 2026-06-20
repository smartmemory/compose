/**
 * YamlPane — COMP-PIPE-EDIT-6 / Wave 2.
 *
 * A monospace <textarea> view of the current spec, bidirectional with the canvas:
 *   - Model → text (live): YAML.stringify(modelToYamlObject(model)). This is a
 *     comment-stripped editing projection, NOT the persisted artifact (the save
 *     path re-reads the disk Document and merges by id, preserving comments). The
 *     pane recomputes from the model UNLESS the user is actively editing it (the
 *     local buffer wins so a live model re-render can't clobber mid-type).
 *   - Text → model (on edit, debounced ~300ms): setYamlBuffer(text) stashes the
 *     raw text and flushYaml() parses → specToModel → replaces the model
 *     spec-wide (reconciling the selected flow + validating every flow). A parse
 *     error is surfaced inline and leaves the model intact.
 *
 * The pane is spec-wide; any edit latches editorSaveScope='spec' (in the store).
 * Read-only for v0.1 specs (and v0.1 has no editable projection to mutate).
 *
 * Zero props — reads everything from useVisionStore, mounted as the `panel:'yaml'`
 * mode in PipelineEditor (mirrors StepInspector / ContractEditor).
 */
import React, { useEffect, useRef, useState } from 'react';
import YAML from 'yaml';
import { useVisionStore } from './useVisionStore.js';
import { modelToYamlObject } from '../../lib/pipeline-model.js';

const FLUSH_DEBOUNCE_MS = 300;

// Serialize the model to the pane's text projection. Defensive: a malformed model
// should render an empty pane rather than throw and blank the editor.
function serializeModel(model) {
  if (!model) return '';
  try {
    return YAML.stringify(modelToYamlObject(model));
  } catch {
    return '';
  }
}

export default function YamlPane() {
  const model = useVisionStore(s => s.editorModel);
  const readOnly = useVisionStore(s => s.editorReadOnly);
  const yamlError = useVisionStore(s => s.editorYamlError);
  const pendingBuffer = useVisionStore(s => s.editorYamlBuffer);
  const setYamlBuffer = useVisionStore(s => s.setYamlBuffer);
  const flushYaml = useVisionStore(s => s.flushYaml);

  // Local controlled text. `editingRef` guards the model→text effect from
  // clobbering the buffer while the user is typing (the "pane is active editor"
  // guard from the design).
  //
  // Seed from a still-pending store buffer if one survived a previous unmount
  // (e.g. the user toggled away from the YAML panel mid-edit / on a parse error);
  // else from the serialized model. Without this, the textarea would show the
  // model while a non-null editorYamlBuffer silently kept blocking saveSpec.
  const [text, setText] = useState(() => (
    pendingBuffer != null ? pendingBuffer : serializeModel(model)
  ));
  const editingRef = useRef(pendingBuffer != null); // a restored buffer is a live edit
  const debounceRef = useRef(null);
  // Stable ref to the store's flush so the unmount cleanup can call it without
  // re-running on every flushYaml identity change.
  const flushRef = useRef(flushYaml);
  useEffect(() => { flushRef.current = flushYaml; }, [flushYaml]);

  // Model → text: recompute when the model changes, UNLESS the pane is the active
  // editor (a pending local edit). Reconciles after a flush (editing goes false).
  useEffect(() => {
    if (editingRef.current) return;
    setText(serializeModel(model));
  }, [model]);

  // On unmount: cancel the pending debounce and FLUSH SYNCHRONOUSLY so a pending
  // buffer is either applied to the model or surfaced as a parse error — never
  // left stranded in the store (where it would invisibly keep blocking saves).
  // flushYaml is a safe no-op when nothing is buffered.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    flushRef.current?.();
  }, []);

  const onChange = (e) => {
    if (readOnly) return;
    const next = e.target.value;
    setText(next);
    editingRef.current = true;
    setYamlBuffer(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // flushYaml parses the buffer into the model (or surfaces a parse error and
      // leaves the buffer pending). Either way we stop treating the pane as the
      // active editor so a subsequent canvas/inspector edit re-projects.
      editingRef.current = false;
      flushYaml();
    }, FLUSH_DEBOUNCE_MS);
  };

  if (!model) {
    return (
      <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground p-4 text-center">
        Select a spec to view its YAML.
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col" data-testid="yaml-pane">
      <div className="shrink-0 flex items-center justify-between px-3 py-1.5 border-b border-border">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">YAML (spec-wide)</span>
        {readOnly && (
          <span className="text-[10px] text-muted-foreground/70">read-only</span>
        )}
      </div>
      <textarea
        value={text}
        onChange={onChange}
        readOnly={readOnly}
        spellCheck={false}
        className="flex-1 w-full resize-none border-0 outline-none px-3 py-2 text-xs"
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          background: 'hsl(var(--background))',
          color: 'hsl(var(--foreground))',
          tabSize: 2,
        }}
        data-testid="yaml-pane-textarea"
      />
      {yamlError && (
        <div
          className="shrink-0 px-3 py-1.5 text-[11px] bg-destructive/10 text-destructive border-t border-destructive/30"
          data-testid="yaml-pane-error"
        >
          {yamlError}
        </div>
      )}
      <div className="shrink-0 px-3 py-1 text-[10px] text-muted-foreground/70 border-t border-border">
        Comment-stripped editing projection. A pane-only step rename loses that
        step&apos;s disk comments on save.
      </div>
    </div>
  );
}
