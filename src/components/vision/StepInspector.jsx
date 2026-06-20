/**
 * StepInspector — COMP-PIPE-EDIT-2 / T5.
 *
 * Side panel that edits the editor's currently selected step. Structure follows
 * SettingsPanel.jsx (persistent side panel); field widgets follow
 * ItemFormDialog.jsx (controlled inputs, Tailwind HSL tokens, cn()).
 *
 * Fields: id, agent, intent (textarea), inputs (key/value add/remove rows),
 * output_contract (select of the spec's contracts + TaskGraph + (none)), ensure
 * (string rows), retries (number), on_fail (select of other step ids + (none)).
 *
 * Every edit routes through the store: updateStep(id, patch), except an id edit
 * which routes through renameStep(oldId, newId) so all reference fields are
 * rewritten and the _renamedFrom save hint is set. Inline errors come from
 * editorErrors.warningsByStepId[stepId]. Editing is disabled for read-only
 * (v0.1) specs.
 */
import React, { useState, useEffect } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { useVisionStore } from './useVisionStore.js';
import { flowSteps } from '../../lib/pipeline-model.js';

const INPUT_CLS =
  'w-full text-xs bg-muted text-foreground px-2 py-1 rounded border border-border outline-none focus:border-ring';
const LABEL_CLS = 'text-[10px] text-muted-foreground uppercase tracking-wider';

function Field({ label, children, hint }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL_CLS}>{label}</span>
      {children}
      {hint && <span className="text-[10px] text-muted-foreground/70">{hint}</span>}
    </label>
  );
}

