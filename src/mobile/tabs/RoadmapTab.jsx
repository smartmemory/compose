import React, { useMemo, useState } from 'react';
import FilterBar from '../components/FilterBar.jsx';
import ItemCard from '../components/ItemCard.jsx';
import ItemDetailSheet from '../components/ItemDetailSheet.jsx';
import CreateItemSheet from '../components/CreateItemSheet.jsx';
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

/**
 * RoadmapTab — receives items/loading/error/applyOptimisticEdit/createItem/
 * deleteItem/addConnection/removeConnection/fetchItemDetail from the shell (MobileApp).
 */
export default function RoadmapTab({
  items = [],
  loading = false,
  error = null,
  applyOptimisticEdit,
  createItem,
  deleteItem,
  addConnection,
  removeConnection,
  fetchItemDetail,
}) {

  const [statuses, setStatuses] = useState([]);
  const [group, setGroup] = useState('');
  const [keyword, setKeyword] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
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

  const handleCreate = async (fields) => {
    const result = await createItem?.(fields);
    if (!result?.ok) {
      throw new Error(result?.error || 'Create failed');
    }
    // CreateItemSheet calls close() on resolved promise
  };

  const handleDelete = async (id) => {
    const result = await deleteItem?.(id);
    if (result?.ok) {
      setSelectedId(null);
    } else {
      setToast(result?.error || 'Delete failed');
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
          onDelete={handleDelete}
          allItems={items}
          addConnection={addConnection}
          removeConnection={removeConnection}
          fetchItemDetail={fetchItemDetail}
        />
      ) : null}

      <CreateItemSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
        groupOptions={groupOptions}
      />

      <button
        type="button"
        className="m-fab"
        data-testid="mobile-roadmap-fab"
        aria-label="Create new roadmap item"
        onClick={() => setCreateOpen(true)}
      >+</button>

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </section>
  );
}
