import React, { useEffect, useMemo, useState } from 'react';
import StatusPill from './StatusPill.jsx';

const STATUS_OPTIONS = [
  'planned',
  'in_progress',
  'blocked',
  'complete',
  'partial',
  'parked',
  'killed',
  'superseded',
];

export default function ItemDetailSheet({ item, onClose, onSave }) {
  const initial = useMemo(() => ({
    status: item?.status || 'planned',
    group: item?.group || '',
    confidence: item?.confidence ?? '',
  }), [item]);

  const [status, setStatus] = useState(initial.status);
  const [group, setGroup] = useState(initial.group);
  const [confidence, setConfidence] = useState(initial.confidence);
  const [saving, setSaving] = useState(false);

  // Reset form when item identity changes.
  useEffect(() => {
    setStatus(initial.status);
    setGroup(initial.group);
    setConfidence(initial.confidence);
  }, [item?.id, initial.status, initial.group, initial.confidence]);

  if (!item) return null;

  const dirty = (
    status !== initial.status ||
    group !== initial.group ||
    String(confidence) !== String(initial.confidence)
  );

  const handleSave = async () => {
    if (!dirty || saving) return;
    const patch = {};
    if (status !== initial.status) patch.status = status;
    if (group !== initial.group) patch.group = group;
    if (String(confidence) !== String(initial.confidence)) {
      const num = confidence === '' ? null : Number(confidence);
      if (num !== null && Number.isFinite(num)) patch.confidence = num;
      else if (confidence === '') patch.confidence = null;
    }
    setSaving(true);
    try {
      await onSave?.(item.id, patch);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="m-sheet-overlay" role="dialog" aria-modal="true" data-testid="mobile-item-sheet">
      <div className="m-sheet">
        <header className="m-sheet-header">
          <button
            type="button"
            className="m-sheet-close"
            onClick={onClose}
            data-testid="mobile-item-sheet-close"
            aria-label="Close"
          >
            ×
          </button>
          <div className="m-sheet-title-row">
            <div className="m-sheet-title">{item.title || item.id}</div>
            <StatusPill status={status} />
          </div>
        </header>
        <div className="m-sheet-body">
          {item.description ? (
            <section className="m-sheet-section">
              <div className="m-sheet-label">Description</div>
              <p className="m-sheet-desc">{item.description}</p>
            </section>
          ) : null}

          <section className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-sheet-status">Status</label>
            <select
              id="m-sheet-status"
              className="m-sheet-input"
              data-testid="mobile-item-sheet-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </section>

          <section className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-sheet-group">Group</label>
            <input
              id="m-sheet-group"
              type="text"
              className="m-sheet-input"
              data-testid="mobile-item-sheet-group"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            />
          </section>

          <section className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-sheet-confidence">Confidence (0–5)</label>
            <input
              id="m-sheet-confidence"
              type="number"
              min="0"
              max="5"
              step="1"
              className="m-sheet-input"
              data-testid="mobile-item-sheet-confidence"
              value={confidence}
              onChange={(e) => setConfidence(e.target.value)}
            />
          </section>
        </div>
        <footer className="m-sheet-footer">
          <button
            type="button"
            className="m-sheet-btn m-sheet-btn-secondary"
            onClick={onClose}
            data-testid="mobile-item-sheet-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="m-sheet-btn m-sheet-btn-primary"
            onClick={handleSave}
            disabled={!dirty || saving}
            data-testid="mobile-item-sheet-save"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
