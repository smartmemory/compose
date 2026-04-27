/**
 * Vision Server — REST endpoints + WebSocket broadcast for the vision surface.
 * Follows the same attach() pattern as FileWatcherServer.
 */

import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireSensitiveToken } from './security.js';
import { spawnJournalAgent, extractSlugFromPath } from './vision-utils.js';
import { attachFeatureScanRoutes } from './feature-scan.js';
import { attachGraphExportRoutes } from './graph-export.js';
import { StratumSync, attachStratumRoutes } from './stratum-sync.js';
import { createStratumRouter } from './stratum-api.js';
import { attachAgentSpawnRoutes } from './agent-spawn.js';
import { AgentRegistry } from './agent-registry.js';
import { HealthMonitor } from './agent-health.js';
import { WorktreeGC } from './worktree-gc.js';
import { attachVisionRoutes } from './vision-routes.js';
import { deriveDecisionEvents } from './decision-events-snapshot.js';
import { CCSessionWatcher } from './cc-session-watcher.js';
import { emitStatusSnapshot } from './status-emit.js';
import { emitDriftAxes } from './drift-emit.js';
import { SchemaValidator } from './schema-validator.js';
import { attachSessionRoutes } from './session-routes.js';
import { attachActivityRoutes } from './activity-routes.js';
import { SettingsStore } from './settings-store.js';
import { attachSettingsRoutes } from './settings-routes.js';
import { attachDesignRoutes } from './design-routes.js';
import { DesignSessionManager } from './design-session.js';
import { attachPipelineRoutes } from './pipeline-routes.js';
import { attachIdeaboxRoutes } from './ideabox-routes.js';
import { CoalescingBuffer } from './coalescing-buffer.js';
/** Settings defaults (previously derived from contracts/lifecycle.json). */
const SETTINGS_DEFAULTS = {
  phases: [
    { id: 'explore_design', defaultPolicy: null },
    { id: 'prd', defaultPolicy: 'skip' },
    { id: 'architecture', defaultPolicy: 'skip' },
    { id: 'blueprint', defaultPolicy: 'gate' },
    { id: 'verification', defaultPolicy: 'gate' },
    { id: 'plan', defaultPolicy: 'gate' },
    { id: 'execute', defaultPolicy: 'flag' },
    { id: 'report', defaultPolicy: 'skip' },
    { id: 'docs', defaultPolicy: 'flag' },
    { id: 'ship', defaultPolicy: 'gate' },
  ],
  iterationDefaults: {
    review: { maxIterations: 4, timeout: 15, maxTotal: 20 },
    coverage: { maxIterations: 15, timeout: 30, maxTotal: 50 },
  },
  policyModes: ['gate', 'flag', 'skip'],
};

import { getTargetRoot, getDataDir } from './project-root.js';

export class VisionServer {
  constructor(store, sessionManager = null, { config } = {}) {
    this.store = store;
    this.sessionManager = sessionManager;
    this._config = config || { capabilities: { stratum: true } };
    this.clients = new Set();
    this.wss = null;
    this._coalescingBuffer = new CoalescingBuffer((flushed) => {
      if (flushed.visionState) {
        this.broadcastMessage(Object.assign({ type: 'visionState' }, flushed.visionState));
      }
    }, { intervalMs: 16 });
    this._coalescingBuffer.register('visionState', 'latest-wins');
    this._pendingSnapshots = new Map();
    this._stratumSync = null;
  }

