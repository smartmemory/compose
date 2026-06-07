import React, { useState, useMemo } from 'react';
import { Search, History } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import RelativeTime from './shared/RelativeTime.jsx';
import EmptyState from './shared/EmptyState.jsx';

/**
 * PastBuildsView — COMP-COCKPIT-3 run history / past builds.
 *
 * Mirrors SessionsView's toolbar + list + empty-state layout, and like
 * SessionsView it is prop-driven (App reads buildHistory from the store and
 * triggers the fetch when the view opens). The build-history log is forward-
 * only — records are written after each build goes terminal, so the empty
 * state is honest until the first archived run.
 *
 * Props:
 *   builds       — from useVisionStore().buildHistory (most-recent-first)
 *   items        — from useVisionStore().items (for feature-code → item lookup)
 *   onSelectItem — (itemId) => void
 */

const STATUS_COLORS = {
  complete: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
  failed: 'bg-red-500/15 text-red-400 border border-red-500/30',
  aborted: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  killed: 'bg-slate-500/15 text-slate-400 border border-slate-500/30',
};

function formatDuration(ms) {
  if (typeof ms !== 'number' || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatCost(usd) {
  if (typeof usd !== 'number' || usd <= 0) return null;
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

export default function PastBuildsView({ builds = [], items = [], onSelectItem }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const filtered = useMemo(() => {
    let result = builds;
    if (statusFilter !== 'all') {
      result = result.filter(b => b.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(b => (b.featureCode || '').toLowerCase().includes(q));
    }
    return result;
  }, [builds, search, statusFilter]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <History className="h-3 w-3" />
          <span>Past builds</span>
        </div>

        <div className="h-4 w-px bg-border" />

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search feature…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="text-xs pl-5 pr-2 py-0.5 h-6 rounded bg-muted text-foreground border border-border w-36"
          />
        </div>

        {/* Status filter */}
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="text-xs px-1.5 py-0.5 h-6 rounded bg-muted text-foreground border border-border cursor-pointer"
        >
          <option value="all">All status</option>
          {['complete', 'failed', 'aborted', 'killed'].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <span className="ml-auto text-[10px] text-muted-foreground">
          {filtered.length}/{builds.length}
        </span>
      </div>

      {/* Build list */}
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 && (
          <EmptyState
            icon={History}
            title="No past builds yet"
            description="Builds are recorded here after each run completes"
            className="py-8"
          />
        )}
        {filtered.map((build, i) => (
          <BuildRow
            key={`${build.featureCode}-${build.completedAt}-${i}`}
            build={build}
            items={items}
            onSelectItem={onSelectItem}
          />
        ))}
      </div>
    </div>
  );
}

function BuildRow({ build, items, onSelectItem }) {
  const featureItem = build.featureCode
    ? items.find(i => i.featureCode === build.featureCode || i.feature_code === build.featureCode || i.lifecycle?.featureCode === build.featureCode)
    : null;
  const statusCls = STATUS_COLORS[build.status] || STATUS_COLORS.killed;
  const cost = formatCost(build.cost_usd);

  return (
    <div className="flex flex-col gap-1 px-3 py-2.5 border-b border-border/50 hover:bg-muted/30 transition-colors">
      {/* Row 1: status + feature code + relative time */}
      <div className="flex items-center gap-2">
        <span className={cn('text-[10px] px-1.5 py-0.5 rounded capitalize', statusCls)}>
          {build.status}
        </span>
        {build.featureCode && (
          <button
            onClick={() => featureItem && onSelectItem?.(featureItem.id)}
            className={cn(
              'text-[11px] font-mono',
              featureItem
                ? 'text-blue-400 hover:underline cursor-pointer'
                : 'text-muted-foreground cursor-default'
            )}
          >
            {build.featureCode}
          </button>
        )}
        {build.mode === 'bug' && (
          <span className="text-[10px] px-1 py-0.5 rounded bg-rose-500/15 text-rose-400">bug</span>
        )}
        <RelativeTime date={build.completedAt} className="ml-auto text-[10px] shrink-0" />
      </div>

      {/* Row 2: metrics */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>⏱ {formatDuration(build.durationMs)}</span>
        {cost && <span>💵 {cost}</span>}
        {typeof build.stepCount === 'number' && <span>◆ {build.stepCount} steps</span>}
      </div>

      {/* Row 3: failure reason (only for non-complete) */}
      {build.failureReason && (
        <p className="text-[11px] text-red-400/90 truncate">{build.failureReason}</p>
      )}
    </div>
  );
}
