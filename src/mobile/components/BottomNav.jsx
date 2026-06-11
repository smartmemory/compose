import React from 'react';

const ITEMS = [
  { id: 'agents', label: 'Agents', icon: '◇' },
  { id: 'roadmap', label: 'Roadmap', icon: '⚡' },
  { id: 'builds', label: 'Builds', icon: '⏵' },
  { id: 'ideas', label: 'Ideas', icon: '✦' },
];

/**
 * BottomNav — mobile navigation bar.
 *
 * @param {string} active       — currently active tab id
 * @param {function} onSelect   — callback(tabId) when a nav item is tapped
 * @param {object} [badges]     — optional { [tabId]: { count?: number, level?: 'info'|'warn'|'error' } }
 *                                count present → pill badge; count absent → dot badge
 */
export default function BottomNav({ active, onSelect, badges }) {
  return (
    <nav className="m-bottom-nav" role="tablist" aria-label="Mobile navigation">
      {ITEMS.map((it) => {
        const badge = badges?.[it.id];
        return (
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
            <span className="m-nav-icon-wrap">
              <span className="m-nav-icon" aria-hidden="true">{it.icon}</span>
              {badge && (
                <span
                  className={`m-nav-badge m-nav-badge-${badge.level || 'info'}`}
                  data-testid={`mobile-nav-badge-${it.id}`}
                  aria-hidden="true"
                >
                  {badge.count != null ? String(badge.count) : ''}
                </span>
              )}
            </span>
            <span className="m-nav-label">{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
