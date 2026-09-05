import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  descriptorIdFor, deriveBackfillPolicy, buildDescriptorFile, enumerateRegisteredResources, writeDescriptorFile,
} from '../lib/guard-descriptors.js';
import { legacyPolicyProjection } from '../server/lifecycle-guard.js';

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

test('enumerateRegisteredResources and writeDescriptorFile create the signed-artifact target at mode 0600', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'guard-descriptors-'));
  await mkdir(path.join(workspace, '.compose'), { recursive: true });
  const resources = await enumerateRegisteredResources(workspace);
  assert.deepEqual(resources, []);
  const result = await writeDescriptorFile(workspace);
  assert.equal(result.path, path.join(workspace, '.compose', 'guard-upgrades.json'));
  assert.equal(await readFile(result.path, 'utf8'), '{\n  "version": 1,\n  "descriptors": []\n}\n');
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
});
