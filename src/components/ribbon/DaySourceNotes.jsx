/**
 * DaySourceNotes.jsx — COMP-DAYVIEW-DESIGN-FIX-1 U3: the Day page's source state (`daySources.js`) drawn the same way in
 * every branch. `DaySourceNotes` is the failed and stale lines (above what they qualify); `DayMissingSources` is the
 * per-source "not read since" lines (under the ribbon or the Now list, C2). Both take the one `sources` object DayView
 * computes, so the desktop, the phone and the Now drawer cannot say different things about the same read.
 */
import React from 'react';
import SourceNote from '../cockpit/SourceNote.jsx';

export function DaySourceNotes({ sources, className = '' }) {
  if (!sources || (!sources.failed.length && !sources.notes.length)) return null;
  return (
    <div className={`flex flex-col gap-0.5 ${className}`} data-testid="day-sources">
      {sources.failed.map((f) => (
        <p key={f.key} className="m-0 text-[12px] text-destructive" role="status" data-testid="day-feed-error" data-source={f.key} title={f.title}>{f.text}</p>
      ))}
      {sources.notes.map((n) => <SourceNote key={n.key} source={n.source} state={n.state} />)}
    </div>
  );
}

export function DayMissingSources({ sources, className = '', testId = 'day-source-errors' }) {
  if (!sources?.missing.length) return null;
  return (
    <ul className={`m-0 pl-4 text-[12px] text-muted-foreground ${className}`} data-testid={testId}>
      {sources.missing.map((m) => <li key={m.key} title={m.title}>{m.text}</li>)}
    </ul>
  );
}
