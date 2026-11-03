/**
 * fleet-routes.js — `GET /api/fleet`, the read-only multi-session status view (COMP-COCKPIT-12).
 *
 * Three external readers, never re-implemented here (design.md "Hard requirement"):
 *   stratum   `<stratum> session fleet --json` (S/docs/features/SESSION-MGMT-1/session-contract.json
 *             operations.fleet): alive detached Claude jobs vs the fleet cap.
 *   sm_status `python3 ~/.claude/scripts/sm_status.py --json`: sessions, jobs, owner queue, disk, spend,
 *             ledger tail (`{generated, sources: {name: {value, error, ts}}}`).
 *   cadence   the mounted `/api/cadence-ui` handler's `belt` (called in-process, no HTTP hop) plus the
 *             LAST `kind:"would_launch"` line of `~/.cadence/shadow.jsonl` (tail read only). The shadow
 *             report's agreement numbers are wrong until F33 lands and are never read here.
 *
 * Each source is cached on its own window: at most one spawn per window, never two at once (single
 * flight). A stale value is served while one refresh runs. Spawns use argv arrays (no shell) and carry a
 * timeout (SIGTERM, then SIGKILL after a grace period). The three readers take no request input. A reader that cannot
 * run (binary or script absent, non-zero exit, timeout, unparsable output, cadence not mounted) is an
 * outage: its `{value: null, error}` tells the UI to hide that panel, and exactly one warn line is
 * logged per outage. Errors inside a reader's own sources pass through untouched.
 *
 * COMP-COCKPIT-NOTIFY-ACTIONS-1 adds the ONE route here that takes request input and writes:
 *   POST /api/fleet/owner-answer `{id, choice?|text?, resolve?}` (requireSensitiveOrPaired). It re-reads the owner
 *   queue at request time (`owner_queue.py list --json`, never the cache), refuses a closed id with `conflict` and the
 *   winning answer, validates the id, the row's class (`groupOf`: an ask, or a security row with `resolve: true`) and the
 *   choice (`optionsOf`), builds the answer itself (`OWNER (via cockpit): ...`, so provenance cannot be dropped) and
 *   spawns `owner_queue.py close <id> --answer <answer>` with argv only. It never opens the queue file. Replies are the
 *   HITL-1 `ProductReply` (`accepted | conflict | rejected`). Residual: a close from another channel can land in the
 *   milliseconds between the fresh read and the close; OPS-NOTIFY-SPOOL-1's refusal closes that later.
 * COMP-DOGFOOD-OWNER-QUEUE-1: the owner's open questions are ONE list (lib/owner-gates.js `readOwnerGates`, read fresh per
 *   request). `GET /api/fleet/owner-gates` returns it (contracts/owner-gate.schema.json), and the `queue` panel of
 *   `GET /api/fleet` is built from the same file (`readOpenQueuePanel`: every open row in sm_status's row shape, so the inbox's Decided and
 *   FYI groups fill), and `ownerAsks` filters it to what MCP `get_pending_gates` and the day ribbon count. The queue file resolves from `env` (`resolveOwnerQueueFile`); an env that names none (no HOME)
 *   keeps sm_status's panel, which reads the same file.
 * When a notify store is wired (server/notify-state-routes.js), every GET /api/fleet body also carries `notify`
 * (Compose's own ack/snooze/dismiss/answered list, read fresh per request) so the cockpit needs no second poll.
 *
 * Overrides (tests and the live walk): COMPOSE_FLEET_PYTHON, COMPOSE_FLEET_SM_STATUS,
 * COMPOSE_FLEET_STRATUM_BIN, COMPOSE_FLEET_CADENCE_SHADOW, COMPOSE_FLEET_OWNER_QUEUE.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveStratumBin } from '../lib/stratum-engine.js';
import { groupOf, stripTag } from '../lib/owner-queue-class.js';
import { optionsOf, choiceText } from '../lib/ask-options.js';
import { readOpenQueuePanel, readOwnerGates, resolveOwnerQueueFile } from '../lib/owner-gates.js';
import { requireSensitiveOrPaired } from './security.js';

export const FLEET_ROUTE = '/api/fleet';
export const OWNER_ANSWER_ROUTE = '/api/fleet/owner-answer';
export const OWNER_GATES_ROUTE = '/api/fleet/owner-gates';
export const OWNER_QUEUE_TIMEOUT_MS = 15_000;

// Cache windows. sm_status --json refreshes all of its sources in one call (~26 s measured 2026-10-30),
// so its window cannot be shorter than one call; 60 s keeps one open cockpit under half a core. Cadence changes once per tick (cadence-shape.md: 60 s).
export const TTL_MS = { stratum: 10_000, sm_status: 60_000, cadence: 60_000 };
export const TIMEOUT_MS = { stratum: 30_000, sm_status: 150_000 }; // sm_status measured 37-44 s solo at load ~22 (2026-11-03); 60 s timed out
const KILL_GRACE_MS = 5_000;
const MAX_STDOUT = 16 << 20;
const SHADOW_TAIL_BYTES = 256 << 10;

/** The sm_status sources the Fleet view shows (quota/awake/holds stay in the TUI). */
export const SM_PANELS = ['sessions', 'jobs', 'queue', 'df', 'spend', 'ceiling', 'ledger'];
const BELT_UNIT_KEYS = ['id', 'lane', 'column', 'title', 'priority', 'since', 'blocker', 'blockers', 'decision'];
const WOULD_LAUNCH_KEYS = ['ts', 'rung', 'launchable', 'units', 'units_known', 'at_wall'];

