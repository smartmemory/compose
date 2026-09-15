import { prepareProject, withProjectContext, getTargetRoot } from './project-root.js';
import path from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import express from 'express';
import { requireSensitiveToken } from './security.js';
import { hooksForProject } from './agent-hooks.js';
import { CoalescingBuffer } from './coalescing-buffer.js';
import { BuildStreamBridge } from './build-stream-bridge.js';
import { hasPersistedWork } from './workspace-activity.js';

/** One SDK session, message history and stream bridge per project. */
export function createAgentWorkspace(binding, { query }) {
  const _agentBuffer = new CoalescingBuffer((flushed) => {
    if (flushed.agentMessage) {
      for (const msg of flushed.agentMessage) {
        _trackMessage(msg);
        broadcast(msg);
      }
    }
  }, { intervalMs: 16 });
  _agentBuffer.register('agentMessage', 'append');

  const _recentMessages = [];
  const HYDRATE_LIMIT = 50;

  function _trackMessage(msg) {
    _recentMessages.push(msg);
    if (_recentMessages.length > HYDRATE_LIMIT) _recentMessages.shift();
  }

  function getAgentSnapshot() {
    return _recentMessages.length > 0 ? [..._recentMessages] : null;
  }

  const SETTINGS_FILE = path.join(binding.dataDir, 'settings.json');

  function _readModelSetting() {
    try {
      const raw = readFileSync(SETTINGS_FILE, 'utf-8');
      return JSON.parse(raw)?.models?.interactive || null;
    } catch {
      return null;
    }
  }

  const app = express.Router();

  // C12: /api/health is registered once, on the app in createAgentApp. A copy
  // here was unreachable (the app-level route answers first) and would have
  // made liveness depend on resolving a workspace.

  // ---------------------------------------------------------------------------
  // Session state — one active SDK session at a time
  // ---------------------------------------------------------------------------

  /**
   * Active session state:
   *   id: string|null        — SDK session_id captured from init message
   *   queryIter: Query|null  — SDK async iterator, has .interrupt() method
   */
  let _session = { id: null, queryIter: null };
  const _queries = new Set();

  /** SSE clients waiting for messages */
  const _sseClients = new Set();

  function broadcast(msg) {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const client of _sseClients) {
      try {
        client.write(line);
      } catch {
        _sseClients.delete(client);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/agent/stream — SSE subscription
  // ---------------------------------------------------------------------------

  app.get('/api/agent/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if proxied
    res.flushHeaders();

    _sseClients.add(res);

    const snapshot = getAgentSnapshot();
    if (snapshot) {
      res.write(`event: hydrate\ndata: ${JSON.stringify(snapshot)}\n\n`);
    }

    // Immediately tell the new client whether a session exists
    if (_session.id) {
      res.write(`data: ${JSON.stringify({
        type: 'system', subtype: 'connected', sessionId: _session.id,
      })}\n\n`);
    }

    req.on('close', () => _sseClients.delete(res));
  });

  // ---------------------------------------------------------------------------
  // POST /api/agent/session — create a fresh session
  // ---------------------------------------------------------------------------

  app.post('/api/agent/session', requireSensitiveToken, (req, res) => {
    const { prompt = '' } = req.body || {};
    if (!prompt.trim()) return res.status(400).json({ error: 'prompt is required' });

    _killCurrentSession();

    try {
      const q = _startQuery(prompt, null);
      _session = { id: null, queryIter: q };
      _consumeStream(q);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/agent/message — send a follow-up message (resumes session)
  // ---------------------------------------------------------------------------

  app.post('/api/agent/message', requireSensitiveToken, (req, res) => {
    const { prompt } = req.body || {};
    if (!prompt?.trim()) return res.status(400).json({ error: 'prompt is required' });

    const resumeId = _session.id;
    _killCurrentSession();

    try {
      const q = _startQuery(prompt, resumeId);
      _session = { id: resumeId, queryIter: q };
      _consumeStream(q);
      res.json({ ok: true, resumeSessionId: resumeId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/agent/interrupt — interrupt current query
  // ---------------------------------------------------------------------------

  app.post('/api/agent/interrupt', requireSensitiveToken, (req, res) => {
    if (!_session.queryIter) {
      return res.status(404).json({ error: 'No active query' });
    }
    try {
      _session.queryIter.interrupt();

      // COMP-AGT-1: Escalation — if not resolved within 5s, force-kill the session
      const capturedIter = _session.queryIter;
      setTimeout(() => {
        if (_session.queryIter === capturedIter) {
          console.log('[agent-server] Interrupt escalation: killing session after 5s timeout');
          _killCurrentSession();
        }
      }, 5000);

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/agent/session/status
  // ---------------------------------------------------------------------------

  app.get('/api/agent/session/status', (_req, res) => {
    res.json({
      active: !!_session.queryIter,
      sessionId: _session.id || null,
    });
  });

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  function _buildOptions(prompt, resumeId) {
    return {
      cwd: binding.targetRoot,
      env: { ...process.env, COMPOSE_TARGET: binding.targetRoot },
      model: _readModelSetting() || 'claude-sonnet-5',
      permissionMode: 'acceptEdits',
      settingSources: ['project'],
      tools: { type: 'preset', preset: 'claude_code' },
      hooks: hooksForProject(binding),
      ...(resumeId ? { resume: resumeId } : {}),
    };
  }

  function _startQuery(prompt, resumeId) {
    return query({ prompt, options: _buildOptions(prompt, resumeId) });
  }

  function _killCurrentSession() {
    if (_session.queryIter) {
      try { Promise.resolve(_session.queryIter.return()).catch(() => {}); } catch { /* ignore */ }
    }
    _session = { id: null, queryIter: null };
    _recentMessages.length = 0;
  }

  async function _consumeStream(q) {
    _queries.add(q);
    try {
      for await (const msg of q) {
        // Capture session_id from the init message so we can resume
        if (_session.queryIter !== q) break;
        if (msg.type === 'system' && msg.subtype === 'init') {
          _session.id = msg.session_id;
        }
        _agentBuffer.put('agentMessage', msg);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        broadcast({ type: 'error', message: err.message || String(err) });
      }
    } finally {
      _queries.delete(q);
      // Signal completion to clients regardless of success/error
      if (_session.queryIter === q) {
        _session.queryIter = null;
      }
      // Keep _recentMessages populated after natural session end so clients
      // reloading the tab post-turn can still hydrate recent history.
      // Ring is cleared only on force-kill / new-session start in _killCurrentSession.
    }
  }


  const bridge = new BuildStreamBridge(path.join(binding.targetRoot, '.compose'), broadcast);
  bridge.start();
  return {
    router: app,
    getAgentSnapshot,
    get busy() { return _queries.size > 0 || _sseClients.size > 0 || hasPersistedWork(binding.dataDir); },
    close() {
      _agentBuffer.stop(); bridge.stop(); _killCurrentSession();
      for (const client of _sseClients) client.end();
      _sseClients.clear();
    },
  };
}

/** Shared by the production process and executable-boundary integration probes. */
export function createAgentApp({ query, maxWorkspaces = 8 }) {
  if (!Number.isInteger(maxWorkspaces) || maxWorkspaces < 1) throw new Error("maxWorkspaces must be a positive integer");
  const app = express();
  app.use(express.json());
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  const workspaces = new Map();
  app.use((req, res, next) => {
    const root = req.get('x-compose-project-root');
    const dispatch = () => {
      try {
        const target = realpathSync(root || getTargetRoot());
        // A token authorizes the proxy, not turning arbitrary directories into
        // writable SDK workspaces. Header targets must already be configured.
        if (root && target !== realpathSync(getTargetRoot())) {
          const config = JSON.parse(readFileSync(path.join(target, '.compose', 'compose.json'), 'utf8'));
          if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Target must be a configured Compose workspace');
        }
        const binding = prepareProject(target);
        if (!workspaces.has(target) && workspaces.size >= maxWorkspaces) {
          const idle = [...workspaces].find(([, workspace]) => !workspace.busy);
          if (!idle) return res.status(409).json({ error: `Workspace capacity reached (${maxWorkspaces}); every retained workspace is busy`, code: 'WorkspaceCapacityExceeded' });
          idle[1].close(); workspaces.delete(idle[0]);
        }
        let workspace = workspaces.get(binding.targetRoot);
        if (!workspace) {
          workspace = withProjectContext(binding, () => createAgentWorkspace(binding, { query }));
          workspaces.set(binding.targetRoot, workspace);
        }
        // Map insertion order is the LRU order, including status/stream reads.
        workspaces.delete(binding.targetRoot); workspaces.set(binding.targetRoot, workspace);
        return withProjectContext(binding, () => workspace.router(req, res, next));
      } catch (err) { return res.status(400).json({ error: err.message }); }
    };
    // The proxy selects cwd with a server-stamped root and sensitive credential.
    if (root) return requireSensitiveToken(req, res, dispatch);
    return dispatch();
  });
  return { app, close: () => { for (const workspace of workspaces.values()) workspace.close(); } };
}
