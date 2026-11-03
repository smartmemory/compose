#!/usr/bin/env node
/**
 * lib/evidence-cli.js — record or read one receipt without MCP
 * (COMP-DOGFOOD-EVIDENCE-GATE-1). Claude is one arm; Codex, shell runners and
 * the ops scripts mint and resolve `ev:<id>` the same way through this file.
 *
 *   node lib/evidence-cli.js record '<evidence json>' [--subject '<json>']   (or `-` to read stdin)
 *   node lib/evidence-cli.js show ev:<id>
 *
 * `record` prints one JSON line `{"evidence_id":"ev:…","checks":[…]}` and exits
 * 0; a refused receipt prints `{"code":…,"reasons":[…]}` on stderr and exits 2;
 * bad usage or unparsable JSON exits 1. `show` prints the stored record or
 * exits 2 when the store does not hold the id.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkEvidence, readEvidence, recordEvidence } from './evidence.js';

export function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr }) {
  const [cmd, arg] = argv;
  const si = argv.indexOf('--subject');
  if (cmd === 'show' && arg) {
    const rec = readEvidence(arg);
    if (!rec) { io.err.write(JSON.stringify({ code: 'EVIDENCE_UNKNOWN_REF', reasons: [`${arg} is not in the evidence store`] }) + '\n'); return 2; }
    io.out.write(JSON.stringify(rec) + '\n');
    return 0;
  }
  if (cmd !== 'record' || !arg) {
    io.err.write('usage: evidence-cli.js record <json|-> [--subject <json>] | show ev:<id>\n');
    return 1;
  }
  let ev;
  try { ev = JSON.parse(arg === '-' ? readFileSync(0, 'utf8') : arg); } catch (e) {
    io.err.write(`evidence-cli: the evidence is not JSON: ${e.message}\n`);
    return 1;
  }
  try {
    if (typeof ev === 'string') throw Object.assign(new Error('pass the evidence object; an ev:<id> is already recorded'), { code: 'EVIDENCE_INVALID', reasons: ['pass the evidence object'] });
    let subject;
    if (si !== -1) {
      try { subject = JSON.parse(argv[si + 1]); } catch (e) {
        io.err.write(`evidence-cli: --subject is not JSON: ${e.message}\n`);
        return 1;
      }
    }
    const accepted = checkEvidence(ev, 'evidence-cli');
    const rec = recordEvidence(accepted.evidence, { checks: accepted.checks, subject });
    io.out.write(JSON.stringify({ evidence_id: rec.id, checks: rec.checks, ...(rec.subject ? { subject: rec.subject } : {}) }) + '\n');
    return 0;
  } catch (e) {
    io.err.write(JSON.stringify({ code: e.code || 'ERROR', reasons: e.reasons || [e.message] }) + '\n');
    return 2;
  }
}

const _self = fileURLToPath(import.meta.url);
let _entry = null;
try { _entry = process.argv[1] && realpathSync(process.argv[1]); } catch { _entry = null; }
if (_entry === _self) process.exitCode = main();
