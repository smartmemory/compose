/**
 * COMP-PIPELINE-QUARANTINE — every shipped spec is either runnable or quarantined.
 *
 * STRAT-PY-RETIRE converted only build and gsd to TS v1 and deleted the older
 * execution paths. The other nine shipped specs stayed behind and became
 * unrunnable — `compose fix`, `compose plan` and `compose build --quick` all
 * died on a bare `MCP error -32602: spec validation failed`. That went unnoticed
 * for a month because the only coverage was two hand-written tests naming build
 * and gsd explicitly, so a spec could rot without any test noticing.
 *
 * This guard iterates the DIRECTORIES instead of a list, so a new or newly
 * broken spec is covered with nothing to remember:
 *
 *   - a spec declaring `version: 1` MUST actually plan on the real TS engine
 *   - a spec declaring anything else MUST be quarantined by pipeline-compat AND
 *     genuinely refused by the engine
 *
 * The second half is what keeps the quarantine honest: without it, marking a
 * spec incompatible would be an unchecked claim.
 *
 * Plan inputs are synthesized from each flow's OWN declared input types rather
 * than a per-pipeline fixture table — a fixture table is the thing that goes
 * stale and re-creates the gap this test exists to close.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { spawnSync } from 'node:child_process';

import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { tsCompatibilityOf, TS_SPEC_VERSION } from '../lib/pipeline-compat.js';
import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_DIRS = ['pipelines', 'presets'];

/** Every shipped spec, as {dir, file, absPath, text}. */
function shippedSpecs() {
  const specs = [];
  for (const dir of SPEC_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs).filter(f => f.endsWith('.stratum.yaml'))) {
      const absPath = path.join(abs, file);
      specs.push({ dir, file, absPath, text: readFileSync(absPath, 'utf8') });
    }
  }
  return specs;
}

/**
 * Build an input object satisfying a v1 flow's declared `input` block.
 *
 * Optional fields are supplied too, not omitted: gsd declares `pre_merge_gate`
 * optional but references it unconditionally in a fanout's `pre_merge`, so
 * omitting it fails the plan for a reason that says nothing about the health of
 * the spec. This guard asks "can this pipeline run", not "are its optional
 * markers accurate".
 *
 * A declared type carries no value constraints, but a few inputs are
 * semantically constrained by the engine — an `*_agent` input must resolve to a
 * real connector. Those get a valid value by name; everything else stays
 * generic, so a brand-new pipeline is still covered with nothing added here.
 *
 * Throws on a type this synthesizer does not model, so an exotic input forces a
 * deliberate update instead of silently narrowing what the guard covers.
 */
function synthesizeInput(inputDecl) {
  const input = {};
  for (const [field, rawType] of Object.entries(inputDecl ?? {})) {
    const type = String(rawType).replace(/\?$/, '');
    if (/_agent$/.test(field)) input[field] = 'claude';
    else if (type === 'string') input[field] = `probe-${field}`;
    else if (type === 'string[]') input[field] = [`probe-${field}`];
    else if (type === 'number') input[field] = 1;
    else if (type === 'boolean') input[field] = true;
    else if (type === 'object') input[field] = {};
    else throw new Error(`synthesizeInput does not model type ${JSON.stringify(type)} (field ${field})`);
  }
  return input;
}

async function withClient(fn) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'compose-pipeline-guard-'));
  const client = new StratumMcpClient();
  try {
    await client.connect({
      command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      args: [TS_MCP_BIN],
      env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
    });
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await rm(stateRoot, { recursive: true, force: true });
  }
}

test('there are shipped specs to check (the guard is not vacuously green)', () => {
  const specs = shippedSpecs();
  assert.ok(specs.length >= 10, `expected the shipped spec set, found ${specs.length}`);
  assert.ok(specs.some(s => s.file === 'build.stratum.yaml'));
  assert.ok(specs.some(s => s.file === 'bug-fix.stratum.yaml'));
});

