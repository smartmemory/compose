/**
 * GroupFilter.jsx — feature code prefix groups with counts (COMP-UX-1). Toggling one hides its items in the Roadmap
 * graph (`hiddenGroups`, read only by GraphView).
 *
 * COMP-COCKPIT-FLEET-PROJECTS-2: moved out of the left bar, unchanged, into the Roadmap graph toolbar's Groups popover;
 * the left bar lists PROJECTS in every room.
 */
import React from 'react';

const VISIBLE_STATUSES = new Set(['planned', 'ready', 'in_progress', 'review', 'blocked', 'parked']);

export default function GroupFilter({ items, hiddenGroups, onToggleGroup }) {
  const groups = React.useMemo(() => {
    const counts = {};
    const activeCount = {};
    for (const item of items) {
      const title = item.title || '';
      if (title.startsWith('`docs/') || title.startsWith('docs/')) continue;
      if (!VISIBLE_STATUSES.has(item.status)) continue;
      const group = item.group || 'other';
      counts[group] = (counts[group] || 0) + 1;
      if (['in_progress', 'review', 'ready'].includes(item.status)) {
        activeCount[group] = (activeCount[group] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort((a, b) =>
        // Primary: active count desc (most-active groups float up)
        (activeCount[b[0]] || 0) - (activeCount[a[0]] || 0) ||
        // Secondary: total count desc
        b[1] - a[1] ||
        // Tertiary: alphabetical — keeps order stable when counts match
        a[0].localeCompare(b[0])
      )
      .map(([group, count]) => ({ group, count, active: activeCount[group] || 0 }));
  }, [items]);

  if (groups.length <= 1) return null;

  return (
    <>
      {groups.map(({ group, count, active }) => {
        const isHidden = hiddenGroups?.has(group);
        return (
          <button
            key={group}
            onClick={() => onToggleGroup?.(group)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-sidebar-accent/50"
            style={{
              color: isHidden ? 'hsl(var(--muted-foreground))' : 'hsl(var(--muted-foreground))',
              opacity: isHidden ? 0.4 : 1,
              fontWeight: active > 0 ? 500 : 400,
            }}
          >
            <span className="truncate flex-1 text-left">{group}</span>
            <span
              className="text-[10px] tabular-nums shrink-0"
              style={{ color: 'hsl(var(--muted-foreground))' }}
              title={active > 0 ? `${active} active of ${count} items` : `${count} items`}
              data-testid="group-count"
            >
              {active > 0 ? `${active} active / ${count}` : count}
            </span>
          </button>
        );
      })}
    </>
  );
}
