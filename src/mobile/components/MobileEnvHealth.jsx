import React, { useCallback, useEffect, useRef, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';

/**
 * MobileEnvHealth — read-only environment-health indicator for the mobile PWA.
 *
 * COMP-PARITY-3-2: the mobile-shell counterpart to the desktop
 * EnvironmentHealthPanel (COMP-PARITY-3). Surfaces `compose doctor`
 * (external-dep / binary presence + version drift) and `compose hooks status`
 * (git-hook drift) from GET /api/environment-health as an always-visible dot in
 * the header. Tapping the dot reveals a compact summary (missing-dep count,
 * version-behind, per-hook state).
 *
 * Fetch cadence: once on mount. No background polling. Read-only; degrades
 * gracefully (neutral dot, "Unavailable" detail) and never throws — the
 * endpoint itself never 500s.
 */

const SUMMARY_COLOR = {
  ok: 'var(--m-ok)',
  warn: 'var(--m-warn)',
  error: 'var(--m-danger)',
};
const NEUTRAL = 'var(--m-text-dim)';

const HOOK_COLOR = {
  'installed-current': 'var(--m-ok)',
  absent: 'var(--m-text-dim)',
  foreign: 'var(--m-danger)',
  'installed-stale': 'var(--m-warn)',
  'workspace-unverified': 'var(--m-warn)',
  unavailable: 'var(--m-text-dim)',
};

function Dot({ color }) {
  return (
    <span
      className="m-env-dot"
      aria-hidden="true"
      style={{ background: color }}
    />
  );
}

// Total missing dependencies across the doctor sections (skills + binaries).
// An `unavailable` section contributes nothing to the count (degrade, don't
// fabricate a number).
function missingCount(...sections) {
  return sections.reduce((n, s) => {
    if (!s || s.unavailable) return n;
    return n + ((s.missing || []).length);
  }, 0);
}

export default function MobileEnvHealth() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    try {
      const r = await wsFetch('/api/environment-health');
      const json = await r.json();
      setData(json);
      setError(null);
    } catch (e) {
      setData(null);
      setError(e?.message || 'unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch once on mount. The dot needs data without being tapped.
  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  // Tap-outside / Escape closes the detail sheet.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const summary = data?.summary;
  const dotColor = summary ? (SUMMARY_COLOR[summary] || NEUTRAL) : NEUTRAL;

  const missing = data ? missingCount(data.dependencies, data.binaries) : 0;
  // A skipped/unavailable section means we can't claim "all present" — surface
  // it as unknown (the dot already reflects the server's warn summary).
  const depsUnavailable = !!(data && (data.dependencies?.unavailable || data.binaries?.unavailable));
  const hooks = data?.hooks && !data.hooks.unavailable
    ? Object.entries(data.hooks).filter(([k]) => k !== 'unavailable')
    : [];

  return (
    <div ref={rootRef} className="m-env-health">
      <button
        type="button"
        className="m-env-btn"
        data-testid="mobile-env-health-dot"
        onClick={() => setOpen((v) => !v)}
        title={`Environment health: ${summary || (loading ? 'checking…' : 'unknown')}`}
        aria-label="Environment health"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Dot color={dotColor} />
      </button>

      {open && (
        <div
          className="m-env-detail"
          data-testid="mobile-env-health-detail"
          role="dialog"
          aria-label="Environment health"
        >
          <div className="m-env-detail-head">Environment Health</div>

          {error && (
            <div className="m-env-row m-env-unavailable">Unavailable: {error}</div>
          )}
          {!data && !error && (
            <div className="m-env-row m-env-dim">{loading ? 'Checking…' : 'No data'}</div>
          )}

          {data && (
            <>
              <div className="m-env-row" data-testid="mobile-env-health-deps">
                <Dot color={depsUnavailable ? NEUTRAL : missing > 0 ? 'var(--m-warn)' : 'var(--m-ok)'} />
                <span className={depsUnavailable ? 'm-env-dim' : undefined}>
                  {depsUnavailable
                    ? 'dependencies unavailable'
                    : missing > 0
                      ? `${missing} dependenc${missing === 1 ? 'y' : 'ies'} missing`
                      : 'All dependencies present'}
                </span>
              </div>

              <div className="m-env-row" data-testid="mobile-env-health-version">
                {!data.version ? (
                  <>
                    <Dot color={NEUTRAL} />
                    <span className="m-env-dim">version check unavailable</span>
                  </>
                ) : data.version.behind ? (
                  <>
                    <Dot color="var(--m-warn)" />
                    <span>{data.version.current} → {data.version.latest} (behind)</span>
                  </>
                ) : (
                  <>
                    <Dot color="var(--m-ok)" />
                    <span>{data.version.current} (up to date)</span>
                  </>
                )}
              </div>

              {hooks.map(([type, h]) => (
                <div
                  key={type}
                  className="m-env-row"
                  data-testid={`mobile-env-health-hook-${type}`}
                >
                  <Dot color={HOOK_COLOR[h.state] || NEUTRAL} />
                  <span className="m-env-mono">{type}</span>
                  <span className="m-env-dim">{h.state}</span>
                </div>
              ))}
              {data.hooks?.unavailable && (
                <div className="m-env-row">
                  <Dot color={NEUTRAL} />
                  <span className="m-env-dim">hook status unavailable</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
