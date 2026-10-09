// lib/codegraph/cache-validity.js — STRAT-CODEGRAPH-1
//
// Is a cached snapshot still what `smartmemory code bundle` would produce now? Compose does not
// copy core's read rules (which folders the collector prunes, which configs the resolvers read).
// It checks three things instead, and anything it cannot verify makes the snapshot invalid:
//
//   (a) git HEAD of the indexed root equals the snapshot's `source.head` (non-git roots skip this);
//   (b) the working-tree state hash recorded at production is unchanged: every path
//       `git status --porcelain=v1 --untracked-files=all --ignored=traditional` lists under the root
//       (ignored files too: core does not read .gitignore), keyed by content or stat; plus, from
//       `git ls-files -s -v`, files git is told not to look at, tracked symlinks (keyed by what they
//       point to) and submodules (their own state, recursively). Non-git roots: a stat walk of every
//       file under the root. A stat key is trusted only when the file last changed more than
//       RACY_WINDOW_MS before the state was read (git's "racily clean" rule); snapshot.js does not
//       store a snapshot whose state has such a file;
//   (c) every `source.resolution_dependencies` entry core recorded still holds (exists, content
//       sha256, or the members_sha256 of a listing/glob, recomputed by the recipe below). At store
//       time, a dependency outside the root that changed after the producer started is not trusted
//       (core hashes dependencies after parsing, so its recorded hash can postdate what it parsed).
//
// Every state record is a JSON array, so no path (a name may hold `=`, `\n` or `>`) can make two
// different trees serialize alike.
//
// Over-invalidation is accepted; under-invalidation is not. Paths with a `.compose` segment are left
// out of (b) because the producer always runs with `--exclude .compose` (snapshot.js bundleArgv).
//
// members_sha256 recipe: smart-memory-docs docs/features/CODE-BUNDLE-CLI-1/design.md,
// "members_sha256 recipe" (core 1.5.26 snapshot.py::membership_digest). Python 3.12 semantics.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export class Unverifiable extends Error {
  constructor(message) {
    super(message);
    this.name = 'Unverifiable';
  }
}

// Errors Python's pathlib treats as "does not exist" (pathlib._ignore_error); anything else raises.
const ABSENT = new Set(['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP']);

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** One state record. JSON frames every field, so file names cannot forge a record boundary. */
const rec = (...fields) => JSON.stringify(fields);

function git(cwd, args) {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, timeout: 120000 }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// (b) working-tree state

/**
 * A file whose mtime or ctime is this close to (or after) the moment its stat key was read can be
 * rewritten within the same timestamp tick, at the same size, and keep its key. 3 s covers 2 s FAT
 * and 1 s HFS+ granularity.
 */
export const RACY_WINDOW_MS = 3000;

/** Per-read context: when the read started and how many stat keys were too recent to trust. */
function stateContext(racyWindowMs) {
  return { racyAfterNs: BigInt(Date.now() - racyWindowMs) * 1000000n, racy: 0 };
}

/** Where a symlink leads: the target file's content, or a directory's stat (directories are not followed). */
function linkTargetKey(path, ctx) {
  try {
    const st = statSync(path);
    if (st.isDirectory()) return rec('dir', statKey(path, ctx, false));
    return st.isFile() ? sha256(readFileSync(path)) : rec('other', statKey(path, ctx, false));
  } catch (err) {
    if (ABSENT.has(err.code)) return 'dangling';
    throw new Unverifiable(`read ${path}: ${err.code ?? err.message}`);
  }
}

/**
 * lstat key (bigint ns times). A symlink is keyed by its link text and what it leads to; a regular
 * file changed within the racy window is counted in `ctx.racy`.
 */
function statKey(path, ctx, follow = true) {
  let l;
  try {
    l = (follow ? lstatSync : statSync)(path, { bigint: true });
  } catch (err) {
    if (ABSENT.has(err.code)) return 'missing';
    throw new Unverifiable(`stat ${path}: ${err.code ?? err.message}`);
  }
  if (l.isSymbolicLink()) return rec('link', readlinkSync(path), linkTargetKey(path, ctx));
  if (l.isFile() && (l.mtimeNs >= ctx.racyAfterNs || l.ctimeNs >= ctx.racyAfterNs)) ctx.racy++;
  return `${l.mode}:${l.ino}:${l.size}:${l.mtimeNs}:${l.ctimeNs}`;
}