test('every v1 spec plans on the real TS engine', async () => {
  const v1 = shippedSpecs().filter(s => tsCompatibilityOf(s.text).compatible);
  assert.ok(v1.length >= 4, `expected at least the migrated specs, found ${v1.length}`);

  const failures = await withClient(async (client) => {
    const bad = [];
    for (const spec of v1) {
      const parsed = YAML.parse(spec.text);
      const entry = parsed?.flows?.entry;
      if (!entry) { bad.push(`${spec.file}: declares version 1 but no flows.entry`); continue; }
      try {
        const planned = await client.plan(spec.text, entry, synthesizeInput(parsed.flows[entry]?.input));
        if (planned.status !== 'ready') bad.push(`${spec.file}: plan returned ${planned.status}`);
      } catch (err) {
        bad.push(`${spec.file}: ${err.message}`);
      }
    }
    return bad;
  });

  assert.deepEqual(failures, [], `v1 specs that cannot run:\n${failures.join('\n')}`);
});

test('every pipeline declares inputs the runner that drives it actually sends', () => {
  // The plan-input envelope comes from the MODE, not from the spec (lib/build.js
  // startFresh, lib/lifecycle-modes.js). A spec is only drivable if its REQUIRED
  // inputs are a subset of the envelope of the runner that actually invokes it.
  //
  // This is the assertion that was missing. The plan test above synthesizes
  // inputs from each spec's OWN declaration, so it happily proved that five
  // pipelines could plan — with an envelope no runner ever sends. They resolved
  // and then failed at run time, which is worse than being unreachable.
  //
  // Matching against "any envelope" is not enough either: `task` alone looks
  // drivable because bug mode sends exactly that, but bug mode only ever runs
  // bug-fix. The binding below is per-spec, and anything NOT bound is reached
  // through `--template`, which is feature mode.
  const ENVELOPES = {
    feature: ['featureCode', 'description', 'implementer_agent', 'reviewer_agent', 'pre_merge_gate'],
    bug: ['task'],
    plan: ['projectName', 'intent'],
    gsd: ['featureCode', 'gateCommands', 'pre_merge_gate'],
  };
  // Specs a dedicated runner drives with its own envelope. Everything else —
  // including every preset — is reached through `compose build --template <name>`,
  // i.e. feature mode.
  //
  // These bindings are only safe because `compose build` REFUSES these four
  // templates (bin/compose.js MODE_BOUND_TEMPLATES). Without that refusal the
  // generic --template path could select them under feature mode and they would
  // fail at plan time, so the exception list would be describing a hole rather
  // than a guarantee. The assertion below checks the refusal still exists.
  const DRIVER = {
    'bug-fix.stratum.yaml': 'bug',
    'plan.stratum.yaml': 'plan',
    'new.stratum.yaml': 'plan',
    'gsd.stratum.yaml': 'gsd',
  };

  // BEHAVIORAL, not a grep: the first version of this searched bin/compose.js for
  // the map's keys, and still passed with the refusal's `if` block deleted. It has
  // to actually invoke the CLI, and with a path-ish spelling too — resolveTemplatePath
  // normalizes `./bug-fix` through join(), so an exact-string guard was bypassable.
  for (const [file, driverCmd] of Object.entries({
    'bug-fix.stratum.yaml': 'compose fix',
    'plan.stratum.yaml': 'compose plan',
    'new.stratum.yaml': 'compose new',
    'gsd.stratum.yaml': 'compose gsd',
  })) {
    const name = file.replace('.stratum.yaml', '');
    for (const spelling of [name, `./${name}`]) {
      // Run in a THROWAWAY cwd. Invoking the CLI from the repo root wrote
      // docs/features/GUARD-1/audit.json into the working tree — a test that
      // dirties the repo it is testing.
      const probeCwd = mkdtempSync(path.join(tmpdir(), 'compose-template-guard-'));
      let r;
      try {
        r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'compose.js'), 'build', '--template', spelling, 'GUARD-1'], { encoding: 'utf-8', cwd: probeCwd });
      } finally {
        rmSync(probeCwd, { recursive: true, force: true });
      }
      assert.equal(r.status, 1, `compose build --template ${spelling} must be refused`);
      assert.match(r.stderr, /is not a build template/, `--template ${spelling} must be refused by name`);
      assert.ok(r.stderr.includes(driverCmd), `refusal for ${spelling} must point at ${driverCmd}`);
    }
  }

  const offenders = [];
  for (const spec of shippedSpecs()) {
    const parsed = YAML.parse(spec.text);
    const entry = parsed?.flows?.entry;
    const declared = parsed?.flows?.[entry]?.input ?? {};
    const required = Object.entries(declared)
      .filter(([, type]) => !String(type).endsWith('?'))
      .map(([field]) => field);
    const driver = DRIVER[spec.file] ?? 'feature';
    const missing = required.filter(field => !ENVELOPES[driver].includes(field));
    if (missing.length) {
      offenders.push(`${spec.dir}/${spec.file}: driven by ${driver} mode, which never sends [${missing.join(', ')}]`);
    }
  }
  assert.deepEqual(offenders, [], `pipelines their runner cannot drive:\n${offenders.join('\n')}`);
});

