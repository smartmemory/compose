import React from 'react';
import StatusPill from './StatusPill.jsx';

function trim(str, n = 140) {
  if (typeof str !== 'string') return '';
  const s = str.trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

export default function ItemCard({ item, onSelect }) {
  if (!item) return null;
  const title = item.title || item.id || 'Untitled';
  const status = item.status || 'unknown';
  const group = item.group || '';
  const desc = trim(item.description || '');

  return (
    <button
      type="button"
      className="m-item-card"
      data-testid={`mobile-item-card-${item.id}`}
      onClick={() => onSelect?.(item)}
    >
      <div className="m-item-card-row">
        <div className="m-item-card-title">{title}</div>
        <StatusPill status={status} />
      </div>
      <div className="m-item-card-meta">
        {group ? <span className="m-item-card-group" data-testid="mobile-item-group">{group}</span> : null}
        {item.id ? <span className="m-item-card-id">{item.id}</span> : null}
      </div>
      {desc ? <div className="m-item-card-desc">{desc}</div> : null}
    </button>
  );
}
