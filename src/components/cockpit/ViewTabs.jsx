/**
 * ViewTabs — cockpit header tab bar for switching main-area views.
 *
 * Renders a horizontal list of tab buttons with icons inside the cockpit header.
 * The active tab is highlighted; clicking a tab fires onTabChange.
 * Includes a Cmd+K search button on the right.
 *
 * Props:
 *   tabs        {string[]}  ordered list of tab keys
 *   activeTab   {string}    currently active tab key
 *   onTabChange {fn}        called with (tabKey) when a tab is clicked
 *   onOpenPalette {fn}      called when Cmd+K button is clicked
 */
import React from 'react';
import { Network, GitBranch, Activity, ShieldCheck, Search, FileText, Workflow, MessageSquare, LayoutDashboard, Lightbulb } from 'lucide-react';

const TAB_META = {
  dashboard: { label: 'Dashboard', icon: LayoutDashboard, tip: 'Overview of project status and activity' },
  tree:      { label: 'Items',     icon: GitBranch,       tip: 'Hierarchical list of all items and features' },
  graph:     { label: 'Graph',     icon: Network,         tip: 'Visual dependency graph of items' },
  pipeline:  { label: 'Pipeline',  icon: Workflow,        tip: 'Build pipeline stages and progress' },
  sessions:  { label: 'Sessions',  icon: Activity,        tip: 'Active and past agent sessions' },
  gates:     { label: 'Gates',     icon: ShieldCheck,     tip: 'Quality gates and approval checkpoints' },
  docs:      { label: 'Docs',      icon: FileText,        tip: 'Project documentation and specs' },
  design:    { label: 'Design',    icon: MessageSquare,   tip: 'Design agent conversations and decisions' },
  ideabox:   { label: 'Ideabox',   icon: Lightbulb,       tip: 'Captured ideas and suggestions' },
};

export default function ViewTabs({ tabs = [], activeTab, onTabChange, onOpenPalette, badges = {} }) {
  return (
    <div
      className="flex items-center gap-0.5 h-full"
      role="tablist"
      aria-label="Main views"
    >
      {tabs.map(tab => {
        const meta = TAB_META[tab];
        const isActive = tab === activeTab;
        const Icon = meta?.icon;
        const label = meta?.label || tab;
        const badge = badges[tab];
        return (
          <button
            key={tab}
            role="tab"
            aria-selected={isActive}
            title={meta?.tip}
            className={[
              'flex items-center gap-1.5 px-3 h-full text-[11px] uppercase tracking-wider font-medium transition-colors',
              'border-b-2 -mb-px',
              isActive
                ? 'border-blue-600 text-blue-600 dark:border-accent dark:text-accent'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
            ].join(' ')}
            onClick={() => onTabChange?.(tab)}
          >
            {Icon && <Icon style={{ width: 12, height: 12 }} />}
            {label}
            {badge > 0 && (
              <span className="text-[9px] min-w-[16px] h-4 flex items-center justify-center rounded-full px-1 tabular-nums"
                style={{ background: 'hsl(var(--destructive) / 0.15)', color: 'hsl(var(--destructive))' }}>
                {badge}
              </span>
            )}
          </button>
        );
      })}
      <div className="flex-1" />
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
