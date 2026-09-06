import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createTestSigner, DESCRIPTOR_NAMESPACE } from './helpers/sshsig-sign.js';
import { SUDO_ENV, PUBKEY_PATH } from '../lib/guard-custody.js';
import { createRequire } from 'node:module';

const enrol = await import('../lib/guard-enrol.js').catch(() => null);
const require = createRequire(import.meta.url);
const { parseAllowedSigners } = enrol ? await import(require.resolve('@smartmemory/stratum/dist/guard/sshsig.js')) : {};

test('principal validation and sudoers text have the specified contract', { skip: !enrol }, () => {
  for (const value of ['ruze', 'A', 'a.b_c-9', 'z'.repeat(64)]) assert.equal(enrol.PRINCIPAL_RE.test(value), true, value);
  for (const value of ['', '-bad', 'has space', 'x'.repeat(65), 'nonascii-\u00e9']) assert.equal(enrol.PRINCIPAL_RE.test(value), false, value);
  assert.equal(enrol.SUDOERS_TEXT('ruze'),
    'Defaults!/Library/Compose/guard/sign timestamp_timeout=0\nruze ALL=(root) /Library/Compose/guard/sign\n');
});

test('sudoers golden file passes visudo when this account can run it without sudo', { skip: !enrol }, async (t) => {
  const probe = spawnSync('/usr/sbin/visudo', ['-V'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return t.skip(`/usr/sbin/visudo unavailable without sudo: ${probe.error?.message || probe.stderr || probe.status}`);
  const dir = await mkdtemp(path.join(tmpdir(), 'guard-visudo-'));
  const file = path.join(dir, 'compose-guard');
  await writeFile(file, enrol.SUDOERS_TEXT('tester'));
  const checked = spawnSync('/usr/sbin/visudo', ['-cf', file], { encoding: 'utf8' });
  if (checked.error || checked.status !== 0) return t.skip(`visudo -cf unavailable without sudo: ${checked.error?.message || checked.stderr || checked.status}`);
  assert.match(checked.stdout + checked.stderr, /parsed OK/i);
});

test('installScript embeds the packaged signer bytes via a quoted heredoc, never its filesystem path', { skip: !enrol }, () => {
  const packagedSigner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'guard-sign', 'compose-guard-sign.sh');
  const signerBytes = readFileSync(packagedSigner, 'utf8');
  const moduleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // the compose checkout root, which the old bug interpolated as part of the packaged-signer path
  const script = enrol.installScript('tester');
  // The rendered script must contain the signer's own content (first line and
  // a body line), proving the bytes are embedded rather than referenced...
  assert.ok(script.includes(signerBytes.split('\n')[0]), 'script should contain the signer script first line');
  assert.ok(script.includes('/usr/bin/ssh-keygen -Y sign -q -f "$KEY" -n "$NAMESPACE" "$WORK/message"'), 'script should contain a body line from the signer');
  // The heredoc opener must be quoted (<<'DELIM') — an unquoted opener
  // (<<DELIM) would let the shell expand every $-prefixed token in the
  // signer's own body (KEY, STAGE_ROOT, NAMESPACE, WORK, ...) before writing
  // it out, corrupting the installed signer.
  assert.ok(script.includes("<<'COMPOSE_GUARD_SIGNER_SCRIPT'"), 'heredoc opener must be quoted to suppress expansion');
  // Every line of the signer that contains a `$` must appear byte-for-byte in
  // the rendered script — proof the heredoc did not expand any of them.
  for (const line of signerBytes.split('\n')) {
    if (line.includes('$')) assert.ok(script.includes(line), `signer line with $ must appear unexpanded: ${JSON.stringify(line)}`);
  }
  // ...and must never contain the module directory path a space or shell
  // metacharacter in an install path could have broken/injected via unquoted
  // interpolation.
  assert.ok(!script.includes(moduleDir), 'script should not reference the packaged-signer filesystem path');
  assert.ok(!script.includes('compose-guard-sign.sh'), 'script should not reference the packaged-signer filename');
});

test('locateTrustRoot distinguishes a source checkout from a dist-only package', { skip: !enrol }, async () => {
  const source = await enrol.locateTrustRoot({ packageRoot: '/fixture/source', exists: async (file) => file === '/fixture/source/contracts/guard-signers.allowed' });
  assert.deepEqual(source, { kind: 'source', path: '/fixture/source/contracts/guard-signers.allowed', checkoutRoot: '/fixture/source' });
  const dist = await enrol.locateTrustRoot({ packageRoot: '/fixture/dist', exists: async (file) => file === '/fixture/dist/dist/contracts/guard-signers.allowed' });
  assert.deepEqual(dist, { kind: 'dist', path: '/fixture/dist/dist/contracts/guard-signers.allowed', checkoutRoot: null });
});

test('validateAncestry reports non-root, writable, and symlink ancestors via injected stats', { skip: !enrol }, async () => {
  const entries = new Map([
    ['/safe/child', { uid: 0, mode: 0o40755, symbolicLink: false }],
    ['/safe', { uid: 0, mode: 0o40755, symbolicLink: false }],
    ['/', { uid: 0, mode: 0o40755, symbolicLink: false }],
  ]);
  const deps = {
    async lstat(file) {
      const item = entries.get(file);
      if (!item) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isSymbolicLink: () => item.symbolicLink };
    },
    async stat(file) {
      const item = entries.get(file);
      if (!item) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return item;
    },
  };
  assert.deepEqual(await enrol.validateAncestry('/safe/child', deps), { ok: true, offending: null });
  entries.get('/safe').mode = 0o40775;
  assert.match((await enrol.validateAncestry('/safe/child', deps)).offending.reason, /writable/);
  entries.get('/safe').mode = 0o40755;
  entries.get('/safe').symbolicLink = true;
  assert.match((await enrol.validateAncestry('/safe/child', deps)).offending.reason, /symlink/);
});

