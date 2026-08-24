/**
 * coverage-gate.test.js — COMP-COVERAGE-GATE slice 2.
 *
 * Two halves:
 *   1. A table-driven error harness over the four codes, on synthetic inputs —
 *      each row constructs the minimal shape that should (or should not) fire
 *      exactly one code.
 *   2. The GATE: the check run against the LIVE tool definitions, registry and
 *      policy. Zero MISSING_EFFECT and zero ORPHAN_REGISTRY_TOOL are hard
 *      assertions; the UNGATED_MUTATION set is pinned so a new ungated mutating
 *      tool fails this test rather than appearing silently in validate output.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkAuthorizationCoverage, C4_EXCEPTIONS } from '../lib/coverage-gate.js';
import { loadToolInventory } from '../lib/tool-inventory.js';
import { canonEntries } from '../lib/canon-registry.js';
import { PROFILE_POLICY, PHASE_REFINEMENT } from '../server/mcp-tool-policy.js';
import { TOOLS } from '../server/mcp-tool-defs.js';

/** Minimal policy stub: implementer denies `deny`, reviewer allows `allow`. */
function policyOf({ deny = [], allow = [], refine = {} } = {}) {
  return {
    PROFILE_POLICY: {
      orchestrator: { mode: 'unrestricted' },
      implementer: { mode: 'deny', tools: new Set(deny) },
      reviewer: { mode: 'allowlist', tools: new Set(allow) },
    },
    PHASE_REFINEMENT: Object.fromEntries(
      Object.entries(refine).map(([k, v]) => [k, new Set(v)]),
    ),
  };
}

const codes = (r) => r.findings.map((f) => f.code);

// --- 1. error harness -------------------------------------------------------

describe('error harness — one row per code', () => {
  const rows = [
    {
      name: 'C1 MISSING_EFFECT — undeclared tool',
      defs: [{ name: 'zap' }],
      registry: [],
      policy: policyOf(),
      expect: ['MISSING_EFFECT'],
      severity: 'error',
    },
    {
      name: 'C1 MISSING_EFFECT — mutating tool with no `writes`',
      defs: [{ name: 'zap', effect: 'mutating' }],
      registry: [],
      policy: policyOf(),
      expect: ['MISSING_EFFECT'],
      severity: 'error',
    },
    {
      name: 'C4 UNGATED_MUTATION — mutating tool in no profile list',
      defs: [{ name: 'zap', effect: 'mutating', writes: [] }],
      registry: [],
      policy: policyOf(),
      expect: ['UNGATED_MUTATION'],
      severity: 'warning',
    },
    {
      name: 'C3 ORPHAN_REGISTRY_TOOL — registry names a tool that is gone',
      defs: [{ name: 'kept', effect: 'read' }],
      registry: [{ id: 'roadmap', display: 'ROADMAP.md', tools: ['renamed_away'] }],
      policy: policyOf(),
      expect: ['ORPHAN_REGISTRY_TOOL'],
      severity: 'warning',
    },
    {
      name: 'C2 UNCOVERED_WRITE — declared write absent from the entry tool list',
      defs: [{ name: 'zap', effect: 'mutating', writes: ['roadmap'] }],
      registry: [{ id: 'roadmap', display: 'ROADMAP.md', tools: [] }],
      policy: policyOf({ deny: ['zap'] }),
      expect: ['UNCOVERED_WRITE'],
      severity: 'info',
    },
  ];

  for (const row of rows) {
    test(row.name, () => {
      const r = checkAuthorizationCoverage({
        inventory: loadToolInventory(row.defs),
        registry: row.registry,
        policy: row.policy,
      });
      assert.deepEqual(codes(r), row.expect);
      assert.equal(r.findings[0].severity, row.severity);
      assert.ok(r.findings[0].remediation.length > 0, 'every finding carries a remediation');
    });
  }
});

describe('the clean cases stay silent', () => {
  test('a read tool needs no gating and writes nothing', () => {
    const r = checkAuthorizationCoverage({
      inventory: loadToolInventory([{ name: 'peek', effect: 'read' }]),
      registry: [], policy: policyOf(),
    });
    assert.deepEqual(r.findings, []);
  });

  test('a setup tool is not a mutation', () => {
    const r = checkAuthorizationCoverage({
      inventory: loadToolInventory([{ name: 'bind_session', effect: 'setup' }]),
      registry: [], policy: policyOf(),
    });
    assert.deepEqual(r.findings, []);
  });

  test('IMPLEMENTER_DENY membership gates a mutation', () => {
    const r = checkAuthorizationCoverage({
      inventory: loadToolInventory([{ name: 'zap', effect: 'mutating', writes: [] }]),
      registry: [], policy: policyOf({ deny: ['zap'] }),
    });
    assert.deepEqual(r.findings, []);
  });

  test('PHASE_REFINEMENT membership gates a mutation', () => {
    const r = checkAuthorizationCoverage({
      inventory: loadToolInventory([{ name: 'zap', effect: 'mutating', writes: [] }]),
      registry: [], policy: policyOf({ refine: { ship: ['zap'] } }),
    });
    assert.deepEqual(r.findings, []);
  });

  test('REVIEWER_ALLOW membership counts as an explicit ruling', () => {
    const r = checkAuthorizationCoverage({
      inventory: loadToolInventory([{ name: 'zap', effect: 'mutating', writes: [] }]),
      registry: [], policy: policyOf({ allow: ['zap'] }),
    });
    assert.deepEqual(r.findings, []);
  });

  test('a C4 exception suppresses the finding without needing a policy entry', () => {
    const tool = Object.keys(C4_EXCEPTIONS)[0];
    const r = checkAuthorizationCoverage({
      inventory: loadToolInventory([{ name: tool, effect: 'mutating', writes: [] }]),
      registry: [], policy: policyOf(),
    });
    assert.deepEqual(r.findings, []);
  });

  test('an undeclared tool is NOT also reported as a registry orphan', () => {
    // It exists — it just forgot its `effect`. Reporting both would send the
    // reader to delete a live tool from the registry.
    const r = checkAuthorizationCoverage({
      inventory: loadToolInventory([{ name: 'zap' }]),
      registry: [{ id: 'roadmap', display: 'ROADMAP.md', tools: ['zap'] }],
      policy: policyOf(),
    });
    assert.deepEqual(codes(r), ['MISSING_EFFECT']);
  });
});

