/**
 * useRecallEnabled.js — module-scoped memoized enabled-probe for the Recall
 * tab (COMP-SMARTMEMORY-RECALL S02).
 *
 * The `{enabled}` bit is fetched from GET /api/smartmemory/recall (no
 * featureCode — the probe path) and cached per workspace identity, so a
 * flag-OFF workspace pays at most one lightweight local request per
 * workspace per page load, not one per detail-open. A workspace switch (a
 * different cache key) re-probes.
 */
import { useEffect, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';

const _resolved = new Map(); // key -> boolean
const _inflight = new Map(); // key -> Promise<boolean>

function keyFor(workspaceId) {
  return workspaceId ?? '__none__';
}

function probe(key) {
  let promise = _inflight.get(key);
  if (promise) return promise;
  promise = wsFetch('/api/smartmemory/recall')
    .then((r) => r.json())
    .then((d) => d?.enabled === true)
    .catch(() => false);
  _inflight.set(key, promise);
  promise.then((value) => {
    _resolved.set(key, value);
    _inflight.delete(key);
  });
  return promise;
}

/**
 * @param {string|null} workspaceId
 * @returns {boolean|null} true/false once resolved, null while unknown/in-flight
 */
export default function useRecallEnabled(workspaceId) {
  const key = keyFor(workspaceId);
  const [enabled, setEnabled] = useState(() => (_resolved.has(key) ? _resolved.get(key) : null));

  useEffect(() => {
    let cancelled = false;
    if (_resolved.has(key)) {
      setEnabled(_resolved.get(key));
      return undefined;
    }
    setEnabled(null);
    probe(key).then((value) => {
      if (!cancelled) setEnabled(value);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return enabled;
}

/** Test-only: clears both caches so each test file starts unmemoized. */
export function __resetRecallEnabledCache() {
  _resolved.clear();
  _inflight.clear();
}