/** Stat keys of every entry under `dir` (not following directory symlinks, skipping .git and .compose). */
function walkStats(dir, label, out, ctx) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Unverifiable(`read ${dir}: ${err.code ?? err.message}`);
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.compose') continue;
    const path = join(dir, entry.name);
    const name = label ? `${label}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkStats(path, name, out, ctx);
    else out.push(rec('stat', name, statKey(path, ctx)));
  }
}

/** Content key of a listed (non-ignored) path: sha256 of a file, a stat walk of a directory. */
function contentKey(path, label, out, ctx) {
  let l;
  try {
    l = lstatSync(path);
  } catch (err) {
    if (ABSENT.has(err.code)) return 'missing';
    throw new Unverifiable(`stat ${path}: ${err.code ?? err.message}`);
  }
  if (l.isDirectory()) {
    walkStats(path, label, out, ctx);
    return 'dir';
  }
  if (l.isSymbolicLink()) return rec('link', readlinkSync(path), linkTargetKey(path, ctx));
  try {
    return sha256(readFileSync(path));
  } catch (err) {
    if (ABSENT.has(err.code)) return 'missing';
    throw new Unverifiable(`read ${path}: ${err.code ?? err.message}`);
  }
}

/**
 * The working-tree state of one indexed root, for (a) and (b).
 *
 * @param {string} root
 * @param {{racyWindowMs?: number}} [opts]  test seam; production uses RACY_WINDOW_MS
 * @returns {Promise<{git: boolean, head: string, hash: string, paths: number, racy: number} | {error: string}>}
 *   `head` is '' for a non-git root or an unborn branch. `racy`: stat keys too recent to trust.
 */
export async function worktreeState(root, { racyWindowMs = RACY_WINDOW_MS } = {}) {
  try {
    const ctx = stateContext(racyWindowMs);
    const top = await git(root, ['rev-parse', '--show-toplevel']);
    if (!top.ok) {
      const lines = [];
      walkStats(root, '', lines, ctx);
      lines.sort();
      return { git: false, head: '', hash: sha256(`nogit\0${lines.join('\n')}`), paths: lines.length, racy: ctx.racy };
    }
    const toplevel = top.stdout.trim();
    const [head, status, indexed] = await Promise.all([
      git(root, ['rev-parse', '--verify', '-q', 'HEAD']),
      git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=traditional', '--ignore-submodules=none', '--', '.']),
      // Every index entry under the root, toplevel-relative like porcelain: `<tag> <mode> <sha> <stage>\t<path>`.
      git(root, ['ls-files', '-s', '-v', '--full-name', '-z', '--', '.']),
    ]);
    if (!status.ok) return { error: `git status failed: ${status.stderr.trim().split('\n').pop()}` };
    if (!indexed.ok) return { error: `git ls-files failed: ${indexed.stderr.trim().split('\n').pop()}` };
    // Porcelain and --full-name paths are relative to the toplevel; `.compose` counts only below the indexed root.
    const rootDepth = relative(toplevel, realpathSync(root)).split('/').filter(Boolean).length;
    const ownState = (path) => path.split('/').slice(rootDepth).includes('.compose');
    const lines = [];
    const parts = status.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const record = parts[i];
      if (!record) continue;
      const xy = record.slice(0, 2);
      const path = record.slice(3);
      const origin = xy[0] === 'R' || xy[0] === 'C' ? parts[++i] ?? '' : '';
      if (ownState(path) && (!origin || ownState(origin))) continue;
      const abs = join(toplevel, path);
      if (path.endsWith('/')) {
        // A nested repository (or an ignored directory git did not expand): every file in it.
        walkStats(abs, path.slice(0, -1), lines, ctx);
        lines.push(rec(xy, path, origin, 'dir'));
      } else if (xy === '!!') {
        lines.push(rec(xy, path, origin, statKey(abs, ctx)));
      } else {
        lines.push(rec(xy, path, origin, contentKey(abs, path, lines, ctx)));
      }
    }
    // What a clean status hides: files git is told not to look at (assume-unchanged: lowercase tag;
    // skip-worktree: S), tracked symlinks (git compares the link text, core reads the target) and
    // submodules (a clean gitlink hides the submodule's own untracked and ignored files).
    const seen = new Set();
    for (const record of indexed.stdout.split('\0')) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const [tag, mode] = record.slice(0, tab).split(' ');
      const path = record.slice(tab + 1);
      if (seen.has(path) || ownState(path)) continue;
      seen.add(path);
      const abs = join(toplevel, path);
      if (mode === '160000') {
        if (followedExists(join(abs, '.git'))) {
          const inner = await worktreeState(abs, { racyWindowMs });
          if (inner.error) return { error: `submodule ${path}: ${inner.error}` };
          ctx.racy += inner.racy;
          lines.push(rec('G', path, inner.head, inner.hash));
        } else if (isDir(abs)) {
          walkStats(abs, path, lines, ctx);
          lines.push(rec('G', path, 'unpopulated'));
        } else lines.push(rec('G', path, 'missing'));
      } else if (tag === 'S' || (tag >= 'a' && tag <= 'z') || mode === '120000') {
        lines.push(rec(tag, mode, path, contentKey(abs, path, lines, ctx)));
      }
    }
    lines.sort();
    const headSha = head.ok ? head.stdout.trim() : '';
    return { git: true, head: headSha, hash: sha256(`git\0${headSha}\0${lines.join('\n')}`), paths: lines.length, racy: ctx.racy };
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------------------------
// (c) resolution dependencies

/** Python `json.dumps` text of a str, ensure_ascii=True (escapes outside 0x20..0x7e, surrogate pairs). */
function pyJsonString(text) {
  const hex = (n) => `\\u${n.toString(16).padStart(4, '0')}`;
  const named = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
  let out = '"';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (named[ch]) out += named[ch];
    else if (cp >= 0x20 && cp <= 0x7e) out += ch;
    else if (cp > 0xffff) {
      const v = cp - 0x10000;
      out += hex(0xd800 + (v >> 10)) + hex(0xdc00 + (v & 0x3ff));
    } else out += hex(cp);
  }
  return `${out}"`;
}

