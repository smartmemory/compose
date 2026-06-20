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
import { Plus, Save, RefreshCw, Link2, FileBox, Sliders, FileCode, Group } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog.jsx';
import { Button } from '@/components/ui/button.jsx';
import { useVisionStore } from './useVisionStore.js';
import { listEditableFlows } from '../../lib/pipeline-model.js';
import PipelineEditorCanvas from './PipelineEditorCanvas.jsx';
import StepInspector from './StepInspector.jsx';
import ContractEditor from './ContractEditor.jsx';
import YamlPane from './YamlPane.jsx';

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
  // COMP-PIPE-EDIT-6: conflict + pending-buffer state.
  const conflict = useVisionStore(s => s.editorConflict);
  const yamlBuffer = useVisionStore(s => s.editorYamlBuffer);
  const yamlError = useVisionStore(s => s.editorYamlError);

  const loadSpecList = useVisionStore(s => s.loadSpecList);
  const loadSpecForEdit = useVisionStore(s => s.loadSpecForEdit);
  const selectFlow = useVisionStore(s => s.selectFlow);
  const addStep = useVisionStore(s => s.addStep);
  const saveSpec = useVisionStore(s => s.saveSpec);
  const saveAsTemplate = useVisionStore(s => s.saveAsTemplate);
  const resolveConflict = useVisionStore(s => s.resolveConflict);
  const collapseSelectedToSubflow = useVisionStore(s => s.collapseSelectedToSubflow);

  // COMP-PIPE-EDIT-3/-4/-7: local view state for connect mode, the side panel
  // (step inspector vs contract editor), and the save-as-template dialog.
  const [connectMode, setConnectMode] = useState(false);
  const [panel, setPanel] = useState('inspector'); // 'inspector' | 'contracts' | 'yaml'
  const [templateOpen, setTemplateOpen] = useState(false);
  const [tplForm, setTplForm] = useState({ filename: '', id: '', label: '' });
  const [tplError, setTplError] = useState('');
  const [tplSaving, setTplSaving] = useState(false);

  // COMP-PIPE-EDIT-5: multi-select set for collapse (shift-tap on the canvas
  // accumulates here). The collapse dialog reads it; the canvas surfaces it.
  const [collapseSel, setCollapseSel] = useState([]); // step ids
  const [collapseOpen, setCollapseOpen] = useState(false);
  const [collapseName, setCollapseName] = useState('');
  const [collapseError, setCollapseError] = useState('');

  // Load the spec list once when the view mounts.
  useEffect(() => { loadSpecList(); }, [loadSpecList]);

  // Connect/contract editing must be off for read-only (v0.1) specs.
  useEffect(() => { if (readOnly) { setConnectMode(false); setPanel('inspector'); } }, [readOnly]);

  // COMP-PIPE-EDIT-5: a flow switch (or spec switch) drops a stale collapse
  // selection — its step ids belong to the previous flow.
  useEffect(() => { setCollapseSel([]); }, [selectedFlow, specFile]);

  const flows = model?._doc ? listEditableFlows(model._doc) : [];
  const errorCount = errors?.errors?.length || 0;
  // COMP-PIPE-EDIT-6: a pending/unparseable YAML pane buffer blocks the save (it
  // would persist the stale model, not the visible buffer). Mirrors the store gate.
  const bufferPending = yamlBuffer != null || !!yamlError;
  const canSave = dirty && errorCount === 0 && !readOnly && !bufferPending;

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

  // COMP-PIPE-EDIT-6: resolve an on-disk conflict (reload discards local edits;
  // overwrite re-saves with force). Both clear the banner via the store.
  const handleResolveConflict = async (mode) => {
    const res = await resolveConflict(mode);
    if (res?.error && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('compose:notify', {
        detail: { level: 'warn', message: `Conflict resolution failed: ${res.error}` },
      }));
    }
  };

  // COMP-PIPE-EDIT-5: open the collapse dialog (needs >= 1 selected step).
  const openCollapseDialog = () => {
    setCollapseName('');
    setCollapseError('');
    setCollapseOpen(true);
  };

  const handleCollapse = () => {
    const name = collapseName.trim();
    if (!name) { setCollapseError('A sub-flow name is required'); return; }
    if (collapseSel.length === 0) { setCollapseError('Select at least one step to collapse'); return; }
    const ok = collapseSelectedToSubflow(collapseSel, name);
    if (!ok) {
      // The store surfaced the precise reason into editorErrors; echo the latest.
      const reason = useVisionStore.getState().editorErrors?.errors?.[0] || 'Cannot collapse the selected steps';
      setCollapseError(reason);
      return;
    }
    setCollapseOpen(false);
    setCollapseSel([]);
    canvasRef.current?.relayout();
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

        {/* COMP-PIPE-EDIT-4: toggle the side panel to the contract editor (a
            3-way panel: inspector | contracts | yaml). */}
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

        {/* COMP-PIPE-EDIT-6: toggle the side panel to the YAML pane. */}
        <button
          type="button"
          onClick={() => setPanel(p => (p === 'yaml' ? 'inspector' : 'yaml'))}
          disabled={!model}
          aria-pressed={panel === 'yaml'}
          className={cn(
            'flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors',
            !model
              ? 'opacity-50 cursor-not-allowed text-muted-foreground border-border'
              : panel === 'yaml'
                ? 'border-accent/60 text-accent bg-accent/10'
                : 'text-foreground border-border hover:bg-accent',
          )}
          title="View / edit YAML"
          data-testid="yaml-toggle"
        >
          <FileCode className="h-3 w-3" /> YAML
        </button>

        {/* COMP-PIPE-EDIT-5: collapse the multi-selected steps into a sub-flow. */}
        <button
          type="button"
          onClick={openCollapseDialog}
          disabled={!model || !selectedFlow || readOnly || collapseSel.length === 0}
          className={cn(
            'flex items-center gap-1 text-xs px-2 py-1 rounded border border-border transition-colors',
            (!model || !selectedFlow || readOnly || collapseSel.length === 0)
              ? 'opacity-50 cursor-not-allowed text-muted-foreground'
              : 'text-foreground hover:bg-accent',
          )}
          title={
            collapseSel.length === 0
              ? 'Shift-tap steps on the canvas to select a group, then collapse'
              : `Collapse ${collapseSel.length} step${collapseSel.length === 1 ? '' : 's'} to a sub-flow`
          }
          data-testid="collapse-toggle"
        >
          <Group className="h-3 w-3" /> Collapse{collapseSel.length > 0 ? ` (${collapseSel.length})` : ''}
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

      {/* COMP-PIPE-EDIT-6: on-disk conflict banner (Reload discards local edits;
          Overwrite re-saves with force). */}
      {conflict && (
        <div
          className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-[11px] bg-destructive/10 text-destructive border-b border-destructive/30"
          data-testid="conflict-banner"
        >
          <span className="flex-1">This spec changed on disk since you loaded it.</span>
          <button
            type="button"
            onClick={() => handleResolveConflict('reload')}
            className="px-2 py-0.5 rounded border border-destructive/50 hover:bg-destructive/15"
            data-testid="conflict-reload"
          >
            Reload (discard my edits)
          </button>
          <button
            type="button"
            onClick={() => handleResolveConflict('overwrite')}
            className="px-2 py-0.5 rounded border border-destructive/50 hover:bg-destructive/15"
            data-testid="conflict-overwrite"
          >
            Overwrite
          </button>
        </div>
      )}

      {/* COMP-PIPE-EDIT-6: pending-buffer notice (Save is blocked until it flushes). */}
      {bufferPending && (
        <div
          className="shrink-0 px-3 py-1 text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 border-b border-amber-500/30"
          data-testid="buffer-pending"
        >
          {yamlError
            ? 'The YAML pane has a parse error. Fix it before saving.'
            : 'The YAML pane has unsaved text. It will apply shortly; saving is paused until then.'}
        </div>
      )}

      {/* Canvas + side panel (step inspector | contract editor | YAML pane) */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0">
          <PipelineEditorCanvas
            ref={canvasRef}
            connectMode={connectMode && !readOnly}
            multiSelect={collapseSel}
            onMultiSelectChange={setCollapseSel}
            onExpand={fl => useVisionStore.getState().expandSubflow(fl)}
          />
        </div>
        <div className="w-80 shrink-0 border-l border-border overflow-hidden">
          {panel === 'yaml'
            ? <YamlPane />
            : panel === 'contracts'
              ? <ContractEditor />
              : <StepInspector />}
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

      {/* COMP-PIPE-EDIT-5: collapse-to-sub-flow dialog (new flow name). */}
      <Dialog open={collapseOpen} onOpenChange={v => !v && setCollapseOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Collapse to sub-flow</DialogTitle>
          </DialogHeader>
          <div className="px-6 pb-2 space-y-3">
            <p className="text-xs text-muted-foreground">
              Extract {collapseSel.length} selected step{collapseSel.length === 1 ? '' : 's'}
              {' '}({collapseSel.join(', ') || 'none'}) into a new sub-flow, replacing
              {collapseSel.length === 1 ? ' it' : ' them'} with one flow step.
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Sub-flow name</span>
              <input
                type="text"
                placeholder="prep"
                value={collapseName}
                onChange={e => setCollapseName(e.target.value)}
                className="text-xs bg-muted text-foreground px-2 py-1 rounded border border-border outline-none focus:border-ring"
                data-testid="collapse-name"
              />
            </label>
            {collapseError && <p className="text-xs text-destructive" data-testid="collapse-error">{collapseError}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setCollapseOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCollapse} disabled={!collapseName.trim()}>
              Collapse
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
