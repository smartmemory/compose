/** A workspace owns its stores, routes and background services for its lifetime.
 * Requests and async work keep their binding even when the UI switches projects.
 */
import express from 'express';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { hasPersistedWork } from './workspace-activity.js';
import { hasDesignWork, closeDesignStratum } from './design-routes.js';
import { FileWatcherServer } from './file-watcher.js';
import { VisionStore } from './vision-store.js';
import { VisionServer } from './vision-server.js';
import { SessionManager } from './session-manager.js';
import { attachGraphLayoutRoutes } from './graph-layout-routes.js';
import { attachAgentProxy } from './remote-utils.js';
import { scanFeatures, seedFeatures, scanSubPackages, seedSubPackages } from './feature-scan.js';
import { prepareProject, withProjectContext, resolveProjectPath, switchProject } from './project-root.js';
import { deriveId } from '../lib/discover-workspaces.js';
import { probeStratumBin, resolveStratumBin } from '../lib/stratum-engine.js';

export class WorkspaceRuntime {
  constructor(httpServer, { agentPort = 4002, maxWorkspaces = 8 } = {}) {
    this.server = httpServer;
    this.agentPort = agentPort;
    if (!Number.isInteger(maxWorkspaces) || maxWorkspaces < 1) throw new Error("maxWorkspaces must be a positive integer");
    this.maxWorkspaces = maxWorkspaces;
    this.contexts = new Map();
    this.active = null;
    // Monotonic stamp for LRU ordering; Date.now() ties within a millisecond.
    this._tick = 0;
  }

  /** Record a workspace as most-recently-used. */
  touch(context) { if (context) context.usedAt = ++this._tick; return context; }

  /**
   * Whether a retained workspace still has work that eviction would destroy.
   * The active workspace is never evictable. Everything else is judged on
   * signals the runtime can see: live vision/file sockets, an open session, a
   * running build (`active-build.json`) and running spawned agents
   * (`agents.json`). `isBusy` lets the host add its own signal.
   */
  busy(context) {
    if (context === this.active) return true;
    if (context.visionServer?.clients?.size) return true;
    if (context.fileWatcher?.clients?.size) return true;
    if (context.sessionManager?.currentSession) return true;
    if (context.requests || context.binding.activeWork) return true;
    if (context.visionServer?._healthMonitor?.hasActiveProcesses) return true;
    if (hasDesignWork(context.binding.targetRoot)) return true;
    if (hasPersistedWork(context.binding.dataDir)) return true;
    return Boolean(this.isBusy?.(context));
  }

  /**
   * Close the least-recently-used idle workspace to make room for another.
   * Retention is an LRU cache, not a hard wall: refusing at the cap stranded
   * users behind "restart to release retained sessions" while every retained
   * workspace sat idle. The cap still refuses when nothing is evictable.
   * @returns {boolean} whether a workspace was evicted
   */
  evictIdle() {
    let victimKey = null; let victim = null;
    for (const [key, context] of this.contexts) {
      if (this.busy(context)) continue;
      if (!victim || (context.usedAt ?? 0) < (victim.usedAt ?? 0)) { victimKey = key; victim = context; }
    }
    if (!victim) return false;
    victim.fileWatcher.close();
    victim.visionServer.close();
    void closeDesignStratum(victim.binding.targetRoot);
    this.contexts.delete(victimKey);
    console.error(`[workspace] Evicted idle workspace ${victim.binding.targetRoot} (cap ${this.maxWorkspaces})`);
    return true;
  }

  /**
   * Context-map key. The agent server (`createAgentApp`) realpaths its target
   * root, so keying on `path.resolve` alone made `/var/...` and
   * `/private/var/...` two entries for ONE directory — the two capacity counts
   * then disagreed. Both sides now key on the real path.
   */
  key(root) {
    const resolved = path.resolve(root);
    try { return realpathSync(resolved); } catch { return resolved; }
  }

  /** The retained context for a root, keyed on its real path. */
  get(root) { return this.contexts.get(this.key(root)); }

