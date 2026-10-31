/**
 * HeaderStatus.jsx
 *
 * COMP-COCKPIT-HEADER-COUNTERS-1: the item counters and the agent-status pill,
 * moved from the top of the left bar into the top status bar.
 *
 * COMP-COCKPIT-WHAT-LINE-1 (supersedes the width rules of HEADER-COUNTERS-1 and the one-string pill label of
 * PROCESS-DATA-1): the header names what each answer covers. The counters are ONE chip, "Compose: N items", with the
 * active / blocked / gates breakdown beside it. The pill has two labelled parts: "Compose agent: <state>" (this
 * app's own agent, from the `compose:agent-status` event) and "Fleet: <n sessions busy · n jobs | quiet | unknown>"
 * (the shared /api/fleet poll through `runningNow`). Words never drop at a breakpoint any more; sm_status down reads
 * "Fleet: unknown", muted, with no error text.
 */

import React from 'react';
import { compactStats } from '../vision/attentionQueueState.js';
import { useFleet } from '../../lib/fleetPoller.js';
import { runningNow } from './fleetLogic.js';
import { useAgentState } from './what/useAgentState.js';

function Counter({ testId, value, word, color }) {
  return (
    <span
      data-testid={testId}
      className="tabular-nums whitespace-nowrap"
      style={color ? { color } : undefined}
      title={`${value} ${word}`}
      aria-label={`${value} ${word}`}
    >
      {value} {word}
    </span>
  );
}

export function HeaderCounters({ items, gates }) {
  const stats = React.useMemo(() => compactStats(items, gates), [items, gates]);
  if (stats.total === 0) return null;
  const gateWord = stats.pendingGates === 1 ? 'gate' : 'gates';
  const breakdown = [
    stats.inProgress > 0 && `${stats.inProgress} active`,
    stats.blocked > 0 && `${stats.blocked} blocked`,
    stats.pendingGates > 0 && `${stats.pendingGates} ${gateWord}`,
  ].filter(Boolean);
  return (
    <div
      className="flex items-center gap-1.5 text-[11px] shrink-0"
      data-testid="header-counters"
      title={[`Compose: ${stats.total} items`, ...breakdown].join(' · ')}
    >
      <span className="text-muted-foreground whitespace-nowrap">Compose:</span>{' '}
      <Counter testId="header-count-total" value={stats.total} word="items" color="hsl(var(--muted-foreground))" />
      {stats.inProgress > 0 && (
        <>{' '}<Counter testId="header-count-active" value={stats.inProgress} word="active" color="hsl(var(--primary))" /></>
      )}
      {stats.blocked > 0 && (
        <>{' '}<Counter testId="header-count-blocked" value={stats.blocked} word="blocked" color="hsl(var(--destructive))" /></>
      )}
      {stats.pendingGates > 0 && (
        <>{' '}<Counter testId="header-count-gates" value={stats.pendingGates} word={gateWord} color="hsl(var(--warning))" /></>
      )}
    </div>
  );
}

export function AgentStatusPill() {
  const agentState = useAgentState();
  const { data: fleet } = useFleet();
  const now = React.useMemo(() => runningNow(fleet, agentState), [fleet, agentState]);
  const working = now.composeWorking;
  const fleetBusy = now.fleetKnown && now.busy + now.jobs > 0;
  const agentText = `Compose agent: ${now.composeLabel}`;
  const fleetText = `Fleet: ${!now.fleetKnown ? 'unknown' : now.text || 'quiet'}`;
  return (
    <span data-testid="header-agent-pill" className="flex items-center gap-1.5 text-[11px] font-medium shrink-0">
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: working ? 'var(--color-category-writing)' : fleetBusy ? 'hsl(var(--primary))' : 'hsl(var(--success))',
          animation: working || fleetBusy ? 'pulse 1.5s ease-in-out infinite' : 'none',
        }}
      />
      <span
        data-testid="header-agent-status"
        className="whitespace-nowrap"
        style={{ color: working ? 'var(--color-category-writing)' : 'hsl(var(--muted-foreground))' }}
        title={agentText}
        aria-label={agentText}
      >
        {agentText}
      </span>
      <span
        data-testid="header-agent-fleet"
        className={`whitespace-nowrap ${now.fleetKnown ? '' : 'opacity-60'}`}
        style={{ color: fleetBusy ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}
        title={fleetText}
        aria-label={fleetText}
      >
        {fleetText}
      </span>
    </span>
  );
}
