// The local SmartMemory key's path into the cockpit (COMP-COCKPIT-WIRING-1 gap 6): scripts/sealed-put.mjs writes it
// into the sealed dir from stdin, and cockpit.sh load_sm_key reads it into the var named by smartmemory.apiKeyEnv.
// Synthetic values only, all in a tmp dir.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WRITER = resolve(import.meta.dirname, '..', 'scripts', 'sealed-put.mjs');
const COCKPIT = resolve(import.meta.dirname, '..', 'scripts', 'cockpit.sh');
const REF = 'compose-sm-key';
const OLD = 'synthetic-old-0123456789abcdef0123456789';
const NEW = 'synthetic-new-fedcba9876543210fedcba9876';

describe('sealed-put.mjs: stdin-only writer for the sealed dir', () => {
  it('creates, replaces and refuses by row; never prints the value', () => {
    const root = mkdtempSync(join(tmpdir(), 'sealed-put-'));
    try {
      const sealed = (name) => {
        const d = join(root, name);
        mkdirSync(d, { mode: 0o700 });
        chmodSync(d, 0o700);
        return d;
      };
      // Each setup returns the WIKI_SEALED_DIR to pass and the dir to inspect.
      const fresh = (name) => { const d = sealed(name); return { env: d, real: d }; };
      const withOld = (name) => { const d = sealed(name); writeFileSync(join(d, REF), OLD, { mode: 0o600 }); return { env: d, real: d }; };
      const linkAtTarget = (name) => {
        const d = sealed(name);
        writeFileSync(join(d, 'elsewhere'), OLD, { mode: 0o600 });
        symlinkSync(join(d, 'elsewhere'), join(d, REF));
        return { env: d, real: d };
      };
      const linkedParent = (name) => { const d = sealed(name); const l = join(root, `${name}-link`); symlinkSync(d, l); return { env: l, real: d }; };
      const looseDir = (name) => { const d = sealed(name); chmodSync(d, 0o770); return { env: d, real: d }; };
      // name, setup, args, stdin, exit, value at <real>/<REF> afterwards (null = absent), what elsewhere must still hold
      const ROWS = [
        ['create: new file, mode 0600', fresh, [REF], `${NEW}\n`, 0, NEW, null],
        ['exists without --replace: refused, old value kept', withOld, [REF], `${NEW}\n`, 2, OLD, null],
        ['replace with --replace: new value, mode 0600', withOld, [REF, '--replace'], `${NEW}\n`, 0, NEW, null],
        ['symlink at the target: refused, its target untouched', linkAtTarget, [REF, '--replace'], `${NEW}\n`, 2, 'symlink', OLD],
        ['symlinked parent dir: refused, nothing written', linkedParent, [REF], `${NEW}\n`, 2, null, null],
        ['empty stdin: refused', fresh, [REF], '\n', 2, null, null],
        ['jq null (a missing field): refused', fresh, [REF], 'null\n', 2, null, null],
        ['value as an argument: refused by usage, nothing written', fresh, [REF, NEW], '', 2, null, null],
        ['dir open to the group: refused', looseDir, [REF], `${NEW}\n`, 2, null, null],
        ['ref with a slash: refused', fresh, ['../escape'], `${NEW}\n`, 2, null, null],
      ];
      ROWS.forEach(([name, setup, args, stdin, exit, want, elsewhere], i) => {
        const { env, real } = setup(`r${i}`);
        const r = spawnSync(process.execPath, [WRITER, ...args], {
          input: stdin,
          encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: root, WIKI_SEALED_DIR: env },
        });
        assert.equal(r.status, exit, `${name}: exit (${r.stderr})`);
        assert.ok(!`${r.stdout}${r.stderr}`.includes(NEW) && !`${r.stdout}${r.stderr}`.includes(OLD), `${name}: output never carries a value`);
        if (exit === 0) assert.equal(r.stdout, `ok ${REF}\n`, `${name}: stdout`);
        const f = join(real, REF);
        if (want === null) assert.ok(!existsSync(f), `${name}: no file`);
        else if (want === 'symlink') assert.ok(lstatSync(f).isSymbolicLink(), `${name}: the link is left as it was`);
        else {
          assert.equal(readFileSync(f, 'utf8'), want, `${name}: value`);
          assert.equal(lstatSync(f).mode & 0o777, 0o600, `${name}: mode`);
        }
        if (elsewhere !== null) assert.equal(readFileSync(join(real, 'elsewhere'), 'utf8'), elsewhere, `${name}: link target`);
        assert.deepEqual(readdirSync(real).filter((n) => n.includes('.tmp-')), [], `${name}: no temp file left`);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cockpit.sh load_sm_key', () => {
  it('loads the named var from the sealed file only for an enabled loopback block', () => {
    const root = mkdtempSync(join(tmpdir(), 'sm-key-env-'));
    try {
      const NAME = 'COMPOSE_SM_KEY';
      const sealed = join(root, 'sealed');
      mkdirSync(sealed);
      writeFileSync(join(sealed, REF), `${NEW}\n`, { mode: 0o600 });
      const linked = join(root, 'linked');
      mkdirSync(linked);
      symlinkSync(join(sealed, REF), join(linked, REF));
      const proj = (i, smartmemory) => {
        const dir = join(root, `p${i}`);
        mkdirSync(join(dir, '.compose'), { recursive: true });
        writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ smartmemory }));
        return dir;
      };
      const local = { enabled: true, baseUrl: 'http://localhost:9001', apiKeyEnv: NAME };
      // name, smartmemory block, sealed dir, preset value, expected value, expected stdout note
      const ROWS = [
        ['loopback block, var unset: read from the sealed file', local, sealed, undefined, NEW, ''],
        ['127.0.0.1 works the same', { ...local, baseUrl: 'http://127.0.0.1:9001' }, sealed, undefined, NEW, ''],
        ['already set: not overridden', local, sealed, 'from-the-environment', 'from-the-environment', ''],
        ['non-loopback baseUrl: the local key is never loaded', { ...local, baseUrl: 'https://api.example.com' }, sealed, undefined, '<unset>', ''],
        ['disabled block: nothing loaded', { ...local, enabled: false }, sealed, undefined, '<unset>', ''],
        ['VITE_ name: refused, nothing loaded', { ...local, apiKeyEnv: 'VITE_SM_KEY' }, sealed, undefined, '<unset>', ''],
        ['sealed file is a symlink: not read, names the var', local, linked, undefined, '<unset>', NAME],
        ['sealed file missing: starts anyway, names the var', local, join(root, 'nowhere'), undefined, '<unset>', NAME],
      ];
      ROWS.forEach(([name, block, dir, preset, want, note], i) => {
        const varName = block.apiKeyEnv;
        const env = { PATH: process.env.PATH, HOME: root, COMPOSE_TARGET: proj(i, block), WIKI_SEALED_DIR: dir };
        if (preset !== undefined) env[varName] = preset;
        const r = spawnSync('bash', ['-c', `source "${COCKPIT}"; load_sm_key; printf '|%s' "\${${varName}:-<unset>}"`], { env, encoding: 'utf8' });
        assert.equal(r.status, 0, `${name}: exit (${r.stderr})`);
        const [said, got] = r.stdout.split('|');
        assert.equal(got, want, `${name}: value`);
        if (note) assert.ok(said.includes(note), `${name}: names the var`);
        assert.ok(!said.includes(NEW), `${name}: the message never carries the value`);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
