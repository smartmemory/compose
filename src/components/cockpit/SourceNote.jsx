import React from 'react';
import { sourceNoteText } from '@/lib/sourceState.js';

/**
 * SourceNote (COMP-COCKPIT-SOURCE-FAULTS-1): the one line a cockpit screen shows when its data source failed or went
 * stale, "<source> unreadable since HH:MM: <reason>" or "<source> stale". `state` is a source state from
 * `lib/sourceState.js` (or any `{error, stale, errorSince, fetchedAt}`). Renders nothing for a healthy source.
 * `compact` prints the short form and keeps the full text in the title (header chips).
 */
export default function SourceNote({ source, state, compact = false, className = '' }) {
  const full = sourceNoteText(source, state);
  if (!full) return null;
  const text = compact ? sourceNoteText(source, state, { short: true }) : full;
  return (
    <span
      role="status"
      data-testid="source-note"
      data-source={source}
      data-stale={state?.stale ? 'true' : 'false'}
      className={`text-[11px] ${compact ? 'whitespace-nowrap' : 'block break-words'} ${className}`}
      style={{ color: 'hsl(var(--warning))' }}
      title={full}
    >
      {text}
    </span>
  );
}
