import React, { useState, useEffect, useCallback } from 'react';
import { BookOpen, Plus, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import EmptyState from './shared/EmptyState.jsx';
import MarkdownViewer from './shared/MarkdownViewer.jsx';
import EntityLink from '../shared/EntityLink.jsx';
import { wsFetch } from '../../lib/wsFetch.js';
import { withComposeToken } from '../../lib/compose-api.js';
import { notify } from '../cockpit/NotificationBar.jsx';

/**
 * JournalView — Journal & changelog cockpit surface (COMP-COCKPIT-9).
 *
 * Self-fetching (like DocsView): GET /api/journal | /api/changelog on mount
 * and whenever source/feature-filter changes. No store props needed.
 *
 * - Source toggle: journal entries vs changelog entries
 * - Feature filter: exact-match feature code (?feature=<code>)
 * - "New entry" inline form → POST /api/journal (sensitive token)
 */

const SECTION_META = [
  ['what_happened', 'What happened'],
  ['what_we_built', 'What we built'],
  ['what_we_learned', 'What we learned'],
  ['open_threads', 'Open threads'],
];

const EMPTY_FORM = {
  summary: '',
  feature_code: '',
  what_happened: '',
  what_we_built: '',
  what_we_learned: '',
  open_threads: '',
};

export default function JournalView() {
  const [source, setSource] = useState('journal');           // 'journal' | 'changelog'
  const [featureFilter, setFeatureFilter] = useState('');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (featureFilter.trim()) params.set('feature', featureFilter.trim());
      const qs = params.toString();
      const res = await wsFetch(`/api/${source}${qs ? `?${qs}` : ''}`);
      if (!res.ok) throw new Error(`fetch failed (${res.status})`);
      const data = await res.json();
      setEntries(data.entries || []);
    } catch (err) {
      setError(err.message || String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [source, featureFilter]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await wsFetch('/api/journal', {
        method: 'POST',
        headers: withComposeToken({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          summary: form.summary,
          // Pre-filled from the active filter; without it a filtered refresh
          // would hide the just-written (unscoped) entry.
          ...(form.feature_code.trim() ? { feature_code: form.feature_code.trim() } : {}),
          sections: {
            what_happened: form.what_happened,
            what_we_built: form.what_we_built,
            what_we_learned: form.what_we_learned,
            open_threads: form.open_threads,
          },
        }),
      });
      if (!res.ok) {
        let msg = `journal write failed (${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch { /* keep status message */ }
        throw new Error(msg);
      }
      notify('Journal entry written', 'info');
      setForm(EMPTY_FORM);
      setShowForm(false);
      fetchEntries();
    } catch (err) {
      notify(err.message || String(err), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-border shrink-0">
        {/* Source toggle */}
        <div className="flex rounded overflow-hidden border border-border" role="group" aria-label="Source">
          {['journal', 'changelog'].map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setSource(s)}
              className={cn(
                'text-xs px-2 py-0.5 h-6 capitalize cursor-pointer',
                source === s ? 'bg-muted text-foreground' : 'bg-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Feature filter */}
        <input
          type="text"
          placeholder="Filter by feature code…"
          aria-label="Feature filter"
          value={featureFilter}
          onChange={e => setFeatureFilter(e.target.value)}
          className="text-xs px-2 py-0.5 h-6 rounded bg-muted text-foreground border border-border w-44 font-mono"
        />

        <button
          type="button"
          onClick={fetchEntries}
          title="Refresh"
          className="text-xs px-1.5 py-0.5 h-6 rounded bg-muted text-muted-foreground border border-border hover:text-foreground cursor-pointer"
        >
          <RefreshCw className="h-3 w-3" />
        </button>

        <span className="text-[10px] text-muted-foreground">{entries.length} entries</span>

        {/* New entry — journal only: changelog writes stay agent/pipeline-owned
            (design §COCKPIT-9), and a write here would refresh the changelog
            feed and "lose" the new journal entry from view. */}
        {source === 'journal' && (
        <button
          type="button"
          onClick={() => setShowForm(v => {
            // Opening: seed the entry's feature code from the active filter.
            if (!v) setForm(f => ({ ...f, feature_code: f.feature_code || featureFilter.trim() }));
            return !v;
          })}
          className="ml-auto flex items-center gap-1 text-xs px-2 py-0.5 h-6 rounded bg-muted text-foreground border border-border hover:bg-accent cursor-pointer"
        >
          <Plus className="h-3 w-3" />
          New entry
        </button>
        )}
      </div>

      {/* Inline write form (journal source only) */}
      {showForm && source === 'journal' && (
        <div className="px-3 py-2 border-b border-border shrink-0 space-y-1.5" data-testid="journal-write-form">
          <input
            type="text"
            placeholder="Summary (one line)"
            aria-label="Summary"
            value={form.summary}
            onChange={e => setForm(f => ({ ...f, summary: e.target.value }))}
            className="text-xs px-2 py-1 rounded bg-muted text-foreground border border-border w-full"
          />
          <input
            type="text"
            placeholder="Feature code (optional)"
            aria-label="Feature code"
            value={form.feature_code}
            onChange={e => setForm(f => ({ ...f, feature_code: e.target.value }))}
            className="text-xs px-2 py-1 rounded bg-muted text-foreground border border-border w-full font-mono"
          />
          {SECTION_META.map(([key, label]) => (
            <textarea
              key={key}
              placeholder={label}
              aria-label={label}
              rows={2}
              value={form[key]}
              onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
              className="text-xs px-2 py-1 rounded bg-muted text-foreground border border-border w-full resize-y"
            />
          ))}
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={submitting}
              onClick={handleSubmit}
              className="text-xs px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 cursor-pointer"
            >
              {submitting ? 'Writing…' : 'Write entry'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground border border-border cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Entry list */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="py-8 text-center text-[11px] text-muted-foreground">Loading…</div>
        )}
        {!loading && error && (
          <div className="py-8 text-center text-[11px] text-red-400">{error}</div>
        )}
        {!loading && !error && entries.length === 0 && (
          <EmptyState
            icon={BookOpen}
            title={source === 'journal' ? 'No journal entries' : 'No changelog entries'}
            description={source === 'journal'
              ? 'Journal entries appear as sessions are written up'
              : 'Changelog entries appear as features ship'}
            className="py-8"
          />
        )}
        {!loading && !error && source === 'journal' && entries.map(e => (
          <JournalEntry key={e.path || `${e.date}-${e.slug}`} entry={e} />
        ))}
        {!loading && !error && source === 'changelog' && entries.map((e, i) => (
          <ChangelogEntry key={`${e.line_number ?? i}`} entry={e} />
        ))}
      </div>
    </div>
  );
}

function JournalEntry({ entry }) {
  return (
    <div className="px-3 py-2.5 border-b border-border/50">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-muted-foreground font-mono">{entry.date}</span>
        <span className="text-[10px] text-muted-foreground">Session {entry.session_number}</span>
        {entry.feature_code && (
          <EntityLink kind="feature" id={entry.feature_code} />
        )}
      </div>
      {entry.summary && (
        <div className="text-xs text-foreground mt-0.5 font-medium">{entry.summary}</div>
      )}
      <div className="mt-1.5 space-y-1.5">
        {SECTION_META.map(([key, label]) => (
          entry.sections?.[key] ? (
            <div key={key}>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
              <MarkdownViewer content={entry.sections[key]} className="prose prose-invert prose-sm max-w-none text-xs" />
            </div>
          ) : null
        ))}
      </div>
      {entry.closing_line && (
        <div className="mt-1.5 text-[11px] italic text-muted-foreground">{entry.closing_line}</div>
      )}
    </div>
  );
}

function ChangelogEntry({ entry }) {
  return (
    <div className="px-3 py-2.5 border-b border-border/50">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-muted-foreground font-mono">{entry.date_or_version}</span>
        {entry.code && <EntityLink kind="feature" id={entry.code} />}
      </div>
      {entry.summary && (
        <div className="text-xs text-foreground mt-0.5 font-medium">{entry.summary}</div>
      )}
      {entry.body && (
        <div className="mt-1">
          <MarkdownViewer content={entry.body} className="prose prose-invert prose-sm max-w-none text-xs" />
        </div>
      )}
    </div>
  );
}
