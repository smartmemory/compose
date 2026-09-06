import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, lstat, writeFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  descriptorIdFor, deriveBackfillPolicy, buildDescriptorFile, enumerateRegisteredResources,
  GENERATIONS_DIR, generationPaths, currentGeneration, adoptLegacyFlatPair, verifyGeneration,
  ensureSignedDescriptors, prepareUnsignedCandidate, pruneGenerations,
} from '../lib/guard-descriptors.js';
import { legacyPolicyProjection } from '../server/lifecycle-guard.js';
import { createTestSigner, DESCRIPTOR_NAMESPACE } from './helpers/sshsig-sign.js';

const require = createRequire(import.meta.url);
const { parseAllowedSigners, verifySshsig } = await import(require.resolve('@smartmemory/stratum/dist/guard/sshsig.js'));

const stored = {
  graph: { explore_design: ['blueprint', 'killed'], blueprint: ['killed'], complete: [], killed: [] },
  edge_predicates: { 'explore_design->blueprint': [{ id: 'design' }] },
  terminal: ['complete', 'killed'],
  stakes: { ship: 'high' },
};

test('deriveBackfillPolicy adds its terminal exactly before killed and is reversible', () => {
  const next = deriveBackfillPolicy(stored, 'build');
  assert.deepEqual(next.graph.complete_backfilled, []);
  assert.deepEqual(next.graph.explore_design, ['blueprint', 'complete_backfilled', 'killed']);
  assert.deepEqual(next.graph.blueprint, ['complete_backfilled', 'killed']);
  assert.deepEqual(next.terminal, ['complete', 'killed', 'complete_backfilled']);
  assert.deepEqual(next.edge_predicates, stored.edge_predicates);
  assert.deepEqual(next.stakes, stored.stakes);
  assert.deepEqual(legacyPolicyProjection(next), stored);
  assert.equal(descriptorIdFor('abcdef1234567890', 'fix'), 'backfill-fix-abcdef123456');
});

test('buildDescriptorFile deduplicates by from_checksum and is byte-stable across shuffled input', () => {
  const entries = [
    { from_checksum: 'b'.repeat(64), mode: 'build', storedPolicy: stored },
    { from_checksum: 'a'.repeat(64), mode: 'fix', storedPolicy: stored },
    { from_checksum: 'b'.repeat(64), mode: 'plan', storedPolicy: stored },
  ];
  const a = buildDescriptorFile(entries);
  const b = buildDescriptorFile([...entries].reverse());
  assert.equal(a, b);
  const parsed = JSON.parse(a);
  assert.deepEqual(parsed.descriptors.map((d) => d.id), [...parsed.descriptors.map((d) => d.id)].sort());
  assert.equal(parsed.descriptors.length, 2);
  assert.ok(a.endsWith('\n'));
});

test('buildDescriptorFile refuses a to_policy with an unknown fifth key before write', () => {
  assert.throws(() => buildDescriptorFile([{
    from_checksum: 'a'.repeat(64),
    mode: 'build',
    to_policy: { ...stored, unexpected: true },
  }]), /unknown policy key/i);
});

function entry(checksum) {
  return { from_checksum: checksum, mode: 'build', storedPolicy: stored };
}

function testCustody(signer, calls = { count: 0 }) {
  return {
    calls,
    async sign({ bytes, namespace }) {
      calls.count++;
      return { ok: true, armored: signer.sign(bytes, namespace) };
    },
  };
}

function verifierFor(signer, { writable = false } = {}) {
  const allowed = parseAllowedSigners(`tester ${signer.publicKeyLine}`).map((entry) => entry.publicKey);
  return async (file) => {
    try {
      verifySshsig(await readFile(file), await readFile(`${file}.sig`, 'utf8'), DESCRIPTOR_NAMESPACE, allowed);
      return { status: 'ok', signature: 'verified: tester', group_or_world_writable: writable };
    } catch (error) {
      return { status: 'ok', signature: `NOT VERIFIED: ${error.message}`, group_or_world_writable: writable };
    }
  };
}

