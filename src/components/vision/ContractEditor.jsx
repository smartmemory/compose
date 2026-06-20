/**
 * ContractEditor — COMP-PIPE-EDIT-4 / Wave 1.
 *
 * Side panel that defines/edits the spec's `contracts:` block. Lists every user
 * contract (EXCLUDING the reserved built-in `TaskGraph`, which is shown locked
 * and never editable/deletable), supports add / rename / delete, and per-field
 * rows (name, type select, optional `values` CSV, `optional` flag).
 *
 * New contracts flow straight into the StepInspector's output_contract dropdown
 * (already sourced from model.contracts). Every mutation routes through the
 * store contract actions (which wrap the pure lib helpers + reactiveModel +
 * revalidate); a blocked delete surfaces its reason into editorErrors.
 *
 * Field widgets follow ItemFormDialog.jsx / StepInspector.jsx idioms (controlled
 * inputs, Tailwind HSL tokens, cn()). Editing is disabled for read-only specs.
 */
import React, { useState, useEffect } from 'react';
import { Plus, X, Lock } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { useVisionStore } from './useVisionStore.js';

const RESERVED_CONTRACT = 'TaskGraph';
const FIELD_TYPES = ['string', 'number', 'boolean', 'array', 'object'];

const INPUT_CLS =
  'w-full text-xs bg-muted text-foreground px-2 py-1 rounded border border-border outline-none focus:border-ring';
const LABEL_CLS = 'text-[10px] text-muted-foreground uppercase tracking-wider';

// Inline-commit text input: keeps a local buffer so a half-typed rename doesn't
// fire on every keystroke; commits on blur / Enter (mirrors StepInspector's id).
function CommitInput({ value, disabled, placeholder, className, onCommit }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => { setDraft(value ?? ''); }, [value]);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value ?? '');
  };
  return (
    <input
      type="text"
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
      className={cn(className, disabled && 'opacity-60 cursor-not-allowed')}
    />
  );
}

