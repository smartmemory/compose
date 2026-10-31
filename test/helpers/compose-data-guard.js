/**
 * COMP-TEST-STATE-LEAK-1: no test process may write the real checkout's `.compose/data`.
 *
 * Incident (2026-10-31): the owner's cockpit read the checkout's `.compose/data`, and every full suite had been
 * appending fixture state there: `checkpoints-<FIXTURE>.jsonl` (TEST-1 at 30 MB), 9,574 of the 9,590 rows in
 * `gate-log.jsonl`, all from route tests that injected a temp `projectRoot` while a writer resolved the
 * process-global root (the cwd, i.e. this checkout). There is no single resolver to guard: ~20 modules join
 * `<cwd>/.compose/data` themselves. Every one of them ends in a node `fs` call, so this module guards that call.
 *
 * Fail closed, never redirect: a write, append, open-for-write, mkdir that would create, rename, copy into, remove,
 * truncate or link under the protected dir throws `ECOMPOSETESTLEAK` naming the path. Nothing is silently moved.
 * Code that swallows the error (best-effort writers such as `anchorBoundary`) still fails the run: each refusal is
 * appended to a ledger file, and the process that installed the guard first for this root (the `node --test` runner)
 * fails at exit when the ledger is non-empty. Node children inherit the guard through NODE_OPTIONS, so the alarm
 * counts writes made by the test process tree and nothing else: the cockpit, the pre-push hook's own log, and other
 * sessions write the same dir during a ~35 min suite and are separate processes.
 *
 * Not covered (no Node `fs` call to intercept): a non-Node writer (shell redirect, python, git) in the test tree, and a
 * node child spawned with an env that drops NODE_OPTIONS.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(dirname(SELF)));
export const PROTECTED_DATA_DIR = join(ROOT, '.compose', 'data');
const realRoot = (() => { try { return fs.realpathSync(ROOT); } catch { return ROOT; } })();
const FORMS = [...new Set([PROTECTED_DATA_DIR, join(realRoot, '.compose', 'data')])];

// One variable per protected dir, so a nested run against another checkout (the gate stand-in in
// git-sandbox-guard.test.js) keeps its own ledger while the outer run keeps the real one.
const LEDGER_ENV = `COMPOSE_TEST_DATA_LEDGER_${createHash('sha1').update(PROTECTED_DATA_DIR).digest('hex').slice(0, 12)}`;
const orig = {
  appendFileSync: fs.appendFileSync, readFileSync: fs.readFileSync, existsSync: fs.existsSync,
  mkdtempSync: fs.mkdtempSync, rmSync: fs.rmSync,
};

// The first process to load the guard for THIS root owns the ledger; its node children inherit the variable.
const owner = !process.env[LEDGER_ENV];
if (owner) process.env[LEDGER_ENV] = join(orig.mkdtempSync(join(tmpdir(), 'compose-test-data-ledger-')), 'refusals.log');
const LEDGER = process.env[LEDGER_ENV];
const importFlag = `--import=${pathToFileURL(SELF).href}`;
if (!(process.env.NODE_OPTIONS ?? '').includes(importFlag)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${importFlag}`.trim();
}

const refusals = [];

/** True when `p` (string, Buffer or file URL; relative to the cwd) names the protected dir or anything under it. */
export function isProtectedPath(p) {
  if (p == null || typeof p === 'number') return false;
  let s;
  try { s = p instanceof URL ? fileURLToPath(p) : Buffer.isBuffer(p) ? p.toString() : String(p); } catch { return false; }
  const abs = resolve(s);
  return FORMS.some((f) => abs === f || abs.startsWith(f + sep));
}

function leakError(op, target) {
  const line = `${process.pid} ${op} ${resolve(String(target))}`;
  refusals.push(line);
  try { orig.appendFileSync(LEDGER, `${line}\n`); } catch { /* the in-process exit check still fires */ }
  return Object.assign(new Error(`COMPOSE TEST STATE LEAK: ${op} ${resolve(String(target))} refused. A test process may not write the real `
    + `checkout's .compose/data (${PROTECTED_DATA_DIR}); give the code under test a temp project root (mkdtemp), or set COMPOSE_TARGET.`),
  { code: 'ECOMPOSETESTLEAK' });
}

const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
const writesFlags = (flags) => (typeof flags === 'number' ? (flags & WRITE_FLAGS) !== 0 : /[wax+]/.test(String(flags ?? 'r')));

// [name, which args are targets (index list), optional predicate on args that must hold for it to count as a write]
const OPS = [
  ['writeFile', [0]], ['appendFile', [0]], ['truncate', [0]], ['unlink', [0]], ['rmdir', [0]], ['rm', [0]],
  ['mkdtemp', [0]], ['rename', [0, 1]], ['copyFile', [1]], ['cp', [1]], ['link', [1]], ['symlink', [1]],
  // mkdir of a dir that already exists changes nothing, and creating the empty data dir itself (ensureDataDir on a
  // fresh worktree) leaks nothing; both are allowed so a run behaves the same in the main checkout and a worktree.
  ['mkdir', [0], (a) => !orig.existsSync(a[0]) && !FORMS.includes(resolve(String(a[0])))],
  ['open', [0], (a) => writesFlags(a[1])],
];

function firstHit(idx, args, when) {
  if (when && !when(args)) return null;
  for (const i of idx) if (isProtectedPath(args[i])) return args[i];
  return null;
}

function wrap(holder, name, kind, idx, when) {
  const fn = holder[name];
  if (typeof fn !== 'function') return;
  holder[name] = function guarded(...args) {
    const hit = firstHit(idx, args, when);
    if (hit !== null) {
      const err = leakError(`${kind === 'promise' ? 'fs.promises.' : 'fs.'}${name}`, hit);
      if (kind === 'promise') return Promise.reject(err);
      const cb = kind === 'callback' ? args.at(-1) : null;
      if (typeof cb === 'function') { process.nextTick(cb, err); return undefined; }
      throw err;
    }
    return fn.apply(this, args);
  };
}

for (const [name, idx, when] of OPS) {
  wrap(fs, `${name}Sync`, 'sync', idx, when);
  wrap(fs, name, 'callback', idx, when);
  wrap(fs.promises, name, 'promise', idx, when);
}
wrap(fs, 'createWriteStream', 'sync', [0]);
syncBuiltinESMExports();

process.on('exit', () => {
  let ledger = '';
  if (owner) {
    try { ledger = orig.existsSync(LEDGER) ? orig.readFileSync(LEDGER, 'utf8') : ''; } catch { /* reported as own refusals only */ }
    try { orig.rmSync(dirname(LEDGER), { recursive: true, force: true }); } catch { /* best effort */ }
  }
  const lines = [...new Set([...refusals, ...ledger.split('\n').filter(Boolean)])];
  if (!lines.length) return;
  process.stderr.write(`\nGOLDEN-LEAK GATE (compose data): this test process tree tried to write the real checkout's .compose/data `
    + `(${PROTECTED_DATA_DIR}); every write was refused. Give the code under test a temp project root. Refused (pid op path):\n  ${lines.join('\n  ')}\n`);
  process.exitCode = 1;
});
