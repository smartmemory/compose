#!/usr/bin/env node
/**
 * lib/launch-events-cli.js — the door the ops scripts use to write launch and hop events (COMP-DOGFOOD-LAUNCH-GATE-1).
 *
 *   node lib/launch-events-cli.js append --root <workspace> <json|->   (`-` reads JSON lines from stdin, one result line each)
 *   node lib/launch-events-cli.js queue --root <workspace>              (the open retry queue, JSON)
 *   node lib/launch-events-cli.js ingest-hops --root <workspace> [--log <hop-governor.log>]
 *
 * `append` prints `{"status":"written"|"duplicate"|"invalid"|"refused", ...}` per event; exit 0 when every event was written
 * or already there, 2 when any was invalid or its `process` re-check refused it, 1 on bad usage. A `launch.running` event's
 * receipt is re-checked and stored by lib/evidence.js (A's checker) before the row is appended, so the row carries `ev:<id>`.
 * The root is always explicit (detach_job passes the fleet workspace): the cockpit's current project never decides it.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEvidence, recordEvidence } from './evidence.js';
import { ingestGovernorLog, readLaunchEvents, recordLaunchEvent, retryQueue } from './launch-events.js';

/** A's checker as the CLI's `check` dep: `{evidence_id}` or throws `{code, reasons}`. */
export function checkProcessReceipt(receipt) {
  const accepted = checkEvidence(receipt, 'launch-events');
  const rec = recordEvidence(accepted.evidence, { checks: accepted.checks });
  return { evidence_id: rec.id };
}

function opt(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr, stdin: () => readFileSync(0, 'utf8') }, deps = { check: checkProcessReceipt }) {
  const [cmd] = argv;
  const root = opt(argv, '--root');
  if (!root || !['append', 'queue', 'ingest-hops'].includes(cmd)) {
    io.err.write('usage: launch-events-cli.js append --root <dir> <json|-> | queue --root <dir> | ingest-hops --root <dir> [--log <file>]\n');
    return 1;
  }
  if (cmd === 'queue') {
    io.out.write(JSON.stringify(retryQueue(readLaunchEvents(root), Date.now())) + '\n');
    return 0;
  }
  if (cmd === 'ingest-hops') {
    const log = opt(argv, '--log') || join(homedir(), '.claude', 'logs', 'hop-governor.log');
    const r = ingestGovernorLog(root, log, { warn: (m) => io.err.write(`${m}\n`) });
    io.out.write(JSON.stringify(r) + '\n');
    return r.invalid.length ? 2 : 0;
  }
  const arg = argv[argv.length - 1];
  if (arg === root || arg === '--root') { io.err.write('launch-events-cli: append needs the event JSON (or -)\n'); return 1; }
  const texts = arg === '-' ? io.stdin().split('\n').filter((l) => l.trim()) : [arg];
  let worst = 0;
  for (const text of texts) {
    let ev;
    try { ev = JSON.parse(text); } catch (e) {
      io.out.write(JSON.stringify({ status: 'invalid', errors: [`not JSON: ${e.message}`] }) + '\n');
      worst = 2;
      continue;
    }
    const r = recordLaunchEvent(root, ev, deps);
    io.out.write(JSON.stringify({ status: r.status, key: ev?.idempotency_key ?? null, ...(r.row?.evidence_id !== undefined ? { evidence_id: r.row.evidence_id } : {}), ...(r.errors ? { errors: r.errors } : {}) }) + '\n');
    if (r.status === 'invalid' || r.status === 'refused') worst = 2;
  }
  return worst;
}

const _self = fileURLToPath(import.meta.url);
let _entry = null;
try { _entry = process.argv[1] && realpathSync(process.argv[1]); } catch { _entry = null; }
if (_entry === _self) process.exitCode = main();
