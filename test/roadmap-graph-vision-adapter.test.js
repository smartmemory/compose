/**
 * roadmap-graph-vision-adapter.test.js — unit tests for visionToGraphInputs
 * (COMP-ROADMAP-GRAPH-2). The adapter converts a VisionStore's items +
 * connections into the { nodes, rawEdges, knownCodes } shape buildGraph
 * consumes, so the cockpit/vision model can drive the one canonical renderer.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { visionToGraphInputs } from '../lib/roadmap-graph/vision-adapter.js';
import { buildGraph, DanglingEdgeError } from '../lib/roadmap-graph/model.js';

// ---- fixture helpers -------------------------------------------------------

let _uuid = 0;
function uid() { return `00000000-0000-0000-0000-${String(++_uuid).padStart(12, '0')}`; }

function item(featureCode, overrides = {}) {
  return {
    id: overrides.id || uid(),
    type: 'feature',
    title: featureCode,
    description: `${featureCode} description`,
    status: 'planned',
    priority: null,
    group: null,
    featureCode,
    ...overrides,
  };
}

function conn(fromId, toId, type) {
  return { id: uid(), fromId, toId, type, createdAt: 'now' };
}

// ---- node mapping ----------------------------------------------------------

describe('visionToGraphInputs node mapping', () => {
  test('maps feature items to CollectedNode shape with UPPERCASE status', () => {
    const a = item('COMP-A', { status: 'in_progress', priority: 'high', group: 'core' });
    const { nodes } = visionToGraphInputs([a], [], {});
    assert.equal(nodes.length, 1);
    assert.deepEqual(nodes[0], {
      id: 'COMP-A',
      status: 'IN_PROGRESS',
      name: 'COMP-A',
      priority: 'high',
      track: 'core',
      desc: 'COMP-A description',
    });
  });

  test('track falls back to standalone, priority to medium', () => {
    const { nodes } = visionToGraphInputs([item('COMP-A')], [], {});
    assert.equal(nodes[0].track, 'standalone');
    assert.equal(nodes[0].priority, 'medium');
  });

  test('filters non-feature items out of the node set', () => {
    const items = [item('COMP-A'), item('IDEA-1', { type: 'idea' })];
    const { nodes } = visionToGraphInputs(items, [], {});
    assert.deepEqual(nodes.map((n) => n.id), ['COMP-A']);
  });

  test('uses featureCode as id, falling back to title when absent', () => {
    const noCode = item('COMP-B', { featureCode: null, title: 'COMP-B' });
    const { nodes } = visionToGraphInputs([noCode], [], {});
    assert.equal(nodes[0].id, 'COMP-B');
  });

  test('prefers lifecycle.featureCode over top-level featureCode/title (live store)', () => {
    const live = item('ignored-title', { featureCode: null, title: 'ignored-title', lifecycle: { featureCode: 'COMP-LC' } });
    const { nodes } = visionToGraphInputs([live], [], {});
    assert.equal(nodes[0].id, 'COMP-LC');
  });

  test('strips Track:/Priority: lines from desc', () => {
    const a = item('COMP-A', { description: 'Real summary.\nTrack: core\nPriority: high' });
    const { nodes } = visionToGraphInputs([a], [], {});
    assert.equal(nodes[0].desc, 'Real summary.');
  });
});

// ---- edge mapping ----------------------------------------------------------

describe('visionToGraphInputs edge mapping', () => {
  test('maps connection types to dep/concurrent and resolves uuids to codes', () => {
    const a = item('COMP-A');
    const b = item('COMP-B');
    const connections = [
      conn(a.id, b.id, 'blocks'),       // -> dep
      conn(a.id, b.id, 'supports'),     // -> concurrent
    ];
    const { rawEdges } = visionToGraphInputs([a, b], connections, {});
    assert.deepEqual(rawEdges, [
      { from: 'COMP-A', to: 'COMP-B', type: 'dep' },
      { from: 'COMP-A', to: 'COMP-B', type: 'concurrent' },
    ]);
  });

  test('informs and implements map to dep; contradicts maps to concurrent', () => {
    const a = item('COMP-A');
    const b = item('COMP-B');
    const mk = (t) => visionToGraphInputs([a, b], [conn(a.id, b.id, t)], {}).rawEdges[0].type;
    assert.equal(mk('informs'), 'dep');
    assert.equal(mk('implements'), 'dep');
    assert.equal(mk('contradicts'), 'concurrent');
  });

  test('drops edges whose endpoint is not a feature item, with a warning', () => {
    const a = item('COMP-A');
    const idea = item('IDEA-1', { type: 'idea' });
    const { rawEdges, warnings } = visionToGraphInputs([a, idea], [conn(a.id, idea.id, 'blocks')], {});
    assert.equal(rawEdges.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /IDEA-1|unresolved|non-feature/i);
  });
});

// ---- knownCodes / external prefixes ---------------------------------------

describe('visionToGraphInputs knownCodes', () => {
  test('knownCodes includes every node id', () => {
    const { knownCodes } = visionToGraphInputs([item('COMP-A'), item('COMP-B')], [], {});
    assert.ok(knownCodes.has('COMP-A') && knownCodes.has('COMP-B'));
  });

  test('feeds buildGraph without throwing for a self-consistent store', () => {
    const a = item('COMP-A');
    const b = item('COMP-B');
    const inputs = visionToGraphInputs([a, b], [conn(a.id, b.id, 'blocks')], {});
    assert.doesNotThrow(() => buildGraph(inputs));
  });

  test('includeProseEdges:false drops informs edges but keeps structural ones (canonical projection)', () => {
    const a = item('COMP-A');
    const b = item('COMP-B');
    const c = item('COMP-C');
    const connections = [
      conn(a.id, b.id, 'informs'),   // prose-derived -> dropped when excluded
      conn(a.id, c.id, 'blocks'),    // deps.yaml-derived -> kept
      conn(b.id, c.id, 'supports'),  // deps.yaml concurrent -> kept
    ];
    const live = visionToGraphInputs([a, b, c], connections, {});
    assert.equal(live.rawEdges.length, 3); // default keeps prose edges (shipped live behavior)

    const canonical = visionToGraphInputs([a, b, c], connections, { includeProseEdges: false });
    assert.deepEqual(
      canonical.rawEdges.map((e) => `${e.from}->${e.to}:${e.type}`).sort(),
      ['COMP-A->COMP-C:dep', 'COMP-B->COMP-C:concurrent'],
    );
  });

  test('external-prefixed edge endpoints are known (no dangling) but not rendered', () => {
    // A depends on an external STRAT- code that has no node.
    const a = item('COMP-A');
    const ext = item('STRAT-X', { type: 'feature' });
    // Emulate a connection to an external code that is NOT a node in our set:
    // build via a synthetic connection whose target resolves to an external code.
    const connections = [conn(a.id, ext.id, 'blocks')];
    // Pass ext as an item so its id resolves, but treat STRAT- as external prefix.
    const inputs = visionToGraphInputs([a, ext], connections, { externalPrefixes: ['STRAT-'] });
    // STRAT-X must be known so buildGraph won't throw, and must not be a rendered node.
    assert.ok(inputs.knownCodes.has('STRAT-X'));
    assert.ok(!inputs.nodes.some((n) => n.id === 'STRAT-X'));
    assert.doesNotThrow(() => buildGraph(inputs));
  });
});
