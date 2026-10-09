// lib/codegraph/cache-validity.js — STRAT-CODEGRAPH-1
//
// Is a cached snapshot still what `smartmemory code bundle` would produce now? Compose does not
// copy core's read rules (which folders the collector prunes, which configs the resolvers read).
// It checks three things instead, and anything it cannot verify makes the snapshot invalid:
//
//   (a) git HEAD of the indexed root equals the snapshot's `source.head` (non-git roots skip this);
//   (b) the working-tree state hash recorded at production is unchanged: every path
//       `git status --porcelain=v1 --untracked-files=all --ignored=traditional` lists under the root
//       (ignored files too: core does not read .gitignore), keyed by content or stat. Non-git roots: a
//       stat walk of every file under the root;
//   (c) every `source.resolution_dependencies` entry core recorded still holds (exists, content
//       sha256, or the members_sha256 of a listing/glob, recomputed by the recipe below).
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

function git(cwd, args) {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, timeout: 120000 }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// (b) working-tree state

/** lstat key (bigint ns times); a symlink adds its link text and its target's stat. */
function statKey(path) {
  let l;
  try {
    l = lstatSync(path, { bigint: true });
  } catch (err) {
    if (ABSENT.has(err.code)) return 'missing';
    throw new Unverifiable(`stat ${path}: ${err.code ?? err.message}`);
  }
  let key = `${l.mode}:${l.ino}:${l.size}:${l.mtimeNs}:${l.ctimeNs}`;
  if (l.isSymbolicLink()) {
    key += `>${readlinkSync(path)}`;
    try {
      const t = statSync(path, { bigint: true });
      key += `>${t.mode}:${t.ino}:${t.size}:${t.mtimeNs}:${t.ctimeNs}`;
    } catch (err) {
      if (!ABSENT.has(err.code)) throw new Unverifiable(`stat ${path}: ${err.code ?? err.message}`);
      key += '>dangling';
    }
  }
  return key;
}

/** Stat keys of every entry under `dir` (not following directory symlinks, skipping .git and .compose). */
function walkStats(dir, label, out) {
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
    if (entry.isDirectory()) walkStats(path, name, out);
    else out.push(`${name}=${statKey(path)}`);
  }
}

