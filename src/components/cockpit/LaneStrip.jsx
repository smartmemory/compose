/**
 * LaneStrip — per-worker lanes for parallel fanouts (COMP-AGENT-LANES).
 *
 * One tab per lane (status dot, mandate label, attempt badge, joined-mid-build
 * marker) over the selected lane's own message feed. Collapsed, it shows the
 * legacy aggregate counter line. Borrows AgentPanel's tab pattern but is fed
 * exclusively from the `compose:agent-status` payload's `lanes` array (module
 * state in AgentStream) — NOT from the zustand/WS pipe AgentPanel uses.
 */
import React, { useState } from 'react';

const STATUS_COLORS = {
  working: 'hsl(var(--success))',
  succeeded: 'hsl(142 71% 45%)',
  failed: 'hsl(var(--destructive))',
  skipped: 'hsl(45 93% 47%)',
};

function laneCounts(lanes) {
  const counts = { total: lanes.length, completed: 0, failed: 0, active: 0 };
  for (const entry of lanes) {
    if (entry.status === 'working') counts.active++;
    else if (entry.status === 'failed') counts.failed++;
    else counts.completed++;
  }
  return counts;
}

function LaneMessage({ msg, index }) {
  if (msg.type === 'error') {
    return (
      <div className="text-[11px] font-mono py-0.5" style={{ color: 'hsl(var(--destructive))' }}>
        ⚠ {msg.message}
      </div>
    );
  }
  if (msg.subtype === 'tool_use_summary') {
    return (
      <div className="text-[11px] py-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
        {msg.summary}
      </div>
    );
  }
  const content = msg.message?.content ?? [];
  return (
    <div className="py-0.5">
      {content.map((block, i) => {
        if (block.type === 'text') {
          return (
            <div key={i} className="text-[11px] whitespace-pre-wrap" style={{ color: 'hsl(var(--foreground))' }}>
              {block.text}
            </div>
          );
        }
        if (block.type === 'tool_use') {
          return (
            <div key={i} className="text-[11px] font-mono" style={{ color: 'hsl(var(--muted-foreground))' }}>
              → {block.name}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

export default function LaneStrip({ lanes }) {
  const [collapsed, setCollapsed] = useState(false);
  const [selectedKey, setSelectedKey] = useState(null);

  if (!lanes || lanes.length === 0) return null;

  const counts = laneCounts(lanes);
  const selected = lanes.find((entry) => entry.key === selectedKey) ?? lanes[0];

  return (
    <div
      className="shrink-0 flex flex-col"
      style={{ borderBottom: '1px solid hsl(var(--border) / 0.5)' }}
    >
      <div className="flex items-center gap-1 px-3 py-1 overflow-x-auto">
        <button
          data-testid="lane-strip-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand lanes' : 'Collapse lanes'}
          aria-label="Toggle lanes"
          className="text-[10px] shrink-0 px-1 rounded cursor-pointer"
          style={{ color: 'hsl(var(--muted-foreground))' }}
        >
          {collapsed ? '▸' : '▾'}
        </button>

        {collapsed ? (
          <span
            data-testid="lane-strip-counter"
            className="text-[11px] font-mono truncate"
            style={{ color: 'hsl(var(--muted-foreground))' }}
          >
            ∥ {counts.completed}/{counts.total} tasks
            {counts.failed ? ` (${counts.failed} failed)` : ''}
            {counts.active ? ` • ${counts.active} active` : ''}
          </span>
        ) : (
          lanes.map((entry) => (
            <button
              key={entry.key}
              onClick={() => setSelectedKey(entry.key)}
              className="text-[10px] px-2 py-0.5 rounded cursor-pointer transition-colors border flex items-center gap-1 shrink-0"
              style={selected.key === entry.key
                ? { background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))', borderColor: 'hsl(var(--primary))' }
                : { background: 'transparent', color: 'hsl(var(--muted-foreground))', borderColor: 'hsl(var(--border))' }}
            >
              <span
                data-testid="lane-status-dot"
                data-status={entry.status}
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{
                  background: STATUS_COLORS[entry.status] ?? STATUS_COLORS.working,
                  animation: entry.status === 'working' ? 'phase-active-pulse 2s ease-in-out infinite' : 'none',
                }}
              />
              <span className="truncate max-w-[160px]">{entry.lane.label}</span>
              {(entry.lane.attempt ?? 1) > 1 && (
                <span
                  data-testid="lane-attempt-badge"
                  title={`attempt ${entry.lane.attempt}`}
                  className="text-[8px] px-1 rounded"
                  style={{ background: 'hsl(45 93% 47% / 0.2)', color: 'hsl(45 93% 47%)' }}
                >
                  ×{entry.lane.attempt}
                </span>
              )}
            </button>
          ))
        )}
      </div>

      {!collapsed && selected && (
        <div className="px-3 pb-1.5 max-h-40 overflow-y-auto">
          {selected.joinedMidBuild && (
            <div className="text-[10px] italic py-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
              (joined mid-build — earlier output not shown)
            </div>
          )}
          {selected.messages.map((msg, i) => (
            <LaneMessage key={i} msg={msg} index={i} />
          ))}
          {selected.messages.length === 0 && !selected.joinedMidBuild && (
            <div className="text-[10px] italic py-0.5" style={{ color: 'hsl(var(--muted-foreground))', opacity: 0.6 }}>
              no output yet
            </div>
          )}
        </div>
      )}
    </div>
  );
}
