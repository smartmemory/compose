import React, { useState } from 'react';
import { wsFetch } from '../../../lib/wsFetch.js';
import { StateBadge } from './ProcessBadge.jsx';

/**
 * ProcessHeader — title, freshness and poll state as badges with the reason on hover, and the U3 Publish control.
 */

const warn = { color: 'hsl(var(--warning))' };
const PUBLISH_CLI = 'compose process publish';

/** U3: asks GET /api/process/publish (the one call this control makes) for the loopback link, shows it with a copy control and the CLI line. */
function PublishControl() {
  const [state, setState] = useState({ busy: false, url: null, at: null, error: null, copied: false });
  const publish = async () => {
    setState((s) => ({ ...s, busy: true, error: null, copied: false }));
    try {
      const res = await wsFetch('/api/process/publish');
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `publish route ${res.status}`);
      setState({ busy: false, url: body.url, at: body.generatedAt, error: null, copied: false });
    } catch (e) {
      setState({ busy: false, url: null, at: null, error: String(e?.message ?? e), copied: false });
    }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(state.url); setState((s) => ({ ...s, copied: true })); }
    catch { setState((s) => ({ ...s, error: 'copy failed: select the address and copy it by hand' })); }
  };
  const btn = 'rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ring';
  return (
    <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 text-[11px]" data-testid="process-publish">
      {state.url ? (<>
        <code className="max-w-[360px] truncate rounded bg-muted px-1.5 py-0.5 text-[11px] select-all" data-testid="process-publish-url">{state.url}</code>
        <button type="button" className={btn} onClick={copy} data-testid="process-publish-copy">{state.copied ? 'Copied' : 'Copy'}</button>
        <span className="text-muted-foreground" data-testid="process-publish-cli">CLI: <code className="select-all">{PUBLISH_CLI}</code></span>
        <span className="text-muted-foreground">Only this link leaves the Mac, never the figures.</span>
      </>) : null}
      {state.error ? <span style={warn} data-testid="process-publish-error">publish unavailable: {state.error}</span> : null}
      <button type="button" className={btn} disabled={state.busy} onClick={publish} data-testid="process-publish-button">Publish</button>
    </div>
  );
}

export default function ProcessHeader({ data, error, builder, stamps }) {
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
      <h2 className="text-base font-semibold">Process</h2>
      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Read-only</span>
      <span className="text-[11px] text-muted-foreground">How unit work has been flowing, per lane.</span>
      {data?.generated ? <span className="font-mono text-[11px] text-muted-foreground">as of {new Date(data.generated).toLocaleTimeString()}</span> : null}
      {error ? <span className="text-[11px]" style={warn} data-testid="process-poll-error">last poll failed: {error}</span> : null}
      {builder?.stale ? <StateBadge state="stale" label="builder: cached copy" tip="builder source: serving cached copy" /> : null}
      {stamps?.stale ? <StateBadge state="stale" label="stamps: cached copy" tip="stamps source: serving cached copy" /> : null}
      <PublishControl />
    </header>
  );
}