// One field row of a contract: name (commit-rename), type select, values CSV,
// optional flag, remove.
function FieldRow({ contractName, fieldName, spec, disabled, store }) {
  const type = spec?.type ?? 'string';
  const valuesCsv = Array.isArray(spec?.values) ? spec.values.join(', ') : '';
  const optional = !!spec?.optional;

  const patchSpec = (patch) => store.setContractField(contractName, fieldName, { ...spec, ...patch });

  return (
    <div className="flex items-center gap-1" data-testid={`contract-field-${contractName}-${fieldName}`}>
      <CommitInput
        value={fieldName}
        disabled={disabled}
        placeholder="field"
        className={cn(INPUT_CLS, 'w-1/4')}
        onCommit={next => store.renameContractField(contractName, fieldName, next)}
      />
      <select
        value={type}
        disabled={disabled}
        onChange={e => patchSpec({ type: e.target.value })}
        className={cn(INPUT_CLS, 'w-1/4 cursor-pointer', disabled && 'opacity-60 cursor-not-allowed')}
      >
        {FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      <input
        type="text"
        value={valuesCsv}
        disabled={disabled}
        placeholder="values (csv)"
        onChange={e => {
          const parsed = e.target.value.split(',').map(v => v.trim()).filter(Boolean);
          patchSpec({ values: parsed.length ? parsed : undefined });
        }}
        className={cn(INPUT_CLS, 'flex-1', disabled && 'opacity-60')}
      />
      <label className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0" title="Optional">
        <input
          type="checkbox"
          checked={optional}
          disabled={disabled}
          onChange={e => patchSpec({ optional: e.target.checked || undefined })}
        />
        opt
      </label>
      {!disabled && (
        <button type="button" onClick={() => store.removeContractField(contractName, fieldName)}
          className="text-muted-foreground hover:text-destructive shrink-0" title="Remove field">
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// One contract block: name (commit-rename), delete, and its field rows + add.
function ContractBlock({ name, fields, disabled, store }) {
  const entries = Object.entries(fields || {});
  const addField = () => {
    let key = 'field';
    let n = 1;
    while (Object.prototype.hasOwnProperty.call(fields || {}, key)) { key = `field_${++n}`; }
    store.setContractField(name, key, { type: 'string' });
  };
  return (
    <div className="rounded border border-border/60 p-2 space-y-2" data-testid={`contract-${name}`}>
      <div className="flex items-center gap-1">
        <CommitInput
          value={name}
          disabled={disabled}
          placeholder="ContractName"
          className={cn(INPUT_CLS, 'flex-1 font-medium')}
          onCommit={next => store.renameContract(name, next)}
        />
        {!disabled && (
          <button type="button" onClick={() => store.deleteContract(name)}
            className="text-muted-foreground hover:text-destructive shrink-0" title="Delete contract">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {entries.length === 0 && (
        <span className="text-[10px] text-muted-foreground/70">No fields</span>
      )}
      {entries.map(([fieldName, spec]) => (
        <FieldRow
          key={fieldName}
          contractName={name}
          fieldName={fieldName}
          spec={spec}
          disabled={disabled}
          store={store}
        />
      ))}
      {!disabled && (
        <button type="button" onClick={addField}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground" title="Add field">
          <Plus className="h-3 w-3" /> Add field
        </button>
      )}
    </div>
  );
}

export default function ContractEditor() {
  const model = useVisionStore(s => s.editorModel);
  const readOnly = useVisionStore(s => s.editorReadOnly);
  const editorErrors = useVisionStore(s => s.editorErrors);
  // Pull the contract actions once; pass them down (avoids many selector calls).
  const store = useVisionStore(s => ({
    addContract: s.addContract,
    renameContract: s.renameContract,
    deleteContract: s.deleteContract,
    setContractField: s.setContractField,
    removeContractField: s.removeContractField,
    renameContractField: s.renameContractField,
  }));

  const [newName, setNewName] = useState('');

  if (!model) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Select a spec to edit its contracts.
      </div>
    );
  }

  const contracts = model.contracts || {};
  const userNames = Object.keys(contracts).filter(n => n !== RESERVED_CONTRACT);
  const hasTaskGraph = RESERVED_CONTRACT in contracts;
  const disabled = readOnly;

  const submitNew = () => {
    const next = newName.trim();
    if (!next) return;
    const ok = store.addContract(next);
    if (ok) setNewName('');
  };

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4" data-testid="contract-editor">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Contracts</h3>
        {readOnly && <span className="text-[10px] text-muted-foreground/70">read-only</span>}
      </div>

      {/* Surface validation/blocked-action reasons (e.g. a delete refused because
          a step/flow still references the contract) so the user sees WHY. */}
      {(editorErrors?.errors?.length > 0) && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 space-y-0.5" data-testid="contract-errors">
          {editorErrors.errors.map((e, i) => (
            <p key={i} className="text-[11px] text-destructive">{e}</p>
          ))}
        </div>
      )}

      {/* Add contract */}
      {!disabled && (
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={newName}
            placeholder="New contract name…"
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitNew(); } }}
            className={INPUT_CLS}
            data-testid="new-contract-name"
          />
          <button type="button" onClick={submitNew}
            disabled={!newName.trim()}
            className={cn(
              'flex items-center gap-1 text-xs px-2 py-1 rounded border border-border shrink-0 transition-colors',
              newName.trim() ? 'text-foreground hover:bg-accent' : 'opacity-50 cursor-not-allowed text-muted-foreground',
            )}
            title="Add contract">
            <Plus className="h-3 w-3" /> Add
          </button>
        </div>
      )}

      {userNames.length === 0 && (
        <p className="text-[11px] text-muted-foreground/70">No contracts defined.</p>
      )}

      <div className="space-y-3">
        {userNames.map(name => (
          <ContractBlock
            key={name}
            name={name}
            fields={contracts[name]}
            disabled={disabled}
            store={store}
          />
        ))}
      </div>

      {/* The reserved built-in is shown locked, never editable/deletable. */}
      {hasTaskGraph && (
        <div className="rounded border border-border/40 bg-muted/20 p-2 flex items-center gap-2"
          data-testid="contract-taskgraph-locked">
          <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
          <span className="text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">{RESERVED_CONTRACT}</span> — reserved built-in (locked)
          </span>
        </div>
      )}
    </div>
  );
}
