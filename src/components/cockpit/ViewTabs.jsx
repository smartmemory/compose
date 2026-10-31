/**
 * ViewTabs — cockpit header room row (COMP-AUDIT-17, shape A "labelled rooms").
 *
 * Top row (COMP-COCKPIT-PROJECTS-TAB-1): Day · Projects · Fleet · Library, the Settings gear, and a
 * `Feature: CODE ×` chip while a feature is focused. Projects holds Project home, Ideas, Roadmap, Build and Review in
 * its own sub-row (`ProjectSubTabs`, with the project selector at the left). A room with more than one view shows a
 * views row (`ViewSubTabs`, rendered under the header). The view key stays flat: `locateView` derives which room
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
 *   (projectName moved to ProjectSubTabs' selector and RoomBreadcrumb)
 *   colleague      {object?}  {installed, open, onToggle} — the Maya summon
 *                             button (FOH-6). Renders iff installed; NOT a room.
 */
import React from 'react';
import { Network, Activity, ShieldCheck, Search, Workflow, LayoutDashboard, Lightbulb, Sparkles, Settings, X, Library, CalendarClock, FolderKanban } from 'lucide-react';
import { ROOMS, PROJECTS_KEY, TOP_TABS, GEAR_VIEW, SUB_LABELS, locateView, roomViews, roomEntryView, projectRooms } from '../../../lib/view-keys.js';

const ROOM_META = {
  day:     { icon: CalendarClock,   tip: 'The last day and the next, one row per lane' },
  home:    { icon: LayoutDashboard, tip: 'This project: what needs you, what is running' },
  roadmap: { icon: Network,         tip: 'Graph of all items, with a list view' },
  ideas:   { icon: Lightbulb,       tip: 'Captured ideas and suggestions' },
  review:  { icon: ShieldCheck,     tip: 'Gates, validation findings and QA scope' },
  build:   { icon: Workflow,        tip: 'Design, the live build, past builds and the flow editor' },
  fleet:   { icon: Activity,        tip: 'Agents and seats: Cadence, Stratum, Ops, Sessions, Usage, Process' },
  library: { icon: Library,         tip: 'Docs, the wiki and the journal' },
};

const PROJECTS_META = { icon: FolderKanban, tip: 'Project home, Ideas, Roadmap, Build and Review for one Compose project' };

const tabClass = (isActive) => [
  'flex items-center gap-1.5 px-3 h-full text-[11px] uppercase tracking-wider font-medium transition-colors',
  'border-b-2 -mb-px',
  isActive
    ? 'border-blue-600 text-blue-600 dark:border-accent dark:text-accent'
    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
].join(' ');

/**
 * One sub-row: the Fleet/Library views, the Projects rooms and a project room's views all render through this
 * (COMP-COCKPIT-PROJECTS-TAB-1). `items` are `{key, label, active, testid, badge?, tip?, onClick}`; `lead` sits before the tabs.
 */
