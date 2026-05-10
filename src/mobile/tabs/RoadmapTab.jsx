import React, { useMemo, useState } from 'react';
import { useRoadmapItems } from '../hooks/useRoadmapItems.js';
import FilterBar from '../components/FilterBar.jsx';
import ItemCard from '../components/ItemCard.jsx';
import ItemDetailSheet from '../components/ItemDetailSheet.jsx';
import Toast from '../components/Toast.jsx';

function uniqueGroups(items) {
  const set = new Set();
  for (const it of items) {
    const g = (it?.group || '').trim();
    if (g) set.add(g);
  }
  return Array.from(set).sort();
}

function matchesKeyword(item, kw) {
  if (!kw) return true;
  const needle = kw.toLowerCase();
  const t = (item.title || '').toLowerCase();
  const d = (item.description || '').toLowerCase();
  return t.includes(needle) || d.includes(needle);
}

export default function RoadmapTab() {
  const { items, loading, error, applyOptimisticEdit } = useRoadmapItems();

  const [statuses, setStatuses] = useState([]);
  const [group, setGroup] = useState('');
  const [keyword, setKeyword] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [toast, setToast] = useState(null);

  const groupOptions = useMemo(() => uniqueGroups(items), [items]);

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (statuses.length && !statuses.includes(it.status)) return false;
      if (group && it.group !== group) return false;
      if (!matchesKeyword(it, keyword)) return false;
      return true;
    });
  }, [items, statuses, group, keyword]);

  const selected = useMemo(
    () => items.find((it) => it.id === selectedId) || null,
    [items, selectedId],
  );

  const toggleStatus = (s) => {
    setStatuses((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
  };

  const handleSave = async (id, patch) => {
    const result = await applyOptimisticEdit(id, patch);
    if (result?.ok) {
      setSelectedId(null);
    } else {
      setToast(result?.error || 'Save failed');
    }
  };

  return (
    <section className="m-roadmap" data-testid="mobile-tab-roadmap">
      <FilterBar
        statuses={statuses}
        onToggleStatus={toggleStatus}
        group={group}
        groupOptions={groupOptions}
        onChangeGroup={setGroup}
        keyword={keyword}
        onChangeKeyword={setKeyword}
      />

      {error ? (
        <div className="m-roadmap-error" data-testid="mobile-roadmap-error">{error}</div>
      ) : null}

      {loading ? (
        <div className="m-roadmap-skeleton" data-testid="mobile-roadmap-loading">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="m-skel-card" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="m-roadmap-empty" data-testid="mobile-roadmap-empty">
          {items.length === 0 ? 'No roadmap items yet.' : 'No items match the current filters.'}
        </div>
      ) : (
        <ul className="m-roadmap-list" data-testid="mobile-roadmap-list">
          {filtered.map((it) => (
            <li key={it.id}>
              <ItemCard item={it} onSelect={(item) => setSelectedId(item.id)} />
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <ItemDetailSheet
          item={selected}
          onClose={() => setSelectedId(null)}
          onSave={handleSave}
        />
      ) : null}

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </section>
  );
}
