/**
 * useMayaStatus.js — workspace-keyed status probe for the Maya colleague
 * (COMP-FOH FOH-6 S3).
 *
 * Mirrors useRecallEnabled's module-scoped memo (one lightweight probe per
 * workspace per page load) but returns the WHOLE /api/maya/status body and a
 * `refresh` — the panel drives FUNNEL STATES off it, not visibility
 * (RecallTab's hide-when-disabled is the named anti-pattern). The only
 * visibility decision keyed on this is the summon button's `enabled` bit:
 * "not installed" is a different state from "installed but degraded".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { wsFetch } from '../../lib/wsFetch.js';

const _cache = new Map(); // workspaceKey -> last status body

/**
 * @param {string|null} workspaceKey any stable per-project identity (project root)
 * @returns {{status: object|null, refresh: () => Promise<object>}}
 *   `status` is null while the first probe is in flight.
 */
export default function useMayaStatus(workspaceKey) {
  const key = workspaceKey ?? '__none__';
  const [status, setStatus] = useState(() => _cache.get(key) ?? null);
  // Guards a slow probe against a project switch: a response that started
  // under an old key must not clobber the new project's status (Codex r1 P1).
  const keyRef = useRef(key);
  keyRef.current = key;

  const refresh = useCallback(async () => {
    let body;
    try {
      const r = await wsFetch('/api/maya/status');
      body = await r.json();
    } catch {
      // The cockpit's own server didn't answer — treat as not-installed rather
      // than inventing a funnel the relay never reported.
      body = { enabled: false, unreachable: true };
    }
    _cache.set(key, body);
    if (keyRef.current === key) setStatus(body);
    return body;
  }, [key]);

  useEffect(() => {
    let cancelled = false;
    if (_cache.has(key)) {
      setStatus(_cache.get(key));
      return undefined;
    }
    setStatus(null);
    refresh().then((body) => {
      if (cancelled) return undefined;
      return body;
    });
    return () => { cancelled = true; };
  }, [key, refresh]);

  return { status, refresh };
}
