/**
 * File Watcher Server
 * Watches docs/ for changes and broadcasts file content over WebSocket.
 * Also serves file content via REST for initial loads.
 */

import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTargetRoot, loadProjectConfig, ensureDataDir } from './project-root.js';
import {
  resolveDocsPathFromConfig,
  resolveFeaturesPathFromConfig,
  resolveIdeaboxPathFromConfig,
  relForDisplay,
} from '../lib/project-paths.js';

const PROJECT_ROOT = getTargetRoot();

/**
 * fs.watch fileFilter for the pipelines/ watch (COMP-PIPE-EDIT-6): only
 * *.stratum.yaml files trigger a specChanged. `filename` is what fs.watch hands
 * us (a name, possibly with a subdir prefix on recursive watches).
 */
export function isStratumSpecFile(filename) {
  return typeof filename === 'string' && filename.endsWith('.stratum.yaml');
}

/**
 * Shape of the vision-WS `specChanged` broadcast (COMP-PIPE-EDIT-6). `file` is a
 * BASENAME (editorSpecFile is a bare filename, so the store compares on basename);
 * `path` carries the prefixed relative path for diagnostics.
 */
export function buildSpecChangedMessage(file, relativePath) {
  return { type: 'specChanged', file, path: relativePath };
}

/** Coalescing window for the ideabox-projection watch. */
export const IDEABOX_COALESCE_MS = 100;

/**
 * fs.watch fileFilter for the ideabox-projection watch (IDEA-24). That watch is
 * NON-recursive on the projection's own parent directory, so `filename` is a bare
 * name and exact equality is the whole test.
 *
 * Exact equality, not a suffix or basename match, because `render-ideabox.js`
 * publishes atomically through `.ideabox.md.tmp.<uuid>` in the SAME directory. A
 * looser predicate would fire on the temp file — announcing an update before the
 * rename that makes it real, and a second time after.
 */
export function isIdeaboxProjectionFile(filename, projectionBasename) {
  return typeof filename === 'string'
    && typeof projectionBasename === 'string'
    && projectionBasename.length > 0
    && filename === projectionBasename;
}

/**
 * Shape of the vision-WS `ideaboxUpdated` broadcast raised by the projection
 * watch (IDEA-24).
 *
 * `type` is byte-identical to what `server/ideabox-routes.js` broadcasts, because
 * both ideabox clients compare `msg.type === 'ideaboxUpdated'` and nothing else —
 * a differently-named event would be silently ignored, which is the bug this
 * closes. `timestamp` matches the route's shape so one channel carries one shape;
 * `source` exists so a WS log distinguishes a route-driven update from a
 * file-driven one, which is precisely the diagnosis that was missing here.
 */
export function buildIdeaboxUpdatedMessage(relativePath) {
  return {
    type: 'ideaboxUpdated',
    source: 'projection-watch',
    path: relativePath,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Fire `fn` once, `waitMs` after the LAST call. TRAILING, unlike the
 * leading-edge-and-drop debounce the other watches use, and the difference is
 * the whole point.
 *
 * A leading-edge debounce announces the first write of a burst and discards the
 * rest — so the cockpit ends up showing the state at the START of the burst and
 * never hears about the end of it. That is the same "your list is stale until
 * you reload" bug IDEA-24 exists to close, just at a 100ms timescale, and it is
 * reachable from two `compose ideabox add` calls in quick succession.
 *
 * For a NOTIFICATION the last event is the one that must survive; the payload
 * is a re-fetch, so intermediate events carry nothing worth delivering. One
 * broadcast per logical write, always reflecting final state, ~waitMs late.
 */
export function createTrailingDebouncer(fn, waitMs) {
  let timer = null;
  return {
    trigger() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fn(); }, waitMs);
    },
    cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}

export class FileWatcherServer {
  constructor() {
    this.clients = new Set();
    this.wss = null;
    this.watchers = [];
  }

  /** Resolve and validate a relative path stays within project root */
  safePath(relativePath) {
    const resolved = path.resolve(PROJECT_ROOT, relativePath);
    if (!resolved.startsWith(PROJECT_ROOT + path.sep) && resolved !== PROJECT_ROOT) {
      return null;
    }
    return resolved;
  }

