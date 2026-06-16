/**
 * EnvironmentHealthPanel — header health-dot + popover (COMP-PARITY-3).
 *
 * Surfaces `compose doctor` (external-dep presence + version drift) and
 * `compose hooks status` (git-hook drift) from GET /api/environment-health.
 * The always-visible dot is the passive signal that kills "silent drift with
 * zero UI signal"; the popover holds the detail.
 *
 * Fetch cadence: on workspace resolve, on resolved-workspace change (in-app
 * project switch — keyed on {id, root}, not id alone since two roots can share
 * a basename-derived id), and on manual ↻ refresh (forces a fresh version
 * check). No background polling. Read-only; degrades, never throws.
 *
 * Remediation (COMP-PARITY-3-1): the ONLY action executed server-side is the
 * local, idempotent git-hook repair (POST /api/environment-health/repair-hooks).
 * Dependency installs and `compose update` are surfaced as copyable command
 * TEXT only — never executed from the panel. A foreign-hook repair needs
 * `force:true`, gated behind a window.confirm before the POST.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext.jsx';
import { wsFetch } from '../../lib/wsFetch.js';

const SUMMARY_COLOR = {
  ok: 'hsl(var(--success))',
  warn: 'hsl(var(--warning))',
  error: 'hsl(var(--destructive))',
};
const NEUTRAL = 'hsl(var(--muted-foreground))';

const HOOK_COLOR = {
  'installed-current': 'hsl(var(--success))',
  absent: 'hsl(var(--muted-foreground))',
  foreign: 'hsl(var(--destructive))',
  'installed-stale': 'hsl(var(--warning))',
  'workspace-unverified': 'hsl(var(--warning))',
  unavailable: 'hsl(var(--muted-foreground))',
};

function Dot({ color }) {
  return (
    <span
      style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }}
    />
  );
}

function Section({ title, children }) {
  return (
    <div className="mt-2 first:mt-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{title}</div>
      {children}
    </div>
  );
}

function depColor(dep) {
  return dep.optional ? 'hsl(var(--warning))' : 'hsl(var(--destructive))';
}

/** Best-effort clipboard write; degrades silently (panel must never throw). */
async function copyText(text) {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy-to-clipboard button for a command string. We never execute the command;
 * dependency installs and `compose update` are user-run, this just copies the
 * text. Shows a transient "copied" tick. `testid` is the stable data-testid.
 */
function CopyButton({ command, testid, label = 'copy' }) {
  const [copied, setCopied] = useState(false);
  if (!command) return null;
  return (
    <button
      data-testid={testid}
      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors shrink-0"
      title={`Copy: ${command}`}
      aria-label={`Copy command: ${command}`}
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await copyText(command);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }
      }}
    >
      {copied ? '✓ copied' : label}
    </button>
  );
}