  prepare(root, config) {
    const existing = this.get(root);
    // Validate the destination before evicting any retained state.
    const binding = prepareProject(root);
    if (!existing && this.contexts.size >= this.maxWorkspaces && !this.evictIdle()) {
      throw Object.assign(new Error(`Workspace capacity reached (${this.maxWorkspaces}); every retained workspace is busy (open sockets, a live session, a running build or agent)`), { code: 'WorkspaceCapacityExceeded' });
    }
    if (config) binding.config = config;
    else if (binding.config.capabilities?.stratum) {
      const probe = probeStratumBin(resolveStratumBin('cli', binding.targetRoot));
      if (!probe.ok) binding.config.capabilities.stratum = false;
    }
    if (existing) {
      withProjectContext(existing.binding, () => existing.visionServer.refreshConfig(binding.config));
      // One holder, two references: the binding and the vision server must not
      // drift apart, or a request resolved through the binding reads a config
      // the routes no longer use.
      existing.binding.config = existing.visionServer.config;
      return this.touch(existing);
    }
    return withProjectContext(binding, () => {
      const router = express.Router();
      const fileWatcher = new FileWatcherServer({ projectRoot: binding.targetRoot });
      const store = new VisionStore(binding.dataDir);
      const sessionManager = new SessionManager({
        projectRoot: binding.targetRoot,
        sessionsFile: path.join(binding.dataDir, 'sessions.json'),
        featureRoot: resolveProjectPath('features'),
        getFeaturePhase: (code) => store.getItemByFeatureCode(code)?.lifecycle?.currentPhase || null,
      });
      const visionServer = new VisionServer(store, sessionManager, { config: binding.config });
      const context = { binding, router, fileWatcher, store, sessionManager, visionServer };
      try {
        attachGraphLayoutRoutes(router);
        attachAgentProxy(router, { agentPort: this.agentPort });
        fileWatcher.attach(this.server, router);
        visionServer.attach(this.server, router);
        const reseed = () => {
          seedFeatures(scanFeatures(), store);
          seedSubPackages(scanSubPackages(), store);
        };
        reseed();
        fileWatcher.onFeatureChanged = () => {
          try { reseed(); visionServer.scheduleBroadcast(); }
          catch (err) { console.error('[compose] Feature reseed error:', err.message); }
        };
        fileWatcher.onBuildStateChanged = (state) => {
          if (state) visionServer.broadcastMessage({ type: 'buildState', ...state });
        };
        fileWatcher.onSpecChanged = fileWatcher.onIdeaboxChanged = (msg) => visionServer.broadcastMessage(msg);
        return context;
      } catch (err) {
        fileWatcher.close();
        visionServer.close();
        throw err;
      }
    });
  }

  switch(root, config) {
    // Preparation may fail. Never mutate the current root/services until it succeeds.
    const next = this.prepare(root, config);
    if (next === this.active) {
      // C8: switching to the workspace already active is a config refresh, not
      // a workspace change. suspend() closes every vision WebSocket with 1000,
      // so the old suspend/resume pair dropped the whole cockpit on a no-op
      // switch. prepare() has already refreshed the config in place; restart
      // only the OS watchers (paths may have moved) and re-arm the background
      // services that a config refresh stopped. Neither closes a socket.
      withProjectContext(next.binding, () => {
        next.fileWatcher.stopWatching(); next.fileWatcher.startWatching();
        next.visionServer.resume(); switchProject(next.binding.targetRoot);
      });
      return next;
    }
    const retained = this.get(next.binding.targetRoot) !== undefined;
    try {
      if (retained) withProjectContext(next.binding, () => {
        next.fileWatcher.startWatching();
        next.visionServer.resume();
      });
      switchProject(next.binding.targetRoot);
    } catch (err) {
      if (retained) {
        next.fileWatcher.stopWatching(); next.visionServer.suspend();
      } else {
        next.fileWatcher.close(); next.visionServer.close();
      }
      throw err;
    }
    if (this.active) {
      this.active.fileWatcher.stopWatching();
      for (const client of this.active.fileWatcher.clients) client.close(1000, 'Workspace changed');
      this.active.fileWatcher.clients.clear();
      this.active.visionServer.suspend();
    }
    this.contexts.set(this.key(next.binding.targetRoot), next);
    this.active = this.touch(next);
    return next;
  }

  resolveKnownWorkspace(id) {
    const matches = [...this.contexts.values()].filter(c => deriveId({ root: c.binding.targetRoot }).id === id);
    if (matches.length > 1) {
      const err = new Error(`Workspace id collision: ${id}`);
      Object.assign(err, { code: 'WorkspaceIdCollision', id, roots: matches.map(c => c.binding.targetRoot) });
      throw err;
    }
    return matches.length ? { id, root: matches[0].binding.targetRoot, source: 'explicit-header' } : null;
  }

  handle(req, res, next) {
    let context = req.workspace?.root ? this.get(req.workspace.root) : this.active;
    // C6: ONLY workspace preparation is translated into a workspace error. A
    // route that throws is a route bug, not an unavailable workspace, and
    // reporting it as `400 {error: <internal text>}` both mislabels it and
    // leaks internals past the error handler.
    try {
      if (!context && req.workspace?.root) {
        context = this.prepare(req.workspace.root);
        context.fileWatcher.stopWatching(); context.visionServer.suspend();
        this.contexts.set(this.key(context.binding.targetRoot), context);
      }
    } catch (error) {
      return res.status(error.code === 'WorkspaceCapacityExceeded' ? 409 : 400).json({ error: error.message, code: error.code ?? 'WorkspaceUnavailable' });
    }
    if (!context) return res.status(409).json({ error: 'No workspace selected', code: 'WorkspaceUnset', root: null });
    this.touch(context);
    context.requests = (context.requests ?? 0) + 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      context.requests--;
      res.off('finish', release); res.off('close', release);
    };
    res.once('finish', release); res.once('close', release);
    try {
      return withProjectContext(context.binding, () => context.router(req, res, error => { release(); next(error); }));
    } catch (error) {
      release();
      return next(error);
    }
  }

  close() {
    for (const context of this.contexts.values()) {
      context.fileWatcher.close(); context.visionServer.close();
      void closeDesignStratum(context.binding.targetRoot);
    }
    this.contexts.clear();
    this.active = null;
  }
}
