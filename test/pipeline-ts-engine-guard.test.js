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
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

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

test('every non-v1 spec is quarantined AND genuinely refused by the engine', async () => {
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
    // Any still-stranded spec works here; plan is one of the three real commands.
    cpSync(path.join(ROOT, 'pipelines', 'plan.stratum.yaml'), path.join(ws, 'pipelines', 'plan.stratum.yaml'));
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
    ship: { phase: 'ship', summary: 'committed abc1234', outcome: 'complete' },
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
