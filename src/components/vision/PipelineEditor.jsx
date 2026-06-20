/**
 * PipelineEditor — COMP-PIPE-EDIT-1 / T6.
 *
 * The `pipeline-editor` view. Composes the visual pipeline editor:
 *   - a spec picker (GET /api/pipeline/specs → dropdown of *.stratum.yaml files)
 *   - a flow picker (listEditableFlows of the loaded model)
 *   - a toolbar: Add step, Save (disabled unless dirty && no errors), re-layout
 *   - the canvas (PipelineEditorCanvas, T4) and inspector (StepInspector, T5)
 *     side by side
 *   - a read-only banner for v0.1 specs
 *
 * State lives entirely in useVisionStore's editor slice; this view is a thin
 * shell wiring the store to the widgets.
 */
import React, { useEffect, useRef } from 'react';
import { Plus, Save, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { useVisionStore } from './useVisionStore.js';
import { listEditableFlows } from '../../lib/pipeline-model.js';
import PipelineEditorCanvas from './PipelineEditorCanvas.jsx';
import StepInspector from './StepInspector.jsx';

const SELECT_CLS =
  'text-xs bg-muted text-foreground px-2 py-1 rounded border border-border cursor-pointer outline-none focus:border-ring';

export default function PipelineEditor() {
  const canvasRef = useRef(null);

  const specs = useVisionStore(s => s.editorSpecs);
  const specFile = useVisionStore(s => s.editorSpecFile);
  const model = useVisionStore(s => s.editorModel);
  const selectedFlow = useVisionStore(s => s.editorSelectedFlow);
  const dirty = useVisionStore(s => s.editorDirty);
  const errors = useVisionStore(s => s.editorErrors);
  const readOnly = useVisionStore(s => s.editorReadOnly);

  const loadSpecList = useVisionStore(s => s.loadSpecList);
  const loadSpecForEdit = useVisionStore(s => s.loadSpecForEdit);
  const selectFlow = useVisionStore(s => s.selectFlow);
  const addStep = useVisionStore(s => s.addStep);
  const saveSpec = useVisionStore(s => s.saveSpec);

  // Load the spec list once when the view mounts.
  useEffect(() => { loadSpecList(); }, [loadSpecList]);

  const flows = model?._doc ? listEditableFlows(model._doc) : [];
  const errorCount = errors?.errors?.length || 0;
  const canSave = dirty && errorCount === 0 && !readOnly;

  const handleSave = async () => {
    const res = await saveSpec();
    if (res?.error && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('compose:notify', {
        detail: { level: 'warn', message: `Save failed: ${res.error}` },
      }));
    } else if (res?.ok && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('compose:notify', {
        detail: { level: 'info', message: `Saved ${res.file}` },
      }));
    }
  };

  return (
    <div className="w-full h-full flex flex-col bg-background">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
        <select
          value={specFile ?? ''}
          onChange={e => e.target.value && loadSpecForEdit(e.target.value)}
          className={SELECT_CLS}
          title="Spec file"
          data-testid="spec-picker"
        >
          <option value="" disabled>Select a spec…</option>
          {specs.map(s => (
            <option key={s.file} value={s.file}>
              {s.file}{s.version ? ` (v${s.version})` : ''}
            </option>
          ))}
        </select>

        <select
          value={selectedFlow ?? ''}
          onChange={e => e.target.value && selectFlow(e.target.value)}
          className={SELECT_CLS}
          title="Flow"
          disabled={!model || flows.length === 0}
          data-testid="flow-picker"
        >
          {flows.length === 0 && <option value="">(no flows)</option>}
          {flows.map(name => <option key={name} value={name}>{name}</option>)}
        </select>

        <div className="w-px h-5 bg-border mx-1" />

        <button
          type="button"
          onClick={() => addStep()}
          disabled={!model || !selectedFlow || readOnly}
          className={cn(
            'flex items-center gap-1 text-xs px-2 py-1 rounded border border-border transition-colors',
            (!model || !selectedFlow || readOnly)
              ? 'opacity-50 cursor-not-allowed text-muted-foreground'
              : 'text-foreground hover:bg-accent',
          )}
          title="Add step"
        >
          <Plus className="h-3 w-3" /> Add step
        </button>

        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
          className={cn(
            'flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors',
            canSave
              ? 'border-accent/60 text-accent hover:bg-accent/10'
              : 'opacity-50 cursor-not-allowed text-muted-foreground border-border',
          )}
          title={errorCount > 0 ? 'Fix validation errors before saving' : 'Save spec'}
        >
          <Save className="h-3 w-3" /> Save{dirty ? ' *' : ''}
        </button>

        <button
          type="button"
          onClick={() => canvasRef.current?.relayout()}
          disabled={!model || !selectedFlow}
          className={cn(
            'flex items-center gap-1 text-xs px-2 py-1 rounded border border-border transition-colors',
            (!model || !selectedFlow)
              ? 'opacity-50 cursor-not-allowed text-muted-foreground'
              : 'text-foreground hover:bg-accent',
          )}
          title="Re-layout"
        >
          <RefreshCw className="h-3 w-3" /> Layout
        </button>

        <div className="flex-1" />

        {errorCount > 0 && (
          <span className="text-[10px] text-destructive" data-testid="error-count">
            {errorCount} validation {errorCount === 1 ? 'error' : 'errors'}
          </span>
        )}
      </div>

      {/* Read-only banner for v0.1 specs */}
      {readOnly && (
        <div className="shrink-0 px-3 py-1.5 text-[11px] bg-amber-500/10 text-amber-600 dark:text-amber-400 border-b border-amber-500/30">
          This spec is version 0.1 and cannot be validated by Stratum. It is loaded read-only.
        </div>
      )}

      {/* Canvas + inspector */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0">
          <PipelineEditorCanvas ref={canvasRef} />
        </div>
        <div className="w-80 shrink-0 border-l border-border overflow-hidden">
          <StepInspector />
        </div>
      </div>
    </div>
  );
}
