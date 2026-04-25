/**
 * CC-session watcher — COMP-OBS-BRANCH T5.
 *
 * Orchestrator that combines:
 *   - cc-session-reader.js     (T1) — parses one JSONL file
 *   - cc-session-feature-resolver.js (T2) — resolves cc_session_id → feature_code
 *   - decision-event-id.js     (T6) — deterministic DecisionEvent ids
 *
 * Maintains a per-feature × per-session accumulator so a feature with multiple
 * CC sessions never has branches clobbered on POST. On each scan, computes the
 * union BranchLineage per feature, emits DecisionEvents for NEW forks only (via
 * persisted emitted_event_ids), and POSTs the updated lineage.
 *
 * `projectsRoot` is injectable — tests use tmp dirs; production points at
 * `~/.claude/projects`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readCCSession } from './cc-session-reader.js';
import { CCSessionFeatureResolver } from './cc-session-feature-resolver.js';
import { branchDecisionEventId, shouldEmit } from './decision-event-id.js';

const DEFAULT_DEBOUNCE_MS = 100;

function listJsonlFiles(projectsRoot) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(projectsRoot, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    if (!ent.isDirectory()) {
      if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        out.push(path.join(projectsRoot, ent.name));
      }
      continue;
    }
    const subdir = path.join(projectsRoot, ent.name);
    let files;
    try { files = fs.readdirSync(subdir); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.jsonl')) out.push(path.join(subdir, f));
    }
  }
  return out;
}

function uniqById(arr, key) {
  const seen = new Map();
  for (const x of arr) {
    if (!seen.has(x[key])) seen.set(x[key], x);
  }
  return [...seen.values()];
}

export class CCSessionWatcher {
  constructor({
    projectsRoot,
    sessionsFile,
    featureRoot,
    findItemIdByFeatureCode,
    postBranchLineage,
    broadcastMessage = () => {},
    now = () => new Date().toISOString(),
    // COMP-OBS-STATUS: optional deps for post-lineage status broadcast
    emitStatusSnapshot = null,
    getState = null,
    // COMP-OBS-DRIFT: optional deps for post-lineage drift broadcast
    emitDriftAxes = null,
    projectRoot = null,
  }) {
    if (!projectsRoot) throw new Error('projectsRoot required');
    if (!sessionsFile) throw new Error('sessionsFile required');
    if (!featureRoot) throw new Error('featureRoot required');
    if (typeof findItemIdByFeatureCode !== 'function') throw new Error('findItemIdByFeatureCode required');
    if (typeof postBranchLineage !== 'function') throw new Error('postBranchLineage required');

    this.projectsRoot = projectsRoot;
    this.resolver = new CCSessionFeatureResolver({ sessionsFile, featureRoot });
    this.findItemIdByFeatureCode = findItemIdByFeatureCode;
    this.postBranchLineage = postBranchLineage;
    this.broadcastMessage = broadcastMessage;
    this.now = now;
    // COMP-OBS-STATUS: optional snapshot emitter (defaults to no-op if not injected)
    this._emitStatusSnapshot = emitStatusSnapshot;
    this._getState = getState;
    // COMP-OBS-DRIFT: optional drift emitter
    this._emitDriftAxes = emitDriftAxes;
    this._projectRoot = projectRoot;

    // featureCode → (cc_session_id → BranchOutcome[])
    this._accum = new Map();
    // featureCode → Set<emitted_event_id>
    this._emitted = new Map();
    this._watcher = null;
    this._debounce = new Map();
  }

  _accumFor(fc) {
    if (!this._accum.has(fc)) this._accum.set(fc, new Map());
    return this._accum.get(fc);
  }
  _emittedFor(fc) {
    if (!this._emitted.has(fc)) this._emitted.set(fc, new Set());
    return this._emitted.get(fc);
  }

  /** Seed emitted_event_ids from persisted lineage (e.g. from prior lineage.emitted_event_ids on server). */
  seedEmittedEventIds(featureCode, ids) {
    const s = this._emittedFor(featureCode);
    for (const id of ids || []) s.add(id);
  }

  async _scanOne(jsonlPath) {
    const cc_session_id = path.basename(jsonlPath).replace(/\.jsonl$/, '');
    const fc = this.resolver.resolve(cc_session_id);
    if (!fc) return null;

    let result;
    try { result = await readCCSession(jsonlPath); }
    catch (err) {
      console.warn(`[cc-watcher] read failed for ${jsonlPath}: ${err.message}`);
      return null;
    }

    const featureScope = `docs/features/${fc}/`;
    const enriched = result.branches.map(b => {
      // Reader-side `final_artifact` is chosen before `feature_code` is known, so
      // a branch that touched multiple feature folders may have picked another
      // feature's artifact. Re-filter against the resolved feature_code — if the
      // picked path isn't scoped to this feature, drop the artifact pointer. Lazy
      // re-selection from the branch path isn't possible here (the reader drops
      // intermediate state), so the safe behavior is to return null rather than
      // point at the wrong feature.
      let fa = b.final_artifact;
      if (fa && fa.path && !fa.path.includes(featureScope)) fa = null;
      return { ...b, feature_code: fc, final_artifact: fa };
    });
    this._accumFor(fc).set(cc_session_id, enriched);
    return { featureCode: fc, cc_session_id, result };
  }

  _aggregate(featureCode) {
    const sessionMap = this._accumFor(featureCode);
    const all = [];
    for (const branches of sessionMap.values()) all.push(...branches);
    const branches = uniqById(all, 'branch_id');
    const in_progress_siblings = branches.filter(b => b.state === 'running').map(b => b.branch_id);
    return {
      feature_code: featureCode,
      branches,
      in_progress_siblings,
      emitted_event_ids: [...this._emittedFor(featureCode)],
      last_scan_at: this.now(),
    };
  }

  /** Build the DecisionEvent payload for a fork — pure, no side effects. */
  _buildForkEvent(featureCode, fork) {
    const eventId = branchDecisionEventId(featureCode, fork.branch_id);
    return {
      eventId,
      message: {
        type: 'decisionEvent',
        event: {
          id: eventId,
          feature_code: featureCode,
          timestamp: this.now(),
          kind: 'branch',
          title: `New branch ${fork.branch_id.slice(0, 8)}…`,
          metadata: {
            branch_id: fork.branch_id,
            fork_uuid: fork.fork_uuid || null,
            sibling_branch_ids: fork.sibling_branch_ids || [],
          },
        },
      },
    };
  }

  async _flush(featureCodes) {
    for (const fc of featureCodes) {
      const itemId = this.findItemIdByFeatureCode(fc);
      if (!itemId) continue;

      const lineage = this._aggregate(fc);

      const byFork = new Map();
      for (const b of lineage.branches) {
        if (!b.fork_uuid) continue;
        if (!byFork.has(b.fork_uuid)) byFork.set(b.fork_uuid, []);
        byFork.get(b.fork_uuid).push(b.branch_id);
      }
      const forks = [];
      for (const b of lineage.branches) {
        if (!b.fork_uuid) continue;
        forks.push({
          branch_id: b.branch_id,
          fork_uuid: b.fork_uuid,
          sibling_branch_ids: byFork.get(b.fork_uuid) || [],
        });
      }

      // Build DecisionEvents for NEW forks only (not yet in emitted set).
      // Do NOT broadcast yet — we persist the updated emitted_event_ids to the
      // lineage POST first, so a failure doesn't leak an unpersisted event id.
      const emitted = this._emittedFor(fc);
      const newEvents = [];
      for (const fork of forks) {
        const { eventId, message } = this._buildForkEvent(fc, fork);
        if (!shouldEmit(eventId, emitted)) continue;
        newEvents.push({ eventId, message });
      }

      // Stage the new event ids in the lineage payload; keep a rollback list.
      const stagedIds = newEvents.map(e => e.eventId);
      lineage.emitted_event_ids = [
        ...emitted,
        ...stagedIds,
      ];

      try {
        await this.postBranchLineage(itemId, lineage);
      } catch (err) {
        console.warn(`[cc-watcher] POST lineage failed for ${fc} (${itemId}): ${err.message}`);
        // Persistence failed → do NOT broadcast. emitted set is NOT updated,
        // so a later successful POST will replay and persist these events.
        continue;
      }

      // POST succeeded → commit event ids to the in-memory dedupe set, then broadcast.
      for (const { eventId, message } of newEvents) {
        emitted.add(eventId);
        this.broadcastMessage(message);
      }

      // COMP-OBS-DRIFT: emit drift axes before STATUS so STATUS reads fresh drift_axes
      if (this._emitDriftAxes && this._getState && this._projectRoot) {
        try {
          const state = this._getState();
          const itemId = this.findItemIdByFeatureCode(fc);
          const it = itemId && state.items?.get ? state.items.get(itemId) : null;
          if (it) this._emitDriftAxes(this.broadcastMessage, state, it, this._projectRoot, this.now());
        } catch (err) {
          console.warn(`[cc-watcher] emitDriftAxes failed for ${fc}: ${err.message}`);
        }
      }
      // COMP-OBS-STATUS: emit status snapshot after branch lineage update
      if (this._emitStatusSnapshot && this._getState) {
        try {
          this._emitStatusSnapshot(this.broadcastMessage, this._getState(), fc, this.now());
        } catch (err) {
          console.warn(`[cc-watcher] emitStatusSnapshot failed for ${fc}: ${err.message}`);
        }
      }
    }
  }

  async fullScan() {
    const files = listJsonlFiles(this.projectsRoot);
    const touched = new Set();
    for (const f of files) {
      const scanned = await this._scanOne(f);
      if (scanned) touched.add(scanned.featureCode);
    }
    await this._flush(touched);
    return { files_scanned: files.length, features_touched: [...touched] };
  }

  async _onFileChange(jsonlPath) {
    const scanned = await this._scanOne(jsonlPath);
    if (scanned) await this._flush([scanned.featureCode]);
  }

  start() {
    if (this._watcher) return;
    if (!fs.existsSync(this.projectsRoot)) {
      fs.mkdirSync(this.projectsRoot, { recursive: true });
    }
    try {
      this._watcher = fs.watch(this.projectsRoot, { recursive: true }, (_evt, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;
        const full = path.join(this.projectsRoot, filename);
        const last = this._debounce.get(full) || 0;
        const now = Date.now();
        if (now - last < DEFAULT_DEBOUNCE_MS) return;
        this._debounce.set(full, now);
        this._onFileChange(full).catch(err => {
          console.warn(`[cc-watcher] change handler failed: ${err.message}`);
        });
      });
    } catch (err) {
      console.warn(`[cc-watcher] fs.watch unavailable, falling back to polling: ${err.message}`);
      this._startPolling();
    }
  }

  _startPolling(intervalMs = 2000) {
    this._pollTimer = setInterval(async () => {
      const files = listJsonlFiles(this.projectsRoot);
      for (const f of files) {
        const stat = fs.statSync(f, { throwIfNoEntry: false });
        if (!stat) continue;
        const key = f;
        const last = this._debounce.get(key) || 0;
        if (stat.mtimeMs > last) {
          this._debounce.set(key, stat.mtimeMs);
          await this._onFileChange(f);
        }
      }
    }, intervalMs);
  }

  stop() {
    if (this._watcher) { try { this._watcher.close(); } catch {} this._watcher = null; }
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }
}