test('generation layout adopts a legacy flat pair once and leaves the flat pair untouched', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const signer = createTestSigner();
  const verifier = verifierFor(signer);
  const bytes = buildDescriptorFile([]);
  const legacy = path.join(workspace, '.compose', 'guard-upgrades.json');
  await mkdir(path.dirname(legacy), { recursive: true });
  await writeFile(legacy, bytes, { mode: 0o600 });
  await writeFile(`${legacy}.sig`, signer.sign(bytes, DESCRIPTOR_NAMESPACE), { mode: 0o600 });

  const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(generationPaths(workspace, sha), {
    dir: path.join(workspace, GENERATIONS_DIR, sha),
    file: path.join(workspace, GENERATIONS_DIR, sha, 'descriptors.json'),
    sig: path.join(workspace, GENERATIONS_DIR, sha, 'descriptors.json.sig'),
  });
  assert.deepEqual(await adoptLegacyFlatPair(workspace, verifier), { adopted: true });
  assert.deepEqual(await adoptLegacyFlatPair(workspace, verifier), { adopted: false });
  const current = await currentGeneration(workspace);
  assert.equal(current.sha, sha);
  assert.equal(await readFile(current.file, 'utf8'), bytes);
  assert.equal(await readFile(legacy, 'utf8'), bytes, 'adoption is a copy, not a destructive move');
});

test('adoption refuses a legacy pair whose signature does not verify, leaving no trace', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const signer = createTestSigner();
  const verifier = verifierFor(signer);
  const bytes = buildDescriptorFile([]);
  const legacy = path.join(workspace, '.compose', 'guard-upgrades.json');
  await mkdir(path.dirname(legacy), { recursive: true });
  await writeFile(legacy, bytes, { mode: 0o600 });
  await writeFile(`${legacy}.sig`, 'corrupt-signature', { mode: 0o600 });

  const result = await adoptLegacyFlatPair(workspace, verifier);
  assert.deepEqual(result, { adopted: false, reason: 'legacy descriptor pair does not verify' });
  assert.equal(await currentGeneration(workspace), null);
  const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  assert.equal(await stat(generationPaths(workspace, sha).dir).then(() => true, () => false), false);
  const leftovers = (await readdir(path.join(workspace, GENERATIONS_DIR)).catch(() => []))
    .filter((name) => name.startsWith('.staging-'));
  assert.deepEqual(leftovers, []);
});

test('adoption refuses when a pre-existing generation with the same sha does not verify, leaving it and current untouched', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const signer = createTestSigner();
  const verifier = verifierFor(signer);
  const bytes = buildDescriptorFile([]);
  const legacy = path.join(workspace, '.compose', 'guard-upgrades.json');
  await mkdir(path.dirname(legacy), { recursive: true });
  await writeFile(legacy, bytes, { mode: 0o600 });
  await writeFile(`${legacy}.sig`, signer.sign(bytes, DESCRIPTOR_NAMESPACE), { mode: 0o600 });

  const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  const target = generationPaths(workspace, sha);
  await mkdir(target.dir, { recursive: true });
  await writeFile(target.file, bytes, { mode: 0o600 });
  await writeFile(target.sig, 'corrupt-signature', { mode: 0o600 });

  const result = await adoptLegacyFlatPair(workspace, verifier);
  assert.deepEqual(result, { adopted: false, reason: `existing generation ${sha} does not verify` });
  assert.equal(await currentGeneration(workspace), null);
  assert.equal(await readFile(target.sig, 'utf8'), 'corrupt-signature', 'existing dir left untouched');
  const leftovers = (await readdir(path.join(workspace, GENERATIONS_DIR)))
    .filter((name) => name.startsWith('.staging-'));
  assert.deepEqual(leftovers, []);
});

