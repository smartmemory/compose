import React from 'react';

const STATUS_FILTERS = [
  { value: 'planned', label: 'planned' },
  { value: 'in_progress', label: 'in progress' },
  { value: 'blocked', label: 'blocked' },
  { value: 'complete', label: 'complete' },
  { value: 'parked', label: 'parked' },
  { value: 'killed', label: 'killed' },
];

export default function FilterBar({
  statuses = [],
  onToggleStatus,
  group = '',
  groupOptions = [],
  onChangeGroup,
  keyword = '',
  onChangeKeyword,
}) {
  return (
    <div className="m-filter-bar" data-testid="mobile-filter-bar">
      <div className="m-filter-chips" role="group" aria-label="Status filter">
        {STATUS_FILTERS.map((s) => {
          const active = statuses.includes(s.value);
          return (
            <button
              key={s.value}
              type="button"
              className="m-filter-chip"
              aria-pressed={active}
              data-testid={`mobile-filter-status-${s.value}`}
              onClick={() => onToggleStatus?.(s.value)}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      <div className="m-filter-row">
        <select
          className="m-filter-select"
          data-testid="mobile-filter-group"
          value={group}
          onChange={(e) => onChangeGroup?.(e.target.value)}
          aria-label="Group filter"
        >
          <option value="">All groups</option>
          {groupOptions.map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
        <input
          type="search"
          className="m-filter-keyword"
          data-testid="mobile-filter-keyword"
          placeholder="Search title or description"
          value={keyword}
          onChange={(e) => onChangeKeyword?.(e.target.value)}
          aria-label="Keyword filter"
        />
      </div>
    </div>
  );
}