  attach(httpServer, app) {
    // ── Settings store ────────────────────────────────────────────────────
    this.settingsStore = new SettingsStore(undefined, SETTINGS_DEFAULTS);

    // ── Settings routes ───────────────────────────────────────────────────
    attachSettingsRoutes(app, {
      settingsStore: this.settingsStore,
      broadcastMessage: (msg) => this.broadcastMessage(msg),
    });

    // ── Vision CRUD + plan/parse routes ────────────────────────────────────
    attachVisionRoutes(app, {
      store: this.store,
      scheduleBroadcast: () => this.scheduleBroadcast(),
      broadcastMessage: (msg) => this.broadcastMessage(msg),
      projectRoot: getTargetRoot(),
      settingsStore: this.settingsStore,
    });

    // ── Activity + error routes ─────────────────────────────────────────────
    attachActivityRoutes(app, {
      store: this.store,
      sessionManager: this.sessionManager,
      scheduleBroadcast: () => this.scheduleBroadcast(),
      broadcastMessage: (msg) => this.broadcastMessage(msg),
      resolveItems: (fp) => this.resolveItems(fp),
    });

    // ── Session routes ──────────────────────────────────────────────────────
    attachSessionRoutes(app, {
      sessionManager: this.sessionManager,
      scheduleBroadcast: () => this.scheduleBroadcast(),
      broadcastMessage: (msg) => this.broadcastMessage(msg),
      spawnJournalAgent,
      projectRoot: getTargetRoot(),
      store: this.store,
    });

    // ── Pipeline authoring routes ──────────────────────────────────────────
    attachPipelineRoutes(app, {
      broadcastMessage: (msg) => this.broadcastMessage(msg),
      scheduleBroadcast: () => this.scheduleBroadcast(),
      getDataDir: () => getDataDir(),
      getPipelinesDir: () => path.join(getTargetRoot(), 'pipelines'),
      stratumClient: null, // V1: no MCP client in server context; fallback YAML parse is acceptable
    });

    // ── Ideabox routes ────────────────────────────────────────────────────────
    attachIdeaboxRoutes(app, {
      getProjectRoot: () => getTargetRoot(),
      getDataDir: () => getDataDir(),
      broadcastMessage: (msg) => this.broadcastMessage(msg),
    });

    // ── Design conversation routes ──────────────────────────────────────────
    // Re-resolve on every call so project switches get fresh instances.
    let _designSessionManager = null;
    let _designDataDir = null;

    attachDesignRoutes(app, {
      getSessionManager: () => {
        const dataDir = getDataDir();
        if (dataDir !== _designDataDir) {
          if (_designSessionManager) _designSessionManager.destroy();
          _designSessionManager = new DesignSessionManager(dataDir);
          _designDataDir = dataDir;
        }
        return _designSessionManager;
      },
      getProjectRoot: () => getTargetRoot(),
    });

    // ── Build state hydration ─────────────────────────────────────────────
    app.get('/api/build/state', (_req, res) => {
      const buildPath = path.join(getDataDir(), 'active-build.json');
      try {
        if (fs.existsSync(buildPath)) {
          const state = JSON.parse(fs.readFileSync(buildPath, 'utf-8'));
          res.json({ state });
        } else {
          res.json({ state: null });
        }
      } catch {
        res.json({ state: null });
      }
    });

    // ── Snapshot route (stays inline: uses this._pendingSnapshots + this.clients) ──
    app.get('/api/snapshot', (req, res) => {
      const requestId = `snap-${Date.now()}`;
      const timeout = parseInt(req.query.timeout) || 3000;

      let target = null;
      for (const client of this.clients) {
        if (client.readyState === 1) { target = client; break; }
      }
      if (!target) {
        return res.status(503).json({ error: 'No connected clients' });
      }

      const timer = setTimeout(() => {
        this._pendingSnapshots.delete(requestId);
        res.status(504).json({ error: 'Snapshot timeout' });
      }, timeout);

      this._pendingSnapshots.set(requestId, { res, timer });

      try {
        target.send(JSON.stringify({ type: 'snapshotRequest', requestId }));
      } catch (err) {
        clearTimeout(timer);
        this._pendingSnapshots.delete(requestId);
        res.status(500).json({ error: err.message });
      }
    });

    // ── Agent spawn routes + lifecycle services ────────────────────────────
    // TODO: Load lifecycle config (silenceKillMs, defaultTimeoutMs, memoryLimitMB,
    // gcIntervalMs, gcMaxAgeMs) from .compose/compose.json and pass to HealthMonitor
    // and WorktreeGC constructors. Defaults work fine for V1.
    const agentRegistry = new AgentRegistry(getDataDir());
    this._healthMonitor = new HealthMonitor({
      broadcastMessage: (msg) => this.broadcastMessage(msg),
    });
    this._worktreeGC = new WorktreeGC({
      projectRoot: getTargetRoot(),
      parDir: path.join(getTargetRoot(), '.compose', 'par'),
    });
    this._worktreeGC.start();
    attachAgentSpawnRoutes(app, {
      projectRoot: getTargetRoot(),
      broadcastMessage: (msg) => this.broadcastMessage(msg),
      requireSensitiveToken,
      registry: agentRegistry,
      sessionManager: this.sessionManager,
      healthMonitor: this._healthMonitor,
      worktreeGC: this._worktreeGC,
    });

    // ── Feature scan routes ────────────────────────────────────────────────
    attachFeatureScanRoutes(app, {
      store: this.store,
      scheduleBroadcast: () => this.scheduleBroadcast(),
    });

    // ── Graph export routes ──────────────────────────────────────────────
    attachGraphExportRoutes(app, { store: this.store });

    // ── Stratum (conditional) ────────────────────────────────────────────
    if (this._config.capabilities?.stratum) {
      app.use('/api/stratum', createStratumRouter());
      this._stratumSync = new StratumSync(this.store, () => this.scheduleBroadcast());
      attachStratumRoutes(app, {
        store: this.store,
        scheduleBroadcast: () => this.scheduleBroadcast(),
        broadcastMessage: (msg) => this.broadcastMessage(msg),
        sync: this._stratumSync,
      });
      this._stratumSync.start();
      console.log('[vision] Stratum sync enabled');
    } else {
      app.use('/api/stratum', (_req, res) => {
        res.status(503).json({ error: 'Stratum not enabled', hint: 'pip install stratum && compose init' });
      });
    }

    // ── COMP-OBS-BRANCH: CC-session watcher (opt-in) ──────────────────────
    // Default OFF. Enable by setting `capabilities.cc_session_watcher: true` in compose.json
    // or by setting the `CC_SESSION_WATCHER=1` env var. When enabled, Forge reads
    // `~/.claude/projects/**/*.jsonl` and emits BranchLineage + DecisionEvents tied to the
    // current feature via sessions.json's transcriptPath basename.
    const ccWatcherEnabled =
      this._config.capabilities?.cc_session_watcher === true ||
      process.env.CC_SESSION_WATCHER === '1';
    if (ccWatcherEnabled) {
      try {
        const projectsRoot = process.env.CC_PROJECTS_ROOT ||
          path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'projects');
        const sessionsFile = this.sessionManager?.sessionsFile || path.join(getDataDir(), 'sessions.json');
        const featureRoot = path.join(getTargetRoot(), 'docs', 'features');

        const findItemIdByFeatureCode = (fc) => {
          for (const it of this.store.items.values()) {
            if (it.lifecycle?.featureCode === fc) return it.id;
          }
          return null;
        };

        const schemaValidator = new SchemaValidator();
        const postBranchLineage = async (itemId, lineage) => {
          // Validate at the producer boundary — the watcher path bypasses the HTTP
          // route, so we must re-check here to guarantee contract conformance.
          const { valid, errors } = schemaValidator.validate('BranchLineage', lineage);
          if (!valid) {
            throw new Error(`Invalid BranchLineage payload: ${JSON.stringify(errors)}`);
          }
          const item = this.store.items.get(itemId);
          const itemFC = item?.lifecycle?.featureCode;
          if (!itemFC || itemFC !== lineage.feature_code) {
            throw new Error(
              `feature_code mismatch: lineage=${lineage.feature_code} item=${itemFC || '<none>'}`
            );
          }
          this.store.updateLifecycleExt(itemId, 'branch_lineage', lineage);
          this.scheduleBroadcast();
          this.broadcastMessage({ type: 'branchLineageUpdate', itemId, ...lineage });
        };

        this._ccWatcher = new CCSessionWatcher({
          projectsRoot,
          sessionsFile,
          featureRoot,
          findItemIdByFeatureCode,
          postBranchLineage,
          broadcastMessage: (msg) => this.broadcastMessage(msg),
          // COMP-OBS-STATUS: inject emitStatusSnapshot for post-lineage status broadcast
          emitStatusSnapshot,
          getState: () => this.store,
          // COMP-OBS-DRIFT: inject emitDriftAxes for post-lineage drift broadcast
          emitDriftAxes,
          projectRoot: getTargetRoot(),
        });

        // Seed emitted_event_ids from any existing lineage so startup doesn't replay.
        for (const it of this.store.items.values()) {
          const l = it.lifecycle?.lifecycle_ext?.branch_lineage;
          if (l?.feature_code && Array.isArray(l.emitted_event_ids)) {
            this._ccWatcher.seedEmittedEventIds(l.feature_code, l.emitted_event_ids);
          }
        }

        this._ccWatcher.fullScan().catch(err => {
          console.warn('[vision] cc-session-watcher initial scan failed:', err.message);
        });
        this._ccWatcher.start();
        console.log(`[vision] cc-session-watcher enabled (projectsRoot=${projectsRoot})`);
      } catch (err) {
        console.warn('[vision] cc-session-watcher failed to start:', err.message);
      }
    }