test('nothing shipped is stranded on a retired dialect', () => {
  // As of COMP-PIPELINE-QUARANTINE every shipped spec is v1, so the loop below
  // would otherwise iterate nothing and pass vacuously. This states the real
  // claim: adding a spec on an older dialect fails HERE, at the point it lands,
  // rather than the first time somebody tries to run it.
  const stranded = shippedSpecs().filter(s => !tsCompatibilityOf(s.text).compatible);
  assert.deepEqual(stranded.map(s => `${s.dir}/${s.file}`), []);
});

test('any non-v1 spec would be quarantined AND genuinely refused by the engine', async () => {
  const stranded = shippedSpecs().filter(s => !tsCompatibilityOf(s.text).compatible);

  for (const spec of stranded) {
    const compat = tsCompatibilityOf(spec.text);
    assert.equal(compat.compatible, false, spec.file);
    assert.ok(compat.reason, `${spec.file}: quarantine must state a reason`);
    assert.notEqual(compat.version, TS_SPEC_VERSION, spec.file);
  }

  // The half that keeps the quarantine honest: each one must ALSO be rejected by
  // the engine. A spec we mark unrunnable that actually runs is a false refusal.
  const wronglyQuarantined = await withClient(async (client) => {
    const wrong = [];
    for (const spec of stranded) {
      const parsed = (() => { try { return YAML.parse(spec.text); } catch { return null; } })();
      const entry = parsed?.flows?.entry ?? Object.keys(parsed?.flows ?? {})[0] ?? 'main';
      try {
        await client.plan(spec.text, entry, {});
        wrong.push(spec.file);
      } catch { /* refused, as quarantine claims */ }
    }
    return wrong;
  });

  assert.deepEqual(wronglyQuarantined, [], `marked unrunnable but the engine accepted them: ${wronglyQuarantined.join(', ')}`);
});