export function resolveFleetReaders(env = process.env) {
  let stratumBin = env.COMPOSE_FLEET_STRATUM_BIN || null;
  if (!stratumBin) {
    try { stratumBin = resolveStratumBin('cli', process.cwd()); } catch { stratumBin = null; }
  }
  return {
    python: env.COMPOSE_FLEET_PYTHON || 'python3',
    smStatus: env.COMPOSE_FLEET_SM_STATUS || join(homedir(), '.claude', 'scripts', 'sm_status.py'),
    stratumBin,
    shadowPath: env.COMPOSE_FLEET_CADENCE_SHADOW || join(homedir(), '.cadence', 'shadow.jsonl'),
    ownerQueue: env.COMPOSE_FLEET_OWNER_QUEUE || join(homedir(), '.claude', 'scripts', 'owner_queue.py'),
  };
}

/**
 * Run argv[0] with argv[1..] (never a shell). Resolves {code, stdout, stderr}; rejects with a short
 * reason on spawn failure, timeout, or a non-zero exit when `okCodes` excludes it.
 */
export function runReader(argv, { timeoutMs, env = process.env, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (error) {
      reject(new Error(`cannot start ${basename(argv[0])}: ${error.code ?? 'spawn failed'}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM'); // sm_status reaps its own fetch processes on SIGTERM
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    child.stdout.on('data', (d) => { if (stdout.length < MAX_STDOUT) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 4096) stderr += d; });
    child.on('error', (error) => finish(reject, new Error(`cannot start ${basename(argv[0])}: ${error.code ?? 'spawn failed'}`)));
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (timedOut) return finish(reject, new Error(`timed out after ${timeoutMs} ms`));
      if (code === null) return finish(reject, new Error(`killed by ${signal}`));
      if (!okCodes.includes(code)) {
        const why = stderr.trim().split('\n').filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l)).pop() ?? '';
        return finish(reject, new Error(`exit ${code}${why ? `: ${scrubHome(why).slice(0, 200)}` : ''}`));
      }
      return finish(resolve, { code, stdout, stderr });
    });
  });
}

/** A diagnostic that leaves the process carries no home path: `/Users/x/...` reads `~/...`. */
function scrubHome(text) {
  const home = homedir();
  return home && home !== '/' ? String(text).split(home).join('~') : String(text);
}

function parseJson(text, what) {
  try { return JSON.parse(text); } catch { throw new Error(`${what} printed no JSON document`); }
}

const MAX_WARNINGS = 5;
const MAX_WARNING_CHARS = 200;

/** A source's `warnings` (strings), bounded; `{}` when it has none, so a clean source's shape is unchanged. */
function boundedWarnings(raw) {
  if (!Array.isArray(raw)) return {};
  const warnings = raw.filter((w) => typeof w === 'string' && w.trim()).slice(0, MAX_WARNINGS).map((w) => w.slice(0, MAX_WARNING_CHARS));
  return warnings.length ? { warnings } : {};
}

/** sm_status: keep only the panels the view shows, each still `{value, error, ts}`. */
export async function readSmStatus(readers, env, timeoutMs = TIMEOUT_MS.sm_status) {
  if (!existsSync(readers.smStatus)) throw new Error(`reader missing: ${basename(readers.smStatus)}`);
  const { stdout } = await runReader([readers.python, readers.smStatus, '--json'], { timeoutMs, env });
  const doc = parseJson(stdout, 'sm_status.py --json');
  if (!doc || typeof doc.sources !== 'object' || doc.sources === null) throw new Error('sm_status.py --json has no sources object');
  const out = {};
  for (const name of SM_PANELS) {
    const src = doc.sources[name];
    out[name] = src && typeof src === 'object'
      ? { value: src.value ?? null, error: src.error ?? null, ts: src.ts ?? null, ...boundedWarnings(src.warnings) }
      : { value: null, error: `sm_status has no ${name} source`, ts: null };
  }
  return { generated: doc.generated ?? null, ...out };
}

/** stratum session fleet --json: the contract envelope; a refusal (exit 1/4) is an outage with its code. */
export async function readStratum(readers, env, timeoutMs = TIMEOUT_MS.stratum) {
  if (!readers.stratumBin) throw new Error('stratum binary not found');
  const { stdout } = await runReader([readers.stratumBin, 'session', 'fleet', '--json'], {
    timeoutMs, env, okCodes: [0, 1, 4],
  });
  const envelope = parseJson(stdout, 'stratum session fleet --json');
  if (envelope?.ok !== true) {
    const r = envelope?.refusal;
    throw new Error(r ? `${r.code}: ${String(r.reason ?? '').slice(0, 200)}` : 'stratum session fleet refused without a reason');
  }
  const d = envelope.data ?? {};
  if (!Array.isArray(d.jobs)) throw new Error('stratum session fleet data has no jobs array');
  return {
    count: Number.isFinite(d.count) ? d.count : null,
    max: Number.isFinite(d.max) ? d.max : null,
    jobs: d.jobs.map((j) => ({ session: j.session ?? null, label: j.label ?? null, pid: Number.isFinite(j.pid) ? j.pid : null })),
  };
}

/** Call a (req, res) handler in-process and parse its JSON body. The call is local, so it names the loopback Host the handler's guard (COMP-LOOPBACK-HOST-GUARD-1) requires. */
function callHandler(handler, url) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const chunks = [];
    const res = {
      writeHead(code) { status = code; return res; },
      setHeader() {},
      end(body) {
        if (body) chunks.push(String(body));
        try {
          const json = JSON.parse(chunks.join(''));
          if (status !== 200) reject(new Error(`belt ${status}: ${json?.error?.message ?? 'error'}`));
          else resolve(json);
        } catch {
          reject(new Error(`belt ${status}: not JSON`));
        }
      },
      write(c) { chunks.push(String(c)); return true; },
    };
    Promise.resolve(handler({ method: 'GET', url, headers: { host: '127.0.0.1' } }, res)).catch(reject);
  });
}

/** Last `kind:"would_launch"` line from the tail of the append-only shadow log; null when none in the tail. */
export async function readLastWouldLaunch(path) {
  const st = await stat(path);
  const start = Math.max(0, st.size - SHADOW_TAIL_BYTES);
  const fh = await open(path, 'r');
  let text;
  try {
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    text = buf.toString('utf8');
  } finally {
    await fh.close();
  }
  const lines = text.split('\n');
  if (start > 0) lines.shift(); // first line may be cut
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"would_launch"')) continue;
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (row?.kind !== 'would_launch') continue;
    const out = {};
    for (const k of WOULD_LAUNCH_KEYS) out[k] = row[k] ?? null;
    return out;
  }
  return null;
}

/** Cadence: ready units with Cadence's verdict, readiness summary, last proposed launches. */
export async function readCadence(handler, readers) {
  if (typeof handler !== 'function') throw new Error('cadence-ui handler not mounted');
  const belt = await callHandler(handler, '/api/belt');
  const ready = (Array.isArray(belt.units) ? belt.units : []).filter((u) => u.column === 'ready').map((u) => {
    const o = {};
    for (const k of BELT_UNIT_KEYS) o[k] = u[k] ?? null;
    return o;
  });
  let wouldLaunch = { value: null, error: null };
  try {
    wouldLaunch = { value: await readLastWouldLaunch(readers.shadowPath), error: null };
  } catch (error) {
    wouldLaunch = { value: null, error: `shadow log: ${error.code ?? 'unreadable'}` };
  }
  return {
    generatedAt: belt.generatedAt ?? null,
    readiness: belt.readiness ?? null,
    ready,
    errors: Array.isArray(belt.errors) ? belt.errors : [],
    wouldLaunch,
  };
}

/**
 * Stratum's fleet is `launch_gate.py --fleet`'s population: running, vendor claude, kind detached. Stratum wins on liveness
 * only inside that population; a bash, Codex or runner job is not in its list, so its absence says nothing and it keeps
 * sm_status's own pid check. Without Stratum's answer every job keeps sm_status liveness.
 */
export function mergeJobs(smJobs, stratum) {
  if (!Array.isArray(smJobs)) return smJobs;
  const pids = stratum ? new Set(stratum.jobs.map((j) => j.pid).filter((p) => p !== null)) : null;
  return smJobs.map((j) => {
    if (pids && Number.isFinite(j?.pid) && j.kind === 'detached' && j.vendor === 'claude') return { ...j, alive: pids.has(j.pid), aliveFrom: 'stratum' };
    return { ...j, aliveFrom: 'sm_status' };
  });
}

/** Single-flight cache with stale-while-revalidate and one warn line per outage. */
export function createSourceCache(name, load, { ttlMs, now = Date.now, warn = console.warn, info = console.log, logPrefix = '[fleet]' }) {
  let entry = null; // {value, error, ts}
  let pending = null;
  let down = false;
  let fetchedAt = -Infinity;

  function refresh() {
    if (pending) return pending;
    pending = (async () => {
      try {
        const value = await load();
        entry = { value, error: null, ts: now() };
        if (down) info(`${logPrefix} ${name} recovered`);
        down = false;
      } catch (error) {
        const reason = scrubHome(error?.message ?? error).slice(0, 300);
        entry = { value: null, error: reason, ts: now() };
        if (!down) warn(`${logPrefix} ${name} unavailable: ${reason}`);
        down = true;
      } finally {
        fetchedAt = now();
        pending = null;
      }
      return entry;
    })();
    return pending;
  }

  return {
    async get() {
      const fresh = now() - fetchedAt < ttlMs;
      if (entry && fresh) return { ...entry, stale: false };
      const p = refresh();
      if (entry) return { ...entry, stale: true }; // serve the last value while the one refresh runs
      return { ...(await p), stale: false };
    },
    get spawning() { return pending !== null; },
    /** NOTIFY-ACTIONS-1: forget the window and start one refresh now (single flight); the last value is still served meanwhile. */
    invalidate() {
      fetchedAt = -Infinity;
      refresh();
    },
  };
}

/** `OWNER (via cockpit) ...` -> `compose`; `OWNER (via <x>) ...` -> `chat:<x>`; anything else -> null (omitted). */
export function channelOf(answer) {
  const m = /^OWNER \(via ([^)]+)\)/.exec(String(answer ?? ''));
  if (!m) return null;
  return m[1] === 'cockpit' ? 'compose' : `chat:${m[1]}`;
}

const firstLineOf = (text) => stripTag(String(text ?? '').split('\n').find((l) => l.trim()) ?? '').slice(0, 140);

/**
 * POST /api/fleet/owner-answer: one answer or one security resolve, validated against a fresh read of the queue.
 * Returns the ProductReply; `onAccepted({key, answer, first})` runs after a zero exit of `close`.
 */
export async function answerOwner(body, { readers, env, onAccepted, warn = console.warn }) {
  const b = body && typeof body === 'object' ? body : {};
  const id = typeof b.id === 'string' ? b.id : '';
  const idLog = JSON.stringify(String(b.id ?? '')).slice(0, 220);
  const rejected = (reason) => { warn(`[fleet] owner-answer ${idLog} rejected: ${reason}`); return { reply: 'rejected', reason }; };
  if (id.length < 1 || id.length > 200 || id.startsWith('-')) return rejected('id must be 1 to 200 characters and must not start with -');
  const resolve = b.resolve === true;
  const hasChoice = b.choice !== undefined && b.choice !== null;
  const hasText = b.text !== undefined && b.text !== null;
  if (hasChoice === hasText) return rejected('send exactly one of choice and text');
  if (resolve && hasChoice) return rejected('a resolve carries text, not a choice');
  if (hasChoice && (typeof b.choice !== 'string' || !b.choice)) return rejected('choice must be a string');
  const maxText = resolve ? 300 : 1000;
  const text = hasText && typeof b.text === 'string' ? b.text.trim() : '';
  if (hasText && (!text || text.length > maxText)) return rejected(`text must be 1 to ${maxText} characters`);

  const opts = { timeoutMs: OWNER_QUEUE_TIMEOUT_MS, env };
  const list = async (all) => {
    const argv = [readers.python, readers.ownerQueue, 'list', ...(all ? ['--all'] : []), '--json'];
    const { stdout } = await runReader(argv, opts);
    const rows = parseJson(stdout, 'owner_queue.py list --json');
    if (!Array.isArray(rows)) throw new Error('owner_queue.py list --json printed no array');
    return rows;
  };
  let record;
  try {
    record = (await list(false)).find((r) => String(r?.id) === id);
    if (!record) {
      const latest = (await list(true)).find((r) => String(r?.id) === id);
      if (latest?.status === 'closed') {
        const winning = String(latest.answer ?? '');
        const channel = channelOf(winning);
        warn(`[fleet] owner-answer ${idLog} conflict: already closed${channel ? ` via ${channel}` : ''}`);
        return { reply: 'conflict', winning_value: winning, ...(channel ? { channel } : {}) };
      }
      return rejected('unknown id');
    }
  } catch (error) {
    return rejected(`the owner queue could not be read (${String(error?.message ?? error).slice(0, 160)})`);
  }

  const group = groupOf(record.text);
  let answer;
  if (resolve) {
    if (group !== 'security') return rejected('only a security row can be resolved');
    answer = `OWNER (via cockpit): resolved: ${text}`;
  } else {
    if (group === 'security') return rejected('a security row is resolved, not answered');
    if (group !== 'asks') return rejected('only an ask can be answered');
    if (hasChoice) {
      const option = optionsOf(record).find((o) => o.value === b.choice);
      if (!option) return rejected('choice is not one of the options');
      answer = `OWNER (via cockpit): ${choiceText(option)}`;
    } else {
      answer = `OWNER (via cockpit): ${text}`;
    }
  }
  try {
    await runReader([readers.python, readers.ownerQueue, 'close', id, '--answer', answer], opts);
  } catch (error) {
    return rejected(`owner_queue.py close failed (${String(error?.message ?? error).slice(0, 160)})`);
  }
  onAccepted?.({ key: `${resolve ? 'security' : 'ask'}:${id}`, answer, first: resolve ? null : firstLineOf(record.text), ts: record.ts });
  return { reply: 'accepted' };
}

/**
 * Mount `GET /api/fleet`. Behind the existing auth gate in remote mode (not allowlisted), loopback otherwise.
 * `cadenceHandler` is a getter so the route sees the handler `attachCadenceUiRoutes` stored on app.locals.
 */
export function attachFleetRoutes(app, {
  env = process.env,
  readers = resolveFleetReaders(env),
  cadenceHandler = () => app.locals?.cadenceUiHandler,
  now = Date.now,
  warn = console.warn,
  info = console.log,
  ttlMs = TTL_MS,
  timeoutMs = TIMEOUT_MS,
  notifyStore = null,
  ownerQueueFile = resolveOwnerQueueFile(env),
} = {}) {
  const opts = (name) => ({ ttlMs: ttlMs[name], now, warn, info });
  // An env with no queue path (no HOME: only a hermetic test env) keeps sm_status's own panel, a reader of the same file,
  // so nothing is lost; /api/fleet/owner-gates then answers unreadable with readOwnerGates' WARNING.
  const ownerGates = () => readOwnerGates({ file: ownerQueueFile, env, now: now(), warn });
  const caches = {
    stratum: createSourceCache('stratum', () => readStratum(readers, env, timeoutMs.stratum), opts('stratum')),
    sm_status: createSourceCache('sm_status', () => readSmStatus(readers, env, timeoutMs.sm_status), opts('sm_status')),
    cadence: createSourceCache('cadence', () => readCadence(cadenceHandler(), readers), opts('cadence')),
  };

  app.get(FLEET_ROUTE, async (_req, res) => {
    try {
      const [stratum, smStatus, cadence] = await Promise.all([caches.stratum.get(), caches.sm_status.get(), caches.cadence.get()]);
      if (smStatus.value?.jobs) {
        smStatus.value = { ...smStatus.value, jobs: { ...smStatus.value.jobs, value: mergeJobs(smStatus.value.jobs.value, stratum.value) } };
      }
      // The cached sm_status entry is never mutated: the owner-gates panel goes on a copy, read fresh per request.
      const sm = ownerQueueFile && smStatus.value ? { ...smStatus, value: { ...smStatus.value, queue: readOpenQueuePanel({ file: ownerQueueFile, env, now: now(), warn }) } } : smStatus;
      res.set('cache-control', 'no-store');
      const body = { generated: new Date(now()).toISOString(), sources: { stratum, sm_status: sm, cadence } };
      if (notifyStore) {
        try { body.notify = notifyStore.get(); } catch (error) { body.notify = { error: String(error?.message ?? error).slice(0, 200) }; }
      }
      res.json(body);
    } catch (error) {
      res.status(500).json({ error: String(error?.message ?? error) });
    }
  });

  app.get(OWNER_GATES_ROUTE, (_req, res) => {
    res.set('cache-control', 'no-store');
    res.json(ownerGates());
  });

  app.post(OWNER_ANSWER_ROUTE, requireSensitiveOrPaired, async (req, res) => {
    const reply = await answerOwner(req.body, {
      readers,
      env,
      warn,
      onAccepted: ({ key, answer, first, ts }) => {
        try { notifyStore?.answered(key, { answer, first, ts }); } catch (error) { warn(`[fleet] owner-answer: the answered entry was not written (${String(error?.message ?? error).slice(0, 160)})`); }
        caches.sm_status.invalidate();
      },
    });
    res.set('cache-control', 'no-store');
    res.json(reply);
  });
  return caches;
}