/** Content key of a listed (non-ignored) path: sha256 of a file, a stat walk of a directory. */
function contentKey(path, label, out) {
  let l;
  try {
    l = lstatSync(path);
  } catch (err) {
    if (ABSENT.has(err.code)) return 'missing';
    throw new Unverifiable(`stat ${path}: ${err.code ?? err.message}`);
  }
  if (l.isDirectory()) {
    walkStats(path, label, out);
    return 'dir';
  }
  if (l.isSymbolicLink()) {
    let target = 'dangling';
    try {
      target = statSync(path).isDirectory() ? `dir:${statKey(path)}` : sha256(readFileSync(path));
    } catch (err) {
      if (!ABSENT.has(err.code)) throw new Unverifiable(`read ${path}: ${err.code ?? err.message}`);
    }
    return `link:${readlinkSync(path)}>${target}`;
  }
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
 * @returns {Promise<{git: boolean, head: string, hash: string, paths: number} | {error: string}>}
 *   `head` is '' for a non-git root or an unborn branch.
 */
export async function worktreeState(root) {
  try {
    const top = await git(root, ['rev-parse', '--show-toplevel']);
    if (!top.ok) {
      const lines = [];
      walkStats(root, '', lines);
      lines.sort();
      return { git: false, head: '', hash: sha256(`nogit\0${lines.join('\n')}`), paths: lines.length };
    }
    const toplevel = top.stdout.trim();
    const [head, status, flagged] = await Promise.all([
      git(root, ['rev-parse', '--verify', '-q', 'HEAD']),
      git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=traditional', '--', '.']),
      // Tracked files git is told not to look at (assume-unchanged: lowercase tag; skip-worktree: S) never
      // show in status however they change, so they are content-keyed directly.
      git(root, ['ls-files', '-v', '-z', '--', '.']),
    ]);
    if (!status.ok) return { error: `git status failed: ${status.stderr.trim().split('\n').pop()}` };
    if (!flagged.ok) return { error: `git ls-files failed: ${flagged.stderr.trim().split('\n').pop()}` };
    // Porcelain paths are relative to the toplevel; `.compose` counts only below the indexed root.
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
      const label = `${xy} ${path}${origin ? ` <- ${origin}` : ''}`;
      if (path.endsWith('/')) {
        // A nested repository (or an ignored directory git did not expand): every file in it.
        walkStats(abs, path.slice(0, -1), lines);
        lines.push(`${label}=dir`);
      } else if (xy === '!!') {
        lines.push(`${label}=${statKey(abs)}`);
      } else {
        lines.push(`${label}=${contentKey(abs, path, lines)}`);
      }
    }
    for (const record of flagged.stdout.split('\0')) {
      const tag = record[0];
      if (!record || !(tag === 'S' || (tag >= 'a' && tag <= 'z'))) continue;
      const path = record.slice(2);
      if (ownState(path)) continue;
      lines.push(`${tag} ${path}=${contentKey(join(toplevel, path), path, lines)}`);
    }
    lines.sort();
    const headSha = head.ok ? head.stdout.trim() : '';
    return { git: true, head: headSha, hash: sha256(`git\0${headSha}\0${lines.join('\n')}`), paths: lines.length };
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

function readNames(dir) {
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

/** `listing`: one [name, kind, target] per direct entry. */
function listingMembers(base, roots) {
  return readNames(base).map((name) => {
    const path = join(base, name);
    let target = null;
    if (isLink(path)) {
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

/** One pattern segment as Python `fnmatch.translate` would match it (case-sensitive, posix). */
function segmentRegex(segment) {
  const esc = (c) => (/[A-Za-z0-9]/.test(c) ? c : `\\${c}`);
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
      const negate = stuff.startsWith('!');
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
          throw new Unverifiable(`glob bracket ${JSON.stringify(stuff)} is not supported`);
        } else cls += esc(stuff[k]);
      }
      out += `[${negate ? '^' : ''}${cls}]`;
    } else out += esc(c);
  }
  return new RegExp(`^${out}$`);
}

/**
 * `glob` without exclude_dirs: Python 3.12 `Path(base).glob(pattern)`, each match relative to base.
 * Every segment is a wildcard selector (3.12 has no precise selector): it lists the parent and matches
 * names case-sensitively, hidden names included, and every segment but the last keeps directories only
 * (symlinks followed). `**`, `..` and absolute patterns are not ported: unverifiable.
 */
function patternMembers(base, pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.startsWith('/')) {
    throw new Unverifiable(`glob pattern ${JSON.stringify(pattern)} is not supported`);
  }
  const segments = pattern.split('/').filter((p) => p && p !== '.');
  if (pattern.endsWith('/')) segments.push('');
  if (segments.length === 0 || segments.some((s) => s === '..' || s.includes('**'))) {
    throw new Unverifiable(`glob pattern ${JSON.stringify(pattern)} is not supported`);
  }
  if (!isDir(base)) return [];
  const matchers = segments.map((s) => (s ? segmentRegex(s) : null));
  let current = [''];
  for (let n = 0; n < matchers.length; n++) {
    const matcher = matchers[n];
    if (!matcher) break; // trailing slash: the previous segment already kept directories only
    const dirOnly = n < matchers.length - 1;
    const next = [];
    for (const rel of current) {
      const parent = rel ? join(base, rel) : base;
      for (const name of readNames(parent)) {
        const child = rel ? `${rel}/${name}` : name;
        if (dirOnly && !isDir(join(base, child))) continue;
        if (matcher.test(name)) next.push(child);
      }
    }
    current = next;
  }
  return current;
}

/**
 * `glob` with exclude_dirs: core's importer inventory walk (os.walk, followlinks=False). Prunes
 * directory names in exclude_dirs, names in exclude_unless_package without an `__init__.py`, and
 * directory symlinks; keeps non-directories whose suffix is in source_suffixes and that are not `.d.ts`.
 * A kept symlink resolving outside the checkout makes core's digest null, so it is unverifiable here.
 */
function walkMembers(base, entry, roots) {
  const always = new Set(entry.exclude_dirs);
  const unless = new Set(Array.isArray(entry.exclude_unless_package) ? entry.exclude_unless_package : []);
  if (!Array.isArray(entry.source_suffixes)) throw new Unverifiable('glob entry has no source_suffixes');
  const suffixes = new Set(entry.source_suffixes);
  if (!isDir(base)) return [];
  const members = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const dir = rel ? join(base, rel) : base;
    for (const name of readNames(dir)) {
      const path = join(dir, name);
      const child = rel ? `${rel}/${name}` : name;
      if (isDir(path)) {
        const pruned = always.has(name) || (unless.has(name) && !followedExists(join(path, '__init__.py')));
        if (!pruned && !isLink(path)) stack.push(child);
        continue;
      }
      if (!suffixes.has(pySuffix(name)) || name.endsWith('.d.ts')) continue;
      if (isLink(path)) {
        let real;
        try {
          real = realpathSync(path);
        } catch (err) {
          throw new Unverifiable(`${path}: ${err.code ?? err.message}`);
        }
        if (insideRoots(real, roots) === null) throw new Unverifiable(`${path} resolves outside the checkout`);
      }
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
    return digestMembers(patternMembers(base, entry.pattern));
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

/**
 * (c): does every resolution dependency the snapshot's producer recorded still hold?
 *
 * @param {object} source    the snapshot's `source` block
 * @param {string} checkout  the indexed root (the path given to `code bundle`)
 * @returns {{ok: true, checked: number} | {ok: false, reason: string}}
 */
export function checkResolutionDependencies(source, checkout) {
  const deps = source?.resolution_dependencies;
  if (!Array.isArray(deps)) return { ok: false, reason: 'the snapshot has no source.resolution_dependencies' };
  try {
    const roots = checkoutRoots(checkout);
    for (const entry of deps) {
      const problem = entryProblem(entry, checkout, roots);
      if (problem) return { ok: false, reason: problem };
    }
    return { ok: true, checked: deps.length };
  } catch (err) {
    return { ok: false, reason: `unverifiable: ${err?.message ?? err}` };
  }
}