/** Python `json.dumps` of the member values (str, None, list), default or compact separators. */
export function pyJsonDumps(value, { compact = false } = {}) {
  if (value === null) return 'null';
  if (typeof value === 'string') return pyJsonString(value);
  if (Array.isArray(value)) return `[${value.map((v) => pyJsonDumps(v, { compact })).join(compact ? ',' : ', ')}]`;
  throw new Unverifiable(`unexpected member value ${JSON.stringify(value)}`);
}

/** sha256 of the members, sorted by their default-separator JSON text, serialized compact. */
export function digestMembers(members) {
  const keyed = members.map((m) => [pyJsonDumps(m), m]);
  keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(pyJsonDumps(keyed.map(([, m]) => m), { compact: true }));
}

/** `str(pathlib.PurePosixPath(text))`: collapse `//` and `.` segments, drop a trailing slash. */
function pyPathText(text) {
  const lead = text.startsWith('//') && !text.startsWith('///') ? '//' : text.startsWith('/') ? '/' : '';
  const parts = text.split('/').filter((p) => p && p !== '.');
  if (!lead && parts.length === 0) return '.';
  return lead + parts.join('/');
}

/** Python 3.12 `PurePath.suffix` of a name: '' for `name.` and for `.rc`. */
function pySuffix(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot) : '';
}

function checkoutRoots(checkout) {
  const abs = resolve(checkout);
  let real;
  try {
    real = realpathSync(abs);
  } catch (err) {
    throw new Unverifiable(`checkout ${abs}: ${err.code ?? err.message}`);
  }
  return [...new Set([abs, real])];
}

/** Posix path of `path` relative to the first root containing it, '.' for a root itself, else null. */
function insideRoots(path, roots) {
  for (const root of roots) {
    if (path === root) return '.';
    if (path.startsWith(root.endsWith('/') ? root : `${root}/`)) return relative(root, path);
  }
  return null;
}

/** Python `Path.is_file()` / `is_dir()` (symlinks followed): 'file' | 'dir' | 'other'. */
function followedKind(path) {
  try {
    const st = statSync(path);
    return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
  } catch (err) {
    if (ABSENT.has(err.code)) return 'other';
    throw new Unverifiable(`stat ${path}: ${err.code ?? err.message}`);
  }
}