export default function EnvironmentHealthPanel() {
  const { loading: wsLoading, workspace } = useWorkspace() || {};
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState(null);
  const rootRef = useRef(null);
  const reqIdRef = useRef(0);

  const fetchHealth = useCallback(async (force = false) => {
    // Monotonic request token: ignore any response that is not the latest
    // in-flight request, so a slow older fetch (e.g. a workspace switch or a
    // manual refresh overlapping an in-flight load) can't overwrite newer
    // state with stale / wrong-workspace data.
    const myId = ++reqIdRef.current;
    setLoading(true);
    try {
      const r = await wsFetch(`/api/environment-health${force ? '?refresh=1' : ''}`);
      const json = await r.json();
      if (myId !== reqIdRef.current) return;
      setData(json);
      setError(null);
    } catch (e) {
      if (myId !== reqIdRef.current) return;
      setData(null);
      setError(e?.message || 'unavailable');
    } finally {
      if (myId === reqIdRef.current) setLoading(false);
    }
  }, []);

  // Guarded local remediation: POST the hook-repair endpoint, then refetch so
  // the panel reflects the new on-disk hook state. `force` is required to
  // overwrite a foreign hook; the caller gates that behind a window.confirm.
  const repairHooks = useCallback(async (force) => {
    setRepairing(true);
    setRepairError(null);
    try {
      const r = await wsFetch('/api/environment-health/repair-hooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: !!force }),
      });
      const json = await r.json().catch(() => null);
      // wsFetch does NOT throw on HTTP 401/503 (guarded route) — treat the POST
      // as successful ONLY on an explicit { ok: true }. An auth/error body like
      // { error: 'Unauthorized' } has no `ok` field and must surface as failure.
      if (!r.ok || json?.ok !== true) {
        setRepairError(json?.error || `repair failed (${r.status})`);
      }
    } catch (e) {
      setRepairError(e?.message || 'repair failed');
    } finally {
      setRepairing(false);
      // Always refetch — even on failure the on-disk state may have changed.
      fetchHealth(false);
    }
  }, [fetchHealth]);

  // Fetch once the workspace has resolved, and re-fetch whenever its identity
  // changes. Not gated on `open` — the dot needs data without being clicked.
  useEffect(() => {
    if (wsLoading || !workspace) return;
    fetchHealth(false);
  }, [wsLoading, workspace?.id, workspace?.root, fetchHealth]);

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
  const dotColor = summary ? SUMMARY_COLOR[summary] : NEUTRAL;

  return (
    <div ref={rootRef} className="relative flex items-center shrink-0">
      <button
        data-testid="env-health-dot"
        className="compose-btn-icon"
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
          data-testid="env-health-panel"
          role="dialog"
          aria-label="Environment health"
          className="absolute top-full right-0 mt-1 z-50 p-2 rounded-md shadow-lg text-xs"
          style={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', minWidth: 280, maxWidth: 360 }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Environment Health
            </span>
            <button
              data-testid="env-health-refresh"
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              onClick={() => fetchHealth(true)}
              disabled={loading}
              title="Refresh"
              aria-label="Refresh environment health"
            >
              {'↻'}
            </button>
          </div>

          {error && <div className="mt-1 text-destructive">Unavailable: {error}</div>}
          {!data && !error && (
            <div className="mt-1 text-muted-foreground">{loading ? 'Checking…' : 'No data'}</div>
          )}

          {data && (
            <>
              <Section title="Dependencies">
                {renderDeps(data.dependencies, 'dependency')}
                {renderDeps(data.binaries, 'binary')}
              </Section>

              <Section title="Version">
                <div data-testid="env-health-version" className="flex items-center gap-1.5">
                  {!data.version ? (
                    <>
                      <Dot color={NEUTRAL} />
                      <span className="text-muted-foreground">version check unavailable</span>
                    </>
                  ) : data.version.behind ? (
                    <>
                      <Dot color="hsl(var(--warning))" />
                      <span className="flex-1">
                        {data.version.current} → {data.version.latest} (behind — run <code>compose update</code>)
                      </span>
                      <CopyButton command="compose update" testid="env-health-copy-version" />
                    </>
                  ) : (
                    <>
                      <Dot color="hsl(var(--success))" />
                      <span>{data.version.current} (up to date)</span>
                    </>
                  )}
                </div>
              </Section>

              <Section title="Git Hooks">
                {Object.entries(data.hooks || {})
                  .filter(([k]) => k !== 'unavailable')
                  .map(([type, h]) => (
                    <div
                      key={type}
                      data-testid={`env-health-hook-${type}`}
                      className="flex items-center gap-1.5"
                    >
                      <Dot color={HOOK_COLOR[h.state] || NEUTRAL} />
                      <span className="font-mono">{type}</span>
                      <span className="text-muted-foreground">
                        {h.state}
                        {h.reason ? ` (${h.reason})` : ''}
                      </span>
                    </div>
                  ))}
                {data.hooks?.unavailable && (
                  <div className="flex items-center gap-1.5">
                    <Dot color={NEUTRAL} />
                    <span className="text-muted-foreground">hook status unavailable</span>
                  </div>
                )}
                {(() => {
                  const entries = Object.entries(data.hooks || {}).filter(([k]) => k !== 'unavailable');
                  const repairable = ['installed-stale', 'absent', 'foreign'];
                  const needsRepair = entries.some(([, h]) => repairable.includes(h?.state));
                  const hasForeign = entries.some(([, h]) => h?.state === 'foreign');
                  if (!needsRepair) return null;
                  return (
                    <div className="mt-1 flex items-center gap-2">
                      <button
                        data-testid="env-health-repair-hooks"
                        className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent/30 transition-colors disabled:opacity-50"
                        disabled={repairing}
                        onClick={() => {
                          // force is needed ONLY to overwrite a foreign hook;
                          // gate that destructive case behind a confirm.
                          if (hasForeign) {
                            if (!window.confirm(
                              'A foreign git hook exists. Overwrite it with the Compose hook?'
                            )) return;
                            repairHooks(true);
                          } else {
                            repairHooks(false);
                          }
                        }}
                        title="Install / refresh Compose git hooks for this workspace"
                      >
                        {repairing ? 'Repairing…' : 'Repair hooks'}
                      </button>
                      {repairError && (
                        <span className="text-destructive text-[10px]">{repairError}</span>
                      )}
                    </div>
                  );
                })()}
              </Section>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function renderDeps(section, kind) {
  if (!section || section.unavailable) {
    return (
      <div className="flex items-center gap-1.5">
        <Dot color="hsl(var(--warning))" />
        <span className="text-muted-foreground">{kind === 'binary' ? 'binaries' : 'skills'} unavailable</span>
      </div>
    );
  }
  const missing = section.missing || [];
  const presentCount = (section.present || []).length;
  return (
    <>
      {missing.map((d) => (
        <div key={d.id} data-testid={`env-health-${kind}-${d.id}`} className="flex items-center gap-1.5">
          <Dot color={depColor(d)} />
          <span className="font-mono truncate">{d.id}</span>
          <span className="text-muted-foreground flex-1">missing{d.optional ? ' (optional)' : ''}</span>
          <CopyButton command={d.install} testid={`env-health-copy-${d.id}`} label="copy install" />
        </div>
      ))}
      {missing.length === 0 && (
        <div className="flex items-center gap-1.5">
          <Dot color="hsl(var(--success))" />
          <span className="text-muted-foreground">
            {presentCount} {kind === 'binary' ? 'binaries' : 'skills'} present
          </span>
        </div>
      )}
    </>
  );
}
