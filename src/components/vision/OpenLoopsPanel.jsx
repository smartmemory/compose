/**
 * OpenLoopsPanel.jsx — COMP-OBS-LOOPS right panel (region ④, CONTRACT layout.md).
 *
 * 320px wide, collapsible to 40px icon strip.
 * Per-feature scope — only shows loops for the active featureCode.
 * Collapse state persisted in localStorage as `compose:<featureCode>:openLoopsCollapsed`.
 *
 * Props:
 *   featureCode  {string|null}  — the active feature (panel hides when null)
 *   items        {object[]}     — vision items array (to look up the active item)
 *   onAddLoop    {function}     — (featureCode, {kind, summary, ttl_days}) => Promise
 *   onResolveLoop{function}     — (featureCode, loopId, {note}) => Promise
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { sortByAge, formatAge, isStaleLoop } from './openLoopsPanelLogic.js';

const PANEL_WIDTH = 320;
const COLLAPSED_WIDTH = 40;

const KIND_LABELS = {
  deferred: 'Deferred',
  blocked: 'Blocked',
  open_question: 'Question',
};

function getCollapseKey(featureCode) {
  return featureCode ? `compose:${featureCode}:openLoopsCollapsed` : null;
}

function loadCollapsed(featureCode) {
  const key = getCollapseKey(featureCode);
  if (!key) return false;
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}

function saveCollapsed(featureCode, value) {
  const key = getCollapseKey(featureCode);
  if (!key) return;
  try { localStorage.setItem(key, value ? 'true' : 'false'); } catch { /* ignore */ }
}

// ── Add Modal ─────────────────────────────────────────────────────────────────

