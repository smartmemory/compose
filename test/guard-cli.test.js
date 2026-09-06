import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';

import { _testOnly_setCustodyBackend } from '../lib/guard-custody.js';

const cli = await import('../lib/guard-cli.js').catch(() => null);

afterEach(() => _testOnly_setCustodyBackend(null));

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'guard-cli-'));
  mkdirSync(path.join(root, '.compose'), { recursive: true });
  writeFileSync(path.join(root, '.compose', 'compose.json'), '{}\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function noopLock() { return async () => () => {}; }

test('descriptors uses unsigned preparation and returns the manual signing line with custody none', { skip: !cli }, async (t) => {
  const root = workspace(t);
  _testOnly_setCustodyBackend('none');
  let prepared = 0;
  const result = await cli.runGuardDescriptors(root, {
    acquireDirLock: noopLock(),
    enumerateRegisteredResources: async () => [],
    ensureSignedDescriptors: async () => ({ status: 'refused', message: 'no signing custody on this platform', code: 'upgrade_descriptor_unavailable' }),
    prepareUnsignedCandidate: async () => { prepared += 1; return { sha: 'a'.repeat(64), path: '/tmp/candidate/descriptors.json' }; },
  });
  assert.equal(prepared, 1);
  assert.equal(result.status, 'manual');
  assert.deepEqual(result.lines, ['ssh-keygen -Y sign -f ~/.stratum/guard-signing -n stratum-guard-descriptors /tmp/candidate/descriptors.json']);
});

test('descriptors refuses (never falls back to manual) when an existing generation fails to verify, even with custody none', { skip: !cli }, async (t) => {
  const root = workspace(t);
  _testOnly_setCustodyBackend('none');
  let prepared = 0;
  const result = await cli.runGuardDescriptors(root, {
    acquireDirLock: noopLock(),
    enumerateRegisteredResources: async () => [],
    ensureSignedDescriptors: async () => ({
      status: 'refused',
      message: `generation ${'a'.repeat(64)} exists but signature does not verify: not verified; remove it and retry`,
      code: 'upgrade_descriptor_unavailable',
      hint: 'run `compose guard enrol`',
    }),
    prepareUnsignedCandidate: async () => { prepared += 1; return { sha: 'a'.repeat(64), path: '/tmp/candidate/descriptors.json' }; },
  });
  assert.equal(prepared, 0);
  assert.equal(result.status, 'refused');
  assert.deepEqual(result.lines, [
    `generation ${'a'.repeat(64)} exists but signature does not verify: not verified; remove it and retry`,
    'run `compose guard enrol`',
  ]);
});

test('descriptors publishes an already-signed candidate before falling back to manual, even with custody none', { skip: !cli }, async (t) => {
  const root = workspace(t);
  _testOnly_setCustodyBackend('none');
  let prepared = 0;
  const result = await cli.runGuardDescriptors(root, {
    acquireDirLock: noopLock(),
    enumerateRegisteredResources: async () => [],
    ensureSignedDescriptors: async () => ({ status: 'fresh', path: '/tmp/current/descriptors.json' }),
    prepareUnsignedCandidate: async () => { prepared += 1; return { sha: 'a'.repeat(64), path: '/tmp/candidate/descriptors.json' }; },
  });
  assert.equal(prepared, 0);
  assert.equal(result.status, 'fresh');
  assert.deepEqual(result.lines, ['fresh: /tmp/current/descriptors.json']);
});

test('descriptors signs under the descriptor lock and formats a verified verdict', { skip: !cli }, async (t) => {
  const root = workspace(t);
  _testOnly_setCustodyBackend({ backend: 'test', sign: async () => ({ ok: true, armored: 'unused' }) });
  const events = [];
  const result = await cli.runGuardDescriptors(root, {
    acquireDirLock: async (lock, options) => { events.push(['lock', lock, options]); return () => events.push(['release']); },
    enumerateRegisteredResources: async () => [{ from_checksum: 'a'.repeat(64) }],
    ensureSignedDescriptors: async (options) => { events.push(['ensure', options.needChecksums]); return { status: 'signed', path: '/tmp/descriptors.json' }; },
    guardDescriptors: async () => ({ status: 'ok', signature: 'verified: signed by tester (SHA256:test)', group_or_world_writable: false }),
    readFile: async () => JSON.stringify({ descriptors: [{}] }),
  });
  assert.equal(result.status, 'signed');
  assert.deepEqual(result.lines, ['signed by tester (SHA256:test), 1 descriptor(s), verified']);
  assert.deepEqual(events[1], ['ensure', ['a'.repeat(64)]]);
  assert.equal(events.at(-1)[0], 'release');
});

test('runGuardEnrol forwards deps unchanged, so a caller with no emit is refused (no silent no-op default)', { skip: !cli }, async () => {
  const result = await cli.runGuardEnrol({}, {});
  assert.equal(result.status, 'refused');
  assert.match(result.lines[0], /requires a line emitter/);
});

test('signingStatusLines reports all signing state, including no generation and no custody', { skip: !cli }, async (t) => {
  const root = workspace(t);
  _testOnly_setCustodyBackend('none');
  const result = await cli.signingStatusLines(root, {
    custodyStatus: async () => ({ backend: 'none', installed: false, rule: 'absent', presence: 'unknown', cachedCredential: 'unknown', publicKeyLine: null, detail: ['no signing custody on this platform'] }),
    currentGeneration: async () => null,
    enumerateRegisteredResources: async () => [],
    execFile(file, args, options, callback) { callback(null, '', ''); return { on() {} }; },
    coverage: true,
  });
  assert.deepEqual(result.lines, [
    'signing:',
    '  backend: none',
    '  installed: no',
    '  rule: absent',
    '  presence: unknown',
    '  enrolled fingerprint: absent',
    '  current generation: absent',
    '  signature: absent',
    '  coverage: 0/0',
    '  generations committed: yes',
    '  legacy flat pair: absent',
    '  cached admin credential: unknown',
    '  detail: no signing custody on this platform',
  ]);
});

test('signingStatusLines skips the coverage probe unless asked (it spawns stratum per feature dir)', { skip: !cli }, async (t) => {
  const root = workspace(t);
  _testOnly_setCustodyBackend('none');
  let enumerated = 0;
  const result = await cli.signingStatusLines(root, {
    custodyStatus: async () => ({ backend: 'none', installed: false, rule: 'absent', presence: 'unknown', cachedCredential: 'unknown', publicKeyLine: null, detail: [] }),
    currentGeneration: async () => null,
    enumerateRegisteredResources: async () => { enumerated++; return []; },
    execFile(file, args, options, callback) { callback(null, '', ''); return { on() {} }; },
  });
  assert.equal(enumerated, 0);
  assert.ok(result.lines.includes('  coverage: skipped (pass --coverage)'), result.lines.join('\n'));
});

test('status prune takes the same descriptor lock before deleting generations', { skip: !cli }, async (t) => {
  const root = workspace(t);
  const events = [];
  const result = await cli.pruneGuardGenerations(root, {
    acquireDirLock: async (lock, options) => { events.push([lock, options]); return () => events.push(['release']); },
    pruneGenerations: async () => ({ removed: ['a'.repeat(64)] }),
  });
  assert.deepEqual(result.lines, [`pruned: ${'a'.repeat(64)}`]);
  assert.equal(events[0][0], path.join(root, '.compose', 'data', 'locks', 'guard-descriptors'));
  assert.equal(events.at(-1)[0], 'release');
});

test('compose guard status prints the signing contract against a workspace with no custody', { skip: !cli }, (t) => {
  const root = workspace(t);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync(process.execPath, [path.join(repo, 'bin', 'compose.js'), 'guard', 'status'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, COMPOSE_TARGET: root }, timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /canon-guard:/);
  assert.match(result.stdout, new RegExp(`signing:\\n  backend: ${process.platform === 'darwin' ? 'sudo' : 'none'}`));
  assert.match(result.stdout, /installed: (yes|no)/);
  assert.match(result.stdout, /rule: (present|absent|unknown)/);
  assert.match(result.stdout, /current generation: absent/);
  assert.match(result.stdout, /legacy flat pair: absent/);
  assert.match(result.stdout, /cached admin credential: (live|none|unknown)/);
});
