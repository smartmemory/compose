#!/usr/bin/env node
/**
 * lib/ledger-records-cli.js — the door smart-memory-ops uses to write and read ledger records (COMP-DOGFOOD-CUTOVER-1).
 *
 *   node lib/ledger-records-cli.js append --root <workspace> -                      (JSON lines on stdin, one result line each)
 *   node lib/ledger-records-cli.js list --root <workspace> [--since <iso>] [--until <iso>]   (JSON lines, oldest day first)
 *
 * `append` prints `{"status":"written"|"duplicate"|"invalid","id","day",errors?}` per input line, in order; exit 0 when every line was
 * written or already there, 2 when any was invalid, 1 on bad usage or when the store could not be written (locked, IO: the message is on
 * stderr and no result line is printed, so the caller keeps every row). `list` is read only; bad bounds exit 1.
 * The root is always explicit (the fleet workspace): the cockpit's current project never decides it.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readLedgerRecords, recordLedgerLines } from './ledger-records.js';

const USAGE = 'usage: ledger-records-cli.js append --root <dir> - | list --root <dir> [--since <iso>] [--until <iso>]';

function opt(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr, stdin: () => readFileSync(0, 'utf8') }) {
  const [cmd] = argv;
  const root = opt(argv, '--root');
  if (!root || !['append', 'list'].includes(cmd)) { io.err.write(`${USAGE}\n`); return 1; }
  const warn = (m) => io.err.write(`${m}\n`);
  if (cmd === 'list') {
    let rows;
    try { rows = readLedgerRecords(root, { since: opt(argv, '--since'), until: opt(argv, '--until'), warn }); } catch (e) {
      io.err.write(`ledger-records-cli: ${e.message}\n`);
      return 1;
    }
    io.out.write(rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
    return 0;
  }
  if (argv[argv.length - 1] !== '-') { io.err.write(`${USAGE}\n`); return 1; }
  const texts = io.stdin().split('\n').filter((l) => l.trim());
  const parsed = texts.map((t) => { try { return JSON.parse(t); } catch (e) { return { _bad: `not JSON: ${e.message}` }; } });
  let results;
  try {
    // a line that is not JSON is passed as a non-object so it fails validation in its place, keeping one result per input line
    results = recordLedgerLines(root, parsed.map((p) => (p && p._bad ? null : p)), { warn });
  } catch (e) {
    io.err.write(`ledger-records-cli: store not written: ${e.message}\n`);
    return 1;
  }
  let worst = 0;
  results.forEach((r, i) => {
    if (parsed[i] && parsed[i]._bad) r.errors = [parsed[i]._bad];
    if (r.status === 'invalid') worst = 2;
    io.out.write(`${JSON.stringify(r)}\n`);
  });
  return worst;
}

const _self = fileURLToPath(import.meta.url);
let _entry = null;
try { _entry = process.argv[1] && realpathSync(process.argv[1]); } catch { _entry = null; }
if (_entry === _self) process.exitCode = main();
