#!/usr/bin/env node
// lib/live-state-cli.js — COMP-DOGFOOD-LIVE-STATE-1
//
// The live-state store from a shell, for runners that are not an MCP client of
// Compose: the Claude `sm-ops` mod reads the section after a compaction with
// `read`, a ledger hook adds an OWNER line with `add`, a Codex or detached
// runner reads the same block with `read --text`. Same functions as the MCP
// tools (lib/live-state.js), so every runner gets the same text.
//
//   node lib/live-state-cli.js read      --root <ws> [--text] [--max-bytes N]
//   node lib/live-state-cli.js add       --root <ws> --text <t> --source <s> [--by <name>] [--at <iso>]
//                                        [--expires <iso> | --expires-in <N>h] [--supersedes LO-1,LO-2] [--key <event id>]...
//   node lib/live-state-cli.js supersede --root <ws> --id LO-n --by <LO-m|source> [--reason <r>]
//   node lib/live-state-cli.js configure --root <ws> --rules-dir <dir relative to the root>
//   node lib/live-state-cli.js backfill-keys --root <ws> --prefix <key prefix, e.g. owner-ledger:>
//   any command: [--now <iso>] sets the clock (a replayed ledger line, a reproducible fixture)
//
// add --key: an event already handled under that key (even one whose order was superseded) writes nothing and replies `handled: true`.
// --key repeats (at most 9): the add is handled if ANY of its keys is on ANY order, so one event can be known by its line and by its decision id.
//
// add --key, handled: the add's other keys are also recorded on the order it matched (an alias), so a later relay sharing any one of them is handled.
// backfill-keys: each order with no `keys` gains <prefix>D-NNNN from the first decision id in its text (else its source); idempotent, replies { changed: [ids] }.
//
// Output: one JSON document on stdout (`read --text`: the markdown section).
// Exit 0 ok, 2 usage, 3 store or workspace error, 4 refused (message on stderr).
//
// add, supersede, configure and backfill-keys are refused to the implementer and reviewer
// profiles (COMPOSE_SESSION_PROFILE, the rule the MCP writers use, FU-2); read is open.

import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveId } from './discover-workspaces.js';
import { ownerOrderWriterDenial, resolveProfile } from '../server/mcp-tool-policy.js';
import {
  LiveStateError, addOrder, backfillKeys, buildLiveState, configureLiveState, formatLiveStateSection, supersedeOrder,
} from './live-state.js';

const FLAGS = new Set(['root', 'text', 'source', 'by', 'at', 'expires', 'expires-in', 'supersedes', 'id', 'reason',
  'rules-dir', 'max-bytes', 'now', 'key', 'prefix']);

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new LiveStateError(`unexpected argument: ${a}`, 'usage');
    const k = a.slice(2);
    if (k === 'text' && cmd === 'read') { opts.asText = true; continue; }
    if (!FLAGS.has(k)) throw new LiveStateError(`unknown flag --${k}`, 'usage');
    if (i + 1 >= rest.length) throw new LiveStateError(`--${k} needs a value`, 'usage');
    opts[k] = rest[++i];
    if (k === 'key') (opts.keyList ??= []).push(opts[k]);
  }
  return { cmd, opts };
}

const WRITERS = new Set(['add', 'supersede', 'configure', 'backfill-keys']);

export function run(argv, { now: nowIn = new Date(), env = process.env } = {}) {
  const { cmd, opts } = parseArgs(argv);
  if (WRITERS.has(cmd)) {
    const why = ownerOrderWriterDenial(cmd, resolveProfile(env.COMPOSE_SESSION_PROFILE, null));
    if (why) throw new LiveStateError(`OWNER_ORDER_WRITER_DENIED: ${why}`, 'denied');
  }
  // --now: the clock for this call (a replayed ledger line, a reproducible fixture)
  const now = opts.now !== undefined ? new Date(opts.now) : nowIn;
  if (Number.isNaN(now.getTime())) throw new LiveStateError('--now must be an ISO date-time', 'usage');
  if (!opts.root) throw new LiveStateError('--root <workspace> is required', 'usage');
  const root = resolve(opts.root);
  if (!existsSync(join(root, '.compose', 'compose.json'))) {
    throw new LiveStateError(`not a Compose workspace (no .compose/compose.json): ${root}`, 'workspace');
  }
  const dataDir = join(root, '.compose', 'data');
  switch (cmd) {
    case 'read': {
      const view = buildLiveState({ root, dataDir, workspaceId: deriveId({ root }).id, now });
      const maxBytes = opts['max-bytes'] ? Number(opts['max-bytes']) : undefined;
      const text = formatLiveStateSection(view, maxBytes ? { maxBytes } : {});
      return opts.asText ? text : JSON.stringify({ view, text });
    }
    case 'add': {
      let expires = opts.expires;
      if (opts['expires-in'] !== undefined) {
        const m = /^([1-9][0-9]*)h$/.exec(opts['expires-in']);
        if (!m) throw new LiveStateError('--expires-in takes <N>h', 'usage');
        const base = opts.at ? Date.parse(opts.at) : now.getTime();
        expires = new Date(base + Number(m[1]) * 3_600_000).toISOString();
      }
      const supersedes = opts.supersedes ? opts.supersedes.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      return JSON.stringify(addOrder(dataDir, { text: opts.text, source: opts.source, by: opts.by, at: opts.at, expires, supersedes, key: opts.keyList?.[0], keys: opts.keyList?.slice(1) }, { now }));
    }
    case 'supersede':
      return JSON.stringify(supersedeOrder(dataDir, { id: opts.id, superseded_by: opts.by, reason: opts.reason }, { now }));
    case 'backfill-keys':
      return JSON.stringify(backfillKeys(dataDir, { prefix: opts.prefix }));
    case 'configure':
      return JSON.stringify(configureLiveState(dataDir, { root, rules_dir: opts['rules-dir'] }));
    default:
      throw new LiveStateError(`unknown command: ${cmd ?? '(none)'} (read | add | supersede | configure | backfill-keys)`, 'usage');
  }
}

// realpath both sides: node gives import.meta.url as the realpath, so a symlinked
// argv[1] compared unresolved would never match and the CLI would exit 0 silently (F4)
function invokedDirectly() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (invokedDirectly()) {
  try {
    process.stdout.write(run(process.argv.slice(2)) + '\n');
  } catch (err) {
    process.stderr.write(`live-state: ${err.message}\n`);
    const code = err instanceof LiveStateError ? ({ usage: 2, denied: 4 }[err.code] ?? 3) : 3;
    process.exit(code);
  }
}
