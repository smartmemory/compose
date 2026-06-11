import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import StatusPill from './StatusPill.jsx';

// Server-validated statuses (vision-store.js:11). 'partial' is NOT valid.
const STATUS_OPTIONS = [
  'planned',
  'ready',
  'in_progress',
  'review',
  'complete',
  'blocked',
  'parked',
  'killed',
  'superseded',
];

// Server-validated connection types (vision-store.js:12).
const CONNECTION_TYPES = ['informs', 'blocks', 'supports', 'contradicts', 'implements'];

export default function ItemDetailSheet({
  item,
  onClose,
  onSave,
  onDelete,
  allItems = [],
  addConnection,
  removeConnection,
  fetchItemDetail,
}) {
  const initial = useMemo(() => ({
    status: item?.status || 'planned',
    group: item?.group || '',
    confidence: item?.confidence ?? '',
  }), [item]);

  const [status, setStatus] = useState(initial.status);
  const [group, setGroup] = useState(initial.group);
  const [confidence, setConfidence] = useState(initial.confidence);
  const [saving, setSaving] = useState(false);

  // Delete two-tap state
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteTimerRef = useRef(null);

  // Connections local state
  const [connections, setConnections] = useState([]);
  const [connLoading, setConnLoading] = useState(false);
  const [showConnPicker, setShowConnPicker] = useState(false);
  const [connSearch, setConnSearch] = useState('');
  const [connType, setConnType] = useState('informs');
  const [addingConn, setAddingConn] = useState(false);
  // Two-tap for each connection remove: stores the index of the armed connection
  const [armedConnIdx, setArmedConnIdx] = useState(null);
  const connArmTimerRef = useRef(null);

  // Reset form when item identity changes.
  useEffect(() => {
    setStatus(initial.status);
    setGroup(initial.group);
    setConfidence(initial.confidence);
    setDeleteArmed(false);
    setConnections([]);
    setShowConnPicker(false);
    setConnSearch('');
    setConnType('informs');
    setArmedConnIdx(null);
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    if (connArmTimerRef.current) clearTimeout(connArmTimerRef.current);
  }, [item?.id, initial.status, initial.group, initial.confidence]);

  // Lazy load connections when sheet opens
  useEffect(() => {
    if (!item?.id || !fetchItemDetail) return;
    setConnLoading(true);
    fetchItemDetail(item.id).then((result) => {
      if (result?.ok && Array.isArray(result.item?.connections)) {
        setConnections(result.item.connections);
      }
    }).finally(() => setConnLoading(false));
  }, [item?.id, fetchItemDetail]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      if (connArmTimerRef.current) clearTimeout(connArmTimerRef.current);
    };
  }, []);

  if (!item) return null;

  const dirty = (
    status !== initial.status ||
    group !== initial.group ||
    String(confidence) !== String(initial.confidence)
  );

  function disarmDelete() {
    setDeleteArmed(false);
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
  }

  function handleAnyFieldInteraction() {
    if (deleteArmed) disarmDelete();
    if (armedConnIdx !== null) {
      setArmedConnIdx(null);
      if (connArmTimerRef.current) clearTimeout(connArmTimerRef.current);
    }
  }

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

  const handleDeleteClick = async () => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      deleteTimerRef.current = setTimeout(() => {
        setDeleteArmed(false);
      }, 3000);
    } else {
      // Second tap: perform delete
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      setDeleteArmed(false);
      setDeleting(true);
      try {
        await onDelete?.(item.id);
      } finally {
        setDeleting(false);
      }
    }
  };

  // Filtered items for connection picker (exclude self)
  const pickerItems = useMemo(() => {
    const q = connSearch.toLowerCase();
    return allItems.filter((it) => {
      if (it.id === item.id) return false;
      if (!q) return true;
      return it.id.toLowerCase().includes(q) || (it.title || '').toLowerCase().includes(q);
    });
  }, [allItems, item?.id, connSearch]);

  const handleAddConn = async (targetItem) => {
    setAddingConn(true);
    const result = await addConnection?.({ fromId: item.id, toId: targetItem.id, type: connType });
    if (result?.ok) {
      const newConn = result.connection || { id: `local-${Date.now()}`, fromId: item.id, toId: targetItem.id, type: connType };
      setConnections((prev) => [...prev, newConn]);
      setShowConnPicker(false);
      setConnSearch('');
      setConnType('informs');
    }
    setAddingConn(false);
  };

  const handleConnRemoveClick = async (conn, idx) => {
    if (armedConnIdx !== idx) {
      // First tap: arm
      if (connArmTimerRef.current) clearTimeout(connArmTimerRef.current);
      setArmedConnIdx(idx);
      connArmTimerRef.current = setTimeout(() => {
        setArmedConnIdx(null);
      }, 3000);
    } else {
      // Second tap: remove
      if (connArmTimerRef.current) clearTimeout(connArmTimerRef.current);
      setArmedConnIdx(null);
      const result = await removeConnection?.(conn.id);
      if (result?.ok) {
        setConnections((prev) => prev.filter((c) => c.id !== conn.id));
      }
    }
  };

  function resolveItemTitle(id) {
    const found = allItems.find((it) => it.id === id);
    return found?.title || id;
  }

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
              onChange={(e) => { handleAnyFieldInteraction(); setStatus(e.target.value); }}
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
              onChange={(e) => { handleAnyFieldInteraction(); setGroup(e.target.value); }}
            />
          </section>

          <section className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-sheet-confidence">Confidence (0–4)</label>
            <input
              id="m-sheet-confidence"
              type="number"
              min="0"
              max="4"
              step="1"
              className="m-sheet-input"
              data-testid="mobile-item-sheet-confidence"
              value={confidence}
              onChange={(e) => { handleAnyFieldInteraction(); setConfidence(e.target.value); }}
            />
          </section>

          {/* Connections section */}
          <section className="m-sheet-section m-sheet-connections">
            <div className="m-sheet-connections-header">
              <span className="m-sheet-label">Connections</span>
              {!showConnPicker && (
                <button
                  type="button"
                  className="m-conn-add-btn"
                  data-testid="mobile-item-conn-add"
                  onClick={() => { handleAnyFieldInteraction(); setShowConnPicker(true); }}
                >+ Add</button>
              )}
            </div>

            {connLoading ? (
              <div className="m-conn-loading">Loading…</div>
            ) : connections.length === 0 && !showConnPicker ? (
              <div className="m-conn-empty">No connections</div>
            ) : (
              <ul className="m-conn-list">
                {connections.map((conn, idx) => {
                  const isOut = conn.fromId === item.id;
                  const otherId = isOut ? conn.toId : conn.fromId;
                  const otherTitle = resolveItemTitle(otherId);
                  const armed = armedConnIdx === idx;
                  return (
                    <li key={conn.id} className="m-conn-row">
                      <span className="m-conn-dir">{isOut ? '→' : '←'}</span>
                      <span className="m-conn-title">{otherTitle}</span>
                      <span className="m-conn-type">{conn.type}</span>
                      <button
                        type="button"
                        className={`m-conn-remove${armed ? ' m-conn-remove--armed' : ''}`}
                        data-testid={`mobile-item-conn-remove-${idx}`}
                        aria-label={armed ? 'Confirm remove connection' : 'Remove connection'}
                        onClick={() => { handleAnyFieldInteraction(); handleConnRemoveClick(conn, idx); }}
                      >{armed ? '✓' : '×'}</button>
                    </li>
                  );
                })}
              </ul>
            )}

            {showConnPicker && (
              <div className="m-conn-picker">
                <div className="m-conn-picker-row">
                  <input
                    type="text"
                    className="m-sheet-input m-conn-search"
                    placeholder="Search items…"
                    value={connSearch}
                    onChange={(e) => setConnSearch(e.target.value)}
                    data-testid="mobile-item-conn-search"
                    autoFocus
                  />
                  <select
                    className="m-sheet-input m-conn-type-select"
                    value={connType}
                    onChange={(e) => setConnType(e.target.value)}
                    data-testid="mobile-item-conn-type"
                  >
                    {CONNECTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <ul className="m-conn-picker-list">
                  {pickerItems.map((it) => (
                    <li key={it.id}>
                      <button
                        type="button"
                        className="m-conn-picker-item"
                        disabled={addingConn}
                        onClick={() => handleAddConn(it)}
                        data-testid={`mobile-item-conn-pick-${it.id}`}
                      >
                        <span className="m-conn-picker-title">{it.title || it.id}</span>
                        <span className="m-conn-picker-id">{it.id}</span>
                      </button>
                    </li>
                  ))}
                  {pickerItems.length === 0 && (
                    <li className="m-conn-picker-empty">No items found</li>
                  )}
                </ul>
                <button
                  type="button"
                  className="m-sheet-btn m-sheet-btn-secondary"
                  onClick={() => { setShowConnPicker(false); setConnSearch(''); setConnType('informs'); }}
                >Cancel</button>
              </div>
            )}
          </section>
        </div>

        <footer className="m-sheet-footer">
          <button
            type="button"
            className={`m-sheet-btn m-sheet-btn-danger${deleteArmed ? ' m-sheet-btn-danger--armed' : ''}`}
            onClick={handleDeleteClick}
            disabled={deleting}
            data-testid="mobile-item-sheet-delete"
          >
            {deleting ? 'Deleting…' : deleteArmed ? 'Confirm delete' : 'Delete'}
          </button>
          <div className="m-sheet-footer-right">
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
          </div>
        </footer>
      </div>
    </div>
  );
}