    // ── Haiku summary broadcast ─────────────────────────────────────────────
    if (this.sessionManager) {
      this.sessionManager.onSummary((summary) => {
        this.broadcastMessage({ type: 'sessionSummary', ...summary, timestamp: new Date().toISOString() });
      });
    }

    // ── WebSocket ───────────────────────────────────────────────────────────
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      console.log(`[vision] Client connected (${this.clients.size} total)`);

      try {
        this.getVisionSnapshot(ws);
        ws.send(JSON.stringify({ type: 'settingsState', settings: this.settingsStore.get() }));
      } catch (err) {
        console.error('[vision] Error sending initial state:', err.message);
      }

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'snapshotResponse' && msg.requestId) {
            const pending = this._pendingSnapshots.get(msg.requestId);
            if (pending) {
              clearTimeout(pending.timer);
              this._pendingSnapshots.delete(msg.requestId);
              pending.res.json(msg.snapshot);
            }
          }
        } catch {
          // ignore malformed messages
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[vision] Client disconnected (${this.clients.size} total)`);
      });

      ws.on('error', (err) => {
        console.error('[vision] WebSocket error:', err.message);
        this.clients.delete(ws);
      });
    });

    console.log('Vision server attached (REST + WebSocket at /ws/vision)');
  }

  /** Schedule a coalesced broadcast via CoalescingBuffer (16ms interval, latest-wins) */
  scheduleBroadcast() {
    this._coalescingBuffer.put('visionState', this.store.getState());
  }

  /** Send a hydrate snapshot to a single newly-connected WebSocket client */
  getVisionSnapshot(ws) {
    try {
      const state = this.store.getState();
      if ('type' in state) {
        throw new Error('store.getState() must not include a `type` field — would collide with hydrate envelope');
      }

      // COMP-OBS-TIMELINE: derive DecisionEvents for the active feature
      // (derive from all features present in state — client filters by featureCode)
      let decisionEventsSnapshot = [];
      try {
        const internalState = this.store;
        // Use internal items Map for deriveDecisionEvents (avoids serialization round-trip)
        const featureCodes = new Set();
        for (const item of (internalState.items?.values?.() || [])) {
          if (item?.lifecycle?.featureCode) featureCodes.add(item.lifecycle.featureCode);
        }
        for (const fc of featureCodes) {
          decisionEventsSnapshot = decisionEventsSnapshot.concat(
            deriveDecisionEvents(internalState, fc)
          );
        }
      } catch (snapshotErr) {
        console.error('[vision] decisionEventsSnapshot derivation error:', snapshotErr.message);
      }

      const snapshot = Object.assign(
        { type: 'hydrate' },
        state,
        {
          sessions: this.sessionManager?.getRecentSessions?.() || [],
          decisionEventsSnapshot,
        }
      );
      ws.send(JSON.stringify(snapshot));
    } catch (err) {
      console.error('[vision] Hydrate error:', err.message);
    }
  }

  /** Broadcast full state to all connected clients */
  broadcastState() {
    this.broadcastMessage({ type: 'visionState', ...this.store.getState(), sessions: this.sessionManager?.getRecentSessions?.() || [] });
  }

  /** Broadcast any message to all connected clients */
  broadcastMessage(msg) {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        try {
          client.send(data);
        } catch (err) {
          console.error('[vision] Broadcast error:', err.message);
        }
      }
    }
  }

  close() {
    this._coalescingBuffer?.stop();
    if (this._stratumSync) this._stratumSync.stop();
    if (this._healthMonitor) this._healthMonitor.destroy();
    if (this._worktreeGC) this._worktreeGC.stop();
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    if (this.wss) this.wss.close();
  }

  /** Resolve a file path to matching tracker items */
  resolveItems(filePath) {
    const rel = filePath.startsWith(getTargetRoot())
      ? filePath.slice(getTargetRoot().length + 1)
      : filePath.replace(/^\.\//, '');
    const matches = [];
    const matchType = new Map();

    for (const item of this.store.items.values()) {
      if (item.files && item.files.length > 0) {
        for (const pattern of item.files) {
          if (pattern.endsWith('/')) {
            if (rel.startsWith(pattern)) { matches.push(item); matchType.set(item.id, 'prefix'); break; }
          } else {
            if (rel === pattern) { matches.push(item); matchType.set(item.id, 'exact'); break; }
          }
        }
      }
      if (rel.startsWith('docs/') && item.slug) {
        const slug = extractSlugFromPath(rel);
        if (slug && slug === item.slug) {
          if (!matches.find(m => m.id === item.id)) {
            matches.push(item);
            matchType.set(item.id, 'slug');
          }
        }
      }
    }

    const specificity = { exact: 0, prefix: 1, slug: 2 };
    matches.sort((a, b) => {
      if (a.status === 'in_progress' && b.status !== 'in_progress') return -1;
      if (b.status === 'in_progress' && a.status !== 'in_progress') return 1;
      const sa = specificity[matchType.get(a.id)] ?? 3;
      const sb = specificity[matchType.get(b.id)] ?? 3;
      if (sa !== sb) return sa - sb;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    return matches;
  }
}