// Set by checkResolutionDependencies while it checks recency: every directory a recipe reads.
let observeDir = null;

function readNames(dir) {
  observeDir?.(dir);
  try {
    return readdirSync(dir);
  } catch (err) {
    throw new Unverifiable(`read ${dir}: ${err.code ?? err.message}`);
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch (err) {
    if (ABSENT.has(err.code)) return false;
    throw new Unverifiable(`stat ${path}: ${err.code ?? err.message}`);
  }
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (err) {
    if (ABSENT.has(err.code)) return false;
    throw new Unverifiable(`lstat ${path}: ${err.code ?? err.message}`);
  }
}

/** realpath of a symlink member, which must resolve inside the checkout (core's digest is null otherwise). */
function assertResolvesInside(path, roots) {
  let real;
  try {
    real = realpathSync(path);
  } catch (err) {
    throw new Unverifiable(`${path}: ${err.code ?? err.message}`);
  }
  if (insideRoots(real, roots) === null) throw new Unverifiable(`${path} resolves outside the checkout`);
}

/** The base of a listing/glob: an existing directory inside the checkout, as core requires for a digest. */
function assertBase(base, roots) {
  if (!isDir(base)) throw new Unverifiable(`${base} is not a directory`);
  assertResolvesInside(base, roots);
}

/** `listing`: one [name, kind, target] per direct entry. */
function listingMembers(base, roots) {
  assertBase(base, roots);
  return readNames(base).map((name) => {
    const path = join(base, name);
    let target = null;
    if (isLink(path)) {
      assertResolvesInside(path, roots);
      target = pyPathText(readlinkSync(path));
      if (isAbsolute(target)) {
        const rel = insideRoots(resolve(target), roots);
        if (rel === null) throw new Unverifiable(`${path} links outside the checkout`);
        target = `$root/${rel}`;
      }
    }
    return [name, followedKind(path), target];
  });
}

// Characters a /u regex needs escaped (it rejects identity escapes of anything else).
const REGEX_SYNTAX = new Set([...'^$\\.*+?()[]{}|/']);
const CLASS_SYNTAX = new Set([...REGEX_SYNTAX, '-']);

/**
 * One pattern segment as Python `fnmatch.translate` would match it (case-sensitive, posix), over code
 * points: Python's `?` and `[...]` match one character, so an astral character is one, not two.
 */
function segmentRegex(text) {
  const segment = [...text];
  const esc = (c) => (REGEX_SYNTAX.has(c) ? `\\${c}` : c);
  const escClass = (c) => (CLASS_SYNTAX.has(c) ? `\\${c}` : c);
  let out = '';
  let i = 0;
  while (i < segment.length) {
    const c = segment[i++];
    if (c === '*') {
      if (!out.endsWith('[\\s\\S]*')) out += '[\\s\\S]*';
    } else if (c === '?') {
      out += '[\\s\\S]';
    } else if (c === '[') {
      let j = i;
      if (segment[j] === '!') j++;
      if (segment[j] === ']') j++;
      while (j < segment.length && segment[j] !== ']') j++;
      if (j >= segment.length) {
        out += '\\[';
        continue;
      }
      let stuff = segment.slice(i, j);
      i = j + 1;
      const negate = stuff[0] === '!';
      if (negate) stuff = stuff.slice(1);
      if (!stuff) {
        out += negate ? '[\\s\\S]' : '(?!)';
        continue;
      }
      let cls = '';
      for (let k = 0; k < stuff.length; k++) {
        if (stuff[k + 1] === '-' && k + 2 < stuff.length) {
          const lo = stuff[k];
          const hi = stuff[k + 2];
          if (!/[A-Za-z0-9]/.test(lo) || !/[A-Za-z0-9]/.test(hi) || lo > hi) {
            throw new Unverifiable(`glob range ${lo}-${hi} is not supported`);
          }
          cls += `${lo}-${hi}`;
          k += 2;
        } else if (stuff[k] === '-') {
          throw new Unverifiable(`glob bracket ${JSON.stringify(stuff.join(''))} is not supported`);
        } else cls += escClass(stuff[k]);
      }
      out += `[${negate ? '^' : ''}${cls}]`;
    } else out += esc(c);
  }
  return new RegExp(`^${out}$`, 'u');
}

/**
 * `glob` without exclude_dirs: Python 3.12 `Path(base).glob(pattern)`, each match relative to base.
 * Every segment is a wildcard selector (3.12 has no precise selector): it lists the parent and matches
 * names case-sensitively, hidden names included, and every segment but the last keeps directories only
 * (symlinks followed). `**`, `..` and absolute patterns are not ported: unverifiable.
 */
function patternMembers(base, pattern, roots) {
  if (typeof pattern !== 'string' || !pattern || pattern.startsWith('/')) {
    throw new Unverifiable(`glob pattern ${JSON.stringify(pattern)} is not supported`);
  }
  const segments = pattern.split('/').filter((p) => p && p !== '.');
  if (pattern.endsWith('/')) segments.push('');
  if (segments.length === 0 || segments.some((s) => s === '..' || s.includes('**'))) {
    throw new Unverifiable(`glob pattern ${JSON.stringify(pattern)} is not supported`);
  }
  assertBase(base, roots);
  const matchers = segments.map((s) => (s ? segmentRegex(s) : null));
  let current = [''];
  for (let n = 0; n < matchers.length; n++) {
    const matcher = matchers[n];
    if (!matcher) break; // trailing slash: the previous segment already kept directories only
    const dirOnly = n < matchers.length - 1;
    const next = [];
    for (const rel of current) {
      const parent = rel ? join(base, rel) : base;
      // A directory reached through a symlink is consulted even when nothing below it matches.
      if (rel) assertResolvesInside(parent, roots);
      for (const name of readNames(parent)) {
        const child = rel ? `${rel}/${name}` : name;
        if (dirOnly && !isDir(join(base, child))) continue;
        if (matcher.test(name)) next.push(child);
      }
    }
    current = next;
  }
  // Intermediate segments follow directory symlinks, so any match can lead outside the checkout.
  for (const rel of current) assertResolvesInside(join(base, rel), roots);
  return current;
}

/**
 * `glob` with exclude_dirs: core's importer inventory walk (os.walk, followlinks=False). Prunes
 * directory names in exclude_dirs, names ending in `.egg-info`, names in exclude_unless_package
 * without an `__init__.py` file, and directory symlinks; keeps non-directories whose suffix is in
 * source_suffixes and that are not `.d.ts`.
 * A symlink outside a pruned directory (a directory link, a member, or any other file) resolving
 * outside the checkout makes core's digest null, so it is unverifiable here.
 */
function walkMembers(base, entry, roots) {
  const always = new Set(entry.exclude_dirs);
  const unless = new Set(Array.isArray(entry.exclude_unless_package) ? entry.exclude_unless_package : []);
  if (!Array.isArray(entry.source_suffixes)) throw new Unverifiable('glob entry has no source_suffixes');
  const suffixes = new Set(entry.source_suffixes);
  assertBase(base, roots);
  const members = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const dir = rel ? join(base, rel) : base;
    for (const name of readNames(dir)) {
      const path = join(dir, name);
      const child = rel ? `${rel}/${name}` : name;
      if (isDir(path)) {
        const pruned = always.has(name) || name.endsWith('.egg-info')
          || (unless.has(name) && followedKind(join(path, '__init__.py')) !== 'file');
        if (pruned) continue;
        // Not followed, but core's digest is null when it resolves outside (design.md null case).
        if (isLink(path)) assertResolvesInside(path, roots);
        else stack.push(child);
        continue;
      }
      // Any symlink the walk meets, member or not, must resolve inside (over-invalidation accepted).
      if (isLink(path)) assertResolvesInside(path, roots);
      if (!suffixes.has(pySuffix(name)) || name.endsWith('.d.ts')) continue;
      members.push(child);
    }
  }
  return members;
}

