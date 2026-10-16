/**
 * feature-events.js — append-only audit log for feature-management mutations.
 *
 * One JSONL row per mutation. Filed by COMP-MCP-FEATURE-MGMT writers; the
 * journal/changelog/completion/checkpoint writers go through recordFeatureEvent
 * (COMPOSE-UX-SIMPLIFY-2)
 * (add_roadmap_entry, set_feature_status, etc.) and read by `roadmap_diff`
 * plus future `validate_feature`.
 *
 * File: <cwd>/.compose/data/feature-events.jsonl
 *
 * Event row shape (additive — extra fields are allowed and preserved by
 * readers, so individual writers can attach context-specific metadata):
 *   {
 *     ts: ISO string,
 *     tool: 'add_roadmap_entry' | 'set_feature_status' | ...,
 *     code?: string,
 *     from?: string,         // status transitions
 *     to?: string,
 *     reason?: string,
 *     actor: string,         // process.env.COMPOSE_ACTOR || 'mcp:agent'
 *     idempotency_key?: string,
 *     ...
 *   }
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { getSmartmemoryConfig } from './smartmemory-config.js';

function eventsFile(cwd) {
  return join(cwd, '.compose', 'data', 'feature-events.jsonl');
}

function actor() {
  return process.env.COMPOSE_ACTOR || 'mcp:agent';
}

/**
 * Append an event to the audit log. Caller supplies tool + payload; ts and
 * actor are stamped here.
 *
 * @param {string} cwd
 * @param {object} event - must include `tool`; other fields are passed through
 * @returns {object} the row that was written (with ts + actor stamped)
 */
export function appendEvent(cwd, event) {
  if (!event || typeof event.tool !== 'string' || !event.tool) {
    throw new Error('feature-events.appendEvent: event.tool is required');
  }

  const path = eventsFile(cwd);
  mkdirSync(dirname(path), { recursive: true });

  const row = {
    ts: new Date().toISOString(),
    actor: actor(),
    // COMP-MCP-MIGRATION-1: stamp build correlation ID when running inside a
    // build runner. Null outside of a build (manual CLI/MCP invocations).
    build_id: process.env.COMPOSE_BUILD_ID || null,
    ...event,
  };
  appendFileSync(path, JSON.stringify(row) + '\n');
  // COMP-SMARTMEMORY-INGEST: fail-open live emit after the durable local append.
  // Flag-gated; emitter is lazy-loaded only when smartmemory.enabled === true.
  try {
    if (getSmartmemoryConfig(cwd).enabled === true) {
      import('./smartmemory-ingest.js')
        .then((m) => m.emitFeatureEvent(cwd, row))
        .catch(() => {});
    }
  } catch { /* fail-open: never let ingest affect the local write */ }
  return row;
}

/**
 * COMPOSE-UX-SIMPLIFY-2 — the one write door for the feature record: journal,
 * changelog, completion and checkpoint writers all record their event here
 * instead of each carrying its own best-effort append. Best-effort by contract:
 * a failed append warns and returns null; it never rolls back the caller's
 * already-committed write.
 *
 * route 'provider' (async): through the tracker provider, so GitHubProvider can
 *   post a <!--compose-event--> comment; LocalFileProvider delegates to
 *   appendEvent byte-identically. Used by changelog and completion.
 * route 'local' (sync): appendEvent directly, so the row lands before the
 *   caller returns. Used by journal (inside its lock) and checkpoint.
 *
 * @param {string} cwd
 * @param {object} event - must include `tool`
 * @param {{route?: 'local'|'provider', source?: string}} [opts] - source names
 *   the writer in the warning line
 */
export function recordFeatureEvent(cwd, event, { route = 'local', source = 'feature-events' } = {}) {
  if (route === 'provider') {
    return (async () => {
      try {
        const { providerFor } = await import('./tracker/factory.js');
        const provider = await providerFor(cwd);
        return await provider.appendEvent(event.code, event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[${source}] audit append failed for ${event?.tool} ${event?.code ?? ''}: ${err.message}`);
        return null;
      }
    })();
  }
  try {
    return appendEvent(cwd, event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[${source}] audit append failed for ${event?.tool}: ${err.message}`);
    return null;
  }
}

/**
 * Read events from the audit log, optionally filtered.
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {string|number|Date} [opts.since] - ISO date, ms since epoch, Date,
 *   or shorthand '24h' / '7d'. Default: read all.
 * @param {string} [opts.code] - filter to events with `code === <value>`
 * @param {string} [opts.tool] - filter to events with `tool === <value>`
 * @returns {Array<object>}
 */
export function readEvents(cwd, opts = {}) {
  const path = eventsFile(cwd);
  if (!existsSync(path)) return [];

  const sinceMs = normalizeSince(opts.since);
  const text = readFileSync(path, 'utf-8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (sinceMs !== null) {
      const ts = Date.parse(row.ts);
      if (Number.isNaN(ts) || ts < sinceMs) continue;
    }
    if (opts.code && row.code !== opts.code) continue;
    if (opts.tool && row.tool !== opts.tool) continue;
    out.push(row);
  }
  return out;
}

/**
 * Normalize a since value to milliseconds-since-epoch, or return null for
 * "no filter".
 */
export function normalizeSince(since) {
  if (since === undefined || since === null) return null;
  if (since instanceof Date) return since.getTime();
  if (typeof since === 'number') return since;
  if (typeof since !== 'string') return null;

  // Shorthand: "24h" | "7d" | "30m"
  const m = since.match(/^(\d+)([hdm])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const mult = m[2] === 'h' ? 3600_000 : m[2] === 'd' ? 86_400_000 : 60_000;
    return Date.now() - n * mult;
  }

  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? null : parsed;
}
