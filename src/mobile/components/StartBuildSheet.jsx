import React, { useEffect, useId, useMemo, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';

async function fetchFeatureCodes() {
  try {
    const res = await wsFetch('/api/vision/items');
    if (!res.ok) return [];
    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
    const codes = new Set();
    for (const it of items) {
      const code = it?.lifecycle?.featureCode || it?.featureCode || it?.id;
      if (code && typeof code === 'string') codes.add(code);
    }
    return [...codes].sort();
  } catch {
    return [];
  }
}

export default function StartBuildSheet({ open, onClose, onSubmit }) {
  const [featureCode, setFeatureCode] = useState('');
  const [mode, setMode] = useState('feature');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);
  const [codes, setCodes] = useState([]);
  const listId = useId();

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    fetchFeatureCodes().then(c => { if (alive) setCodes(c); });
    return () => { alive = false; };
  }, [open]);

  const filteredCodes = useMemo(() => codes, [codes]);

  if (!open) return null;

  function reset() {
    setFeatureCode('');
    setMode('feature');
    setDescription('');
    setErr(null);
    setSubmitting(false);
  }

  function close() {
    reset();
    onClose?.();
  }

  async function handleSubmit(ev) {
    ev?.preventDefault();
    if (!featureCode.trim()) {
      setErr('Feature code is required');
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      await onSubmit?.({
        featureCode: featureCode.trim(),
        mode,
        description: description.trim(),
      });
      close();
    } catch (e) {
      setErr(e.message || 'Failed to start build');
      setSubmitting(false);
    }
  }

  return (
    <div
      className="m-sheet-overlay"
      data-testid="mobile-start-build-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Start build"
      onClick={(ev) => { if (ev.target === ev.currentTarget) close(); }}
    >
      <div className="m-sheet">
        <header className="m-sheet-header">
          <button
            type="button"
            className="m-sheet-close"
            aria-label="Close start build"
            onClick={close}
            disabled={submitting}
          >×</button>
          <div className="m-sheet-title-row">
            <div className="m-sheet-title">Start build</div>
          </div>
        </header>

        <form className="m-sheet-body" onSubmit={handleSubmit}>
          <div className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-build-feature">Feature code</label>
            <input
              id="m-build-feature"
              type="text"
              className="m-sheet-input"
              value={featureCode}
              onChange={(e) => setFeatureCode(e.target.value)}
              placeholder="e.g. COMP-MOBILE"
              data-testid="mobile-build-feature-input"
              list={listId}
              autoFocus
              required
            />
            <datalist id={listId}>
              {filteredCodes.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>

          <div className="m-sheet-section">
            <div className="m-sheet-label">Mode</div>
            <div className="m-build-mode-row" role="radiogroup" aria-label="Build mode">
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'feature'}
                className={`m-priority-chip${mode === 'feature' ? ' is-selected' : ''}`}
                data-testid="mobile-build-mode-feature"
                onClick={() => setMode('feature')}
              >Feature</button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'bug'}
                className={`m-priority-chip${mode === 'bug' ? ' is-selected' : ''}`}
                data-testid="mobile-build-mode-bug"
                onClick={() => setMode('bug')}
              >Bug</button>
            </div>
          </div>

          <div className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-build-desc">Description (optional)</label>
            <textarea
              id="m-build-desc"
              className="m-sheet-input m-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              data-testid="mobile-build-description"
            />
          </div>

          {err ? <div className="m-form-error" role="alert">{err}</div> : null}
        </form>

        <footer className="m-sheet-footer">
          <button
            type="button"
            className="m-sheet-btn m-sheet-btn-secondary"
            onClick={close}
            disabled={submitting}
            data-testid="mobile-build-cancel"
          >Cancel</button>
          <button
            type="button"
            className="m-sheet-btn m-sheet-btn-primary"
            disabled={submitting || !featureCode.trim()}
            data-testid="mobile-build-submit"
            onClick={handleSubmit}
          >{submitting ? 'Starting…' : 'Start'}</button>
        </footer>
      </div>
    </div>
  );
}