test('invoking a quarantined pipeline fails with a message that names the cause', async () => {
  // The failure users actually hit. Before the quarantine seam this surfaced as
  // a bare `MCP error -32602: spec validation failed` naming neither the file
  // nor the reason, which is why three broken commands read as mysterious rather
  // than as un-migrated.
  const ws = mkdtempSync(path.join(tmpdir(), 'compose-quarantine-'));
  try {
    mkdirSync(path.join(ws, '.compose'), { recursive: true });
    writeFileSync(path.join(ws, '.compose', 'compose.json'), JSON.stringify({ capabilities: { stratum: true } }));
    mkdirSync(path.join(ws, 'pipelines'), { recursive: true });
    // The fixture is MINTED here rather than copied from pipelines/. Pointing at a
    // real stranded spec made this test quietly depend on the repo still containing
    // one, so it broke the moment the last of them was migrated — the refusal path
    // has to stay covered after there is nothing left to refuse. It also has to keep
    // working for a workspace that pins an old spec, which is the real-world case.
    writeFileSync(path.join(ws, 'pipelines', 'plan.stratum.yaml'), [
      'version: "0.3"',
      'workflow:',
      '  name: plan',
      'flows:',
      '  plan:',
      '    steps: []',
      '',
    ].join('\n'));
    mkdirSync(path.join(ws, 'docs', 'bugs', 'BUG-1'), { recursive: true });
    writeFileSync(path.join(ws, 'docs', 'bugs', 'BUG-1', 'description.md'), '# BUG-1\nbroken\n');

    const { runBuild } = await import('../lib/build.js');
    await assert.rejects(
      () => runBuild('BUG-1', { cwd: ws, template: 'plan', mode: 'bug', description: 'probe' }),
      (err) => {
        assert.match(err.message, /This pipeline cannot run/);
        assert.match(err.message, /plan\.stratum\.yaml/);
        assert.match(err.message, /only runs version 1/);
        assert.doesNotMatch(err.message, /-32602/);
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('the migrated bug-fix pipeline runs its whole lifecycle to completion', async () => {
  const specText = readFileSync(path.join(ROOT, 'pipelines', 'bug-fix.stratum.yaml'), 'utf8');
  const evidence = { command: 'node -e "..."', actual_output: '2', conclusion: 'renders twice' };
  const outputs = {
    reproduce: { phase: 'reproduce', summary: 'failing test written', outcome: 'complete' },
    diagnose: {
      root_cause: 'double subscribe', affected_layers: ['frontend'],
      trace_evidence: [evidence, evidence], summary: 'traced', scope_hint: 'single',
    },
    bisect: { skipped: true, bisect_commit: '', estimate_minutes: 0, log_path: '', summary: 'not a regression' },
    scope_check: { scope: 'single', references_found: [], repos_scanned: 1, summary: 'single layer', references_count: '0' },
    fix: { phase: 'fix', summary: 'removed duplicate subscribe', outcome: 'complete' },
    test: { passing: true, summary: '100 passed', failures: [] },
    verify: { phase: 'verify', summary: 'repro now passes', outcome: 'complete' },
    retro_check: { fix_chains: [], attempt_count: 1, escalation: false, discipline_score: 95, summary: 'clean' },
    // ShipResult, not BugFixResult: `ship` is intercepted by compose and submitted
    // as the commit-metadata shape, so it declares its own contract.
    ship: { phase: 'ship', artifact: 'abc1234', summary: 'committed abc1234', outcome: 'complete', commit_hash: 'abc1234' },
  };

  const { walked, status, output } = await withClient(async (client) => {
    let res = await client.plan(specText, 'bug_fix', { task: 'BUG-1: widget renders twice' });
    const order = [];
    let guard = 0;
    while (res.status === 'ready' && guard++ < 30) {
      const step = res.ready[0];
      order.push(step.id);
      res = await client.stepDone(res.runId, step.id, { output: outputs[step.id] }, step.dispatchToken);
    }
    return { walked: order, status: res.status, output: res.output ?? null };
  });

  assert.deepEqual(walked, [
    'reproduce', 'diagnose', 'bisect', 'scope_check', 'fix', 'test', 'verify', 'retro_check', 'ship',
  ]);
  assert.equal(status, 'completed');
  assert.equal(output?.outcome, 'complete');
});

test('bug-fix debug-discipline guards reject weak diagnoses', async () => {
  const specText = readFileSync(path.join(ROOT, 'pipelines', 'bug-fix.stratum.yaml'), 'utf8');
  const evidence = { command: 'c', actual_output: 'o', conclusion: 'x' };
  const reproduced = { phase: 'reproduce', summary: 's', outcome: 'complete' };

  // Each of these must send diagnose back for another attempt rather than
  // advancing — they are the COMP-DEBUG-1 discipline rules, and a migration that
  // silently dropped them would still plan and still walk.
  const rejected = {
    'one piece of trace evidence': { root_cause: 'r', affected_layers: [], trace_evidence: [evidence], summary: 's', scope_hint: 'single' },
    'scope_hint outside the enum': { root_cause: 'r', affected_layers: [], trace_evidence: [evidence, evidence], summary: 's', scope_hint: 'bogus' },
    'empty root cause': { root_cause: '', affected_layers: [], trace_evidence: [evidence, evidence], summary: 's', scope_hint: 'single' },
  };

  await withClient(async (client) => {
    for (const [label, diagnoseOut] of Object.entries(rejected)) {
      let res = await client.plan(specText, 'bug_fix', { task: 't' });
      res = await client.stepDone(res.runId, 'reproduce', { output: reproduced }, res.ready[0].dispatchToken);
      res = await client.stepDone(res.runId, 'diagnose', { output: diagnoseOut }, res.ready[0].dispatchToken);
      assert.equal(res.ready?.[0]?.id, 'diagnose', `${label}: should retry diagnose`);
      assert.equal(res.ready?.[0]?.attempt, 2, `${label}: should be a second attempt`);
    }

    // Control: a compliant diagnosis advances, so the assertions above are
    // measuring the guards and not some unrelated stall.
    let res = await client.plan(specText, 'bug_fix', { task: 't' });
    res = await client.stepDone(res.runId, 'reproduce', { output: reproduced }, res.ready[0].dispatchToken);
    res = await client.stepDone(res.runId, 'diagnose', {
      output: { root_cause: 'r', affected_layers: [], trace_evidence: [evidence, evidence], summary: 's', scope_hint: 'single' },
    }, res.ready[0].dispatchToken);
    assert.equal(res.ready?.[0]?.id, 'bisect');
  });
});
