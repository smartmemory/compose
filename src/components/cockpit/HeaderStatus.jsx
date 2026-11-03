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
 * COMP-COCKPIT-SOURCE-FAULTS-1 (WHAT-LINE M1): a failed /api/fleet refresh is not sm_status down. The retained last
 * good body is not counted; the fleet part reads "Fleet unreadable since HH:MM" (SourceNote, reason in the title).
 * Both mount in the thin status row under the tab row (`App.jsx`, testid `header-status-strip`): with every word shown they need
 * ~500 px and the tab row has ~220 px left at 1440, so beside the tabs they painted over the ⌘K hint.
 * COMP-DAYVIEW-DESIGN-FIX-1 U3 (M14): the strip is `justify-end`, so at 400 px children that would not shrink spilled off its
 * LEFT edge ("d Compose agent: Idle"). The counters and the pill now shrink (counters first) and end in an ellipsis, with
 * every word in the title; the notification chip beside them keeps its width. Nothing is hidden past the left edge.
 */

import React from 'react';
import { compactStats } from '../vision/attentionQueueState.js';
import { useFleet } from '../../lib/fleetPoller.js';
import { runningNow } from './fleetLogic.js';
import { useAgentState } from './what/useAgentState.js';
import SourceNote from './SourceNote.jsx';

function Counter({ testId, value, word, color }) {
  return (
    <span
      data-testid={testId}
      className="tabular-nums"
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
      className="min-w-0 shrink-[3] truncate text-[11px]"
      data-testid="header-counters"
      title={[`Compose: ${stats.total} items`, ...breakdown].join(' · ')}
    >
      <span className="text-muted-foreground">Compose:</span>{' '}
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
  const fleetSrc = useFleet();
  const fleet = fleetSrc.error ? null : fleetSrc.data; // retained data after a failed refresh is not a current count
  const now = React.useMemo(() => runningNow(fleet, agentState), [fleet, agentState]);
  const working = now.composeWorking;
  const fleetBusy = now.fleetKnown && now.busy + now.jobs > 0;
  const agentText = `Compose agent: ${now.composeLabel}`;
  const fleetText = `Fleet: ${now.fleetKnown ? now.text || 'quiet' : now.text || 'unknown'}`;
  return (
    <span data-testid="header-agent-pill" className="flex min-w-0 shrink items-center gap-1.5 text-[11px] font-medium">
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: working ? 'var(--color-category-writing)' : fleetBusy ? 'hsl(var(--primary))' : 'hsl(var(--success))',
          animation: working || fleetBusy ? 'pulse 1.5s ease-in-out infinite' : 'none',
        }}
      />
      <span
        data-testid="header-agent-status"
        className="min-w-0 truncate"
        style={{ color: working ? 'var(--color-category-writing)' : 'hsl(var(--muted-foreground))' }}
        title={agentText}
        aria-label={agentText}
      >
        {agentText}
      </span>
      {fleetSrc.error ? <SourceNote source="Fleet" state={fleetSrc} compact /> : (
        <span
          data-testid="header-agent-fleet"
          className={`min-w-0 truncate ${now.fleetKnown ? '' : 'opacity-60'}`}
          style={{ color: fleetBusy ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}
          title={fleetText}
          aria-label={fleetText}
        >
          {fleetText}
        </span>
      )}
    </span>
  );
}