function SubTabRow({ label, testid, items, lead = null }) {
  return (
    <div
      className="flex items-center gap-0.5 h-8 px-3 shrink-0"
      style={{ borderBottom: '1px solid hsl(var(--border))' }}
      role="tablist"
      aria-label={label}
      data-testid={testid}
    >
      {lead}
      {items.map((it) => (
        <button
          key={it.key}
          role="tab"
          aria-selected={it.active}
          data-testid={it.testid}
          title={it.tip}
          className={tabClass(it.active)}
          onClick={it.onClick}
        >
          {it.label}
          {it.badge > 0 && (
            <span className="text-[11px] min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 tabular-nums"
              style={{ background: 'hsl(var(--destructive) / 0.15)', color: 'hsl(var(--destructive))' }}>
              {it.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Second row for the active room (or a project room's views); renders nothing for a room with one view (Home, Ideas) or the gear. */
export function ViewSubTabs({ activeView, availability, onViewChange }) {
  const loc = locateView(activeView);
  if (!loc || loc.top === GEAR_VIEW) return null;
  const roomKey = loc.room || loc.top;
  const views = roomViews(roomKey, availability, activeView);
  if (views.length < 2) return null;
  const room = ROOMS.find((r) => r.key === roomKey);
  return (
    <SubTabRow
      label={`${room.label} views`}
      testid="sub-tabs"
      items={views.map((key) => ({ key, label: SUB_LABELS[key] || key, active: key === activeView, testid: `sub-tab-${key}`, onClick: () => onViewChange?.(key) }))}
    />
  );
}

/**
 * The Projects sub-row: the project selector at the left, then Project home, Ideas, Roadmap, Build, Review, styled and built
 * like Fleet's row. Renders only inside a project room. A room with several views gets `ViewSubTabs` under it.
 *   selector {node?}   the project selector (App passes ProjectSwitchPopover)
 */
export function ProjectSubTabs({ activeView, availability = {}, onViewChange, lastByRoom = {}, badges = {}, selector = null }) {
  const loc = locateView(activeView);
  if (!loc || loc.top !== PROJECTS_KEY) return null;
  const items = projectRooms(availability, activeView).map((r) => ({
    key: r.key,
    label: r.label,
    active: loc.room === r.key,
    testid: `sub-tab-${r.key}`,
    tip: ROOM_META[r.key]?.tip,
    badge: r.key === 'review' ? badges.review : 0,
    onClick: () => onViewChange?.(loc.room === r.key ? activeView : roomEntryView(r.key, availability, lastByRoom[r.key])),
  }));
  return (
    <SubTabRow
      label="Project rooms"
      testid="project-sub-tabs"
      items={items}
      lead={selector && <div className="flex items-center pr-2 mr-1 border-r border-border h-5" data-testid="project-selector">{selector}</div>}
    />
  );
}

/**
 * The top row reads Day · Projects · Fleet · Library · gear (COMP-COCKPIT-PROJECTS-TAB-1, which replaces RIBBON-TOP-1's project
 * chip). Projects is a tab like Fleet: active whenever a project room shows, and a click re-opens the last project room.
 */
export default function ViewTabs({ activeView, availability = {}, onViewChange, onOpenPalette, badges = {}, lastByRoom = {}, focusedFeature, onClearFocus, colleague }) {
  const loc = locateView(activeView);

  const topTab = (key) => {
    const isProjects = key === PROJECTS_KEY;
    const room = isProjects ? { key, label: 'Projects' } : ROOMS.find((r) => r.key === key);
    const meta = isProjects ? PROJECTS_META : ROOM_META[key];
    const isActive = loc?.top === key;
    const Icon = meta?.icon;
    const badge = isProjects ? badges.review : badges[key];
    return (
      <button
        key={key}
        role="tab"
        aria-selected={isActive}
        data-testid={`room-tab-${key}`}
        title={meta?.tip}
        className={tabClass(isActive)}
        onClick={() => onViewChange?.(isActive ? activeView : roomEntryView(key, availability, lastByRoom[key]))}
      >
        {Icon && <Icon style={{ width: 12, height: 12 }} />}
        {room.label}
        {badge > 0 && (
          <span className="text-[11px] min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 tabular-nums"
            style={{ background: 'hsl(var(--destructive) / 0.15)', color: 'hsl(var(--destructive))' }}>
            {badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      className="flex items-center gap-0.5 h-full"
      role="tablist"
      aria-label="Rooms"
    >
      {TOP_TABS.map(topTab)}
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
          className="ml-2 flex items-center gap-1 px-2 h-5 rounded text-[11px] font-mono"
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
          className="flex items-center gap-1.5 px-1 min-[1440px]:px-2.5 h-full text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          title="Search (⌘K)"
        >
          <Search style={{ width: 12, height: 12 }} />
          <kbd className="hidden min-[1440px]:inline-block text-[11px] font-mono text-muted-foreground bg-muted px-1 py-0.5 rounded">⌘K</kbd>
        </button>
      )}
    </div>
  );
}

/**
 * "Day › Projects › <project> › <room>" (› <view> where the room has several) under the header inside a project room
 * (COMP-COCKPIT-PROJECTS-TAB-1). Each part is a button: Day goes to the Day page, Projects to the last project room, the
 * project to Project home, the room to the room's entry view. Renders nothing elsewhere.
 */
export function RoomBreadcrumb({ activeView, availability = {}, projectName = '', lastByRoom = {}, onViewChange }) {
  const loc = locateView(activeView);
  if (!loc || loc.top !== PROJECTS_KEY) return null;
  const room = ROOMS.find((r) => r.key === loc.room);
  const part = 'text-[11px] text-muted-foreground hover:text-foreground hover:underline focus-visible:underline outline-none';
  const sep = <span aria-hidden="true" className="text-[11px] text-muted-foreground">›</span>;
  const subLabel = loc.sub ? (SUB_LABELS[loc.sub] || loc.sub) : null;
  return (
    <nav
      aria-label="Breadcrumb"
      data-testid="room-breadcrumb"
      className="flex items-center gap-1.5 h-6 px-3 shrink-0"
      style={{ borderBottom: '1px solid hsl(var(--border))' }}
    >
      <button type="button" className={part} data-testid="crumb-day" onClick={() => onViewChange?.('day')}>Day</button>
      {sep}
      <button type="button" className={part} data-testid="crumb-projects" onClick={() => onViewChange?.(roomEntryView(PROJECTS_KEY, availability, activeView))}>Projects</button>
      {sep}
      <button type="button" className={part} data-testid="crumb-project" onClick={() => onViewChange?.(roomEntryView('home', availability, lastByRoom.home))}>{projectName || 'Project'}</button>
      {sep}
      <button type="button" className={`${part} ${subLabel ? '' : 'text-foreground'}`} data-testid="crumb-room" aria-current={subLabel ? undefined : 'page'} onClick={() => onViewChange?.(roomEntryView(room.key, availability, lastByRoom[room.key]))}>{room.label}</button>
      {subLabel && (
        <>
          {sep}
          <span className="text-[11px] text-foreground" data-testid="crumb-view" aria-current="page">{subLabel}</span>
        </>
      )}
    </nav>
  );
}
