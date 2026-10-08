// STRAT-CODEGRAPH-1 fix round 1: the Python adapter's pure derivations, table-driven.
// edge_state (snapshot amendment) and skip_report (files_skipped / skipped_paths /
// budget_exhausted) are computed in lib/codegraph/bundle_fallback.py only; Compose's JS
// reads them. These run under any python3 (no smartmemory import needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODEGRAPH = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'codegraph');

function hasPython() {
  try { execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** Run `expr` (a Python expression over the adapter module `m` and the JSON input `x`); return its JSON. */
function py(expr, input) {
  const script = `import json, sys; sys.path.insert(0, ${JSON.stringify(CODEGRAPH)}); import bundle_fallback as m; `
    + `x = json.loads(sys.stdin.read()); print(json.dumps(${expr}))`;
  // -I keeps the user's site-packages and cwd off the path; -B writes no __pycache__ into lib/codegraph.
  return JSON.parse(execFileSync('python3', ['-I', '-B', '-c', script], { input: JSON.stringify(input), encoding: 'utf8' }));
}

test('edge_state follows the contract derivation table', { skip: !hasPython() && 'no python3' }, () => {
  const rows = [
    // [properties, expected, why]
    [{}, 'resolved', 'structural edge (IMPORTS/DEFINES) joins two indexed entities'],
    [{ unresolved: true }, 'unresolved', 'structural edge flagged unresolved'],
    [{ resolution: 'exact', candidates: [] }, 'resolved', 'reserved exact'],
    [{ resolution: 'name_only', candidates: ['a'], unresolved: false, confidence: 0.5 }, 'resolved', 'one candidate (inferred)'],
    [{ resolution: 'name_only', candidates: ['a', 'b'], unresolved: false }, 'ambiguous', 'several candidates'],
    [{ resolution: 'name_only', candidates: ['a'], module_resolution: 'ambiguous' }, 'ambiguous', 'binding ambiguous'],
    [{ resolution: 'name_only', candidates: ['a'], receiver_status: 'ambiguous' }, 'ambiguous', 'receiver ambiguous'],
    [{ resolution: 'name_only', candidates: [], unresolved: true, confidence: 0 }, 'unresolved', 'no candidates'],
    [{ resolution: 'name_only', candidates: [], unresolved: true, module_resolution: 'unsupported' }, 'unsupported', 'unsupported module site'],
    [{ resolution: 'name_only', candidates: [], unresolved: true, receiver_status: 'unresolved' }, 'unsupported', 'unresolvable receiver'],
    [{ resolution: 'name_only', candidates: ['a', 'b'], unresolved: true }, 'unresolved', 'unresolved flag wins over candidates'],
    [{ resolution: 'name_only' }, 'unresolved', 'resolution present, candidates missing'],
  ];
  const got = py('[m.edge_state(p) for p in x]', rows.map(([p]) => p));
  rows.forEach(([props, expected, why], i) => assert.equal(got[i], expected, `${why}: ${JSON.stringify(props)}`));
});

test('stamp_edge_states stamps relations and call/test evidence, before slimming', { skip: !hasPython() && 'no python3' }, () => {
  const candidates = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const bundle = {
    relations: [{ relation_type: 'CALLS', properties: { resolution: 'name_only', candidates, unresolved: false } }],
    entities: [{ call_evidence: [{ properties: { resolution: 'name_only', candidates: [], unresolved: true } }],
      test_evidence: [{ properties: { resolution: 'name_only', candidates: ['x'], unresolved: false } }] }],
  };
  const out = py('(m.stamp_edge_states(x), x)[1]', bundle);
  assert.equal(out.relations[0].edge_state, 'ambiguous');
  assert.equal(out.entities[0].call_evidence[0].edge_state, 'unresolved');
  assert.equal(out.entities[0].test_evidence[0].edge_state, 'resolved');
});

test('skip_report reads core skip messages, maps the grammar case to grammar_unavailable, and sees budget exhaustion', { skip: !hasPython() && 'no python3' }, () => {
  const report = (errors, filesSkipped) => py(
    'm.skip_report(type("R", (), {"errors": x["errors"], "files_skipped": x["n"]})())', { errors, n: filesSkipped },
  );
  assert.deepEqual(report([], 0), { files_skipped: 0, skipped_paths: [], budget_exhausted: false });
  // Message texts as core writes them (budgets.py record_skip / record_run_exhaustion, indexer.py:474-479).
  const out = report([
    'Extraction failed for lib/bad.py: SyntaxError: invalid syntax',
    'Extraction skipped for lib/big.js: file exceeds 2000000 bytes',
    'Extraction skipped for src/a.ts: typescript/javascript file included only by the default language set failed to extract '
      + '(tree-sitter not installed: No module named \'tree_sitter_typescript\'); skipped, not refused. Pass --language typescript',
    'Extraction stopped at lib/rest.js: SMARTMEMORY_CODE_MAX_RUN_ENTITIES=50000 exhausted; 5 file(s) not extracted. '
      + 'Raise SMARTMEMORY_CODE_MAX_RUN_ENTITIES to index this checkout.',
  ], 7);
  assert.equal(out.files_skipped, 7, 'the count is core\'s, including files a spent budget never named');
  assert.deepEqual(out.skipped_paths.map((s) => [s.path, s.reason]), [
    ['lib/big.js', 'file exceeds 2000000 bytes'],
    ['src/a.ts', 'grammar_unavailable'],
  ]);
  assert.equal(out.budget_exhausted, true);
});
