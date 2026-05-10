import React from 'react';
import { UNTRIAGED } from '../hooks/useIdeas.js';

const OPTIONS = [
  { value: 'P0', label: 'P0' },
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: UNTRIAGED, label: 'Untriaged' },
];

export default function PrioritySelector({ value, onChange, disabled = false }) {
  return (
    <div className="m-priority-selector" role="radiogroup" aria-label="Priority">
      {OPTIONS.map(opt => {
        const selected = value === opt.value;
        const cls = `m-priority-chip${selected ? ' is-selected' : ''}`;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected ? 'true' : 'false'}
            className={cls}
            data-priority={opt.value === UNTRIAGED ? 'untriaged' : opt.value.toLowerCase()}
            data-testid={`priority-chip-${opt.value === UNTRIAGED ? 'untriaged' : opt.value.toLowerCase()}`}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
