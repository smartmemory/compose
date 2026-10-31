#!/usr/bin/env node
// Writes one secret into the sealed dir from stdin, never from argv or env, and never echoes it (COMP-COCKPIT-WIRING-1 gap 6).
// Usage: <producer> | node scripts/sealed-put.mjs <ref> [--replace]
// The dir is $WIKI_SEALED_DIR, else ~/.config/smartmemory-wiki/sealed: the dir scripts/cockpit.sh loads from.
// Rules, the same as the wiki's owner_token.py: mode 0600, O_EXCL create, no symlink followed (neither the file nor its
// dir). A replace (only with --replace) writes a temp file beside the target and renames it over, so a reader never sees
// a half-written value. Prints `ok <ref>` and nothing else; a refusal names the reason, never the value.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import tty from 'node:tty';

const REF_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;

function refuse(msg) {
  process.stderr.write(`sealed-put: refused: ${msg}\n`);
  process.exit(2);
}

function checkDir(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = fs.lstatSync(dir);
  }
  if (st.isSymbolicLink()) refuse('the sealed dir is a symlink');
  if (!st.isDirectory()) refuse('the sealed dir is not a directory');
  if (st.uid !== process.getuid()) refuse('the sealed dir is not owned by this user');
  if (st.mode & 0o077) refuse('the sealed dir is open to group or others (want 0700)');
}

/** The value from stdin with trailing line ends dropped, or a refusal. */
function readValue() {
  if (tty.isatty(0)) refuse('stdin is a terminal; pipe the value in');
  const value = fs.readFileSync(0, 'utf8').replace(/[\r\n]+$/, '');
  if (!value) refuse('empty value');
  if (value === 'null') refuse('the value is the literal null (a jq field that was missing?)');
  if (/[\x00-\x20\x7f]/.test(value)) refuse('the value holds whitespace or control characters');
  return value;
}

function main(argv) {
  const args = argv.slice(2);
  const replace = args.includes('--replace');
  const rest = args.filter((a) => a !== '--replace');
  if (rest.length !== 1) refuse('usage: sealed-put.mjs <ref> [--replace] (the value comes on stdin)');
  const ref = rest[0];
  if (!REF_RE.test(ref)) refuse('the ref must be lowercase letters, digits and dashes');

  const dir = process.env.WIKI_SEALED_DIR || path.join(os.homedir(), '.config', 'smartmemory-wiki', 'sealed');
  checkDir(dir);
  const target = path.join(dir, ref);
  let exists = false;
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) refuse(`${ref} is a symlink`);
    if (!st.isFile()) refuse(`${ref} is not a regular file`);
    exists = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (exists && !replace) refuse(`${ref} exists; pass --replace to replace it`);

  const value = readValue();
  const tmp = path.join(dir, `.${ref}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    try {
      fs.fchmodSync(fd, 0o600); // the umask may have taken bits off the create mode
      fs.writeSync(fd, value);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Create: link() fails on an existing name, so a racing writer is refused rather than overwritten.
    // Replace: rename() swaps the directory entry and never follows a symlink that appeared since the check.
    if (exists) fs.renameSync(tmp, target);
    else fs.linkSync(tmp, target);
  } catch (e) {
    if (e.code === 'EEXIST') {
      fs.rmSync(tmp, { force: true }); // refuse() exits, so the finally below would not run
      refuse(`${ref} appeared while writing; nothing replaced`);
    }
    throw new Error(`write failed (${e.code ?? 'error'})`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  process.stdout.write(`ok ${ref}\n`);
}

try {
  main(process.argv);
} catch (e) {
  refuse(e.message.split('\n')[0]); // fs errors carry paths and codes, never the value (it is only on stdin)
}
