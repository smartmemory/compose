/**
 * AttentionQueueSidebar.jsx
 *
 * COMP-UI-2: Live attention-queue sidebar.
 *
 * Replaces AppSidebar with a focused layout that surfaces:
 *   • Active build status (step + progress bar)
 *   • Pending gates queue
 *   • Blocked items queue
 *   • Compact stats row
 *   • Global phase filter (wired to useVisionStore — affects all views)
 *   • View navigation (all existing views preserved)
 *   • Agent telemetry panel (preserved from AppSidebar)
 *   • PROJECTS (FleetProjectsSection) in every room (COMP-COCKPIT-FLEET-PROJECTS-2; GROUPS moved to the Roadmap graph toolbar)
 */

import React from 'react';
import {
  Search, CircleDot, Bell, ChevronDown, ChevronRight,
  AlertTriangle, Shield, Lightbulb,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge.jsx';
import { Input } from '@/components/ui/input.jsx';
import { ScrollArea } from '@/components/ui/scroll-area.jsx';
import { Separator } from '@/components/ui/separator.jsx';
import { PHASE_LABELS, PHASES } from './constants.js';
import AgentPanel from './AgentPanel.jsx';
import { computeAttentionQueue, compactStats, togglePhase, ATTENTION_PRIORITY } from './attentionQueueState.js';
import StatusBadge from './shared/StatusBadge.jsx';
import PhaseTag from './shared/PhaseTag.jsx';
import { useIdeaboxStore } from './useIdeaboxStore.js';
import FleetProjectsSection from './FleetProjectsSection.jsx';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * AttentionQueueSection — inline queue of blocked + pending-gate + decision items.
 * Clicking an item navigates to it.
 */
export function attentionCollapsedKey(scope) {
  return `compose:needs-attention-collapsed:${scope || (typeof window !== 'undefined' ? window.location.host : '')}`;
}

function AttentionQueueSection({ items, gates, onSelectItem, storageScope }) {
  const queue = React.useMemo(() => computeAttentionQueue(items, gates), [items, gates]);
  // COMP-COCKPIT-8: "+N more" used to navigate to a nonexistent 'attention'
  // view; it now expands the full queue in place (rows are already clickable).
  const [expanded, setExpanded] = React.useState(false);
  // COMP-COCKPIT-HEADER-COUNTERS-1: whole-panel collapse, remembered per cockpit/project.
  const storageKey = attentionCollapsedKey(storageScope);
  const [collapsed, setCollapsed] = React.useState(() => {
    try { return window.localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { window.localStorage.setItem(storageKey, next ? '1' : '0'); } catch { /* ignore */ }
  };

  if (queue.length === 0) return null;

  // Show up to 5 items; more → expand in place
  const visible = expanded ? queue : queue.slice(0, 5);
  const overflow = queue.length - 5;

  const iconFor = (priority) => {
    if (priority === ATTENTION_PRIORITY.BLOCKED) return <AlertTriangle className="h-3 w-3 shrink-0" style={{ color: 'hsl(var(--destructive))' }} />;
    if (priority === ATTENTION_PRIORITY.PENDING_GATE) return <Shield className="h-3 w-3 shrink-0" style={{ color: 'hsl(var(--warning))' }} />;
    return <Bell className="h-3 w-3 shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }} />;
  };

  return (
    <div className="px-2 mb-2">
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        data-testid="attention-toggle"
        className="flex w-full items-center gap-1 text-[10px] font-medium uppercase tracking-wider px-2 mb-1"
        style={{ color: 'hsl(var(--muted-foreground))' }}
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        Needs Attention
        <span className="ml-auto tabular-nums" data-testid="attention-count">{queue.length}</span>
      </button>
      {!collapsed && visible.map(({ item, priority, reason }) => (
        <button
          data-testid="attention-row"
          key={item.id}
          onClick={() => onSelectItem?.(item.id)}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-sidebar-accent/50"
          style={{ color: 'hsl(var(--muted-foreground))' }}
          title={reason}
        >
          {iconFor(priority)}
          <span className="truncate flex-1 text-left">{item.title}</span>
          {item.phase && <PhaseTag phase={item.phase} className="shrink-0 text-[9px] px-1.5 py-0 h-4" />}
          <StatusBadge status={item.status} className="shrink-0" />
        </button>
      ))}
      {!collapsed && overflow > 0 && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex w-full items-center px-2 py-0.5 text-[10px] rounded-md hover:bg-sidebar-accent/50 transition-colors"
          style={{ color: 'hsl(var(--muted-foreground))' }}
        >
          {expanded ? 'Show less' : `+${overflow} more`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IdeasSection — shows untriaged idea count, click navigates to ideabox
// ---------------------------------------------------------------------------

function IdeasSection({ onViewChange }) {
  const ideas = useIdeaboxStore(s => s.ideas);
  const untriagedCount = React.useMemo(
    () => ideas.filter(i => !i.priority || i.priority === '—').length,
    [ideas],
  );

  if (untriagedCount === 0) return null;

  return (
    <div className="px-2 mb-2">
      <p
        className="text-[10px] font-medium uppercase tracking-wider px-2 mb-1"
        style={{ color: 'hsl(var(--muted-foreground))' }}
      >
        Ideas
      </p>
      <button
        onClick={() => onViewChange?.('ideabox')}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-sidebar-accent/50"
        style={{ color: 'hsl(var(--muted-foreground))' }}
        title="View untriaged ideas"
      >
        <Lightbulb className="h-3 w-3 shrink-0 text-amber-400" />
        <span className="flex-1 text-left">{untriagedCount} untriaged</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AttentionQueueSidebar
// ---------------------------------------------------------------------------

/**
 * AttentionQueueSidebar
 *
 * Props:
 *   items            VisionItem[]
 *   gates            Gate[]
 *   activeBuild      ActiveBuild | null
 *   onViewChange     (viewKey: string) => void  ← used by attention overflow link
 *   selectedPhase    string | null          ← from useVisionStore (global)
 *   onPhaseSelect    (phase: string|null) => void  ← calls store's setSelectedPhase
 *   searchQuery      string
 *   onSearchChange   (query: string) => void
 *   connected        boolean
 *   agentActivity    Activity[]
 *   agentErrors      Error[]
 *   sessionState     SessionState | null
 *   onSelectItem     (itemId: string) => void
 *   projectsMode     'lane' | 'project'  ← FleetProjectsSection mode (projectsModeFor(room))
 *   projectRoot      string   ← the cockpit's project, highlighted in project mode
 *   noProjectLane    string | null  ← the project-less lane a project room is showing
 *   onSelectProject  (lane, root|null) => void
 */
function AttentionQueueSidebar({
  storageScope,
  items,
  gates,
  activeBuild,
  onViewChange,
  selectedPhase,
  onPhaseSelect,
  selectedTrack: selectedTrackProp,
  onTrackSelect,
  visibleTracks,
  onToggleVisibleTrack,
  onShowAllTracks,
  searchQuery,
  onSearchChange,
  connected,
  agentActivity,
  agentErrors,
  spawnedAgents,
  agentRelays,
  sessionState,
  onSelectItem,
  onStopAgent,
  widthPx,
  projectsMode = 'lane',
  projectRoot = null,
  noProjectLane = null,
  onSelectProject,
}) {
  const safeItems = items || [];
  const safeGates = gates || [];

  const stats = React.useMemo(() => compactStats(safeItems, safeGates), [safeItems, safeGates]);

  const handlePhaseClick = React.useCallback((phaseKey) => {
    if (onPhaseSelect) onPhaseSelect(togglePhase(selectedPhase, phaseKey));
  }, [onPhaseSelect, selectedPhase]);

  return (
    <aside className="shrink-0 flex flex-col bg-sidebar border-r border-sidebar-border" style={{ width: widthPx ?? 208 }}>

      {/* ── Header ── */}
      {/* Counters + agent pill live in the top bar (COMP-COCKPIT-HEADER-COUNTERS-1) */}
      {!connected && (
      <div className="p-3 pb-2">
        <div className="mb-1">
          <span className="text-[10px] text-destructive">disconnected</span>
        </div>
      </div>
      )}

      {/* ── Agent telemetry (isolated to avoid re-render churn) ── */}
      <AgentPanel
        agentActivity={agentActivity}
        agentErrors={agentErrors}
        sessionState={sessionState}
        onSelectItem={onSelectItem}
        onStopAgent={onStopAgent}
        spawnedAgents={spawnedAgents}
        agentRelays={agentRelays}
      />

      {/* ── Attention queue (blocked + pending gates + decisions) ── */}
      {stats.attentionCount > 0 && (
        <>
          <Separator className="bg-sidebar-border" />
          <AttentionQueueSection
            storageScope={storageScope}
            items={safeItems}
            gates={safeGates}
            onSelectItem={onSelectItem}
            onViewChange={onViewChange}
          />
        </>
      )}

      {/* ── Ideas section (untriaged ideas count) ── */}
      <IdeasSection onViewChange={onViewChange} />

      {/* ── Search ── */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-7 pl-7 text-xs bg-sidebar"
          />
        </div>
      </div>

      <Separator className="bg-sidebar-border" />

      {/* ── PROJECTS in every room (COMP-COCKPIT-FLEET-PROJECTS-2) ── */}
      <ScrollArea className="flex-1">
        {/* A fixed width: the Radix viewport's table wrapper otherwise grows to the longest label and pushes each
            row's up / down / remove buttons out of view (seen in FLEET-PROJECTS-1's Fleet shot). */}
        <div className="p-2" style={{ width: (widthPx ?? 208) - 1 }}>
          <FleetProjectsSection
            onViewChange={onViewChange}
            mode={projectsMode}
            projectRoot={projectRoot}
            noProjectLane={noProjectLane}
            onSelectProject={onSelectProject}
          />
        </div>
      </ScrollArea>
    </aside>
  );
}

export default AttentionQueueSidebar;
