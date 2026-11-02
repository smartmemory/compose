/**
 * ontology-seam.test.js — FORGE-ONTOLOGY-READY-1: Compose's `lib/ontology` seam resolves the project ontology pack,
 * exports the pack's type and relation names, matches the pack byte-for-byte (drift check) and warns when the pack
 * is missing instead of passing silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as seam from '../lib/ontology/index.js';
import { resolveOntologyPack } from '../lib/ontology/resolve-pack.js';
import { render } from '../lib/ontology/gen-stub.js';

const STUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'ontology', 'pack.generated.js');
const EXPECTED_TYPES = ['Project', 'Group', 'Module', 'Repository', 'Release', 'Feature', 'Unit', 'Lane', 'Seat', 'Session',
  'Gate', 'ProjectDecision', 'Idea', 'Commit', 'Artifact'];

const quiet = () => { const seen = []; return { seen, warn: (m) => seen.push(m) }; };

test('the seam exports the pack identity, the 15 type names, 17 relation names and one JSON Schema per type', () => {
  assert.equal(seam.PACK_ID, 'project-ontology');
  assert.deepEqual([...seam.TYPE_NAMES], EXPECTED_TYPES);
  assert.equal(seam.RELATION_NAMES.length, 17);
  assert.ok(seam.RELATION_NAMES.includes('dependsOn') && seam.RELATION_NAMES.includes('featureLink'));
  assert.deepEqual(Object.keys(seam.JSON_SCHEMAS), EXPECTED_TYPES);
  assert.deepEqual(seam.JSON_SCHEMAS.Feature.required, ['code']);
  assert.deepEqual(seam.JSON_SCHEMAS.Gate.required, ['id', 'round']);
  assert.deepEqual(seam.JSON_SCHEMAS.Unit.properties.repos, { type: 'array', items: { type: 'string' } });
});

test('the committed stub matches the pack this checkout resolves (drift check)', (t) => {
  const { seen, warn } = quiet();
  const found = resolveOntologyPack(process.env, { warn });
  if (!found) { t.skip(`no pack on this machine: ${seen.join(' ')}`); return; }
  assert.equal(seam.PACK_SHA256, found.sha256, `pack changed (${found.source} ${found.packFile}): regenerate with lib/ontology/gen-stub.js`);
  const committed = readFileSync(STUB, 'utf8');
  const label = committed.match(/ from (\S+) \(sha256 /)[1];
  assert.equal(render(found.pack, { sha256: found.sha256, sourceLabel: label, format: 'js' }), committed);
});

test('PROJECT_ONTOLOGY_PACK=none forces absent with a WARNING', () => {
  const { seen, warn } = quiet();
  assert.equal(resolveOntologyPack({ PROJECT_ONTOLOGY_PACK: 'none' }, { warn }), null);
  assert.match(seen[0], /^WARNING: .*forced absent/);
});

test('an env pack dir wins and is read from pack.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onto-seam-'));
  try {
    writeFileSync(join(dir, 'pack.json'), JSON.stringify({ pack_id: 'project-ontology', types: [], relations: [] }));
    const found = resolveOntologyPack({ PROJECT_ONTOLOGY_PACK: dir }, { warn: () => assert.fail('no warning expected') });
    assert.equal(found.source, 'env');
    assert.equal(found.pack.pack_id, 'project-ontology');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no SmartMemory checkout above the start dir: null with a WARNING, never a silent pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'onto-seam-'));
  try {
    const { seen, warn } = quiet();
    assert.equal(resolveOntologyPack({}, { start: dir, warn }), null);
    assert.match(seen[0], /^WARNING: project ontology pack not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('core\'s pack dir beats the draft, and a generated/ dir with .d.ts marks it generated', () => {
  const root = mkdtempSync(join(tmpdir(), 'onto-seam-'));
  try {
    const sm = join(root, 'SmartMemory');
    const packDir = join(sm, 'smart-memory-core', 'smartmemory', 'ontology', 'packs', 'project-ontology', '1.0.0');
    mkdirSync(join(sm, 'contracts'), { recursive: true });
    writeFileSync(join(sm, 'contracts', 'project-ontology-bundle.v1.json'), '{"pack_id":"draft"}');
    const start = join(root, 'forge', 'compose', 'lib');
    mkdirSync(start, { recursive: true });
    assert.equal(resolveOntologyPack({}, { start }).source, 'draft');
    mkdirSync(join(packDir, 'generated'), { recursive: true });
    writeFileSync(join(packDir, 'pack.json'), '{"pack_id":"core"}');
    assert.equal(resolveOntologyPack({}, { start }).source, 'pack');
    writeFileSync(join(packDir, 'generated', 'project-ontology.d.ts'), 'export {};');
    const found = resolveOntologyPack({}, { start });
    assert.equal(found.source, 'generated');
    assert.equal(found.generatedDir, join(packDir, 'generated'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