test('adoption refuses when a pre-existing generation escapes containment via a symlinked descriptors.json', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const signer = createTestSigner();
  const verifier = verifierFor(signer);
  const bytes = buildDescriptorFile([]);
  const legacy = path.join(workspace, '.compose', 'guard-upgrades.json');
  await mkdir(path.dirname(legacy), { recursive: true });
  await writeFile(legacy, bytes, { mode: 0o600 });
  await writeFile(`${legacy}.sig`, signer.sign(bytes, DESCRIPTOR_NAMESPACE), { mode: 0o600 });

  const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  const target = generationPaths(workspace, sha);
  await mkdir(target.dir, { recursive: true });
  const outside = await mkdtemp(path.join(tmpdir(), 'guard-outside-'));
  const outsideFile = path.join(outside, 'descriptors.json');
  await writeFile(outsideFile, bytes);
  await symlink(outsideFile, target.file);
  await writeFile(target.sig, signer.sign(bytes, DESCRIPTOR_NAMESPACE), { mode: 0o600 });

  const result = await adoptLegacyFlatPair(workspace, verifier);
  assert.equal(result.adopted, false);
  assert.match(result.reason, /escapes/);
  assert.equal(await currentGeneration(workspace), null);
  assert.equal((await lstat(target.file)).isSymbolicLink(), true, 'the pre-existing dir is left untouched, escaping symlink and all');
  const leftovers = (await readdir(path.join(workspace, GENERATIONS_DIR)))
    .filter((name) => name.startsWith('.staging-'));
  assert.deepEqual(leftovers, []);
});

test('currentGeneration throws when descriptors.json is a symlink escaping the generations directory', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'guard-outside-'));
  const outsideFile = path.join(outside, 'descriptors.json');
  await writeFile(outsideFile, '{}');
  const sha = 'f'.repeat(64);
  const generation = generationPaths(workspace, sha);
  await mkdir(generation.dir, { recursive: true });
  await symlink(outsideFile, generation.file);
  await writeFile(generation.sig, '');
  await symlink(sha, path.join(workspace, GENERATIONS_DIR, 'current'));

  await assert.rejects(currentGeneration(workspace), /escapes/);

  const signer = createTestSigner();
  const verifier = verifierFor(signer);
  const refused = await ensureSignedDescriptors({
    workspaceRoot: workspace, needChecksums: [], custody: testCustody(signer), verifier, enumerate: async () => [],
  });
  assert.equal(refused.status, 'refused');
  assert.match(refused.message, /escapes/);
});

test('currentGeneration throws when current escapes the generations directory', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'guard-outside-'));
  const sha = 'd'.repeat(64);
  const outsideDir = path.join(outside, sha);
  await mkdir(outsideDir, { recursive: true });
  await writeFile(path.join(outsideDir, 'descriptors.json'), '{}');
  await writeFile(path.join(outsideDir, 'descriptors.json.sig'), '');
  await mkdir(path.join(workspace, GENERATIONS_DIR), { recursive: true });
  await symlink(outsideDir, path.join(workspace, GENERATIONS_DIR, 'current'));

  await assert.rejects(currentGeneration(workspace), /escapes/);

  const signer = createTestSigner();
  const verifier = verifierFor(signer);
  const refused = await ensureSignedDescriptors({
    workspaceRoot: workspace, needChecksums: [], custody: testCustody(signer), verifier, enumerate: async () => [],
  });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.code, 'upgrade_descriptor_unavailable');
  assert.match(refused.message, /escapes/);
});

test('currentGeneration throws when generation bytes do not hash to its directory name', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const sha = 'e'.repeat(64);
  const generation = generationPaths(workspace, sha);
  await mkdir(generation.dir, { recursive: true });
  await writeFile(generation.file, JSON.stringify({ version: 1, descriptors: [{ mismatched: true }] }));
  await writeFile(generation.sig, '');
  await symlink(sha, path.join(workspace, GENERATIONS_DIR, 'current'));

  await assert.rejects(currentGeneration(workspace), /bytes do not hash to its name/);
});

test('a symlinked generations directory is refused rather than treated as contained', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  await mkdir(path.join(workspace, '.compose'), { recursive: true });
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'guard-elsewhere-'));
  const sha = 'a'.repeat(64);
  const shaDir = path.join(elsewhere, sha);
  await mkdir(shaDir, { recursive: true });
  await writeFile(path.join(shaDir, 'descriptors.json'), '{}');
  await writeFile(path.join(shaDir, 'descriptors.json.sig'), '');
  await symlink(sha, path.join(elsewhere, 'current'));
  await symlink(elsewhere, path.join(workspace, GENERATIONS_DIR));

  await assert.rejects(currentGeneration(workspace), /symlink/);

  const signer = createTestSigner();
  const verifier = verifierFor(signer);
  const result = await ensureSignedDescriptors({
    workspaceRoot: workspace, needChecksums: [], custody: testCustody(signer), verifier, enumerate: async () => [],
  });
  assert.equal(result.status, 'refused');
  assert.match(result.message, /symlink/);
  // Nothing new was written into the external directory the symlink points to.
  assert.deepEqual((await readdir(elsewhere)).sort(), ['current', sha].sort());
});

