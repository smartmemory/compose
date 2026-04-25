/**
 * DecisionTimelineStrip.jsx — Horizontal decision timeline strip.
 *
 * COMP-OBS-TIMELINE B4:
 *   - 72px sticky band, full-width, horizontally scrollable
 *   - filters by currentFeatureCode from props
 *   - renders events in oldest-first order (newest rightmost per layout.md region ②)
 *   - shrinks to zero pixels when no filtered events (empty state: no visual noise)
 *
 * Mount location: top of VisionTracker.jsx, sticky top:0.
 */
import React from 'react';
import DecisionCard from './DecisionCard.jsx';
import { sortAndFilterEvents } from './decisionTimelineLogic.js';

export default function DecisionTimelineStrip({ events = [], currentFeatureCode, now }) {
  const filtered = sortAndFilterEvents(events, currentFeatureCode);

  // Empty state: render nothing — the strip takes no space when empty
  if (filtered.length === 0) {
    return null;
  }

  return (
    <div
      className="w-full overflow-x-auto whitespace-nowrap border-b border-border/30 bg-background/95 backdrop-blur-sm"
      style={{ height: 72, minHeight: 72, maxHeight: 72, position: 'sticky', top: 0, zIndex: 10 }}
      data-decision-timeline-strip
    >
      <div className="flex items-center gap-2 px-3 h-full">
        {filtered.map(event => (
          <DecisionCard key={event.id} event={event} now={now} />
        ))}
      </div>
    </div>
  );
}