test('candidate trust root validates, parses, and is idempotent by fingerprint', { skip: !enrol }, async () => {
  const signer = createTestSigner();
  const first = enrol.candidateTrustRoot('# existing\n', 'tester', signer.publicKeyLine);
  assert.equal(first.present, false);
  assert.match(first.text, /^# existing\ntester ssh-ed25519 /);
  assert.equal(first.signers.length, 1);
  assert.equal(parseAllowedSigners(first.text).length, 1);
  const second = enrol.candidateTrustRoot(first.text, 'tester', signer.publicKeyLine);
  assert.equal(second.present, true);
  assert.equal(second.text, first.text);
  assert.throws(() => enrol.candidateTrustRoot('', 'has space', signer.publicKeyLine), /principal/);
  assert.throws(() => enrol.candidateTrustRoot('', 'tester', `${signer.publicKeyLine} \u00e9`), /ASCII|allowed_signers/);
});

test('roundTrip verifies the fixture with its signer and rejects a different public key', { skip: !enrol }, async (t) => {
  const signer = createTestSigner();
  const fixture = await enrol.roundTrip({
    custodySign: async ({ bytes, namespace }) => ({ ok: true, armored: signer.sign(bytes, namespace) }),
    publicKeyLine: signer.publicKeyLine,
  });
  t.after(async () => fixture.cleanup());
  assert.equal(await readFile(fixture.file, 'utf8'), '{"version":1,"descriptors":[]}\n');
  assert.equal(fixture.namespace, DESCRIPTOR_NAMESPACE);
  const other = createTestSigner();
  await assert.rejects(enrol.roundTrip({
    custodySign: async ({ bytes, namespace }) => ({ ok: true, armored: signer.sign(bytes, namespace) }),
    publicKeyLine: other.publicKeyLine,
  }), /allowed signer/);
});

test('runEnrol refuses non-sudo custody before spawning or writing', { skip: !enrol }, async () => {
  let spawns = 0;
  let writes = 0;
  const result = await enrol.runEnrol({}, {
    custodyBackend: () => 'test',
    emit: () => {},
    execFile: () => { spawns += 1; },
    writeFile: async () => { writes += 1; },
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.lines[0], 'enrol requires the sudo custody backend on macOS');
  assert.equal(spawns, 0);
  assert.equal(writes, 0);
});

test('runEnrol root step uses scrubbed sudo and byte-identical install script', { skip: !enrol }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'guard-enrol-'));
  t.after(async () => {});
  const signer = createTestSigner();
  const rootFile = path.join(root, 'guard-signers.allowed');
  await writeFile(rootFile, '# trust root\n');
  const seen = [];
  const okay = { ok: true, offending: null };
  const deps = {
    custodyBackend: () => 'sudo',
    validateAncestry: async () => okay,
    locateTrustRoot: () => ({ kind: 'source', path: rootFile, checkoutRoot: root }),
    readFile: async (file) => file === PUBKEY_PATH ? `${signer.publicKeyLine}\n` : readFile(file, 'utf8'),
    writeFile,
    rebuildStratumDist: async () => {},
    custodySign: async ({ bytes, namespace }) => ({ ok: true, armored: signer.sign(bytes, namespace) }),
    guardDescriptors: async () => ({ status: 'ok', signature: `verified: signed by tester (${parseAllowedSigners(`tester ${signer.publicKeyLine}`)[0].fingerprint})`, group_or_world_writable: false }),
    emit: () => {},
    execFile(file, args, options, callback) {
      seen.push({ file, args, options, input: null });
      callback(null, 'ok install\n', '');
      return { stdin: { end(bytes) { seen[0].input = Buffer.from(bytes).toString('utf8'); } }, on() {} };
    },
  };
  const result = await enrol.runEnrol({ principal: 'tester' }, deps);
  assert.equal(result.status, 'done');
  assert.deepEqual(seen[0].args, ['-k', '/bin/sh', '-s']);
  assert.deepEqual(seen[0].options.env, SUDO_ENV());
  assert.equal(seen[0].input, enrol.installScript('tester'));
});

