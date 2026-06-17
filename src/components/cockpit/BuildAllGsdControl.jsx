/**
 * BuildAllGsdControl — header control for the two batch-grade build verbs that
 * had no UI trigger (COMP-PARITY-8): `compose build --all` and `compose gsd
 * <CODE>`.
 *
 * Self-contained: a header icon button toggles an absolutely-positioned popover
 * with two actions, both dispatched through the shared `startBuild` helper (the
 * one POST /api/build/start seam) — no new fetch path, no shared launcher.
 *
 *   - Build all PLANNED → confirm-gated (roadmap-wide + expensive) via
 *     useConfirm(), then startBuild({ mode: 'all' }) (no featureCode).
 *   - GSD <CODE>        → startBuild({ featureCode, mode: 'gsd' }).
 *
 * Mirrors EnvironmentHealthPanel's header-button + outside-click/escape popover
 * pattern and StartBuildPopover's styling + testid conventions. Pure dispatch
 * shaping lives in buildAllGsdControlState.js so it is testable without JSX.
 */
import React, { useEffect, useRef, useState } from 'react';
import { startBuild } from '../../lib/startBuild.js';
import { useConfirm } from '../ui/DialogProvider.jsx';
import {
  BUILD_ALL_CONFIRM,
  buildAllPayload,
  canSubmitGsd,
  gsdPayload,
} from './buildAllGsdControlState.js';

export default function BuildAllGsdControl() {
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [featureCode, setFeatureCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);
  const rootRef = useRef(null);

  // Outside-click / Escape closes the popover (mirrors EnvironmentHealthPanel).
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function reset() {
    setErr(null);
    setSubmitting(false);
  }

  async function dispatch(payload) {
    setSubmitting(true);
    setErr(null);
    try {
      await startBuild(payload);
      setOpen(false);
      setFeatureCode('');
      setSubmitting(false);
    } catch (e) {
      // Error carries .status (e.g. 409 = a build is already active); surface
      // it and keep the popover open (mirrors StartBuildPopover).
      setErr(e.message || 'Failed to start build');
      setSubmitting(false);
    }
  }

  async function handleBuildAll() {
    // Roadmap-wide and expensive → confirm first (COMP-PARITY-8 design).
    const ok = await confirm(BUILD_ALL_CONFIRM);
    if (!ok) return;
    await dispatch(buildAllPayload());
  }

  async function handleGsd(ev) {
    ev?.preventDefault();
    const payload = gsdPayload(featureCode);
    if (!payload) {
      setErr('Feature code is required');
      return;
    }
    await dispatch(payload);
  }

  return (
    <div ref={rootRef} className="relative flex items-center shrink-0">
      <button
        type="button"
        data-testid="build-all-gsd-trigger"
        className="compose-btn-icon"
        onClick={() => { setOpen((v) => !v); reset(); }}
        title="Batch builds: build all PLANNED features or run GSD on one feature"
        aria-label="Batch builds"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {/* Stacked-bars glyph — "build everything" */}
        <span aria-hidden="true" className="text-[13px] leading-none">≣</span>
      </button>

      {open && (
        <div
          data-testid="build-all-gsd-popover"
          role="dialog"
          aria-label="Batch builds"
          className="absolute top-full right-0 mt-1 w-64 rounded-md border border-border bg-popover shadow-lg z-50"
        >
          <div className="p-2 space-y-3">
            <div className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Build all
              </div>
              <button
                type="button"
                data-testid="build-all-submit"
                className="w-full text-[10px] px-2 py-1.5 rounded border border-accent bg-accent/10 text-foreground disabled:opacity-50"
                disabled={submitting}
                onClick={handleBuildAll}
              >
                {submitting ? 'Starting…' : 'Build all PLANNED features'}
              </button>
            </div>

            <form className="space-y-1" onSubmit={handleGsd}>
              <label
                className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                htmlFor="build-gsd-feature"
              >
                GSD
              </label>
              <input
                id="build-gsd-feature"
                type="text"
                className="w-full text-xs bg-muted text-foreground px-2 py-1.5 rounded border border-border outline-none"
                placeholder="FEATURE-CODE"
                value={featureCode}
                onChange={(e) => setFeatureCode(e.target.value)}
                data-testid="build-gsd-feature-input"
              />
              <button
                type="submit"
                data-testid="build-gsd-submit"
                className="w-full text-[10px] px-2 py-1.5 rounded border border-accent bg-accent/10 text-foreground disabled:opacity-50"
                disabled={submitting || !canSubmitGsd(featureCode)}
              >
                {submitting ? 'Starting…' : 'Run GSD'}
              </button>
            </form>

            {err ? (
              <div className="text-[10px] text-destructive" role="alert" data-testid="build-all-gsd-error">
                {err}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
