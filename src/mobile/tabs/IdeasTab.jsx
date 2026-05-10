import React, { useMemo, useState } from 'react';
import { useIdeas, UNTRIAGED } from '../hooks/useIdeas.js';
import IdeaCard from '../components/IdeaCard.jsx';
import CaptureSheet from '../components/CaptureSheet.jsx';
import IdeaDetailSheet from '../components/IdeaDetailSheet.jsx';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'P0', label: 'P0' },
  { id: 'P1', label: 'P1' },
  { id: 'P2', label: 'P2' },
  { id: 'untriaged', label: 'Untriaged' },
];

const PRIORITY_RANK = { 'P0': 3, 'P1': 2, 'P2': 1 };

function sortIdeas(ideas) {
  return [...ideas].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] || 0;
    const pb = PRIORITY_RANK[b.priority] || 0;
    if (pa !== pb) return pb - pa;
    // recency: prefer higher num (later additions first)
    const na = typeof a.num === 'number' ? a.num : 0;
    const nb = typeof b.num === 'number' ? b.num : 0;
    return nb - na;
  });
}

export default function IdeasTab() {
  const {
    ideas,
    loading,
    toasts,
    dismissToast,
    createIdea,
    promote,
    kill,
    setPriority,
  } = useIdeas();

  const [filter, setFilter] = useState('all');
  const [captureOpen, setCaptureOpen] = useState(false);
  const [detailIdea, setDetailIdea] = useState(null);

  const visibleIdeas = useMemo(() => {
    let list = ideas;
    if (filter === 'untriaged') {
      list = list.filter(i => !i.priority || i.priority === UNTRIAGED || i.priority === '');
    } else if (filter !== 'all') {
      list = list.filter(i => i.priority === filter);
    }
    return sortIdeas(list);
  }, [ideas, filter]);

  const existingClusters = useMemo(() => {
    const seen = new Set();
    for (const i of ideas) if (i.cluster) seen.add(i.cluster);
    return [...seen];
  }, [ideas]);

  return (
    <section className="m-ideas-tab" data-testid="mobile-tab-ideas">
      <div className="m-ideas-toolbar">
        <button
          type="button"
          className="m-sheet-btn m-sheet-btn-primary m-capture-btn"
          onClick={() => setCaptureOpen(true)}
          data-testid="open-capture"
          aria-label="Capture new idea"
        >+ Capture</button>
        <div className="m-filter-chips" role="tablist" aria-label="Priority filter">
          {FILTERS.map(f => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-pressed={filter === f.id ? 'true' : 'false'}
              aria-selected={filter === f.id ? 'true' : 'false'}
              className="m-filter-chip"
              onClick={() => setFilter(f.id)}
              data-testid={`filter-${f.id}`}
            >{f.label}</button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="m-ideas-list" data-testid="ideas-loading">
          {[0, 1, 2].map(i => (
            <div key={i} className="m-idea-skeleton" aria-hidden="true" />
          ))}
        </div>
      ) : visibleIdeas.length === 0 ? (
        <div className="m-empty-state" data-testid="ideas-empty">
          <div className="m-empty-title">
            {ideas.length === 0 ? 'No ideas yet' : 'Nothing matches this filter'}
          </div>
          <div className="m-empty-body">
            {ideas.length === 0
              ? 'Tap Capture to add your first idea.'
              : 'Try All to see everything.'}
          </div>
        </div>
      ) : (
        <div className="m-ideas-list" data-testid="ideas-list">
          {visibleIdeas.map(idea => (
            <IdeaCard
              key={idea.id}
              idea={idea}
              onTap={(i) => setDetailIdea(i)}
              onSwipeLeft={(i) => kill(i.id)}
              onSwipeRight={(i) => promote(i.id)}
            />
          ))}
        </div>
      )}

      <CaptureSheet
        open={captureOpen}
        onClose={() => setCaptureOpen(false)}
        onSubmit={createIdea}
        existingClusters={existingClusters}
      />

      <IdeaDetailSheet
        idea={detailIdea}
        open={!!detailIdea}
        onClose={() => setDetailIdea(null)}
        onPromote={(id) => promote(id)}
        onKill={(id) => kill(id)}
        onSetPriority={(id, p) => setPriority(id, p)}
      />

      <div className="m-toast-stack" aria-live="polite" data-testid="toasts">
        {toasts.map(t => (
          <div
            key={t.id}
            className="m-toast"
            data-kind={t.kind === 'error' ? 'error' : 'ok'}
            role={t.kind === 'error' ? 'alert' : 'status'}
            onClick={() => dismissToast(t.id)}
          >{t.message}</div>
        ))}
      </div>
    </section>
  );
}