test('ensureSignedDescriptors refuses a symlinked destination sha directory without touching current', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const signer = createTestSigner();
  const verifier = verifierFor(signer);
  const checksum = 'a'.repeat(64);
  const old = await ensureSignedDescriptors({ workspaceRoot: workspace, needChecksums: [checksum], custody: testCustody(signer), verifier, enumerate: async () => [entry(checksum)] });

  const nextChecksum = 'b'.repeat(64);
  const bytes = buildDescriptorFile([entry(nextChecksum)]);
  const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'guard-elsewhere-'));
  await mkdir(path.join(workspace, GENERATIONS_DIR), { recursive: true });
  await symlink(elsewhere, path.join(workspace, GENERATIONS_DIR, sha));

  const result = await ensureSignedDescriptors({
    workspaceRoot: workspace, needChecksums: [nextChecksum], custody: testCustody(signer), verifier, enumerate: async () => [entry(nextChecksum)],
  });
  assert.equal(result.status, 'refused');
  assert.match(result.message, /is a symlink/);
  assert.equal((await currentGeneration(workspace)).file, old.path);
});

test('ensureSignedDescriptors refuses when the existing candidate signature is a dangling symlink', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const signer = createTestSigner();
  const verifier = verifierFor(signer);
  const checksum = 'a'.repeat(64);
  const bytes = buildDescriptorFile([entry(checksum)]);
  const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  const target = generationPaths(workspace, sha);
  await mkdir(target.dir, { recursive: true });
  await writeFile(target.file, bytes, { mode: 0o600 });
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'guard-elsewhere-'));
  const danglingTarget = path.join(elsewhere, 'nonexistent-sig-target');
  await symlink(danglingTarget, target.sig);

  const calls = { count: 0 };
  const result = await ensureSignedDescriptors({
    workspaceRoot: workspace, needChecksums: [checksum], custody: testCustody(signer, calls), verifier, enumerate: async () => [entry(checksum)],
  });
  assert.equal(result.status, 'refused');
  assert.match(result.message, /symlink/);
  assert.equal(calls.count, 0, 'custody.sign must never be reached when the sig entry is a dangling symlink');
  assert.equal(await stat(danglingTarget).then(() => true, () => false), false, 'nothing was written at the symlink target');
});

test('ensure reuses a verified current generation without another custody prompt', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const signer = createTestSigner();
  const calls = { count: 0 };
  const options = { workspaceRoot: workspace, needChecksums: ['a'.repeat(64)], custody: testCustody(signer, calls), verifier: verifierFor(signer), enumerate: async () => [entry('a'.repeat(64))] };
  const signed = await ensureSignedDescriptors(options);
  const fresh = await ensureSignedDescriptors(options);
  assert.equal(signed.status, 'signed');
  assert.equal(fresh.status, 'fresh');
  assert.equal(fresh.prompts, 0);
  assert.equal(calls.count, 1);
  assert.equal(fresh.path, await (await import('node:fs/promises')).realpath(signed.path));
});

test('a custody refusal leaves the published generation byte-identical and no staging directory', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const signer = createTestSigner();
  const verifier = verifierFor(signer);
  const initial = await ensureSignedDescriptors({ workspaceRoot: workspace, needChecksums: ['a'.repeat(64)], custody: testCustody(signer), verifier, enumerate: async () => [entry('a'.repeat(64))] });
  const before = await readFile(initial.path);
  const refused = await ensureSignedDescriptors({
    workspaceRoot: workspace, needChecksums: ['b'.repeat(64)], verifier, enumerate: async () => [entry('b'.repeat(64))],
    custody: { sign: async () => ({ ok: false, code: 'signature_not_approved', message: 'declined', hint: 'approve' }) },
  });
  assert.equal(refused.status, 'refused');
  assert.equal((await currentGeneration(workspace)).file, initial.path);
  assert.deepEqual(await readFile(initial.path), before);
  assert.deepEqual((await readdir(path.join(workspace, GENERATIONS_DIR))).filter((name) => name.startsWith('.staging-')), []);
});

