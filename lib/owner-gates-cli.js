#!/usr/bin/env node
/**
 * owner-gates-cli.js — COMP-DOGFOOD-OWNER-QUEUE-1: print the owner's open questions as JSON, the same list the cockpit,
 * the day ribbon and the MCP `get_pending_gates` tool read (lib/owner-gates.js `readOwnerGates`). Read only.
 *
 *   node lib/owner-gates-cli.js list [--root <workspace>] [--file <owner-queue.jsonl>]
 *
 * `--root` is the SmartMemory workspace (its `smart-memory-ops/coordination/owner-queue.jsonl`) or the ops repo itself
 * (`coordination/owner-queue.jsonl`). With neither flag the file resolves from the env (resolveOwnerQueueFile).
 * Exit 0 with `{file, count, gates}`; exit 2 with `{unreadable: true, error}` when the queue cannot be read; 64 on usage.
 */
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOwnerGates } from './owner-gates.js';

const USAGE = 'usage: node lib/owner-gates-cli.js list [--root <workspace>] [--file <owner-queue.jsonl>]';

export function fileForRoot(root) {
  const asOps = join(root, 'coordination', 'owner-queue.jsonl');
  return existsSync(asOps) ? asOps : join(root, 'smart-memory-ops', 'coordination', 'owner-queue.jsonl');
}

export function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr, env = process.env } = {}) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'list') { err.write(`${USAGE}\n`); return 64; }
  let file;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if ((flag !== '--root' && flag !== '--file') || !value) { err.write(`${USAGE}\n`); return 64; }
    file = flag === '--root' ? fileForRoot(value) : value;
    i += 1;
  }
  const result = readOwnerGates({ file, env, warn: (m) => err.write(`${m}\n`) });
  out.write(`${JSON.stringify(result)}\n`);
  return result.unreadable ? 2 : 0;
}

const _self = fileURLToPath(import.meta.url);
let _entry = null;
try { _entry = process.argv[1] && realpathSync(process.argv[1]); } catch { _entry = null; }
if (_entry === _self) process.exitCode = main();
