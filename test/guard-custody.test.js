import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.NODE_ENV = 'test';
const custody = await import('../lib/guard-custody.js');

afterEach(() => custody._testOnly_setCustodyBackend(null));

test('custody selects sudo only on macOS when no test backend is injected', () => {
  assert.equal(custody.custodyBackend(), process.platform === 'darwin' ? 'sudo' : 'none');
});

function fakeExec({ code = 0, stdout = '', stderr = '', error = null } = {}) {
  const seen = {};
  return {
    seen,
    execFile(file, args, options, callback) {
      Object.assign(seen, { file, args, options, input: '' });
      callback(error ?? (code === 0 ? null : Object.assign(new Error(`exit ${code}`), { code })), stdout, stderr);
      return { stdin: { end(bytes) { seen.input = Buffer.from(bytes).toString('utf8'); } }, on() {} };
    },
  };
}

test('sudo custody uses the root signer argv, a scrubbed environment, and stdin bytes', async () => {
  custody._testOnly_setCustodyBackend('sudo');
  const fake = fakeExec({ stdout: '-----BEGIN SSH SIGNATURE-----\nfixture\n' });
  const result = await custody.custodySign({ bytes: Buffer.from('descriptor bytes'), namespace: 'stratum-guard-descriptors' }, { execFile: fake.execFile });

  assert.deepEqual(result, { ok: true, armored: '-----BEGIN SSH SIGNATURE-----\nfixture\n' });
  assert.equal(fake.seen.file, '/usr/bin/sudo');
  assert.deepEqual(fake.seen.args, ['-k', custody.SIGNER_PATH, 'stratum-guard-descriptors']);
  assert.equal(fake.seen.options.timeout, custody.CUSTODY_TIMEOUT_MS);
  assert.equal(fake.seen.input, 'descriptor bytes');
  assert.deepEqual(Object.keys(fake.seen.options.env).sort(), ['HOME', 'LANG', 'PATH', 'USER']);
  assert.equal(fake.seen.options.env.SUDO_ASKPASS, undefined);
  assert.equal(fake.seen.options.env.SSH_ASKPASS, undefined);
  assert.equal(fake.seen.options.env.SUDO_PROMPT, undefined);
});

test('custody maps every sudo failure class to an honest refusal envelope', async () => {
  custody._testOnly_setCustodyBackend('sudo');
  const cases = [
    [{ code: 1, stderr: 'a terminal is required' }, 'signature_not_approved', custody.HINT_APPROVE],
    [{ code: 1, stderr: 'Sorry, try again.' }, 'signature_not_approved', custody.HINT_APPROVE],
    [{ code: 1, stderr: 'authentication failed' }, 'signature_not_approved', custody.HINT_APPROVE],
    [{ code: 1, stderr: 'timed out waiting for approval' }, 'signature_not_approved', custody.HINT_APPROVE],
    [{ code: 64, stderr: 'compose-guard-sign: invalid namespace\nmore' }, 'upgrade_descriptor_unavailable', custody.HINT_ENROL],
    [{ code: 66, stderr: 'compose-guard-sign: signing key not readable' }, 'upgrade_descriptor_unavailable', custody.HINT_ENROL],
    [{ code: 2, stderr: 'sudo infrastructure failed' }, 'upgrade_descriptor_unavailable', custody.HINT_ENROL],
    [{ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true }) }, 'signature_not_approved', custody.HINT_APPROVE],
    [{ error: Object.assign(new Error('spawn broke'), { code: 'ENOENT' }) }, 'upgrade_descriptor_unavailable', custody.HINT_ENROL],
  ];
  for (const [response, code, hint] of cases) {
    const fake = fakeExec(response);
    const result = await custody.custodySign({ bytes: Buffer.from('x'), namespace: 'stratum-guard-descriptors' }, { execFile: fake.execFile });
    assert.equal(result.ok, false, JSON.stringify(response));
    assert.equal(result.code, code, JSON.stringify(response));
    assert.equal(result.hint, hint, JSON.stringify(response));
    assert.equal(typeof result.message, 'string');
  }
});

test('none custody refuses with the enrol hint', async () => {
  custody._testOnly_setCustodyBackend('none');
  assert.deepEqual(await custody.custodySign({ bytes: Buffer.from('x'), namespace: 'x' }), {
    ok: false, code: 'upgrade_descriptor_unavailable', message: 'no signing custody on this platform', hint: custody.HINT_ENROL,
  });
});

test('the test-only custody seam is refused outside NODE_ENV=test', async () => {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const modulePath = join(repo, 'lib', 'guard-custody.js');
  await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e',
    `import { _testOnly_setCustodyBackend } from ${JSON.stringify(modulePath)}; _testOnly_setCustodyBackend('none');`,
  ], { env: { ...process.env, NODE_ENV: 'production' } }, (error, _stdout, stderr) => {
    if (!error) return reject(new Error('expected the seam to refuse'));
    try { assert.match(stderr || '', /NODE_ENV=test/); resolve(); } catch (assertion) { reject(assertion); }
  }));
});