test('a pre-existing invalid signed generation refuses without moving current', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const signer = createTestSigner();
  const verifier = verifierFor(signer);
  const old = await ensureSignedDescriptors({ workspaceRoot: workspace, needChecksums: ['a'.repeat(64)], custody: testCustody(signer), verifier, enumerate: async () => [entry('a'.repeat(64))] });
  const bytes = buildDescriptorFile([entry('b'.repeat(64))]);
  const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  const target = generationPaths(workspace, sha);
  await mkdir(target.dir, { recursive: true });
  await writeFile(target.file, bytes, { mode: 0o600 });
  await writeFile(target.sig, 'corrupt', { mode: 0o600 });
  const result = await ensureSignedDescriptors({ workspaceRoot: workspace, needChecksums: ['b'.repeat(64)], custody: testCustody(signer), verifier, enumerate: async () => [entry('b'.repeat(64))] });
  assert.equal(result.status, 'refused');
  assert.match(result.message, /signature does not verify/);
  assert.equal((await currentGeneration(workspace)).file, old.path);
});

test('an unsigned manual candidate is signed in place and then published', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const signer = createTestSigner();
  const candidate = await prepareUnsignedCandidate(workspace, { enumerate: async () => [entry('a'.repeat(64))] });
  const calls = { count: 0 };
  const result = await ensureSignedDescriptors({ workspaceRoot: workspace, needChecksums: ['a'.repeat(64)], custody: testCustody(signer, calls), verifier: verifierFor(signer), enumerate: async () => [entry('a'.repeat(64))] });
  assert.equal(result.status, 'signed');
  assert.equal(result.path, candidate.path);
  assert.equal(calls.count, 1);
  assert.equal(await readFile(`${candidate.path}.sig`, 'utf8').then(Boolean), true);
});

test('prepareUnsignedCandidate refuses to hand out a sign command over an already-signed generation', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const candidate = await prepareUnsignedCandidate(workspace, { enumerate: async () => [entry('a'.repeat(64))] });
  await writeFile(`${candidate.path}.sig`, 'already-signed');
  await assert.rejects(
    prepareUnsignedCandidate(workspace, { enumerate: async () => [entry('a'.repeat(64))] }),
    /already has a signature/,
  );
});

test('prepareUnsignedCandidate refuses when a dangling .sig symlink is present', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const candidate = await prepareUnsignedCandidate(workspace, { enumerate: async () => [entry('a'.repeat(64))] });
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'guard-elsewhere-'));
  const danglingTarget = path.join(elsewhere, 'nonexistent-sig-target');
  await symlink(danglingTarget, `${candidate.path}.sig`);

  await assert.rejects(
    prepareUnsignedCandidate(workspace, { enumerate: async () => [entry('a'.repeat(64))] }),
    /symlink|already has a signature/,
  );
});

test('a race destination is re-verified before it becomes current', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const signer = createTestSigner();
  const verifier = verifierFor(signer);
  const checksum = 'a'.repeat(64);
  const bytes = buildDescriptorFile([entry(checksum)]);
  const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  const target = generationPaths(workspace, sha);
  const result = await ensureSignedDescriptors({
    workspaceRoot: workspace, needChecksums: [checksum], verifier, enumerate: async () => [entry(checksum)],
    custody: { sign: async () => {
      await mkdir(target.dir, { recursive: true });
      await writeFile(target.file, bytes, { mode: 0o600 });
      await writeFile(target.sig, signer.sign(bytes, DESCRIPTOR_NAMESPACE), { mode: 0o600 });
      return { ok: true, armored: signer.sign(bytes, DESCRIPTOR_NAMESPACE) };
    } },
  });
  assert.equal(result.status, 'fresh');
  assert.equal((await currentGeneration(workspace)).file, await (await import('node:fs/promises')).realpath(target.file));
});

