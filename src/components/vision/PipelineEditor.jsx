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
import React, { useEffect, useRef, useState } from 'react';
import { Plus, Save, RefreshCw, Link2, FileBox, Sliders } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog.jsx';
import { Button } from '@/components/ui/button.jsx';
import { useVisionStore } from './useVisionStore.js';
import { listEditableFlows } from '../../lib/pipeline-model.js';
import PipelineEditorCanvas from './PipelineEditorCanvas.jsx';
import StepInspector from './StepInspector.jsx';
import ContractEditor from './ContractEditor.jsx';

// Normalize a filename to a traversal-safe basename ending in .stratum.yaml.
function normalizeTemplateFilename(raw) {
  let f = String(raw || '').trim().replace(/[/\\]/g, '');
  if (!f) return '';
  if (!f.endsWith('.stratum.yaml')) {
    f = f.replace(/\.(ya?ml)$/i, '');
    f = `${f}.stratum.yaml`;
  }
  return f;
}

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
  const saveAsTemplate = useVisionStore(s => s.saveAsTemplate);

  // COMP-PIPE-EDIT-3/-4/-7: local view state for connect mode, the side panel
  // (step inspector vs contract editor), and the save-as-template dialog.
  const [connectMode, setConnectMode] = useState(false);
  const [panel, setPanel] = useState('inspector'); // 'inspector' | 'contracts'
  const [templateOpen, setTemplateOpen] = useState(false);
  const [tplForm, setTplForm] = useState({ filename: '', id: '', label: '' });
  const [tplError, setTplError] = useState('');
  const [tplSaving, setTplSaving] = useState(false);

  // Load the spec list once when the view mounts.
  useEffect(() => { loadSpecList(); }, [loadSpecList]);

  // Connect/contract editing must be off for read-only (v0.1) specs.
  useEffect(() => { if (readOnly) { setConnectMode(false); setPanel('inspector'); } }, [readOnly]);

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

  const openTemplateDialog = () => {
    setTplForm({ filename: '', id: '', label: '' });
    setTplError('');
    setTemplateOpen(true);
  };

  const handleSaveTemplate = async () => {
    const filename = normalizeTemplateFilename(tplForm.filename);
    const id = tplForm.id.trim();
    if (!filename) { setTplError('Filename is required'); return; }
    if (!id) { setTplError('Template id is required'); return; }
    // Mirror the Save gate: never publish a template that fails validation.
    if (errorCount > 0) { setTplError('Resolve validation errors before saving as a template'); return; }
    setTplSaving(true);
    setTplError('');
    const res = await saveAsTemplate({
      filename,
      metadata: { id, ...(tplForm.label.trim() ? { label: tplForm.label.trim() } : {}) },
    });
    setTplSaving(false);
    if (res?.error) {
      // Surface the server error (incl. 409 id-collision / overwrite refusal)
      // inline; keep the dialog open so the user can adjust.
      setTplError(res.error);
      return;
    }
    setTemplateOpen(false);
    // Refresh the spec list so the new template shows up immediately.
    loadSpecList();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('compose:notify', {
        detail: { level: 'info', message: `Saved template ${res.file || filename}` },
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

        <div className="w-px h-5 bg-border mx-1" />

        {/* COMP-PIPE-EDIT-3: connect-mode toggle for dependency wiring. */}
        <button
          type="button"
          onClick={() => setConnectMode(v => !v)}
          disabled={!model || !selectedFlow || readOnly}
          aria-pressed={connectMode}
          className={cn(
            'flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors',
            (!model || !selectedFlow || readOnly)
              ? 'opacity-50 cursor-not-allowed text-muted-foreground border-border'
              : connectMode
                ? 'border-accent/60 text-accent bg-accent/10'
                : 'text-foreground border-border hover:bg-accent',
          )}
          title="Connect dependencies (tap source, then target)"
          data-testid="connect-toggle"
        >
          <Link2 className="h-3 w-3" /> Connect
        </button>

        {/* COMP-PIPE-EDIT-4: toggle the side panel between step inspector and
            the contract editor. */}
        <button
          type="button"
          onClick={() => setPanel(p => (p === 'contracts' ? 'inspector' : 'contracts'))}
          disabled={!model}
          aria-pressed={panel === 'contracts'}
          className={cn(
            'flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors',
            !model
              ? 'opacity-50 cursor-not-allowed text-muted-foreground border-border'
              : panel === 'contracts'
                ? 'border-accent/60 text-accent bg-accent/10'
                : 'text-foreground border-border hover:bg-accent',
          )}
          title="Edit contracts"
          data-testid="contracts-toggle"
        >
          {panel === 'contracts' ? <Sliders className="h-3 w-3" /> : <FileBox className="h-3 w-3" />}
          Contracts
        </button>

        {/* COMP-PIPE-EDIT-7: save the current canvas as a new template. */}
        <button
          type="button"
          onClick={openTemplateDialog}
          disabled={!model || !selectedFlow || readOnly || errorCount > 0}
          className={cn(
            'flex items-center gap-1 text-xs px-2 py-1 rounded border border-border transition-colors',
            (!model || !selectedFlow || readOnly || errorCount > 0)
              ? 'opacity-50 cursor-not-allowed text-muted-foreground'
              : 'text-foreground hover:bg-accent',
          )}
          title={errorCount > 0 ? 'Resolve validation errors before saving as a template' : 'Save as new template'}
          data-testid="save-as-template"
        >
          <FileBox className="h-3 w-3" /> Save as template
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

      {/* Canvas + side panel (step inspector OR contract editor) */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0">
          <PipelineEditorCanvas ref={canvasRef} connectMode={connectMode && !readOnly} />
        </div>
        <div className="w-80 shrink-0 border-l border-border overflow-hidden">
          {panel === 'contracts' ? <ContractEditor /> : <StepInspector />}
        </div>
      </div>

      {/* COMP-PIPE-EDIT-7: save-as-template dialog (filename + id + label). */}
      <Dialog open={templateOpen} onOpenChange={v => !v && setTemplateOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Save as template</DialogTitle>
          </DialogHeader>
          <div className="px-6 pb-2 space-y-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Filename</span>
              <input
                type="text"
                placeholder="my-pipeline"
                value={tplForm.filename}
                onChange={e => setTplForm(p => ({ ...p, filename: e.target.value }))}
                className="text-xs bg-muted text-foreground px-2 py-1 rounded border border-border outline-none focus:border-ring"
                data-testid="tpl-filename"
              />
              <span className="text-[10px] text-muted-foreground/70">
                Saved to pipelines/. ".stratum.yaml" is appended automatically.
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Template id</span>
              <input
                type="text"
                placeholder="my-pipeline"
                value={tplForm.id}
                onChange={e => setTplForm(p => ({ ...p, id: e.target.value }))}
                className="text-xs bg-muted text-foreground px-2 py-1 rounded border border-border outline-none focus:border-ring"
                data-testid="tpl-id"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Label (optional)</span>
              <input
                type="text"
                placeholder="My Pipeline"
                value={tplForm.label}
                onChange={e => setTplForm(p => ({ ...p, label: e.target.value }))}
                className="text-xs bg-muted text-foreground px-2 py-1 rounded border border-border outline-none focus:border-ring"
                data-testid="tpl-label"
              />
            </label>
            {tplError && <p className="text-xs text-destructive" data-testid="tpl-error">{tplError}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setTemplateOpen(false)} disabled={tplSaving}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSaveTemplate}
              disabled={tplSaving || !tplForm.filename.trim() || !tplForm.id.trim()}
            >
              {tplSaving ? 'Saving…' : 'Save template'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