describe('robustness — the check never throws on bad input', () => {
  for (const [label, args] of [
    ['no args', undefined],
    ['empty object', {}],
    ['null inventory', { inventory: null, registry: null, policy: null }],
    ['garbage types', { inventory: 7, registry: 'nope', policy: 3 }],
  ]) {
    test(label, () => {
      const r = checkAuthorizationCoverage(args);
      assert.deepEqual(r.findings, []);
    });
  }
});

describe('findings are ranked most-actionable first', () => {
  test('MISSING_EFFECT before UNGATED_MUTATION before UNCOVERED_WRITE', () => {
    const r = checkAuthorizationCoverage({
      inventory: loadToolInventory([
        { name: 'a_uncovered', effect: 'mutating', writes: ['roadmap'] },
        { name: 'b_ungated', effect: 'mutating', writes: [] },
        { name: 'c_undeclared' },
      ]),
      registry: [{ id: 'roadmap', display: 'ROADMAP.md', tools: [] }],
      policy: policyOf({ deny: ['a_uncovered'] }),
    });
    assert.deepEqual(codes(r), ['MISSING_EFFECT', 'UNGATED_MUTATION', 'UNCOVERED_WRITE']);
  });
});

// --- 2. the gate, against the live surface ----------------------------------

describe('GATE — live tool definitions, registry and policy', () => {
  const live = () => checkAuthorizationCoverage({
    inventory: loadToolInventory(TOOLS),
    registry: canonEntries(),
    policy: { PROFILE_POLICY, PHASE_REFINEMENT },
  });

  test('zero MISSING_EFFECT — every tool declares its effect', () => {
    assert.deepEqual(live().findings.filter((f) => f.code === 'MISSING_EFFECT'), []);
  });

  test('zero ORPHAN_REGISTRY_TOOL — the registry names no vanished tool', () => {
    assert.deepEqual(live().findings.filter((f) => f.code === 'ORPHAN_REGISTRY_TOOL'), []);
  });

  test('zero UNCOVERED_WRITE — closed by the registry fix', () => {
    // complete_feature/kill_feature were the two known instances; slice 2 added
    // them to TOOLS_FOR_FEATURE_JSON. A new one here means a tool started
    // declaring a canon write without being offered as an alternative in the
    // canon-guard deny message.
    assert.deepEqual(live().findings.filter((f) => f.code === 'UNCOVERED_WRITE'), []);
  });

  test('zero UNGATED_MUTATION — the ten C4 findings were closed in IMPLEMENTER_DENY', () => {
    // The gate's first run found ten mutating tools named by no profile list:
    // canon_override_grant (an implementer could mint its own canon bypass),
    // the eight judgment_* writers (the decision record was writable by the
    // profile whose decisions it records), and roadmap_xref_push (writes
    // external trackers). All ten were added to IMPLEMENTER_DENY.
    //
    // This assertion is the standing guard: a NEW mutating tool that nobody
    // rules on fails here, rather than appearing as a warning nobody reads.
    assert.deepEqual(live().findings.filter((f) => f.code === 'UNGATED_MUTATION'), []);
  });

  test('the whole live run is clean — zero findings of any code', () => {
    assert.deepEqual(live().findings, []);
  });

  test('nothing in the live run is an error — the gate is advisory today', () => {
    assert.deepEqual(live().findings.filter((f) => f.severity === 'error'), []);
  });

  test('every C4 exception names a tool that still exists and still mutates', () => {
    const mutating = new Set(loadToolInventory(TOOLS).mutating);
    for (const tool of Object.keys(C4_EXCEPTIONS)) {
      assert.ok(mutating.has(tool), `C4 exception '${tool}' is not a live mutating tool — stale exception`);
      assert.ok(C4_EXCEPTIONS[tool].length > 0, `C4 exception '${tool}' has no reason`);
    }
  });
});

// --- 3. the wiring ----------------------------------------------------------

describe('wired into validateProject, absent from validateFeature', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-gate-'));

  test('validateProject exposes a `coverage` section', async () => {
    const { validateProject } = await import('../lib/feature-validator.js');
    const r = await validateProject(tmp, {});
    assert.ok(r.coverage, 'result.coverage present');
    assert.ok(Array.isArray(r.coverage.findings));
  });

  test('coverage findings also reach the main findings array, tagged', async () => {
    // This is what makes the CLI exit code, --block-on and the REST severity
    // rollup pick them up with no per-consumer fork.
    const { validateProject } = await import('../lib/feature-validator.js');
    const r = await validateProject(tmp, {});
    const tagged = r.findings.filter((f) => f.source === 'coverage');
    assert.equal(tagged.length, r.coverage.findings.length);
    assert.ok(tagged.every((f) => typeof f.detail === 'string' && f.detail.length > 0));
  });

  test('validateFeature has NO coverage section — it is a project property', async () => {
    const { validateFeature } = await import('../lib/feature-validator.js');
    const r = await validateFeature(tmp, 'X-1');
    assert.equal(r.coverage, undefined);
  });
});