test('a race destination that lands as a symlink is refused rather than trusted', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const signer = createTestSigner();
  const verifier = verifierFor(signer);
  const checksum = 'a'.repeat(64);
  const bytes = buildDescriptorFile([entry(checksum)]);
  const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  const target = generationPaths(workspace, sha);
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'guard-elsewhere-'));
  await writeFile(path.join(elsewhere, 'descriptors.json'), bytes, { mode: 0o600 });
  await writeFile(path.join(elsewhere, 'descriptors.json.sig'), signer.sign(bytes, DESCRIPTOR_NAMESPACE), { mode: 0o600 });

  const result = await ensureSignedDescriptors({
    workspaceRoot: workspace, needChecksums: [checksum], verifier, enumerate: async () => [entry(checksum)],
    custody: { sign: async () => {
      await mkdir(path.dirname(target.dir), { recursive: true });
      await symlink(elsewhere, target.dir);
      return { ok: true, armored: signer.sign(bytes, DESCRIPTOR_NAMESPACE) };
    } },
  });
  assert.equal(result.status, 'refused');
  assert.match(result.message, /is a symlink/);
  assert.equal(await currentGeneration(workspace), null);
  const leftovers = (await readdir(path.join(workspace, GENERATIONS_DIR)))
    .filter((name) => name.startsWith('.staging-'));
  assert.deepEqual(leftovers, []);
});

test('a writable verifier verdict is never fresh and thrown enumeration becomes a refusal envelope', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const signer = createTestSigner();
  const result = await ensureSignedDescriptors({ workspaceRoot: workspace, needChecksums: ['a'.repeat(64)], custody: testCustody(signer), verifier: verifierFor(signer, { writable: true }), enumerate: async () => [entry('a'.repeat(64))] });
  assert.equal(result.status, 'refused');
  const thrown = await ensureSignedDescriptors({ workspaceRoot: workspace, needChecksums: [], custody: testCustody(signer), verifier: verifierFor(signer), enumerate: async () => { throw new Error('enumeration failed'); } });
  assert.deepEqual(thrown, { status: 'refused', code: 'upgrade_descriptor_unavailable', message: 'enumeration failed', hint: 'compose guard enrol' });
  assert.equal((await verifyGeneration(workspace, path.join(workspace, 'missing'), verifierFor(signer))).verified, false);
});

test('prune keeps current and generations referenced by pending completion intents', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const { createHash } = await import('node:crypto');
  const contentFor = (label) => JSON.stringify({ version: 1, descriptors: [], label });
  const shaFor = (label) => createHash('sha256').update(contentFor(label)).digest('hex');
  const keep = shaFor('keep'), intent = shaFor('intent'), remove = shaFor('remove');
  for (const [sha, label] of [[keep, 'keep'], [intent, 'intent'], [remove, 'remove']]) {
    const generation = generationPaths(workspace, sha);
    await mkdir(generation.dir, { recursive: true });
    await writeFile(generation.file, contentFor(label));
    await writeFile(generation.sig, '');
  }
  await symlink(keep, path.join(workspace, GENERATIONS_DIR, 'current'));
  const intents = path.join(workspace, '.compose', 'data', 'completion-intents');
  await mkdir(intents, { recursive: true });
  await writeFile(path.join(intents, 'pending.json'), JSON.stringify({ descriptorsPath: generationPaths(workspace, intent).file }));
  const result = await pruneGenerations(workspace);
  assert.deepEqual(result.removed, [remove]);
  assert.equal((await currentGeneration(workspace)).sha, keep);
  assert.equal(await stat(generationPaths(workspace, intent).dir).then(() => true), true);
});

test('prune never deletes or follows a symlink entry in the generations directory', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-generations-'));
  const keep = 'f'.repeat(64);
  const generation = generationPaths(workspace, keep);
  await mkdir(generation.dir, { recursive: true });
  await writeFile(generation.file, '{}');
  await writeFile(generation.sig, '');
  await symlink(keep, path.join(workspace, GENERATIONS_DIR, 'current'));

  const bogusSha = '1'.repeat(64);
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'guard-elsewhere-'));
  await symlink(elsewhere, path.join(workspace, GENERATIONS_DIR, bogusSha));

  const result = await pruneGenerations(workspace);
  assert.deepEqual(result.removed, []);
  assert.equal(await stat(path.join(workspace, GENERATIONS_DIR, bogusSha)).then(() => true), true);
});
