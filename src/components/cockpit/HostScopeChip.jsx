import { useEffect, useMemo, useState } from 'react';
import { roomScope, roomSelection, scopeLabel, withoutSelection } from './subappHost.js';

/**
 * COMP-SUBAPP-HOST-1: a room's view of the host. `scope` is the selection field the room filters by (null: nothing to
 * filter); the chip's × clears it for this room only (the selection itself, and the other rooms, keep it), and a new
 * selection shows the filter again. `host` is what the room's provider gets: the host, or the host with nothing selected.
 */
export function useHostScope(host, room) {
  const selection = useMemo(() => roomSelection(host?.selection, room), [host?.selection, room]);
  const scope = roomScope(selection, room);
  const key = scope ? `${scope.key}:${scope.value}` : null;
  const [clearedKey, setClearedKey] = useState(null);
  // A changed selection shows its filter again, so a re-selected feature is not still cleared.
  useEffect(() => { setClearedKey((k) => (k === key ? k : null)); }, [key]);
  const cleared = key !== null && clearedKey === key;
  const scoped = useMemo(() => {
    if (!host) return host;
    return cleared ? withoutSelection(host) : { ...host, selection };
  }, [host, selection, cleared]);
  return {
    scope,
    cleared,
    host: scoped,
    chip: <HostScopeChip scope={scope} cleared={cleared} onClear={() => setClearedKey(key)} onRestore={() => setClearedKey(null)} />,
  };
}

/** `filtered to <feature> ×`, or after a clear a one-click way back (`show <feature> only`); nothing with no scope. */
export function HostScopeChip({ scope, cleared, onClear, onRestore }) {
  if (!scope) return null;
  if (cleared) {
    return (
      <button type="button" data-testid="host-scope-restore" onClick={onRestore}
        className="h-6 rounded-full border border-border px-2 text-xs text-muted-foreground hover:text-foreground">
        show {scope.value} only
      </button>
    );
  }
  return (
    <span data-testid="host-scope-chip" className="inline-flex h-6 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 pl-2 pr-1 text-xs font-mono">
      {scopeLabel(scope)}
      <button type="button" aria-label="Clear the filter" title="Show everything" onClick={onClear}
        className="rounded-full px-1 leading-none text-muted-foreground hover:text-foreground">×</button>
    </span>
  );
}
