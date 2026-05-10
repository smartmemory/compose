import React, { useState } from 'react';
import PrioritySelector from './PrioritySelector.jsx';
import { UNTRIAGED } from '../hooks/useIdeas.js';

export default function IdeaDetailSheet({
  idea,
  open,
  onClose,
  onPromote,
  onKill,
  onSetPriority,
}) {
  const [busy, setBusy] = useState(false);
  if (!open || !idea) return null;

  const tags = Array.isArray(idea.tags) ? idea.tags : [];
  const priority = idea.priority || UNTRIAGED;

  async function withBusy(fn, closeAfter = true) {
    setBusy(true);
    try {
      await fn();
      if (closeAfter) onClose?.();
    } catch {
      // toast surfaced upstream
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="m-sheet-overlay"
      data-testid="idea-detail-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={`Idea ${idea.id}`}
      onClick={(ev) => { if (ev.target === ev.currentTarget) onClose?.(); }}
    >
      <div className="m-sheet">
        <header className="m-sheet-header">
          <button
            type="button"
            className="m-sheet-close"
            aria-label="Close detail"
            onClick={onClose}
            disabled={busy}
          >×</button>
          <div className="m-sheet-title-row">
            <div className="m-sheet-title">{idea.title}</div>
          </div>
          <div className="m-detail-meta">
            <span className="m-detail-meta-id">{idea.id}</span>
            <span className="m-detail-meta-status">{idea.status || 'NEW'}</span>
            {idea.cluster ? <span className="m-detail-meta-cluster">{idea.cluster}</span> : null}
          </div>
        </header>

        <div className="m-sheet-body">
          {idea.description ? (
            <div className="m-sheet-section">
              <div className="m-sheet-label">Description</div>
              <p className="m-sheet-desc">{idea.description}</p>
            </div>
          ) : null}

          {idea.source ? (
            <div className="m-sheet-section">
              <div className="m-sheet-label">Source</div>
              <p className="m-sheet-desc">{idea.source}</p>
            </div>
          ) : null}

          {tags.length > 0 ? (
            <div className="m-sheet-section">
              <div className="m-sheet-label">Tags</div>
              <div className="m-idea-tags">
                {tags.map(t => <span key={t} className="m-idea-tag">{t}</span>)}
              </div>
            </div>
          ) : null}

          <div className="m-sheet-section">
            <div className="m-sheet-label">Priority</div>
            <PrioritySelector
              value={priority}
              disabled={busy}
              onChange={(p) => withBusy(() => onSetPriority?.(idea.id, p), false)}
            />
          </div>
        </div>

        <footer className="m-sheet-footer">
          <button
            type="button"
            className="m-sheet-btn m-sheet-btn-secondary"
            data-testid="detail-kill"
            disabled={busy}
            onClick={() => withBusy(() => onKill?.(idea.id))}
          >Kill</button>
          <button
            type="button"
            className="m-sheet-btn m-sheet-btn-primary"
            data-testid="detail-promote"
            disabled={busy}
            onClick={() => withBusy(() => onPromote?.(idea.id))}
          >Promote</button>
        </footer>
      </div>
    </div>
  );
}
