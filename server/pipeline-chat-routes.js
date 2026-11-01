/**
 * pipeline-chat-routes.js — COMP-PIPE-EDIT-CHAT-PANE-1. The Flow editor's spec chat.
 *
 * Routes:
 *   POST   /api/pipeline/chat          one turn, NDJSON: {type:'delta',text}* then {type:'final',reply,proposal}
 *   GET    /api/pipeline/chat?file=    stored history for one spec
 *   POST   /api/pipeline/chat/cancel   abort the in-flight turn for a spec
 *   DELETE /api/pipeline/chat?file=    clear a spec's history
 *
 * One stateless Stratum agentRun per turn, ZERO tools, so a turn is one request and one
 * reply (cost bound, design §5). The run is ISOLATED (F6): no settings files, hooks, MCP
 * servers or Claude Code preset, so the model sees only CHAT_SYSTEM_PROMPT and the prompt.
 * Without it a 1.6K-token prompt reached the model as 113-141K tokens (review M1). The client sends its in-memory YAML each turn; this
 * module never reads the spec from disk and never writes it. A proposed edit comes back
 * as `proposal` and only the editor can apply it. `/api/agent/*` is not touched.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { getStratum } from './stratum-connection.js';
import {
  buildPrompt, checkInputSize, extractProposal, summarizeProposal, hashText,
  CHAT_SYSTEM_PROMPT, MAX_INPUT_TOKENS, realInputTokens,
} from './pipeline-chat-prompt.js';

export const CHAT_MODEL = 'claude-sonnet-5-5';
export const CHAT_SITE = 'pipe-chat';
const SPEC_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.stratum\.yaml$/;

const sessionsPath = (dataDir) => path.join(dataDir, 'pipeline-chat-sessions.json');

function readSessions(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsPath(dataDir), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeSessions(dataDir, sessions) {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = sessionsPath(dataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
  fs.renameSync(tmp, target);
}

/** The same chain as pipeline-routes.js draft/approve: Stratum validate, else a parse check. */
async function validateProposal(stratum, text) {
  try {
    YAML.parse(text);
  } catch (err) {
    return { valid: false, error: `Invalid YAML: ${err.message}` };
  }
  if (stratum && typeof stratum.validate === 'function') {
    try {
      const r = await stratum.validate(text);
      if (r?.valid === false) return { valid: false, error: `Spec validation failed: ${r.error || 'unknown error'}` };
    } catch { /* Stratum unavailable: the parse check above stands */ }
  }
  return { valid: true, error: null };
}

/**
 * @param {import('express').Express} app
 * @param {{ getDataDir: () => string, getProjectRoot: () => string,
 *           getStratumClient?: (root: string) => Promise<object> }} deps
 */
