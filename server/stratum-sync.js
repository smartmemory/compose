/**
 * stratum-sync.js — Stratum flow poller + route registration.
 *
 * Polls stratum flow state via stratum-client (not direct file reads) and syncs
 * into the vision store on a self-scheduling, sleep-aware loop.
 *
 * Sleep behavior: each poll cold-starts a `stratum-mcp` subprocess (Python
 * interpreter spin-up — the expensive part, not the query itself). Doing that
 * every few seconds generated enough periodic activity to keep the host from
 * sleeping. Two mitigations:
 *   1. Cadence widened to 60s (override with COMPOSE_STRATUM_POLL_MS).
 *   2. The spawn is skipped entirely when no bound flow can still change state
 *      (`hasLiveFlows`), so an idle/finished Forge does zero periodic spawning
 *      and the host is free to sleep. The cheap in-memory scan that gates this
 *      holds no power assertion.
 * On wake, a tick that fired far later than scheduled is treated as a
 * post-sleep resync rather than business as usual.
 *
 * Routes: POST /api/stratum/bind, POST /api/stratum/audit/:itemId
 * (Flow/gate query routes are now in stratum-api.js)
 */

import { queryFlows } from './stratum-client.js';

// Poll cadence. 60s is plenty for a flow list (slower than any build step) and
// keeps periodic process-spawn activity low enough not to fight host sleep.
const DEFAULT_POLL_MS = 60_000;
const MIN_POLL_MS = 1_000;
const POLL_MS = (() => {
  const raw = parseInt(process.env.COMPOSE_STRATUM_POLL_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= MIN_POLL_MS ? raw : DEFAULT_POLL_MS;
})();
// A tick that fires later than POLL_MS * this factor means the host slept
// through scheduled ticks — log it and treat the next sync as a wake resync.
const WAKE_GAP_FACTOR = 1.5;

/**
 * Sleep-aware poll gate: true only when some bound vision item could still
 * change state (i.e. is bound to a flow and not settled-`complete`). When this
 * is false the poller skips the stratum-mcp spawn so an idle host can sleep.
 *
 * A bound `complete` item is steady-state (status only advances to `complete`
 * via the audit route, never back), so polling it changes nothing. Anything
 * else bound — `in_progress`, `blocked`, or mid-flight — can still transition
 * and is worth a poll.
 *
 * @param {Iterable<{stratumFlowId?: string, status?: string}>} items
 * @returns {boolean}
 */
export function hasLiveFlows(items) {
  for (const item of items) {
    if (item.stratumFlowId && item.status !== 'complete') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// StratumSync class
// ---------------------------------------------------------------------------

export class StratumSync {
  #store;
  #scheduleBroadcast;
  #pollTimer = null;
  #stopped = true;
  #lastTickAt = 0;

  /**
   * @param {object} store — VisionStore instance
   * @param {function} scheduleBroadcast
   */
  constructor(store, scheduleBroadcast) {
    this.#store = store;
    this.#scheduleBroadcast = scheduleBroadcast;
  }

  /** Start the self-scheduling, sleep-aware poll loop (default 60s). */
  start() {
    this.#stopped = false;
    this.#lastTickAt = Date.now();
    this.#scheduleNext();
  }

  /** Stop the poll loop. */
  stop() {
    this.#stopped = true;
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  /** Arm the next tick. No-op once stopped so stop() is final. */
  #scheduleNext() {
    if (this.#stopped) return;
    this.#pollTimer = setTimeout(() => this.#tick(), POLL_MS);
  }

  /**
   * One poll tick. Skips the stratum-mcp spawn when nothing is live (lets the
   * host sleep); on a tick that fired far later than scheduled, notes the
   * sleep gap before resyncing.
   */
  async #tick() {
    if (this.#stopped) return;
    const now = Date.now();
    const gap = now - this.#lastTickAt;
    this.#lastTickAt = now;

    if (hasLiveFlows(this.#store.items.values())) {
      if (gap > POLL_MS * WAKE_GAP_FACTOR) {
        console.log(`[vision] Stratum sync resuming after ${Math.round(gap / 1000)}s gap (host likely slept) — resyncing`);
      }
      try {
        await this.#syncFlows();
      } catch (err) {
        console.error('[vision] Stratum poll error:', err.message);
      }
    }

    this.#scheduleNext();
  }

  /**
   * Fetch flow summaries via stratum-client (stable contract, not direct file reads).
   * Maps stratum's query output to the shape the sync logic expects.
   * @returns {Promise<Array>}
   */
  async readFlows() {
    const raw = await queryFlows();
    if (!Array.isArray(raw)) return [];

    return raw.map(f => {
      // Map stratum canonical status → legacy sync status labels
      const status = f.status === 'running' || f.status === 'awaiting_gate' ? 'running'
        : f.status === 'complete' ? 'complete'
        : f.status === 'killed' ? 'blocked'
        : 'paused';

      // STRAT-PAR-3: completed_steps and active_steps are now string[] in v0.3.
      // Fall back to [] when stratum returns the old integer format (backward compat).
      const completedSet = Array.isArray(f.completed_steps) ? f.completed_steps : [];
      const activeSet    = Array.isArray(f.active_steps)    ? f.active_steps    : [];

      return {
        flowId:         f.flow_id,
        flowName:       f.flow_name,
        status,
        stepsCompleted: completedSet,    // string[] — set of completed step IDs
        stepsActive:    activeSet,       // string[] — set of active (in-progress) step IDs
        stepCount:      f.step_count ?? null,
        steps:          [],
        // currentIdx removed — consumers use stepsCompleted.length
      };
    });
  }

  /** Sync stratum flow states → vision item statuses + violation evidence. */
  async #syncFlows() {
    const flows = await this.readFlows();
    if (flows.length === 0) return;

    const flowMap = new Map(flows.map(f => [f.flowId, f]));
    let changed = false;

    for (const item of this.#store.items.values()) {
      if (!item.stratumFlowId) continue;
      const flow = flowMap.get(item.stratumFlowId);
      if (!flow) continue;

      const targetStatus = flow.status === 'running' ? 'in_progress'
        : flow.status === 'blocked' ? 'blocked'
        : null;

      if (targetStatus && targetStatus !== item.status) {
        try {
          this.#store.updateItem(item.id, { status: targetStatus });
          changed = true;
        } catch { /* ignore */ }
      }

      const existing = item.evidence || {};
      if (flow.status === 'blocked') {
        // Flow was killed via gate reject — record factual evidence, not retry semantics.
        const killNote = `Flow '${flow.flowName}' was killed via gate reject`;
        if (existing.stratumKillNote !== killNote) {
          try {
            // Also clear any stale retry-exhaustion evidence from old sync format.
            const { stratumViolations: _v, violatedAt: _va, ...rest } = existing;
            this.#store.updateItem(item.id, {
              evidence: { ...rest, stratumKillNote: killNote, killedAt: new Date().toISOString() },
            });
            changed = true;
          } catch { /* ignore */ }
        }
      } else if (existing.stratumKillNote || existing.stratumViolations) {
        // Flow is no longer blocked — clear kill evidence.
        try {
          const { stratumKillNote: _k, killedAt: _ka, stratumViolations: _v, violatedAt: _va, ...rest } = existing;
          this.#store.updateItem(item.id, { evidence: rest });
          changed = true;
        } catch { /* ignore */ }
      }
    }

    if (changed) this.#scheduleBroadcast();
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Attach stratum REST routes to an Express app.
 *
 * @param {object} app — Express app
 * @param {{ store: object, scheduleBroadcast: function, broadcastMessage: function, sync: StratumSync }} deps
 */
export function attachStratumRoutes(app, { store, scheduleBroadcast, broadcastMessage, sync }) {
  // POST /api/stratum/bind — link a stratum flow_id to a vision item
  app.post('/api/stratum/bind', (req, res) => {
    const { flowId, itemId } = req.body || {};
    if (!flowId || !itemId) return res.status(400).json({ error: 'flowId and itemId required' });
    try {
      const item = store.updateItem(itemId, { stratumFlowId: flowId });
      scheduleBroadcast();
      res.json({ ok: true, itemId, flowId, item });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  // POST /api/stratum/audit/:itemId — store audit trace in item evidence + emit session log event
  app.post('/api/stratum/audit/:itemId', (req, res) => {
    const { trace } = req.body || {};
    if (!trace) return res.status(400).json({ error: 'trace required' });
    try {
      const item = store.items.get(req.params.itemId);
      if (!item) return res.status(404).json({ error: `Item not found: ${req.params.itemId}` });
      // eslint-disable-next-line no-unused-vars
      const { stratumViolations: _v, violatedAt: _va, ...existingEvidence } = item.evidence || {};
      const evidence = { ...existingEvidence, stratumTrace: trace, tracedAt: new Date().toISOString() };
      const updates = { evidence };
      if (trace.status === 'complete' && item.status !== 'complete') {
        updates.status = 'complete';
      }
      const updatedItem = store.updateItem(req.params.itemId, updates);
      scheduleBroadcast();

      const stepsCompleted = Array.isArray(trace.trace) ? trace.trace.length : 0;
      const totalMs = trace.total_duration_ms || null;
      broadcastMessage({
        type: 'agentActivity',
        tool: 'stratum_audit',
        category: 'delegating',
        detail: `${trace.flow_name || trace.flow_id}: ${stepsCompleted} steps${totalMs != null ? `, ${(totalMs / 1000).toFixed(1)}s` : ''}`,
        error: null,
        items: [{ id: updatedItem.id, title: updatedItem.title, status: updatedItem.status }],
        timestamp: new Date().toISOString(),
      });

      res.json({ ok: true, itemId: req.params.itemId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
