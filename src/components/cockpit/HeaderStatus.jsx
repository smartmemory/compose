/**
 * HeaderStatus.jsx
 *
 * COMP-COCKPIT-HEADER-COUNTERS-1: the item counters and the agent-status pill,
 * moved from the top of the left bar into the top status bar.
 *
 * Both read the same sources they did in the sidebar: the counters from
 * compactStats(items, gates) (props from the App that owns them), the pill from
 * the `compose:agent-status` window event AgentStream dispatches. No fetch.
 *
 * Width: the word labels ("items", "active", ...) drop below the `2xl`
 * breakpoint (1536px), where they collide with the room tabs; the pill label and the tab strip's ⌘K hint drop below 1440px for the same reason; each counter keeps its meaning in title/aria-label.
 */

import React from 'react';
import { compactStats } from '../vision/attentionQueueState.js';

const CATEGORY_LABELS = {
  reading: 'Reading', writing: 'Writing', executing: 'Running',
  searching: 'Searching', fetching: 'Fetching', delegating: 'Delegating',
  thinking: 'Thinking',
};

function Counter({ testId, value, word, color }) {
  return (
    <span
      data-testid={testId}
      className="tabular-nums whitespace-nowrap"
      style={color ? { color } : undefined}
      title={`${value} ${word}`}
      aria-label={`${value} ${word}`}
    >
      {value}<span className="hidden 2xl:inline"> {word}</span>
    </span>
  );
}

export function HeaderCounters({ items, gates }) {
  const stats = React.useMemo(() => compactStats(items, gates), [items, gates]);
  if (stats.total === 0) return null;
  return (
    <div className="flex items-center gap-1.5 text-[11px] shrink-0" data-testid="header-counters">
      <Counter testId="header-count-total" value={stats.total} word="items" color="hsl(var(--muted-foreground))" />
      {stats.inProgress > 0 && (
        <Counter testId="header-count-active" value={stats.inProgress} word="active" color="hsl(var(--primary))" />
      )}
      {stats.blocked > 0 && (
        <Counter testId="header-count-blocked" value={stats.blocked} word="blocked" color="hsl(var(--destructive))" />
      )}
      {stats.pendingGates > 0 && (
        <Counter testId="header-count-gates" value={stats.pendingGates} word={stats.pendingGates === 1 ? 'gate' : 'gates'} color="hsl(var(--warning))" />
      )}
    </div>
  );
}

export function AgentStatusPill() {
  const [agentState, setAgentState] = React.useState({ status: 'idle', category: null });
  React.useEffect(() => {
    const handler = (e) => setAgentState(e.detail || { status: 'idle' });
    window.addEventListener('compose:agent-status', handler);
    return () => window.removeEventListener('compose:agent-status', handler);
  }, []);
  const working = agentState.status === 'working';
  const label = working ? (CATEGORY_LABELS[agentState.category] || 'Working') : 'Idle';
  return (
    <span
      data-testid="header-agent-status"
      className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider shrink-0"
      style={{ color: working ? 'var(--color-category-writing)' : 'hsl(var(--muted-foreground))' }}
      title={`Agent: ${label}`}
      aria-label={`Agent: ${label}`}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: working ? 'var(--color-category-writing)' : 'hsl(var(--success))',
          animation: working ? 'pulse 1.5s ease-in-out infinite' : 'none',
        }}
      />
      <span className="hidden min-[1440px]:inline">{label}</span>
    </span>
  );
}
