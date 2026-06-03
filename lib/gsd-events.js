// lib/gsd-events.js
//
// COMP-GSD-7-EVENTLOG: append-only GSD run-event log at
// .compose/gsd/<feature>/events.jsonl — one JSON object per line,
// { ts, kind, ...detail }. GSD otherwise persists only snapshots, so the
// milestone report's timeline (COMP-GSD-7) had to reconstruct order from
// whatever artifacts happened to exist. This log records what happened, in
// order, across resume sessions; the report consumes it (snapshot fallback).
//
// All writes are BEST-EFFORT — an event-log failure must never affect the run.
// The reader tolerates a torn/corrupt final line (crash mid-append) by skipping
// unparseable lines.
//
// Contract: `detail` must NOT contain `ts` or `kind` keys (the event kind would
// be clobbered). For a `paused` event the stuck/budget discriminator is
// `pauseKind`, not `kind`.

import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function gsdDir(cwd, featureCode) {
  return join(cwd, '.compose', 'gsd', featureCode);
}

export function gsdEventsPath(cwd, featureCode) {
  return join(gsdDir(cwd, featureCode), 'events.jsonl');
}

export function appendGsdEvent(cwd, featureCode, kind, detail = {}) {
  try {
    mkdirSync(gsdDir(cwd, featureCode), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...detail }) + '\n';
    appendFileSync(gsdEventsPath(cwd, featureCode), line);
  } catch { /* best-effort — never affect the run */ }
}

export function readGsdEvents(cwd, featureCode) {
  const p = gsdEventsPath(cwd, featureCode);
  if (!existsSync(p)) return [];
  let raw;
  try { raw = readFileSync(p, 'utf-8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; /* skip torn/corrupt line */ }
    // Only event OBJECTS are usable — a parseable scalar/array/null is not an
    // event (and would throw in the report's label mapping). Treat as "no event".
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed);
  }
  return out;
}

// COMP-GSD-7-EVENTLOG: fresh-run truncate. Empties the log so a new run's
// timeline doesn't inherit a prior (abandoned) run's events. Called at the
// planning checkpoint, AFTER preconditions pass (so a failed fresh invocation
// doesn't destroy a prior run's history).
export function clearGsdEvents(cwd, featureCode) {
  const p = gsdEventsPath(cwd, featureCode);
  try { if (existsSync(p)) writeFileSync(p, ''); } catch { /* best-effort */ }
}
