import React, { useState } from 'react';
import { startBuild } from '../../lib/startBuild.js';

/**
 * StartBuildPopover — desktop equivalent of the mobile StartBuildSheet. Lets a
 * UI-created item (one with no lifecycle yet) dispatch the build/bug-fix
 * lifecycle via POST /api/build/start, the same endpoint mobile uses (#31).
 *
 * The feature code defaults to the item's existing identity
 * (lifecycle.featureCode → top-level featureCode → id). Dispatching with the
 * item's id/featureCode lets the CLI/server bind to THIS item rather than
 * creating a duplicate (see matchFeatureItem in lib/vision-writer.js).
 *
 * Dispatches via the shared startBuild helper (src/lib/startBuild.js) so it
 * needs no new prop threaded through the parent surface.
 *
 * @param {{ item: object, onClose: () => void }} props
 */
export default function StartBuildPopover({ item, onClose }) {
  const defaultCode = item?.lifecycle?.featureCode || item?.featureCode || item?.id || '';
  const [featureCode, setFeatureCode] = useState(defaultCode);
  // A bug-typed item should launch the bug-fix pipeline by default (#31).
  const [mode, setMode] = useState(item?.type === 'bug' ? 'bug' : 'feature');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);

  async function handleSubmit(ev) {
    ev?.preventDefault();
    const code = featureCode.trim();
    if (!code) { setErr('Feature code is required'); return; }
    setSubmitting(true);
    setErr(null);
    try {
      await startBuild({ featureCode: code, mode, description: description.trim() });
      onClose?.();
    } catch (e) {
      setErr(e.message || 'Failed to start build');
      setSubmitting(false);
    }
  }

  return (
    <div
      className="absolute bottom-full left-0 mb-1 w-64 rounded-md border border-border bg-popover shadow-lg z-50"
      data-testid="start-build-popover"
    >
      <form className="p-2 space-y-2" onSubmit={handleSubmit}>
        <div className="space-y-1">
          <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground" htmlFor="start-build-feature">
            Feature code
          </label>
          <input
            id="start-build-feature"
            type="text"
            className="w-full text-xs bg-muted text-foreground px-2 py-1.5 rounded border border-border outline-none"
            value={featureCode}
            onChange={(e) => setFeatureCode(e.target.value)}
            data-testid="start-build-feature-input"
            autoFocus
          />
        </div>

        <div className="space-y-1">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Mode</div>
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Build mode">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'feature'}
              className={`text-[10px] px-2 py-1 rounded border cursor-pointer ${mode === 'feature' ? 'bg-accent/10 border-accent text-foreground' : 'bg-muted border-border text-muted-foreground'}`}
              data-testid="start-build-mode-feature"
              onClick={() => setMode('feature')}
            >Feature</button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'bug'}
              className={`text-[10px] px-2 py-1 rounded border cursor-pointer ${mode === 'bug' ? 'bg-accent/10 border-accent text-foreground' : 'bg-muted border-border text-muted-foreground'}`}
              data-testid="start-build-mode-bug"
              onClick={() => setMode('bug')}
            >Bug</button>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground" htmlFor="start-build-desc">
            Description (optional)
          </label>
          <textarea
            id="start-build-desc"
            className="w-full text-xs bg-muted text-foreground px-2 py-1.5 rounded border border-border outline-none resize-none"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            data-testid="start-build-description"
          />
        </div>

        {err ? <div className="text-[10px] text-destructive" role="alert">{err}</div> : null}

        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            className="text-[10px] px-2 py-1 rounded border border-border text-muted-foreground hover:bg-muted/50"
            onClick={() => onClose?.()}
            disabled={submitting}
            data-testid="start-build-cancel"
          >Cancel</button>
          <button
            type="submit"
            className="text-[10px] px-2 py-1 rounded border border-accent bg-accent/10 text-foreground disabled:opacity-50"
            disabled={submitting || !featureCode.trim()}
            data-testid="start-build-submit"
          >{submitting ? 'Starting…' : 'Start'}</button>
        </div>
      </form>
    </div>
  );
}