function AddLoopModal({ onConfirm, onCancel }) {
  const [kind, setKind] = useState('deferred');
  const [summary, setSummary] = useState('');
  const [ttlDays, setTtlDays] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!summary.trim()) return;
    onConfirm({ kind, summary: summary.trim(), ttl_days: ttlDays ? parseInt(ttlDays, 10) : undefined });
  };

  return (
    <div
      data-testid="add-loop-modal"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <form
        onSubmit={handleSubmit}
        style={{ background: '#1e1e2e', borderRadius: 8, padding: 24, width: 360, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <h3 style={{ margin: 0, color: '#cdd6f4', fontSize: 14 }}>Add Open Loop</h3>
        <label style={{ color: '#a6adc8', fontSize: 12 }}>
          Kind
          <select
            value={kind}
            onChange={e => setKind(e.target.value)}
            style={{ display: 'block', width: '100%', marginTop: 4, background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '4px 8px' }}
          >
            <option value="deferred">Deferred</option>
            <option value="blocked">Blocked</option>
            <option value="open_question">Open Question</option>
          </select>
        </label>
        <label style={{ color: '#a6adc8', fontSize: 12 }}>
          Summary (max 280 chars)
          <textarea
            data-testid="add-loop-summary"
            value={summary}
            onChange={e => setSummary(e.target.value)}
            maxLength={280}
            rows={3}
            required
            style={{ display: 'block', width: '100%', marginTop: 4, background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '4px 8px', resize: 'vertical', boxSizing: 'border-box' }}
          />
        </label>
        <label style={{ color: '#a6adc8', fontSize: 12 }}>
          TTL days (optional, default 90)
          <input
            type="number"
            value={ttlDays}
            onChange={e => setTtlDays(e.target.value)}
            min={1}
            style={{ display: 'block', width: '100%', marginTop: 4, background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '4px 8px', boxSizing: 'border-box' }}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" onClick={onCancel} style={{ padding: '6px 16px', background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, cursor: 'pointer' }}>
            Cancel
          </button>
          <button type="submit" data-testid="add-loop-submit" style={{ padding: '6px 16px', background: '#89b4fa', color: '#1e1e2e', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}>
            Add
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Loop row ─────────────────────────────────────────────────────────────────

function LoopRow({ loop, onResolve, nowMs }) {
  const stale = isStaleLoop(loop, nowMs);
  const resolved = !!loop.resolution;

  return (
    <div
      data-testid={`loop-row-${loop.id}`}
      style={{
        padding: '8px 12px',
        borderBottom: '1px solid #313244',
        opacity: resolved ? 0.5 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, color: '#6c7086', background: '#313244', borderRadius: 3, padding: '1px 5px' }}>
          {KIND_LABELS[loop.kind] || loop.kind}
        </span>
        {stale && !resolved && (
          <span data-testid={`stale-badge-${loop.id}`} style={{ fontSize: 10, color: '#f38ba8', background: '#3e1111', borderRadius: 3, padding: '1px 5px' }}>
            &gt;TTL
          </span>
        )}
        <span style={{ fontSize: 10, color: '#6c7086', marginLeft: 'auto' }}>
          {formatAge(loop.created_at, nowMs)}
        </span>
      </div>
      <p style={{ margin: '4px 0 6px', fontSize: 12, color: stale && !resolved ? '#f38ba8' : '#cdd6f4', lineHeight: 1.4 }}>
        {loop.summary}
      </p>
      {!resolved && (
        <button
          data-testid={`resolve-btn-${loop.id}`}
          onClick={() => onResolve(loop.id)}
          style={{ fontSize: 11, padding: '3px 10px', background: '#313244', color: '#a6e3a1', border: '1px solid #a6e3a1', borderRadius: 3, cursor: 'pointer' }}
        >
          Resolve
        </button>
      )}
      {resolved && (
        <span style={{ fontSize: 11, color: '#a6e3a1' }}>Resolved</span>
      )}
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export default function OpenLoopsPanel({ featureCode, items = [], onAddLoop, onResolveLoop }) {
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(featureCode));
  const [showAddModal, setShowAddModal] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Refresh "now" every minute so age labels stay current
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  // Restore collapse state when featureCode changes
  useEffect(() => {
    setCollapsed(loadCollapsed(featureCode));
  }, [featureCode]);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      saveCollapsed(featureCode, next);
      return next;
    });
  }, [featureCode]);

  // Find the active item and its open loops
  const activeItem = useMemo(() => {
    if (!featureCode || !items) return null;
    return items.find(i => i.lifecycle?.featureCode === featureCode) ?? null;
  }, [featureCode, items]);

  const allLoops = activeItem?.lifecycle?.lifecycle_ext?.open_loops ?? [];
  const openLoops = useMemo(() => sortByAge(allLoops.filter(l => l.resolution == null)), [allLoops]);

  const handleAdd = useCallback(async (fields) => {
    setShowAddModal(false);
    if (onAddLoop) {
      try { await onAddLoop(featureCode, fields); }
      catch (err) { console.error('[OpenLoopsPanel] addLoop failed:', err.message); }
    }
  }, [featureCode, onAddLoop]);

  const handleResolve = useCallback(async (loopId) => {
    if (onResolveLoop) {
      const note = window.prompt('Resolve note (optional):') || '';
      try { await onResolveLoop(featureCode, loopId, { note }); }
      catch (err) { console.error('[OpenLoopsPanel] resolveLoop failed:', err.message); }
    }
  }, [featureCode, onResolveLoop]);

  if (!featureCode) return null;

  if (collapsed) {
    return (
      <div
        data-testid="open-loops-panel-collapsed"
        style={{ width: COLLAPSED_WIDTH, background: '#181825', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 12, borderLeft: '1px solid #313244', flexShrink: 0 }}
      >
        <button
          data-testid="open-loops-expand-btn"
          onClick={toggleCollapse}
          title={`Open loops (${openLoops.length})`}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#a6adc8', fontSize: 18 }}
        >
          ↺
        </button>
        {openLoops.length > 0 && (
          <span style={{ fontSize: 10, color: '#f5c2e7', marginTop: 4 }}>{openLoops.length}</span>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        data-testid="open-loops-panel"
        style={{ width: PANEL_WIDTH, background: '#181825', display: 'flex', flexDirection: 'column', borderLeft: '1px solid #313244', flexShrink: 0, overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #313244', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#cdd6f4', flex: 1 }}>
            Open Loops {openLoops.length > 0 && <span style={{ color: '#a6adc8' }}>({openLoops.length})</span>}
          </span>
          <button
            data-testid="add-loop-btn"
            onClick={() => setShowAddModal(true)}
            title="Add open loop"
            style={{ background: 'none', border: '1px solid #45475a', color: '#a6e3a1', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 12 }}
          >
            +
          </button>
          <button
            data-testid="open-loops-collapse-btn"
            onClick={toggleCollapse}
            title="Collapse"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6c7086', fontSize: 16 }}
          >
            ›
          </button>
        </div>

        {/* Loop list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {openLoops.length === 0 ? (
            <div
              data-testid="open-loops-empty"
              style={{ padding: '16px 12px', color: '#6c7086', fontSize: 12, textAlign: 'center' }}
            >
              No open loops for this feature
              <br />
              <button
                onClick={() => setShowAddModal(true)}
                style={{ marginTop: 8, background: 'none', border: '1px solid #45475a', color: '#a6adc8', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 11 }}
              >
                + Add loop
              </button>
            </div>
          ) : (
            openLoops.map(loop => (
              <LoopRow
                key={loop.id}
                loop={loop}
                onResolve={handleResolve}
                nowMs={nowMs}
              />
            ))
          )}
        </div>
      </div>

      {showAddModal && (
        <AddLoopModal
          onConfirm={handleAdd}
          onCancel={() => setShowAddModal(false)}
        />
      )}
    </>
  );
}
