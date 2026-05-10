import React from 'react';

export default function GateCard({ gate, onOpen }) {
  const id = gate.id;
  const flow = gate.flowId || gate.flow || '';
  const step = gate.stepId || gate.step || '';
  const summary = gate.summary || gate.comment || '';
  const phase = gate.toPhase || gate.fromPhase || '';

  return (
    <div
      className="m-gate-card"
      data-testid={`mobile-gate-card-${id}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(gate)}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(gate); }}
    >
      <div className="m-gate-card-row">
        <div className="m-gate-card-title">{flow || id}</div>
        {phase && <span className="m-status-pill" data-status="in_progress">{phase}</span>}
      </div>
      <div className="m-gate-card-step">{step}</div>
      {summary && <div className="m-gate-card-summary">{summary}</div>}
    </div>
  );
}