test('runEnrol refuses without a line emitter, before any backend check, spawn, or write', { skip: !enrol }, async () => {
  let spawns = 0;
  const result = await enrol.runEnrol({ principal: 'tester' }, {
    custodyBackend: () => 'sudo',
    execFile: () => { spawns += 1; },
  });
  assert.equal(result.status, 'refused');
  assert.match(result.lines[0], /requires a line emitter/);
  assert.equal(spawns, 0);
});

test('runEnrol returns a refused envelope (not a rejection) when emit throws, before any spawn', { skip: !enrol }, async () => {
  let spawns = 0;
  const okay = { ok: true, offending: null };
  const result = await enrol.runEnrol({ principal: 'tester' }, {
    custodyBackend: () => 'sudo',
    validateAncestry: async () => okay,
    emit: () => { throw new Error('emit exploded'); },
    execFile: () => { spawns += 1; },
  });
  assert.equal(result.status, 'refused');
  assert.match(result.lines[0], /enrol preparation failed: emit exploded/);
  assert.equal(spawns, 0);
});

test('runEnrol returns a refused envelope (not a rejection) when the packaged signer cannot be read, before any spawn', { skip: !enrol }, async () => {
  let spawns = 0;
  const okay = { ok: true, offending: null };
  const result = await enrol.runEnrol({ principal: 'tester' }, {
    custodyBackend: () => 'sudo',
    validateAncestry: async () => okay,
    emit: () => {},
    readSigner: () => { throw new Error('ENOENT: no such file or directory'); },
    execFile: () => { spawns += 1; },
  });
  assert.equal(result.status, 'refused');
  assert.match(result.lines[0], /enrol preparation failed: ENOENT/);
  assert.equal(spawns, 0);
});

test('runEnrol emits the plan before spawning sudo, and the returned lines do not repeat it', { skip: !enrol }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'guard-enrol-'));
  const signer = createTestSigner();
  const rootFile = path.join(root, 'guard-signers.allowed');
  await writeFile(rootFile, '# trust root\n');
  const events = [];
  const okay = { ok: true, offending: null };
  const deps = {
    custodyBackend: () => 'sudo',
    validateAncestry: async () => okay,
    locateTrustRoot: () => ({ kind: 'source', path: rootFile, checkoutRoot: root }),
    readFile: async (file) => file === PUBKEY_PATH ? `${signer.publicKeyLine}\n` : readFile(file, 'utf8'),
    writeFile,
    rebuildStratumDist: async () => {},
    custodySign: async ({ bytes, namespace }) => ({ ok: true, armored: signer.sign(bytes, namespace) }),
    guardDescriptors: async () => ({ status: 'ok', signature: `verified: signed by tester (${parseAllowedSigners(`tester ${signer.publicKeyLine}`)[0].fingerprint})`, group_or_world_writable: false }),
    emit: (line) => events.push({ type: 'emit', line }),
    execFile(file, args, options, callback) {
      events.push({ type: 'execFile', file, args });
      callback(null, 'ok install\n', '');
      return { stdin: { end() {} }, on() {} };
    },
  };
  const result = await enrol.runEnrol({ principal: 'tester' }, deps);
  assert.equal(result.status, 'done');
  const firstExecFileIndex = events.findIndex((e) => e.type === 'execFile');
  assert.ok(firstExecFileIndex > 0, 'execFile should not be the first event');
  const emitsBeforeSpawn = events.slice(0, firstExecFileIndex).filter((e) => e.type === 'emit').map((e) => e.line);
  assert.deepEqual(emitsBeforeSpawn, [...enrol.installPlan('tester'), 'root installation follows:']);
  assert.equal(events.slice(0, firstExecFileIndex).some((e) => e.type !== 'emit'), false, 'nothing but emits before the spawn');
  for (const line of emitsBeforeSpawn) assert.ok(!result.lines.includes(line), `returned lines should not repeat: ${line}`);
});
