/**
 * DecisionCard.jsx — One card in the DecisionTimelineStrip.
 *
 * COMP-OBS-TIMELINE B3:
 *   - 160px fixed width
 *   - timestamp top-right (HH:mm, 10px)
 *   - title 1-line 12px truncated
 *   - role chips per event.roles[]
 *   - kind icon + color indicator
 *
 * Borrows layout vocabulary from TimelineEvent.jsx:29-54.
 */
import React from 'react';
import { cn } from '@/lib/utils.js';
import { kindIcon, kindColor, roleChipClass, formatRelativeTime } from './decisionTimelineLogic.js';

function formatHHMM(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toISOString().slice(11, 16); // "HH:mm" in UTC
  } catch {
    return '';
  }
}

export default function DecisionCard({ event, now }) {
  const icon = kindIcon(event.kind);
  const colorClass = kindColor(event.kind);
  const rel = formatRelativeTime(event.timestamp, now);

  return (
    <div
      data-decision-card
      className="inline-flex flex-col gap-0.5 w-40 shrink-0 rounded border border-border/40 bg-muted/20 px-2 py-1.5 text-left"
    >
      {/* Header row: kind icon + relative time */}
      <div className="flex items-center justify-between gap-1">
        <span className={cn('text-[11px] shrink-0', colorClass)}>
          {icon}
        </span>
        <span className="text-[10px] text-muted-foreground/50 tabular-nums">
          {rel || formatHHMM(event.timestamp)}
        </span>
      </div>

      {/* Title */}
      <p className="text-[11px] text-foreground/80 truncate leading-tight">
        {event.title}
      </p>

      {/* Role chips */}
      {event.roles && event.roles.length > 0 && (
        <div className="flex flex-wrap gap-0.5 mt-0.5">
          {event.roles.map((role, i) => (
            <span
              key={i}
              data-role-chip
              className={cn(
                'text-[9px] px-1 py-px rounded-full leading-tight',
                roleChipClass(role.name)
              )}
            >
              {role.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
