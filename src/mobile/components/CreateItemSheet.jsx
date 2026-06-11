import React, { useState, useId } from 'react';

// Server-validated statuses (vision-store.js:11). Matches ItemDetailSheet.
const STATUS_OPTIONS = [
  'planned',
  'ready',
  'in_progress',
  'review',
  'complete',
  'blocked',
  'parked',
  'killed',
  'superseded',
];

export default function CreateItemSheet({ open, onClose, onCreate, groupOptions = [] }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [group, setGroup] = useState('');
  const [status, setStatus] = useState('planned');
  const [confidence, setConfidence] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);
  const groupListId = useId();

  if (!open) return null;

  function reset() {
    setTitle('');
    setDescription('');
    setGroup('');
    setStatus('planned');
    setConfidence('');
    setErr(null);
    setSubmitting(false);
  }

  function close() {
    reset();
    onClose?.();
  }

  async function handleSubmit(ev) {
    ev.preventDefault();
    if (!title.trim()) {
      setErr('Title is required');
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const fields = { title: title.trim() };
      if (description.trim()) fields.description = description.trim();
      if (group.trim()) fields.group = group.trim();
      if (status) fields.status = status;
      if (confidence !== '') {
        const num = Number(confidence);
        if (Number.isFinite(num)) fields.confidence = num;
      }
      await onCreate?.(fields);
      close();
    } catch (e) {
      setErr(e.message || 'Failed to create item');
      setSubmitting(false);
    }
  }

  return (
    <div
      className="m-sheet-overlay"
      data-testid="mobile-create-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Create roadmap item"
      onClick={(ev) => { if (ev.target === ev.currentTarget) close(); }}
    >
      <div className="m-sheet">
        <header className="m-sheet-header">
          <button
            type="button"
            className="m-sheet-close"
            aria-label="Close"
            onClick={close}
            disabled={submitting}
          >×</button>
          <div className="m-sheet-title-row">
            <div className="m-sheet-title">New roadmap item</div>
          </div>
        </header>

        <form className="m-sheet-body" onSubmit={handleSubmit}>
          <div className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-create-title">Title</label>
            <input
              id="m-create-title"
              type="text"
              className="m-sheet-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Feature title"
              data-testid="mobile-create-title"
              autoFocus
              required
            />
          </div>

          <div className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-create-desc">Description (optional)</label>
            <textarea
              id="m-create-desc"
              className="m-sheet-input m-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              data-testid="mobile-create-desc"
            />
          </div>

          <div className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-create-group">Group (optional)</label>
            <input
              id="m-create-group"
              type="text"
              className="m-sheet-input"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              list={groupListId}
              placeholder="e.g. core, infra"
              data-testid="mobile-create-group"
            />
            <datalist id={groupListId}>
              {groupOptions.map(g => <option key={g} value={g} />)}
            </datalist>
          </div>

          <div className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-create-status">Status</label>
            <select
              id="m-create-status"
              className="m-sheet-input"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              data-testid="mobile-create-status"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-create-confidence">Confidence (0–4, optional)</label>
            <input
              id="m-create-confidence"
              type="number"
              min="0"
              max="4"
              step="1"
              className="m-sheet-input"
              value={confidence}
              onChange={(e) => setConfidence(e.target.value)}
              data-testid="mobile-create-confidence"
            />
          </div>

          {err ? <div className="m-form-error" role="alert" data-testid="mobile-create-error">{err}</div> : null}
        </form>

        <footer className="m-sheet-footer">
          <button
            type="button"
            className="m-sheet-btn m-sheet-btn-secondary"
            onClick={close}
            disabled={submitting}
            data-testid="mobile-create-cancel"
          >Cancel</button>
          <div className="m-sheet-footer-right">
            <button
              type="button"
              className="m-sheet-btn m-sheet-btn-primary"
              disabled={submitting || !title.trim()}
              data-testid="mobile-create-submit"
              onClick={handleSubmit}
            >{submitting ? 'Creating…' : 'Create'}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
