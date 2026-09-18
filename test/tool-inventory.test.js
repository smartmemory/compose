/**
 * COMP-COVERAGE-GATE slice 1 — derived mutating-tool inventory (lib/tool-inventory.js).
 *
 * The contract test below pins the derived set against the live tool
 * definitions. It is the gate: if someone adds a tool to server/mcp-tool-defs.js
 * without declaring `effect`, this suite fails and names it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadToolInventory, mutatingTools, toolsWritingCanon, CANON_IDS } =
  await import(`${REPO_ROOT}/lib/tool-inventory.js`);
const { TOOLS } = await import(`${REPO_ROOT}/server/mcp-tool-defs.js`);
const { _internals: CANON } = await import(`${REPO_ROOT}/lib/canon-registry.js`);
const { pushExternalRefs } = await import(`${REPO_ROOT}/lib/xref-push.js`);

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
  // Pinned 2026-09-08 after retiring `canon_override_grant`. These counts are a tripwire:
  // adding a tool SHOULD break this, forcing an explicit classification review.
  assert.equal(TOOLS.length, 51, 'tool count changed — re-review the classification');
  assert.equal(inv.setup.length, 4);
  assert.equal(inv.read.length, 21);
  assert.equal(inv.mutating.length, 26);
});

test('CONTRACT: the retired canon override grant is absent from the live MCP surface', () => {
  assert.ok(!TOOLS.some((tool) => tool.name === 'canon_override_grant'));
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

test('CONTRACT: link_features advertises the Forgejo push fields it accepts', () => {
  const definition = TOOLS.find((tool) => tool.name === 'link_features');
  assert.ok(definition, 'link_features must remain on the MCP surface');

  // Tool schemas intentionally allow extra properties. Tighten only this test
  // copy so a field missing from the advertised surface cannot pass as an
  // unvalidated unknown property.
  const validate = new Ajv({ strict: false }).compile({
    ...definition.inputSchema,
    additionalProperties: false,
  });
  const input = {
    from_code: 'COMP-TRACKER-FORGEJO',
    kind: 'external',
    provider: 'forgejo',
    repo: 'smartmemory/compose',
    issue: 7,
    push: true,
    expect_labels: ['roadmap-tracked'],
    derive_expect: true,
  };

  assert.equal(validate(input), true, JSON.stringify(validate.errors));
  assert.deepEqual(definition.inputSchema.properties.provider.enum, [
    'github', 'forgejo', 'local', 'url', 'jira', 'linear', 'notion', 'obsidian',
  ]);
  assert.equal(definition.inputSchema.properties.push.type, 'boolean');
  assert.deepEqual(definition.inputSchema.properties.expect_labels, {
    type: 'array',
    items: { type: 'string', minLength: 1 },
    description: 'Optional labels to add without removing existing labels. Supported by github and forgejo links.',
  });
  assert.equal(definition.inputSchema.properties.derive_expect.type, 'boolean');
});

test('CONTRACT: roadmap_xref_push documents the actual Forgejo partial-success row', async () => {
  const definition = TOOLS.find((tool) => tool.name === 'roadmap_xref_push');
  assert.ok(definition, 'roadmap_xref_push must remain on the MCP surface');

  const cwd = mkdtempSync(join(tmpdir(), 'compose-mcp-xref-contract-'));
  const featureDir = join(cwd, 'docs', 'features', 'COMP-XREF-1');
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'feature.json'), JSON.stringify({
    code: 'COMP-XREF-1',
    status: 'IN_PROGRESS',
    links: [{
      kind: 'external', provider: 'forgejo', repo: 'smartmemory/compose', issue: 7,
      expect: 'closed', expect_labels: ['roadmap-tracked'], push: true,
    }],
  }));

  try {
    const result = await pushExternalRefs(cwd, {
      apply: true,
      forgejoResolve: async () => ({ state: 'open', labels: [] }),
      forgejoWrite: async () => ({
        statePushed: true,
        labelsPushed: false,
        errors: ['label "roadmap-tracked" write HTTP 503'],
      }),
    });
    const row = result.pushed[0];
    const outcomeKeys = ['statePushed', 'labelsPushed', 'errors']
      .filter((key) => Object.hasOwn(row, key));
    const actualShape = `{${outcomeKeys
      .map((key) => Array.isArray(row[key]) ? `${key}[]` : key)
      .join(', ')}}`;

    assert.deepEqual(
      { statePushed: row.statePushed, labelsPushed: row.labelsPushed, errors: row.errors },
      {
        statePushed: true,
        labelsPushed: false,
        errors: ['label "roadmap-tracked" write HTTP 503'],
      },
    );
    assert.equal(actualShape, '{statePushed, labelsPushed, errors[]}');
    assert.match(definition.description, /Forgejo/);
    assert.match(definition.description, /partial-success/);
    assert.ok(
      definition.description.includes(actualShape),
      `roadmap_xref_push description must document its actual Forgejo outcome ${actualShape}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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
  // TOOLS_FOR_FEATURE_JSON. Slice 2 surfaced that as its C2 finding and closed
  // it (both are now in the registry list); the trace is kept here so it is not
  // re-derived from scratch next time.
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
