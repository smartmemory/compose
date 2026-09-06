import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const sshKeygen = '/usr/bin/ssh-keygen';
const script = join(process.cwd(), 'scripts', 'guard-sign', 'compose-guard-sign.sh');
const available = existsSync(sshKeygen);
const require = createRequire(import.meta.url);
const sshsig = available ? await import(require.resolve('@smartmemory/stratum/dist/guard/sshsig.js')) : null;

function run(file, args, { input = '', env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { env }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('guard signer signs exact stdin with the requested namespace and cleans staging', { skip: available ? false : '/usr/bin/ssh-keygen is absent' }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'guard-sign-script-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const key = join(temp, 'signing-key');
  assert.equal((await run(sshKeygen, ['-t', 'ed25519', '-N', '', '-f', key])).error, null);

  const bytes = 'descriptor bytes\n';
  const signed = await run('/bin/sh', [script, 'stratum-guard-descriptors'], {
    input: bytes,
    env: { ...process.env, COMPOSE_GUARD_SIGN_KEY: key, TMPDIR: temp },
  });
  assert.equal(signed.error, null, signed.stderr);
  const allowed = sshsig.parseAllowedSigners(`tester ${require('node:fs').readFileSync(`${key}.pub`, 'utf8').trim()}`).map((entry) => entry.publicKey);
  assert.doesNotThrow(() => sshsig.verifySshsig(Buffer.from(bytes), signed.stdout, 'stratum-guard-descriptors', allowed));
  assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith('sign.')), []);
});

test('guard signer rejects an option-shaped namespace and missing keys without leftovers', { skip: available ? false : '/usr/bin/ssh-keygen is absent' }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'guard-sign-script-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const env = { ...process.env, COMPOSE_GUARD_SIGN_KEY: join(temp, 'missing'), TMPDIR: temp };

  const injection = await run('/bin/sh', [script, '-f x'], { input: 'x', env });
  assert.equal(injection.error?.code, 64);
  const missing = await run('/bin/sh', [script, 'stratum-guard-descriptors'], { input: 'x', env });
  assert.equal(missing.error?.code, 66);
  assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith('sign.')), []);
});
