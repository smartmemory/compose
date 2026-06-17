import React, { useState } from 'react';
import { startBuild } from '../../lib/startBuild.js';
import { buildLaunchPayload } from './launchPopoverState.js';

// Re-exported so the blueprint's named-export contract holds for JSX-aware
// consumers; the pure logic lives in launchPopoverState.js so node --test can
// import it without a JSX transform.
export { buildLaunchPayload };

/**
 * LaunchPopover — top-level cockpit launcher for the fix and new lifecycles
 * plus resume-an-aborted-fix (COMP-PARITY-2). Item-independent: unlike
 * StartBuildPopover it does not require an existing vision item.
 *
 *  - Fix:    POST /api/build/start { featureCode: <bug code>, mode:'bug', description }
 *  - New:    POST /api/build/start { mode:'new', description: <intent> }   (no featureCode)
 *  - Resume: POST /api/build/start { featureCode: <active bug code>, mode:'bug', resume:true }
 *            enabled only when activeBuild?.mode === 'bug'.
 *
 * Dispatches via the shared startBuild helper (src/lib/startBuild.js) so it
 * needs no new prop threaded through the parent surface.
 *
 * @param {{ activeBuild: object|null, onClose: () => void }} props
 */
export default function LaunchPopover({ activeBuild, onClose }) {
  const resumableCode =
    activeBuild && activeBuild.mode === 'bug' && activeBuild.featureCode
      ? activeBuild.featureCode : '';
  const [lifecycle, setLifecycle] = useState('fix'); // 'fix' | 'new' | 'resume'
  const [bugCode, setBugCode] = useState('');
  const [intent, setIntent] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);

  async function handleSubmit(ev) {
    ev?.preventDefault();
    setErr(null);
    const result = buildLaunchPayload(lifecycle, { bugCode, intent, description, resumableCode });
    if (result.error) { setErr(result.error); return; }
    setSubmitting(true);
    try {
      await startBuild(result.args);
      onClose?.();
    } catch (e) {
      setErr(e.message || 'Failed to launch');
      setSubmitting(false);
    }
  }

  const submitDisabled =
    submitting ||
    (lifecycle === 'fix' && !bugCode.trim()) ||
    (lifecycle === 'new' && !intent.trim()) ||
    (lifecycle === 'resume' && !resumableCode);

  return (
    <div
      className="absolute top-full right-0 mt-1 w-64 rounded-md border border-border bg-popover shadow-lg z-50"
      data-testid="launch-popover"
    >
      <form className="p-2 space-y-2" onSubmit={handleSubmit}>
        <div className="space-y-1">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Lifecycle</div>
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Launch lifecycle">
            <button
              type="button"
              role="radio"
              aria-checked={lifecycle === 'fix'}
              className={`text-[10px] px-2 py-1 rounded border cursor-pointer ${lifecycle === 'fix' ? 'bg-accent/10 border-accent text-foreground' : 'bg-muted border-border text-muted-foreground'}`}
              data-testid="launch-mode-fix"
              onClick={() => setLifecycle('fix')}
            >Fix</button>
            <button
              type="button"
              role="radio"
              aria-checked={lifecycle === 'new'}
              className={`text-[10px] px-2 py-1 rounded border cursor-pointer ${lifecycle === 'new' ? 'bg-accent/10 border-accent text-foreground' : 'bg-muted border-border text-muted-foreground'}`}
              data-testid="launch-mode-new"
              onClick={() => setLifecycle('new')}
            >New</button>
            <button
              type="button"
              role="radio"
              aria-checked={lifecycle === 'resume'}
              aria-disabled={!resumableCode}
              disabled={!resumableCode}
              className={`text-[10px] px-2 py-1 rounded border ${!resumableCode ? 'bg-muted border-border text-muted-foreground opacity-50 cursor-not-allowed' : lifecycle === 'resume' ? 'bg-accent/10 border-accent text-foreground cursor-pointer' : 'bg-muted border-border text-muted-foreground cursor-pointer'}`}
              data-testid="launch-mode-resume"
              onClick={() => { if (resumableCode) setLifecycle('resume'); }}
            >Resume</button>
          </div>
        </div>

        {lifecycle === 'new' ? (
          <div className="space-y-1">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground" htmlFor="launch-intent">
              Product intent
            </label>
            <textarea
              id="launch-intent"
              className="w-full text-xs bg-muted text-foreground px-2 py-1.5 rounded border border-border outline-none resize-none"
              rows={3}
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              data-testid="launch-intent-input"
              autoFocus
            />
          </div>
        ) : lifecycle === 'resume' ? (
          <div className="text-[10px] text-muted-foreground" data-testid="launch-resume-target">
            {resumableCode
              ? <>Resume active fix: <span className="text-foreground">{resumableCode}</span></>
              : 'No active fix to resume.'}
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground" htmlFor="launch-bugcode">
                Bug code
              </label>
              <input
                id="launch-bugcode"
                type="text"
                className="w-full text-xs bg-muted text-foreground px-2 py-1.5 rounded border border-border outline-none"
                value={bugCode}
                onChange={(e) => setBugCode(e.target.value)}
                data-testid="launch-bugcode-input"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground" htmlFor="launch-desc">
                Description (optional)
              </label>
              <textarea
                id="launch-desc"
                className="w-full text-xs bg-muted text-foreground px-2 py-1.5 rounded border border-border outline-none resize-none"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                data-testid="launch-description"
              />
            </div>
          </>
        )}

        {err ? <div className="text-[10px] text-destructive" role="alert">{err}</div> : null}

        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            className="text-[10px] px-2 py-1 rounded border border-border text-muted-foreground hover:bg-muted/50"
            onClick={() => onClose?.()}
            disabled={submitting}
            data-testid="launch-cancel"
          >Cancel</button>
          <button
            type="submit"
            className="text-[10px] px-2 py-1 rounded border border-accent bg-accent/10 text-foreground disabled:opacity-50"
            disabled={submitDisabled}
            data-testid="launch-submit"
          >{submitting ? 'Launching…' : 'Launch'}</button>
        </div>
      </form>
    </div>
  );
}