export function attachPipelineChatRoutes(app, { getDataDir, getProjectRoot, getStratumClient = getStratum }) {
  /** @type {Map<string, AbortController>} spec file -> the turn in flight */
  const inFlight = new Map();

  const specFileOf = (v) => {
    const f = typeof v === 'string' ? path.basename(v) : '';
    return SPEC_FILE_RE.test(f) && f === v ? f : null;
  };

  app.get('/api/pipeline/chat', (req, res) => {
    const file = specFileOf(req.query.file);
    if (!file) return res.status(400).json({ error: 'file must be a *.stratum.yaml basename' });
    res.json({ file, messages: readSessions(getDataDir())[file]?.messages ?? [], busy: inFlight.has(file) });
  });

  app.delete('/api/pipeline/chat', (req, res) => {
    const file = specFileOf(req.query.file);
    if (!file) return res.status(400).json({ error: 'file must be a *.stratum.yaml basename' });
    const dataDir = getDataDir();
    const sessions = readSessions(dataDir);
    delete sessions[file];
    writeSessions(dataDir, sessions);
    res.json({ ok: true });
  });

  app.post('/api/pipeline/chat/cancel', (req, res) => {
    const file = specFileOf(req.body?.file);
    if (!file) return res.status(400).json({ error: 'file must be a *.stratum.yaml basename' });
    const ctl = inFlight.get(file);
    if (ctl) ctl.abort();
    res.json({ ok: true, cancelled: !!ctl });
  });

  app.post('/api/pipeline/chat', async (req, res) => {
    const { file: rawFile, message, yaml, selectedFlow, selectedStep, errors, baseHash } = req.body || {};
    const file = specFileOf(rawFile);
    if (!file) return res.status(400).json({ error: 'file must be a *.stratum.yaml basename' });
    if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message is required' });
    if (typeof yaml !== 'string' || !yaml.trim()) return res.status(400).json({ error: 'yaml (the in-memory spec) is required' });
    if (inFlight.has(file)) return res.status(409).json({ error: 'A turn is already running for this spec' });

    const dataDir = getDataDir();
    const sessions = readSessions(dataDir);
    const history = sessions[file]?.messages ?? [];
    const prompt = buildPrompt({ yaml, message, selectedFlow, selectedStep, errors, history });
    const size = checkInputSize(prompt);
    if (!size.ok) {
      // Refused before dispatch: nothing reaches the model and nothing is stored.
      return res.status(413).json({
        error: `This spec is too large to chat about (${size.tokens} tokens, the cap is ${size.cap}).`,
        tokens: size.tokens, cap: size.cap,
      });
    }

    const ctl = new AbortController();
    inFlight.set(file, ctl);
    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
    const send = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };

    const store = (entry) => {
      const all = readSessions(dataDir);
      const msgs = all[file]?.messages ?? [];
      all[file] = { messages: [...msgs, { ...entry, ts: new Date().toISOString() }] };
      writeSessions(dataDir, all);
    };
    store({ role: 'user', text: message.trim() });

    let unsub = () => {};
    try {
      const root = getProjectRoot();
      const stratum = await getStratumClient(root);
      const correlationId = `pipe-chat-${file}-${Date.now()}`;
      let streamed = '';
      unsub = stratum.onEvent?.(correlationId, '_agent_run', (env) => {
        const m = env?.metadata ?? {};
        if (env?.kind === 'agent_relay' && m.role === 'assistant' && typeof m.text === 'string' && m.text) {
          streamed += m.text;
          send({ type: 'delta', text: m.text });
        }
      }) ?? (() => {});

      const run = await stratum.agentRun('claude', prompt, {
        cwd: root,
        correlationId,
        signal: ctl.signal,
        modelID: CHAT_MODEL,
        // An installed Stratum without `isolated` refuses the call (UNSUPPORTED_AGENT_OPTIONS,
        // stratum-mcp-client.js) rather than running unisolated.
        isolated: true,
        systemPrompt: CHAT_SYSTEM_PROMPT,
        allowedTools: [],
        disallowedTools: ['ToolSearch'],
        effort: 'low',
        telemetry: { site: CHAT_SITE, project_cwd: root },
      });
      const inputTokens = realInputTokens(run);
      if (inputTokens === null) {
        console.warn(`WARNING pipe-chat: ${file} turn reported no token split; its real input is unknown and the ${MAX_INPUT_TOKENS}-token cap is unchecked after dispatch`);
      } else if (inputTokens > MAX_INPUT_TOKENS) {
        // Refusing is impossible after the fact; say so loudly, the cap was meant to bound this.
        console.warn(`WARNING pipe-chat: ${file} turn's real input was ${inputTokens} tokens, over the ${MAX_INPUT_TOKENS}-token cap (estimated ${size.tokens} before dispatch)`);
      }
      const usage = {
        input_tokens: inputTokens,
        output_tokens: Number.isFinite(run?.split?.output) ? run.split.output : null,
        usd: Number.isFinite(run?.usage?.usd) ? run.usage.usd : null,
      };
      const full = (typeof run?.text === 'string' && run.text) || streamed;
      const { text, yaml: proposedYaml } = extractProposal(full);

      let proposal = null;
      if (proposedYaml) {
        const v = await validateProposal(stratum, proposedYaml);
        proposal = { yaml: proposedYaml, baseHash: typeof baseHash === 'string' && baseHash ? baseHash : hashText(yaml), ...v };
      }
      store({ role: 'assistant', text, ...(proposal ? { proposed: summarizeProposal(full) } : {}) });
      send({ type: 'final', reply: text, proposal, usage });
    } catch (err) {
      const aborted = ctl.signal.aborted || err?.name === 'AbortError';
      send({ type: 'error', error: aborted ? 'Cancelled' : (err?.message || String(err)), cancelled: aborted });
    } finally {
      try { unsub(); } catch { /* best effort */ }
      inFlight.delete(file);
      res.end();
    }
  });
}
