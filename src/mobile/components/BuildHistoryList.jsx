/**
 * BuildHistoryList — list of past build records from useBuildHistory.
 *
 * Props:
 *   builds  — array of build history records
 *   loading — boolean
 *   error   — string | null
 *
 * Each row shows featureCode, StatusPill-style status, relative completedAt.
 * Failed builds show a truncated failureReason.
 * Tap toggles inline expansion with full details:
 *   mode, durationMs (humanized), stepCount, full failureReason, startedAt/completedAt
 *
 * data-testids: "mobile-build-history", rows "mobile-build-history-<idx>"
 *
 * COMP-MOBILE-1 S02
 */

import React, { useState } from 'react';

function formatRelative(ts) {
  if (!ts) return '';
  const t = typeof ts === 'string' ? Date.parse(ts) : Number(ts);
  if (!t || Number.isNaN(t)) return '';
  const ms = Date.now() - t;
  if (ms < 5_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function humanizeDuration(ms) {
  if (!ms || typeof ms !== 'number') return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const TRUNCATE_LEN = 80;

function statusClass(status) {
  if (!status) return '';
  const s = status.toLowerCase();
  if (s === 'complete' || s === 'completed') return 'ok';
  if (s === 'failed' || s === 'error') return 'error';
  if (s === 'aborted' || s === 'killed') return 'warn';
  return '';
}

function HistoryRow({ build, index }) {
  const [expanded, setExpanded] = useState(false);

  const rel = formatRelative(build.completedAt);
  const truncatedReason = build.failureReason
    ? build.failureReason.slice(0, TRUNCATE_LEN) + (build.failureReason.length > TRUNCATE_LEN ? '…' : '')
    : null;
  const cls = statusClass(build.status);

  return (
    <div
      className={`m-build-history-row${expanded ? ' is-expanded' : ''}`}
      data-testid={`mobile-build-history-${index}`}
      data-status={build.status || 'unknown'}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={() => setExpanded(e => !e)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded(v => !v); }}
    >
      <div className="m-build-history-summary">
        <span className="m-build-history-code">{build.featureCode || '(unknown)'}</span>
        <span className={`m-status-pill${cls ? ' m-status-pill--' + cls : ''}`} data-status={build.status}>
          {build.status || 'unknown'}
        </span>
        {rel && <span className="m-build-history-rel">{rel}</span>}
        {!expanded && truncatedReason && (
          <span className="m-build-history-reason-trunc">{truncatedReason}</span>
        )}
      </div>

      {expanded && (
        <div className="m-build-history-detail">
          {build.mode != null && (
            <div className="m-build-history-field">
              <span className="m-build-history-field-label">Mode</span>
              <span className="m-build-history-field-value">{build.mode}</span>
            </div>
          )}
          {build.durationMs != null && (
            <div className="m-build-history-field">
              <span className="m-build-history-field-label">Duration</span>
              <span className="m-build-history-field-value">{humanizeDuration(build.durationMs)}</span>
            </div>
          )}
          {build.stepCount != null && (
            <div className="m-build-history-field">
              <span className="m-build-history-field-label">Steps</span>
              <span className="m-build-history-field-value">{build.stepCount}</span>
            </div>
          )}
          {build.failureReason && (
            <div className="m-build-history-field m-build-history-field--block">
              <span className="m-build-history-field-label">Failure reason</span>
              <span className="m-build-history-field-value m-build-history-failure">{build.failureReason}</span>
            </div>
          )}
          {build.startedAt && (
            <div className="m-build-history-field">
              <span className="m-build-history-field-label">Started</span>
              <span className="m-build-history-field-value">{new Date(build.startedAt).toLocaleString()}</span>
            </div>
          )}
          {build.completedAt && (
            <div className="m-build-history-field">
              <span className="m-build-history-field-label">Completed</span>
              <span className="m-build-history-field-value">{new Date(build.completedAt).toLocaleString()}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function BuildHistoryList({ builds, loading, error }) {
  if (loading) {
    return (
      <div className="m-build-history" data-testid="mobile-build-history">
        <div className="m-empty">Loading history…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-build-history" data-testid="mobile-build-history">
        <div className="m-empty">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="m-build-history" data-testid="mobile-build-history">
      {(!builds || builds.length === 0) ? (
        <div className="m-empty">No past builds.</div>
      ) : (
        builds.map((b, idx) => (
          <HistoryRow key={b.flowId || idx} build={b} index={idx} />
        ))
      )}
    </div>
  );
}
