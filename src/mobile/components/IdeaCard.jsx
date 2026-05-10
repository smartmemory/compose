import React, { useRef, useState, useCallback } from 'react';
import { UNTRIAGED } from '../hooks/useIdeas.js';
import { useSwipe } from '../lib/swipe.js';

function priorityKey(p) {
  if (p === 'P0' || p === 'P1' || p === 'P2') return p.toLowerCase();
  return 'untriaged';
}

function priorityLabel(p) {
  if (p === 'P0' || p === 'P1' || p === 'P2') return p;
  return 'Untriaged';
}

export default function IdeaCard({ idea, onTap, onSwipeLeft, onSwipeRight }) {
  const rootRef = useRef(null);
  const [dx, setDx] = useState(0);
  const [intent, setIntent] = useState(null); // 'kill' | 'promote' | null

  const handleDrag = useCallback((delta) => {
    setDx(delta);
    if (delta <= -40) setIntent('kill');
    else if (delta >= 40) setIntent('promote');
    else setIntent(null);
  }, []);

  const handleEnd = useCallback(() => {
    setDx(0);
    setIntent(null);
  }, []);

  useSwipe(rootRef, {
    onSwipeLeft: () => onSwipeLeft?.(idea),
    onSwipeRight: () => onSwipeRight?.(idea),
    onDrag: handleDrag,
    onDragEnd: handleEnd,
    threshold: 80,
  });

  const pkey = priorityKey(idea.priority);
  const tags = Array.isArray(idea.tags) ? idea.tags : [];

  return (
    <div className="m-idea-row" data-testid={`idea-row-${idea.id}`}>
      <div className="m-idea-action m-idea-action-left" aria-hidden="true">
        Promote
      </div>
      <div className="m-idea-action m-idea-action-right" aria-hidden="true">
        Kill
      </div>
      <article
        ref={rootRef}
        className={`m-idea-card${intent ? ` is-intent-${intent}` : ''}`}
        data-testid="idea-card"
        data-idea-id={idea.id}
        data-priority={pkey}
        style={{ transform: `translateX(${dx}px)` }}
        role="button"
        tabIndex={0}
        onClick={() => {
          // Only treat as tap if there's no active drag offset
          if (Math.abs(dx) < 4) onTap?.(idea);
        }}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            onTap?.(idea);
          }
        }}
      >
        <div className="m-idea-head">
          <span
            className="m-priority-badge"
            data-priority={pkey}
            data-testid={`priority-badge-${idea.id}`}
          >
            {priorityLabel(idea.priority)}
          </span>
          {idea.cluster ? (
            <span className="m-idea-cluster" title={idea.cluster}>{idea.cluster}</span>
          ) : null}
        </div>
        <h3 className="m-idea-title" data-testid={`idea-title-${idea.id}`}>
          {idea.title}
        </h3>
        {tags.length > 0 ? (
          <div className="m-idea-tags">
            {tags.map(t => (
              <span key={t} className="m-idea-tag">{t}</span>
            ))}
          </div>
        ) : null}
      </article>
    </div>
  );
}

export { priorityKey, priorityLabel };