  attach(httpServer, app) {
    // REST endpoint: GET /api/file?path=docs/brainstorm.md
    app.get('/api/file', (req, res) => {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).json({ error: 'path required' });

      const resolved = this.safePath(filePath);
      if (!resolved) return res.status(403).json({ error: 'path outside project' });

      try {
        const content = fs.readFileSync(resolved, 'utf-8');
        res.json({ path: filePath, content });
      } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
        res.status(500).json({ error: err.message });
      }
    });

    // REST endpoint: PUT /api/file — write content to a file
    app.put('/api/file', (req, res) => {
      const filePath = req.body.path;
      const content = req.body.content;
      if (!filePath) return res.status(400).json({ error: 'path required' });
      if (typeof content !== 'string') return res.status(400).json({ error: 'content required (string)' });

      const resolved = this.safePath(filePath);
      if (!resolved) return res.status(403).json({ error: 'path outside project' });

      try {
        fs.writeFileSync(resolved, content, 'utf-8');
        res.json({ ok: true, path: filePath });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // REST endpoint: GET /api/files — list markdown files in docs/
    app.get('/api/files', (_req, res) => {
      const config = loadProjectConfig();
      const docsPrefix = config.paths?.docs || 'docs';
      // COMP-PATHS-EXTERNAL: list the RESOLVED docs dir (may be relocated).
      const docsDir = resolveDocsPathFromConfig(PROJECT_ROOT, config);
      try {
        const files = this.listMarkdownFiles(docsDir, docsPrefix);
        res.json({ files });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // REST endpoint: POST /api/canvas/open — agent can tell the canvas to load a file
    // Optional: { path, anchor } — anchor scrolls to a heading after opening
    // Special: vision://surface opens the vision surface tab
    app.post('/api/canvas/open', (req, res) => {
      const filePath = req.body.path;
      const anchor = req.body.anchor;
      if (!filePath) return res.status(400).json({ error: 'path required' });

      // Handle vision:// scheme — no file read, just broadcast open
      if (filePath.startsWith('vision://')) {
        this.broadcast({ type: 'openFile', path: filePath, content: null, rendererType: 'vision' });
        return res.json({ ok: true, path: filePath });
      }

      // Handle graph:// scheme — opens a named graph in the GraphRenderer
      if (filePath.startsWith('graph://')) {
        this.broadcast({ type: 'openFile', path: filePath, content: null, rendererType: 'graph' });
        return res.json({ ok: true, path: filePath });
      }

      const resolved = this.safePath(filePath);
      if (!resolved) return res.status(403).json({ error: 'path outside project' });

      try {
        const content = fs.readFileSync(resolved, 'utf-8');
        this.broadcast({ type: 'openFile', path: filePath, content, anchor });
        res.json({ ok: true, path: filePath, anchor });
      } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: 'file not found' });
        res.status(500).json({ error: err.message });
      }
    });

    // REST endpoint: POST /api/canvas/scroll — scroll to a heading in an open tab
    // { anchor, path? } — path switches tab first (file must already be open)
    app.post('/api/canvas/scroll', (req, res) => {
      const { anchor, path: filePath } = req.body;
      if (!anchor) return res.status(400).json({ error: 'anchor required' });
      this.broadcast({ type: 'scrollTo', anchor, path: filePath });
      res.json({ ok: true, anchor, path: filePath });
    });

    // REST endpoint: POST /api/canvas/close — close a tab (or all tabs)
    // { path? } — close specific tab, or omit to close all
    app.post('/api/canvas/close', (req, res) => {
      const filePath = req.body.path;
      this.broadcast({ type: 'closeFile', path: filePath || null });
      res.json({ ok: true, path: filePath || 'all' });
    });

    // WebSocket endpoint: /ws/files
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      console.log(`[file-watcher] Client connected (${this.clients.size} total)`);

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[file-watcher] Client disconnected (${this.clients.size} total)`);
      });

      ws.on('error', (err) => {
        console.error('[file-watcher] WebSocket error:', err.message);
        this.clients.delete(ws);
      });
    });

    // Watch docs/ directory
    this.startWatching();
    console.log('File watcher WebSocket server attached at /ws/files');
  }

  startWatching() {
    const debounceMap = new Map();

    /**
     * @param {object} [opts]
     * @param {boolean} [opts.recursive=true] fs.watch recursion.
     * @param {number} [opts.debounceMs=100] leading-edge suppression window.
     *
     *   PASS 0 FOR ANY WATCH OVER AN ALREADY-WATCHED FILE. `debounceMap` is
     *   shared across every watchDir call and keyed by the prefixed relative
     *   path, so two watches whose dir+prefix resolve to the SAME relative path
     *   for one file suppress each other: whichever fs.watch delivers second
     *   inside the window is silently dropped, and which one that is depends on
     *   the OS. (That already happens between `docs/` and `docs/features/`; it is
     *   left exactly as it was rather than changed underneath callers here.) 0
     *   opts out of the shared map entirely — for a watch that coalesces its own
     *   events, which is the only reason to be in that position.
     */
    const watchDir = (dir, prefix, onChanged, fileFilter = (f) => f.endsWith('.md'), opts = {}) => {
      const { recursive = true, debounceMs = 100 } = opts;
      if (!fs.existsSync(dir)) {
        console.warn(`[file-watcher] ${prefix}/ directory not found, skipping watch`);
        return;
      }
      try {
        const watcher = fs.watch(dir, { recursive }, (eventType, filename) => {
          if (!filename || !fileFilter(filename)) return;

          const relativePath = path.join(prefix, filename);
          // COMP-PATHS-EXTERNAL: derive the real path from the WATCHED dir, not
          // by re-rooting under PROJECT_ROOT — the dir may be relocated outside
          // the workspace. Byte-identical to the old form for an in-root dir.
          const fullPath = path.join(dir, filename);

          // Debounce: ignore events within debounceMs of each other for the same file
          if (debounceMs > 0) {
            const now = Date.now();
            const lastEvent = debounceMap.get(relativePath);
            if (lastEvent && now - lastEvent < debounceMs) return;
            debounceMap.set(relativePath, now);
          }

          onChanged(relativePath, fullPath);
        });
        this.watchers.push(watcher);
      } catch (err) {
        console.error(`[file-watcher] Failed to watch ${prefix}/:`, err.message);
      }
    };

    // Watch docs/ — broadcast fileChanged events. COMP-PATHS-EXTERNAL: watch
    // the RESOLVED absolute dir (may be relocated outside PROJECT_ROOT).
    const config = loadProjectConfig();
    const docsPrefix = config.paths?.docs || 'docs';
    watchDir(resolveDocsPathFromConfig(PROJECT_ROOT, config), docsPrefix, (relativePath, fullPath) => {
      try {
        if (!fs.existsSync(fullPath)) return;
        const content = fs.readFileSync(fullPath, 'utf-8');
        this.broadcast({ type: 'fileChanged', path: relativePath, content });
      } catch (err) {
        console.error(`[file-watcher] Error reading ${relativePath}:`, err.message);
      }
    });

    // Watch features/ — notify for auto-reseed into vision store
    const featuresPrefix = config.paths?.features || 'docs/features';
    watchDir(resolveFeaturesPathFromConfig(PROJECT_ROOT, config), featuresPrefix, (relativePath, fullPath) => {
      // Also broadcast as fileChanged (features are docs). fullPath comes from
      // the watched dir (COMP-PATHS-EXTERNAL) — do not re-root under PROJECT_ROOT.
      try {
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          this.broadcast({ type: 'fileChanged', path: relativePath, content });
        }
      } catch { /* skip */ }
      if (typeof this.onFeatureChanged === 'function') {
        this.onFeatureChanged(relativePath);
      }
    });

    // Watch pipelines/ for *.stratum.yaml changes (COMP-PIPE-EDIT-6). A spec the
    // pipeline editor has open can be edited externally (another writer, the user
    // editing the file directly). The editor store lives on the VISION WS, not
    // /ws/files, so emit a DEDICATED `specChanged` message via the onSpecChanged
    // callback (wired in server/index.js to visionServer.broadcastMessage), NOT a
    // `fileChanged` on this server's /ws/files. The payload carries `file` as a
    // BASENAME because editorSpecFile is a bare filename (a prefixed relative path
    // would never match the store's compare).
    const pipelinesDir = path.join(PROJECT_ROOT, 'pipelines');
    watchDir(pipelinesDir, 'pipelines', (relativePath, fullPath) => {
      if (typeof this.onSpecChanged === 'function') {
        this.onSpecChanged(buildSpecChangedMessage(path.basename(fullPath), relativePath));
      }
    }, isStratumSpecFile);

    // Watch the ideabox projection → `ideaboxUpdated` on the VISION WS (IDEA-24).
    //
    // A CLI ideabox write goes straight to the record store; it never reaches
    // `server/ideabox-routes.js`, which is the only thing that broadcasts. So an
    // open cockpit or mobile client kept showing the pre-write list until someone
    // reloaded it by hand. The `fileChanged` this file already emits for the same
    // write goes out on /ws/files, which neither ideabox client subscribes to.
    //
    // THE PROJECTION IS THE TRIGGER, NOT THE PAYLOAD. Clients respond by
    // re-fetching GET /api/ideabox, which reads RECORDS — the markdown is never
    // parsed to serve a read (COMP-PLAN-IDEA-UNIFY D21). The projection is used
    // only as the signal, and it is a sound one because `ideabox-ops.js`
    // guarantees the record is durable BEFORE the render: an event from this
    // watch can never arrive ahead of the data the re-fetch will return.
    //
    // Two consequences, both accepted:
    //  - An API-driven mutation broadcasts twice (the route's own, then this
    //    one). The re-fetch is idempotent, and suppressing the echo would need a
    //    "did I just write this?" mtime handshake — a race, to save one GET.
    //  - A write whose render FAILED does not notify. That is the
    //    `projectionStale` path: the writer is already told, and `compose ideabox
    //    render` both repairs the file and fires this watch.
    //
    // Watched NON-recursively on the projection's own parent so a relocated
    // `paths.ideabox` outside `paths.docs` still works.
    const ideaboxPath = resolveIdeaboxPathFromConfig(PROJECT_ROOT, config);
    const ideaboxDir = path.dirname(ideaboxPath);
    // The projection's directory may not exist yet in a project that has never
    // rendered one. Create it, or the watch is skipped and the very first CLI
    // write — the one most likely to be watched for — silently does not refresh.
    try { fs.mkdirSync(ideaboxDir, { recursive: true }); } catch { /* read-only tree — watchDir skips */ }
    //
    // Raw fs events are coalesced by a TRAILING debouncer rather than the
    // leading-edge one `watchDir` applies (hence `debounceMs: 0`): see
    // `createTrailingDebouncer` for why the LAST event is the one that has to
    // survive here. That also folds the rename+change pair of a single atomic
    // publish into one broadcast.
    const ideaboxRelative = relForDisplay(PROJECT_ROOT, ideaboxPath);
    this._ideaboxDebouncer = createTrailingDebouncer(() => {
      if (typeof this.onIdeaboxChanged === 'function') {
        this.onIdeaboxChanged(buildIdeaboxUpdatedMessage(ideaboxRelative));
      }
    }, IDEABOX_COALESCE_MS);
    watchDir(
      ideaboxDir,
      relForDisplay(PROJECT_ROOT, ideaboxDir),
      () => this._ideaboxDebouncer.trigger(),
      (f) => isIdeaboxProjectionFile(f, path.basename(ideaboxPath)),
      { recursive: false, debounceMs: 0 },
    );

    // Watch .compose/data/ for active-build.json changes
    const self = this;
    const dataDir = path.join(PROJECT_ROOT, '.compose', 'data');
    let dataDirWatcherRegistered = false;

    // Guarantee .compose/data/ exists before registering the watcher
    ensureDataDir();

    const registerDataWatcher = () => {
      if (dataDirWatcherRegistered) return;
      if (!fs.existsSync(dataDir)) return;
      dataDirWatcherRegistered = true;

      watchDir(dataDir, '.compose/data', (relativePath, fullPath) => {
        let state = null;
        try {
          if (fs.existsSync(fullPath)) {
            state = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
          }
        } catch { /* parse error or ENOENT — state stays null */ }

        if (typeof self.onBuildStateChanged === 'function') {
          self.onBuildStateChanged(state);
        }
      }, (f) => f === 'active-build.json');
    };

    registerDataWatcher();
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        try {
          client.send(data);
        } catch (err) {
          console.error('[file-watcher] Broadcast error:', err.message);
        }
      }
    }
  }

  listMarkdownFiles(dir, prefix) {
    const results = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = path.join(prefix, entry.name);
        if (entry.isDirectory()) {
          results.push(...this.listMarkdownFiles(path.join(dir, entry.name), relativePath));
        } else if (entry.name.endsWith('.md')) {
          results.push(relativePath);
        }
      }
    } catch {
      // Directory might not exist or be readable
    }
    return results;
  }

  close() {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    // AFTER the watchers: cancelling first would leave a window in which a last
    // fs event re-arms the timer, and a pending timer holds the event loop open.
    this._ideaboxDebouncer?.cancel();
    this.watchers = [];
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    if (this.wss) this.wss.close();
  }
}