function followedExists(path) {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if (ABSENT.has(err.code)) return false;
    throw new Unverifiable(`stat ${path}: ${err.code ?? err.message}`);
  }
}

/** members_sha256 of one listing/glob entry, recomputed. Throws Unverifiable. */
export function membersDigest(entry, checkout, roots = checkoutRoots(checkout)) {
  const base = isAbsolute(entry.path) ? entry.path : join(resolve(checkout), entry.path);
  if (entry.kind === 'listing') return digestMembers(listingMembers(base, roots));
  if (entry.kind === 'glob') {
    if (Array.isArray(entry.exclude_dirs)) return digestMembers(walkMembers(base, entry, roots));
    return digestMembers(patternMembers(base, entry.pattern, roots));
  }
  throw new Unverifiable(`kind ${JSON.stringify(entry.kind)} has no members`);
}

function fileSha256(path) {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

/** Why one entry no longer holds (or cannot be checked), or null when it still holds. */
function entryProblem(entry, checkout, roots) {
  if (!entry || typeof entry.path !== 'string' || !entry.path) return 'an entry has no path';
  const path = isAbsolute(entry.path) ? entry.path : join(resolve(checkout), entry.path);
  switch (entry.kind) {
    case 'exists':
      if (typeof entry.exists !== 'boolean') return `${entry.path}: exists is not a boolean`;
      return followedExists(path) === entry.exists ? null : `${entry.path}: ${entry.exists ? 'was removed' : 'appeared'}`;
    case 'content':
      if (typeof entry.sha256 !== 'string' || !entry.sha256) return `${entry.path}: no recorded sha256`;
      return fileSha256(path) === entry.sha256 ? null : `${entry.path}: content changed`;
    case 'listing':
    case 'glob':
      if (typeof entry.members_sha256 !== 'string' || !entry.members_sha256) {
        return `${entry.path}: core could not digest its members (${entry.members_error ?? 'no members_sha256'})`;
      }
      return membersDigest(entry, checkout, roots) === entry.members_sha256 ? null : `${entry.path}: ${entry.kind} members changed`;
    default:
      return `${entry.path}: unknown dependency kind ${JSON.stringify(entry.kind)}`;
  }
}

/** Did `path` (the link or what it leads to) change at or after `sinceNs`? Missing paths did not. */
function changedSince(path, sinceNs) {
  for (const read of [lstatSync, statSync]) {
    try {
      const st = read(path, { bigint: true });
      if (st.mtimeNs >= sinceNs || st.ctimeNs >= sinceNs) return true;
    } catch (err) {
      if (!ABSENT.has(err.code)) throw new Unverifiable(`stat ${path}: ${err.code ?? err.message}`);
    }
  }
  return false;
}

/**
 * (c): does every resolution dependency the snapshot's producer recorded still hold?
 *
 * @param {object} source    the snapshot's `source` block
 * @param {string} checkout  the indexed root (the path given to `code bundle`)
 * @param {{changedSinceNs?: bigint}} [opts]  at store time: a dependency outside the root (or under
 *   `.compose`, which (b) leaves out) whose path, or any directory its recipe reads, changed at or
 *   after this time fails. (b)'s before/after comparison already covers everything inside the root.
 * @returns {{ok: true, checked: number} | {ok: false, reason: string}}
 */
export function checkResolutionDependencies(source, checkout, { changedSinceNs } = {}) {
  const deps = source?.resolution_dependencies;
  if (!Array.isArray(deps)) return { ok: false, reason: 'the snapshot has no source.resolution_dependencies' };
  const touched = new Set();
  try {
    const roots = checkoutRoots(checkout);
    if (changedSinceNs != null) observeDir = (dir) => touched.add(dir);
    for (const entry of deps) {
      const problem = entryProblem(entry, checkout, roots);
      if (problem) return { ok: false, reason: problem };
      touched.add(isAbsolute(entry.path) ? entry.path : join(resolve(checkout), entry.path));
    }
    if (changedSinceNs != null) {
      for (const path of touched) {
        let real = path;
        try {
          real = realpathSync(path);
        } catch {
          // missing: judged by its own lstat below (absent counts as unchanged)
        }
        const rel = insideRoots(real, roots);
        if (rel !== null && !rel.split('/').includes('.compose')) continue;
        if (changedSince(path, changedSinceNs)) {
          return { ok: false, reason: `${path} changed while the producer ran (its recorded state may postdate what core parsed)` };
        }
      }
    }
    return { ok: true, checked: deps.length };
  } catch (err) {
    return { ok: false, reason: `unverifiable: ${err?.message ?? err}` };
  } finally {
    observeDir = null;
  }
}
