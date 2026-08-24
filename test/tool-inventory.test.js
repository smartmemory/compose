/**
 * COMP-COVERAGE-GATE slice 1 — derived mutating-tool inventory (lib/tool-inventory.js).
 *
 * The contract test below pins the derived set against the live tool
 * definitions. It is the gate: if someone adds a tool to server/mcp-tool-defs.js
 * without declaring `effect`, this suite fails and names it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadToolInventory, mutatingTools, toolsWritingCanon, CANON_IDS } =
  await import(`${REPO_ROOT}/lib/tool-inventory.js`);
const { TOOLS } = await import(`${REPO_ROOT}/server/mcp-tool-defs.js`);
const { _internals: CANON } = await import(`${REPO_ROOT}/lib/canon-registry.js`);

// --- pure partition behavior ---

test('loadToolInventory: partitions by declared effect', () => {
  const inv = loadToolInventory([
    { name: 'a', effect: 'read' },
    { name: 'b', effect: 'setup' },
    { name: 'c', effect: 'mutating', writes: [] },
    { name: 'd', effect: 'mutating', writes: ['roadmap'] },
  ]);
  assert.deepEqual(inv.read, ['a']);
  assert.deepEqual(inv.setup, ['b']);
  assert.deepEqual(inv.mutating, ['c', 'd']);
  assert.deepEqual(inv.undeclared, []);
  assert.deepEqual(inv.writesByTool, { c: [], d: ['roadmap'] });
});

test('loadToolInventory: a missing effect is undeclared, not silently read', () => {
  const inv = loadToolInventory([{ name: 'oops', description: 'x' }]);
  assert.deepEqual(inv.read, []);
  assert.equal(inv.undeclared.length, 1);
  assert.equal(inv.undeclared[0].name, 'oops');
  assert.match(inv.undeclared[0].reason, /no `effect` field/);
});

test('loadToolInventory: an unknown effect value is undeclared', () => {
  const inv = loadToolInventory([{ name: 'weird', effect: 'writes-a-bit' }]);
  assert.equal(inv.undeclared.length, 1);
  assert.match(inv.undeclared[0].reason, /unknown effect/);
});

test('loadToolInventory: mutating without `writes` is undeclared — [] is a real answer', () => {
  const inv = loadToolInventory([{ name: 'forgot', effect: 'mutating' }]);
  assert.equal(inv.mutating.length, 0);
  assert.match(inv.undeclared[0].reason, /no `writes` array/);

  const declaredEmpty = loadToolInventory([{ name: 'fine', effect: 'mutating', writes: [] }]);
  assert.deepEqual(declaredEmpty.mutating, ['fine'], 'writes: [] must be accepted');
  assert.deepEqual(declaredEmpty.undeclared, []);
});

test('loadToolInventory: `writes` naming an unknown canon id is undeclared', () => {
  const inv = loadToolInventory([{ name: 'typo', effect: 'mutating', writes: ['road-map'] }]);
  assert.equal(inv.mutating.length, 0);
  assert.match(inv.undeclared[0].reason, /unknown canon id/);
});

test('loadToolInventory: malformed input never throws', () => {
  assert.deepEqual(loadToolInventory(null).mutating, []);
  assert.deepEqual(loadToolInventory(undefined).undeclared, []);
  const inv = loadToolInventory([null, { effect: 'read' }]);
  assert.equal(inv.undeclared.length, 2, 'null entry and unnamed entry both reported');
});

// --- the contract: the live tool array ---

test('CONTRACT: every live tool declares an effect', () => {
  const { undeclared } = loadToolInventory(TOOLS);
  assert.deepEqual(
    undeclared, [],
    `Undeclared tools found. Add \`effect: 'read' | 'mutating' | 'setup'\` (and \`writes\` `
    + `for mutating) to each in server/mcp-tool-defs.js:\n`
    + undeclared.map((u) => `  - ${u.name}: ${u.reason}`).join('\n'),
  );
});

test('CONTRACT: the live partition matches the authored classification', () => {
  const inv = loadToolInventory(TOOLS);
  // Pinned 2026-08-24 against the 51-tool array. These counts are a tripwire:
  // adding a tool SHOULD break this, forcing an explicit classification review.
  assert.equal(TOOLS.length, 51, 'tool count changed — re-review the classification');
  assert.equal(inv.setup.length, 4);
  assert.equal(inv.read.length, 21);
  assert.equal(inv.mutating.length, 26);
});

test('CONTRACT: setup set matches mcp-tool-policy SETUP_TOOLS', async () => {
  const { SETUP_TOOLS } = await import(`${REPO_ROOT}/server/mcp-tool-policy.js`);
  const inv = loadToolInventory(TOOLS);
  assert.deepEqual(
    inv.setup.slice().sort(), [...SETUP_TOOLS].sort(),
    'the `setup` effect and the cross-profile SETUP_TOOLS exemption must name the same tools',
  );
});

test('CONTRACT: no tool is classified read while naming canon writes', () => {
  for (const def of TOOLS) {
    if (def.effect !== 'mutating') {
      assert.equal(def.writes, undefined, `${def.name}: only mutating tools may declare \`writes\``);
    }
  }
});

test('CONTRACT: every declared canon id exists in the registry', () => {
  const ids = new Set(CANON.REGISTRY.map((e) => e.id));
  for (const id of CANON_IDS) {
    assert.ok(ids.has(id), `CANON_IDS names '${id}' which is not a canon-registry entry id`);
  }
  assert.equal(CANON_IDS.size, ids.size, 'CANON_IDS drifted from the registry entry set');
});

// --- derived helpers ---

test('mutatingTools: derived, and includes the judgment writers', () => {
  const m = mutatingTools(TOOLS);
  assert.ok(m.has('record_completion'));
  assert.ok(m.has('judgment_position_create'));
  assert.ok(!m.has('get_roadmap'), 'a read tool must not appear in the mutating set');
  assert.ok(!m.has('validate_project'));
});

test('toolsWritingCanon: feature-json writers include the lifecycle pair', () => {
  const writers = toolsWritingCanon(TOOLS, 'feature-json');
  // Traced 2026-08-24 (server/vision-routes.js:366,451): complete/kill write
  // feature.json server-side via _postLifecycle. Neither is in the registry's
  // TOOLS_FOR_FEATURE_JSON — that gap is slice 2's C2 finding, recorded here
  // so the trace is not re-derived from scratch next time.
  assert.ok(writers.includes('complete_feature'));
  assert.ok(writers.includes('kill_feature'));
  assert.ok(writers.includes('record_completion'));
  // Traced same day: scaffold_feature writes only the six markdown templates.
  assert.ok(!writers.includes('scaffold_feature'), 'scaffold_feature does not write feature.json');
});

test('toolsWritingCanon: roadmap_xref_push writes EXTERNAL trackers, not our canon', () => {
  // It is `mutating` with `writes: []` — the write-side of xref-sync targets
  // github issues and sibling repos, never this repo's ROADMAP.md.
  assert.ok(mutatingTools(TOOLS).has('roadmap_xref_push'));
  assert.ok(!toolsWritingCanon(TOOLS, 'roadmap').includes('roadmap_xref_push'));
});

// --- the wire boundary ---

test('CONTRACT: `effect`/`writes` are local declarations, never part of the tool schema', () => {
  // server/compose-mcp.js strips these at the ListTools handler (toWire). If a
  // future edit returns TOOLS directly, every session's tools/list response
  // carries two non-MCP fields. This test pins the shape the wire expects, so
  // the strip has a reason attached rather than looking like dead mapping.
  const WIRE_KEYS = ['description', 'inputSchema', 'name'];
  for (const def of TOOLS) {
    const wire = { name: def.name, description: def.description, inputSchema: def.inputSchema };
    assert.deepEqual(Object.keys(wire).sort(), WIRE_KEYS, `${def.name}: wire shape drifted`);
    assert.ok(def.effect, `${def.name}: local declaration must exist alongside the wire fields`);
  }
});
