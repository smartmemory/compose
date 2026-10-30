/**
 * ViewTabs — cockpit header room row (COMP-AUDIT-17, shape A "labelled rooms").
 *
 * Top row: Home · Roadmap · Ideas · Review · Build · Fleet · Library, the
 * Settings gear, and a `Feature: CODE ×` chip while a feature is focused.
 * A room with more than one view shows a second row (`ViewSubTabs`, rendered
 * under the header). The view key stays flat: `locateView` derives which room
 * and sub-tab to highlight, and a click calls `onViewChange` with a leaf key.
 *
 * Props:
 *   activeView     {string}   the current leaf view key
 *   availability   {object}   {ops, stratum, cadence, wiki}: 'yes' | 'no' | 'unknown'
 *   onViewChange   {fn}       called with a leaf view key
 *   lastByRoom     {object?}  room key -> last view used there (a room re-opens on it)
 *   badges         {object?}  room key -> count (Review carries the pending gates)
 *   focusedFeature {string?}  feature code to show in the chip
 *   onClearFocus   {fn?}      the chip's ×
 *   onOpenPalette  {fn}       called when Cmd+K button is clicked
 *   colleague      {object?}  {installed, open, onToggle} — the Maya summon
 *                             button (FOH-6). Renders iff installed; NOT a room.
 */
import React from 'react';
import { Network, Activity, ShieldCheck, Search, Workflow, LayoutDashboard, Lightbulb, Sparkles, Settings, X, Library } from 'lucide-react';
import { ROOMS, GEAR_VIEW, SUB_LABELS, locateView, roomViews, roomEntryView } from '../../../lib/view-keys.js';

const ROOM_META = {
  home:    { icon: LayoutDashboard, tip: 'Landing page: what needs you, what is running' },
  roadmap: { icon: Network,         tip: 'Graph of all items, with a list view' },
  ideas:   { icon: Lightbulb,       tip: 'Captured ideas and suggestions' },
  review:  { icon: ShieldCheck,     tip: 'Gates, validation findings and QA scope' },
  build:   { icon: Workflow,        tip: 'Design, the live build, past builds and the flow editor' },
  fleet:   { icon: Activity,        tip: 'Agents and seats: Cadence, Stratum, Ops, Sessions, Usage, Process' },
  library: { icon: Library,         tip: 'Docs, the wiki and the journal' },
};

const tabClass = (isActive) => [
  'flex items-center gap-1.5 px-3 h-full text-[11px] uppercase tracking-wider font-medium transition-colors',
  'border-b-2 -mb-px',
  isActive
    ? 'border-blue-600 text-blue-600 dark:border-accent dark:text-accent'
    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
].join(' ');

/** Second row for the active room; renders nothing for a room with one view (Home, Ideas) or the gear. */
export function ViewSubTabs({ activeView, availability, onViewChange }) {
  const loc = locateView(activeView);
  if (!loc || loc.top === GEAR_VIEW) return null;
  const views = roomViews(loc.top, availability, activeView);
  if (views.length < 2) return null;
  const room = ROOMS.find((r) => r.key === loc.top);
  return (
    <div
      className="flex items-center gap-0.5 h-8 px-3 shrink-0"
      style={{ borderBottom: '1px solid hsl(var(--border))' }}
      role="tablist"
      aria-label={`${room.label} views`}
      data-testid="sub-tabs"
    >
      {views.map((key) => {
        const isActive = key === activeView;
        return (
          <button
            key={key}
            role="tab"
            aria-selected={isActive}
            data-testid={`sub-tab-${key}`}
            className={tabClass(isActive)}
            onClick={() => onViewChange?.(key)}
          >
            {SUB_LABELS[key] || key}
          </button>
        );
      })}
    </div>
  );
}

export default function ViewTabs({ activeView, availability = {}, onViewChange, onOpenPalette, badges = {}, lastByRoom = {}, focusedFeature, onClearFocus, colleague }) {
  const loc = locateView(activeView);
  return (
    <div
      className="flex items-center gap-0.5 h-full"
      role="tablist"
      aria-label="Rooms"
    >
      {ROOMS.map((room) => {
        const meta = ROOM_META[room.key];
        const isActive = loc?.top === room.key;
        const Icon = meta?.icon;
        const badge = badges[room.key];
        return (
          <button
            key={room.key}
            role="tab"
            aria-selected={isActive}
            data-testid={`room-tab-${room.key}`}
            title={meta?.tip}
            className={tabClass(isActive)}
            onClick={() => onViewChange?.(isActive ? activeView : roomEntryView(room.key, availability, lastByRoom[room.key]))}
          >
            {Icon && <Icon style={{ width: 12, height: 12 }} />}
            {room.label}
            {badge > 0 && (
              <span className="text-[9px] min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 tabular-nums"
                style={{ background: 'hsl(var(--destructive) / 0.15)', color: 'hsl(var(--destructive))' }}>
                {badge}
              </span>
            )}
          </button>
        );
      })}
      <button
        role="tab"
        aria-selected={loc?.top === GEAR_VIEW}
        aria-label="Settings"
        data-testid="room-tab-settings"
        title="Project and UI settings"
        className={tabClass(loc?.top === GEAR_VIEW)}
        onClick={() => onViewChange?.(GEAR_VIEW)}
      >
        <Settings style={{ width: 12, height: 12 }} />
      </button>
      {focusedFeature && (
        <span
          className="ml-2 flex items-center gap-1 px-2 h-5 rounded text-[10px] font-mono"
          style={{ background: 'hsl(var(--accent) / 0.15)', color: 'hsl(var(--accent))' }}
          data-testid="focus-chip"
          title="Project views are filtered to this feature. Click × to show everything."
        >
          Feature: {focusedFeature}
          <button
            onClick={onClearFocus}
            aria-label="Clear feature focus"
            data-testid="focus-chip-clear"
            className="hover:opacity-70"
          >
            <X style={{ width: 10, height: 10 }} />
          </button>
        </span>
      )}
      <div className="flex-1" />
      {colleague?.installed && (
        <button
          onClick={colleague.onToggle}
          data-testid="colleague-summon"
          aria-pressed={colleague.open}
          title="Maya — talk to the colleague about this project's ideas"
          className={[
            'colleague-summon flex items-center gap-1.5 px-2.5 h-full text-[11px] transition-colors',
            colleague.open ? 'text-accent' : 'text-muted-foreground hover:text-foreground',
          ].join(' ')}
        >
          <Sparkles style={{ width: 12, height: 12 }} />
          Maya
        </button>
      )}
      {onOpenPalette && (
        <button
          onClick={onOpenPalette}
          className="flex items-center gap-1.5 px-2.5 h-full text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          title="Search (⌘K)"
        >
          <Search style={{ width: 12, height: 12 }} />
          <kbd className="text-[9px] font-mono opacity-50 bg-muted px-1 py-0.5 rounded">⌘K</kbd>
        </button>
      )}
    </div>
  );
}
