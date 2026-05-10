import React from 'react';

const ITEMS = [
  { id: 'agents', label: 'Agents', icon: '◇' },
  { id: 'roadmap', label: 'Roadmap', icon: '⚡' },
  { id: 'builds', label: 'Builds', icon: '⏵' },
  { id: 'ideas', label: 'Ideas', icon: '✦' },
];

export default function BottomNav({ active, onSelect }) {
  return (
    <nav className="m-bottom-nav" role="tablist" aria-label="Mobile navigation">
      {ITEMS.map((it) => (
        <button
          key={it.id}
          type="button"
          className="m-nav-btn"
          role="tab"
          aria-pressed={active === it.id ? 'true' : 'false'}
          aria-label={it.label}
          data-tab={it.id}
          data-testid={`mobile-nav-${it.id}`}
          onClick={() => onSelect(it.id)}
        >
          <span className="m-nav-icon" aria-hidden="true">{it.icon}</span>
          <span className="m-nav-label">{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
