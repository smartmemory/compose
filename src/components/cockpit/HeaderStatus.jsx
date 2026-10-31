/**
 * HeaderStatus.jsx
 *
 * COMP-COCKPIT-HEADER-COUNTERS-1: the item counters and the agent-status pill,
 * moved from the top of the left bar into the top status bar.
 *
 * Both read the same sources they did in the sidebar: the counters from
 * compactStats(items, gates) (props from the App that owns them), the pill from
 * the `compose:agent-status` window event AgentStream dispatches. No fetch of its own: the pill also reads the
 * fleet's busy sessions and live jobs from the shared /api/fleet poll (COMP-COCKPIT-PROCESS-DATA-1), so "Idle"
 * no longer reads as "nothing is running" while detached jobs work; sm_status down = the local state alone.
 * The fleet words show from `2xl` up like the counter words (below it they pushed the counters over the tab
 * strip's ⌘K at 1440px); below it the dot pulses in the primary colour and title/aria-label carry the line.
 *
 * Width: the word labels ("items", "active", ...) drop below the `2xl`
 * breakpoint (1536px), where they collide with the room tabs; the pill label and the tab strip's ⌘K hint drop below 1440px for the same reason; each counter keeps its meaning in title/aria-label.
 */

import React from 'react';
import { compactStats } from '../vision/attentionQueueState.js';
import { useFleet } from '../../lib/fleetPoller.js';
import { fleetActivity } from './fleetLogic.js';

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
  const { data: fleet } = useFleet();
  const activity = React.useMemo(() => fleetActivity(fleet), [fleet]);
  const working = agentState.status === 'working';
  const local = working ? (CATEGORY_LABELS[agentState.category] || 'Working') : 'Idle';
  const label = activity?.text ? `${local} · ${activity.text}` : local;
  const fleetBusy = !working && (activity?.busy ?? 0) + (activity?.jobs ?? 0) > 0;
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
          background: working ? 'var(--color-category-writing)' : fleetBusy ? 'hsl(var(--primary))' : 'hsl(var(--success))',
          animation: working || fleetBusy ? 'pulse 1.5s ease-in-out infinite' : 'none',
        }}
      />
      <span className="hidden min-[1440px]:inline">
        {local}{activity?.text ? <span className="hidden 2xl:inline" data-testid="header-agent-fleet">{` · ${activity.text}`}</span> : null}
      </span>
    </span>
  );
}