export default function StepInspector() {
  const model = useVisionStore(s => s.editorModel);
  const selectedFlow = useVisionStore(s => s.editorSelectedFlow);
  const selectedStepId = useVisionStore(s => s.editorSelectedStep);
  const errors = useVisionStore(s => s.editorErrors);
  const readOnly = useVisionStore(s => s.editorReadOnly);
  const updateStep = useVisionStore(s => s.updateStep);
  const renameStep = useVisionStore(s => s.renameStep);

  const steps = model && selectedFlow ? flowSteps(model, selectedFlow) : [];
  const step = steps.find(s => s.id === selectedStepId) || null;

  // Local id buffer so a half-typed id doesn't rename on every keystroke; commit
  // the rename on blur / Enter.
  const [idDraft, setIdDraft] = useState('');
  useEffect(() => { setIdDraft(step?.id ?? ''); }, [step?.id]);

  if (!step) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Select a step on the canvas to edit it.
      </div>
    );
  }

  const stepWarnings = errors?.warningsByStepId?.[step.id] || [];
  const contractOptions = [
    ...Object.keys(model.contracts || {}),
    'TaskGraph',
    '(none)',
  ];
  const otherStepIds = steps.filter(s => s.id !== step.id).map(s => s.id);

  const commitId = () => {
    const next = idDraft.trim();
    if (next && next !== step.id) renameStep(step.id, next);
    else setIdDraft(step.id);
  };

  // ── inputs (key/value rows) ────────────────────────────────────────────────
  const inputs = step.inputs || {};
  const setInputs = (next) => updateStep(step.id, { inputs: next });
  const addInputRow = () => {
    let key = 'key';
    let n = 1;
    while (Object.prototype.hasOwnProperty.call(inputs, key)) { key = `key_${++n}`; }
    setInputs({ ...inputs, [key]: '' });
  };
  const renameInputKey = (oldKey, newKey) => {
    if (!newKey || newKey === oldKey) return;
    const next = {};
    for (const [k, v] of Object.entries(inputs)) next[k === oldKey ? newKey : k] = v;
    setInputs(next);
  };
  const setInputValue = (key, value) => setInputs({ ...inputs, [key]: value });
  const removeInputRow = (key) => {
    const next = { ...inputs };
    delete next[key];
    setInputs(next);
  };

  // ── ensure (string rows) ───────────────────────────────────────────────────
  const ensure = Array.isArray(step.ensure) ? step.ensure : [];
  const setEnsure = (next) => updateStep(step.id, { ensure: next });
  const setEnsureAt = (i, value) => setEnsure(ensure.map((e, idx) => (idx === i ? value : e)));
  const addEnsureRow = () => setEnsure([...ensure, '']);
  const removeEnsureRow = (i) => setEnsure(ensure.filter((_, idx) => idx !== i));

  const disabled = readOnly;

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4" data-testid="step-inspector">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Step</h3>
        {readOnly && <span className="text-[10px] text-muted-foreground/70">read-only</span>}
      </div>

      {stepWarnings.length > 0 && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 space-y-0.5">
          {stepWarnings.map((w, i) => (
            <p key={i} className="text-[10px] text-destructive">{w}</p>
          ))}
        </div>
      )}

      {/* id */}
      <Field label="ID">
        <input
          type="text"
          value={idDraft}
          disabled={disabled}
          onChange={e => setIdDraft(e.target.value)}
          onBlur={commitId}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitId(); } }}
          className={cn(INPUT_CLS, disabled && 'opacity-60 cursor-not-allowed')}
        />
      </Field>

      {/* agent */}
      <Field label="Agent" hint="provider:template:tier">
        <input
          type="text"
          value={step.agent ?? ''}
          disabled={disabled}
          placeholder="claude:design:opus"
          onChange={e => updateStep(step.id, { agent: e.target.value })}
          className={cn(INPUT_CLS, disabled && 'opacity-60 cursor-not-allowed')}
        />
      </Field>

      {/* intent */}
      <Field label="Intent">
        <textarea
          value={step.intent ?? ''}
          disabled={disabled}
          rows={3}
          onChange={e => updateStep(step.id, { intent: e.target.value })}
          className={cn(INPUT_CLS, 'resize-none', disabled && 'opacity-60 cursor-not-allowed')}
        />
      </Field>

      {/* inputs */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className={LABEL_CLS}>Inputs</span>
          {!disabled && (
            <button type="button" onClick={addInputRow}
              className="text-muted-foreground hover:text-foreground" title="Add input">
              <Plus className="h-3 w-3" />
            </button>
          )}
        </div>
        {Object.entries(inputs).length === 0 && (
          <span className="text-[10px] text-muted-foreground/70">No inputs</span>
        )}
        {Object.entries(inputs).map(([key, value]) => (
          <div key={key} className="flex items-center gap-1">
            <input
              type="text" value={key} disabled={disabled} placeholder="key"
              onChange={e => renameInputKey(key, e.target.value)}
              className={cn(INPUT_CLS, 'w-1/3', disabled && 'opacity-60')}
            />
            <input
              type="text" value={value ?? ''} disabled={disabled} placeholder="$.input.x"
              onChange={e => setInputValue(key, e.target.value)}
              className={cn(INPUT_CLS, 'flex-1', disabled && 'opacity-60')}
            />
            {!disabled && (
              <button type="button" onClick={() => removeInputRow(key)}
                className="text-muted-foreground hover:text-destructive" title="Remove">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* output_contract */}
      <Field label="Output Contract">
        <select
          value={step.output_contract ?? '(none)'}
          disabled={disabled}
          onChange={e => updateStep(step.id, {
            output_contract: e.target.value === '(none)' ? undefined : e.target.value,
          })}
          className={cn(INPUT_CLS, 'cursor-pointer', disabled && 'opacity-60 cursor-not-allowed')}
        >
          {contractOptions.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>

      {/* ensure */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className={LABEL_CLS}>Ensure</span>
          {!disabled && (
            <button type="button" onClick={addEnsureRow}
              className="text-muted-foreground hover:text-foreground" title="Add ensure">
              <Plus className="h-3 w-3" />
            </button>
          )}
        </div>
        {ensure.length === 0 && (
          <span className="text-[10px] text-muted-foreground/70">No postconditions</span>
        )}
        {ensure.map((expr, i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              type="text" value={expr ?? ''} disabled={disabled} placeholder="expression"
              onChange={e => setEnsureAt(i, e.target.value)}
              className={cn(INPUT_CLS, 'flex-1', disabled && 'opacity-60')}
            />
            {!disabled && (
              <button type="button" onClick={() => removeEnsureRow(i)}
                className="text-muted-foreground hover:text-destructive" title="Remove">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* retries */}
      <Field label="Retries">
        <input
          type="number" min={0}
          value={step.retries ?? ''}
          disabled={disabled}
          onChange={e => updateStep(step.id, {
            retries: e.target.value === '' ? undefined : Number(e.target.value),
          })}
          className={cn(INPUT_CLS, disabled && 'opacity-60 cursor-not-allowed')}
        />
      </Field>

      {/* on_fail */}
      <Field label="On Fail">
        <select
          value={step.on_fail ?? '(none)'}
          disabled={disabled}
          onChange={e => updateStep(step.id, {
            on_fail: e.target.value === '(none)' ? undefined : e.target.value,
          })}
          className={cn(INPUT_CLS, 'cursor-pointer', disabled && 'opacity-60 cursor-not-allowed')}
        >
          <option value="(none)">(none)</option>
          {otherStepIds.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
      </Field>
    </div>
  );
}
