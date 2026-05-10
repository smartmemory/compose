import React, { useCallback, useState } from 'react';

const OUTCOMES = [
  { id: 'approve', label: 'Approve', kind: 'primary' },
  { id: 'revise', label: 'Revise', kind: 'warn' },
  { id: 'kill', label: 'Kill', kind: 'danger' },
];

export default function GatePromptSheet({ gate, onResolve, onClose }) {
  const [outcome, setOutcome] = useState(null);
  const [reason, setReason] = useState('');
  const [summary, setSummary] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = useCallback(async (e) => {
    e?.preventDefault();
    if (!outcome) {
      setError('Pick an outcome');
      return;
    }
    if (outcome === 'kill' && !reason.trim()) {
      setError('Reason is required when killing a gate');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onResolve(gate.id, { outcome, reason: reason.trim(), summary: summary.trim() });
      onClose?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }, [gate, outcome, reason, summary, onResolve, onClose]);

  return (
    <div className="m-sheet-backdrop" data-testid="mobile-gate-sheet" onClick={onClose}>
      <div className="m-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-header">
          <div className="m-sheet-title">Resolve gate</div>
          <div className="m-sheet-subtitle">{gate.flowId}:{gate.stepId}</div>
        </div>

        <form onSubmit={handleSubmit} className="m-sheet-body">
          <div className="m-sheet-outcomes" role="radiogroup" aria-label="Outcome">
            {OUTCOMES.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={outcome === o.id}
                className={`m-btn m-btn-${o.kind} ${outcome === o.id ? 'm-btn-active' : ''}`}
                data-testid={`mobile-gate-outcome-${o.id}`}
                onClick={() => setOutcome(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>

          <label className="m-field">
            <span className="m-field-label">
              Reason {outcome === 'kill' ? '(required)' : '(optional)'}
            </span>
            <textarea
              className="m-textarea"
              data-testid="mobile-gate-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </label>

          <label className="m-field">
            <span className="m-field-label">Summary (optional)</span>
            <textarea
              className="m-textarea"
              data-testid="mobile-gate-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={2}
            />
          </label>

          {error && <div className="m-agent-card-error">{error}</div>}

          <div className="m-sheet-actions">
            <button
              type="button"
              className="m-btn m-btn-sm"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="m-btn m-btn-primary m-btn-sm"
              disabled={submitting || !outcome}
              data-testid="mobile-gate-submit"
            >
              {submitting ? 'Submitting…' : 'Submit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
