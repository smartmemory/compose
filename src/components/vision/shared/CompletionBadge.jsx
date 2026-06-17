/**
 * CompletionBadge — read-only recorded-completion view (COMP-PARITY-5).
 *
 * Shows the latest commit-SHA-bound completion (short SHA + tests-pass/failed
 * chip + relative time) next to the status control, and flags divergence vs the
 * vision-state status via computeDivergence. Read-only: never mutates.
 *
 * Self-fetching: mirrors the SessionHistory sub-component (wsFetch +
 * AbortController, keyed on featureCode). A monotonic token guards against a
 * stale in-flight response overwriting a newer one when featureCode changes.
 * Renders null for items with no lifecycle.featureCode (free ideabox items).
 *
 * Props: { featureCode: string|null, status: string|null }
 */
import React, { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils.js';
import { wsFetch } from '../../../lib/wsFetch.js';
import RelativeTime from './RelativeTime.jsx';
import { computeDivergence } from './completionDivergence.js';

export default function CompletionBadge({ featureCode, status }) {
  const [latest, setLatest] = useState(undefined); // undefined=loading, null=none
  const [loading, setLoading] = useState(true);
  const tokenRef = useRef(0);

  useEffect(() => {
    if (!featureCode) {
      setLatest(null);
      setLoading(false);
      return;
    }
    const token = ++tokenRef.current;
    const controller = new AbortController();
    setLoading(true);
    wsFetch(
      `/api/completions?featureCode=${encodeURIComponent(featureCode)}&limit=1`,
      { signal: controller.signal },
    )
      .then((r) => r.json())
      .then((data) => {
        if (token !== tokenRef.current) return; // superseded by a newer fetch
        const c = Array.isArray(data?.completions) ? data.completions[0] : null;
        setLatest(c || null);
      })
      .catch(() => {
        if (token === tokenRef.current) setLatest(null);
      })
      .finally(() => {
        if (token === tokenRef.current) setLoading(false);
      });
    return () => controller.abort();
  }, [featureCode]);

  if (!featureCode || loading) return null;

  const div = computeDivergence(status, latest);

  return (
    <div className="space-y-1" data-testid="completion-badge">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Recorded Completion
      </p>
      {!latest ? (
        <p className="text-[10px] text-muted-foreground/70 italic" data-testid="completion-none">
          No recorded completion.
        </p>
      ) : (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-muted text-foreground"
            data-testid="completion-sha"
          >
            {latest.commit_sha_short || (latest.commit_sha || '').slice(0, 8) || '—'}
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium',
              latest.tests_pass
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-rose-500/15 text-rose-400',
            )}
            data-testid="completion-tests"
          >
            {latest.tests_pass ? 'tests pass' : 'tests failed'}
          </span>
          <RelativeTime date={latest.recorded_at} className="text-[10px]" />
        </div>
      )}
      {div.diverged && (
        <div
          className="flex items-start gap-1.5 px-2 py-1 rounded bg-amber-400/10 border border-amber-400/20"
          data-testid="completion-divergence"
        >
          <span className="text-[10px] text-amber-400 leading-relaxed">⚠ {div.message}</span>
        </div>
      )}
    </div>
  );
}
