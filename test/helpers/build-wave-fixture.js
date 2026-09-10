import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { makeBuildWorkspace, fakeBuildStratum, agentResult } from './build-stratum-fixture.js';
import { git } from './consumer-wave-fixture.js';
import { ConsumerFanoutArtifacts } from '../../lib/consumer-fanout.js';
import { runBuild } from '../../lib/build.js';

export const decisionProfiles = {
  assess_gate: { decide_from: { step: 'assess', field: 'action', approve: ['complete'], revise: ['repair', 'implement'], kill: ['blocked'] },
    validators: [{ name: 'WaveDecision', review_step: 'review' }] },
  execute: { default: 'codex:implementer:standard', tier_from: 'item.tier' },
  _consumer: { execute: { ownership: 'item.files_owned', independent: true, checkpoint_gate: 'execute_merge' } },
};
export function task(index, tier) {
  return { id: `T${index}`, description: `write file ${index}`, files_owned: [`f${index}.txt`], files_read: [], depends_on: [],
    ...(tier !== undefined ? { tier } : {}) };
}
export function decision(action = 'complete', extra = {}) {
  return { action, rationale: action, addressed_findings: [], open_findings: [], open_count: 0,
    blocking: false, tasks: [], ...extra };
}
export function waveSpec({ gsd = false, ship = false } = {}) {
  return { version: 1, contracts: { R: { outcome: 'string', summary: 'string' } }, flows: {
    entry: gsd ? 'gsd' : 'bug_fix', [gsd ? 'gsd' : 'bug_fix']: {
      input: { task: 'string' }, output: { from: '${assess.output}', contract: 'R' }, max_rounds: 4,
      steps: [
        { id: 'plan', agent: 'claude', do: 'plan' },
        { id: 'execute', after: ['plan'], fanout: { over: '${plan.output.tasks}', as: 'item', dispatch: 'consumer', isolation: 'worktree',
          concurrency: 3, merge: 'sequential', steps: [{ id: 'work', agent: 'codex', do: 'work', out: 'R' }] } },
        { id: 'execute_merge', after: ['execute'], gate: { on_approve: 'review', on_revise: 'plan', on_kill: null, max_rounds: 4 } },
        { id: 'review', after: ['execute_merge'], agent: 'claude', do: 'review' },
        { id: 'assess', after: ['review'], agent: 'claude', do: 'assess' },
        { id: 'assess_gate', after: ['assess'], gate: { on_approve: ship ? (gsd ? 'ship_gsd' : 'ship') : null, on_revise: 'plan', on_kill: null, max_rounds: 4 } },
        ...(ship ? [{ id: gsd ? 'ship_gsd' : 'ship', after: ['assess_gate'], agent: 'claude', do: 'ship' }] : []),
      ],
    },
  } };
}
export function buildWaveFixture(t, { profiles = decisionProfiles, spec = waveSpec(), tasks = [task(1)], output = decision(), gate = false, receipts = [], mutate } = {}) {
  const code = 'D2-WIRING';
  const cwd = makeBuildWorkspace(code, { spec: YAML.stringify(spec), profiles, compose: { policies: { default: 'skip' } } });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, '.gitignore'), '.compose/\n');
  git(cwd, ['init', '-q']); git(cwd, ['config', 'user.name', 'Wave Test']); git(cwd, ['config', 'user.email', 'test@example.test']);
  git(cwd, ['add', '-A']); git(cwd, ['commit', '-qm', 'base']);
  const base = git(cwd, ['rev-parse', 'HEAD']);
  const artifactRoot = `${cwd}-artifacts`;
  t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
  writeFileSync(join(cwd, '.compose/data/settings.json'), JSON.stringify({ policies: { execute_merge: 'skip', assess_gate: 'skip' } }));
  const stateRoot = join(cwd, '.compose', 'engine'); mkdirSync(stateRoot, { recursive: true });
  const runId = 'flow-wave';
  const state = { id: runId, revisionDigest: 'revision', input: {}, receipts: structuredClone(receipts), status: 'running', events: [], steps: {
    plan: { status: 'succeeded', output: { tasks }, epoch: 0, acceptedDispatchToken: 'plan-token' },
    execute: { epoch: 0, status: gate ? 'succeeded' : 'running', fanout: { items: tasks.map((_, i) => ({ generation: i + 1, status: 'pending' })) } },
    ...(gate ? { review: { status: 'succeeded', output: { blocking: false }, epoch: 0 },
      assess: { status: 'succeeded', output, epoch: 0, acceptedDispatchToken: 'assess-token' },
      assess_gate: { status: 'waiting_gate', gateToken: 'gate-token', epoch: 0 } } : {}),
  } };
  const persist = () => writeFileSync(join(stateRoot, `${runId}.json`), JSON.stringify(state));
  const descriptors = tasks.map((item, itemIndex) => ({ id: `execute/${itemIndex}`, step: 'execute', flow: 'bug_fix',
    itemIndex, item, generation: itemIndex + 1, epoch: 0, stage: 0, attempt: 1, dispatchToken: `token-${itemIndex}`,
    revisionDigest: 'revision', contractDigest: 'contract', agent: 'codex', do: `write ${itemIndex}`,
    policy: { isolation: 'worktree' }, contract: { root: 'R', contracts: { R: { outcome: 'string', summary: 'string' } } } }));
  let finished = 0;
  const ready = () => {
    const selected = descriptors.filter((d, i) => !['succeeded', 'failed'].includes(state.steps.execute.fanout.items[i].status)).slice(0, 3);
    for (const d of selected) Object.assign(state.steps.execute.fanout.items[d.itemIndex], { status: 'running', dispatchToken: d.dispatchToken });
    persist();
    return { status: 'ready', runId, revisionDigest: 'revision', ready: selected };
  };
  const current = () => gate || state.steps.execute_merge?.status === 'waiting_gate'
    ? { status: state.status, runId, revisionDigest: 'revision' } : ready();
  const stratum = fakeBuildStratum({ plan: () => current(),
    audit: () => structuredClone({ ...state, runId }),
    agentRun: (_provider, prompt, opts) => {
      const index = Number(prompt.match(/write (\d+)/)?.[1] ?? 0);
      if (mutate) mutate(opts.cwd, index, opts);
      else writeFileSync(join(opts.cwd, `f${index + 1}.txt`), `wave ${index}\n`);
      return agentResult({ outcome: 'complete', summary: 'done' }, `call-${index}`);
    },
    stepDone: (_flow, id, envelope, token) => {
      const d = descriptors.find(d => d.dispatchToken === token);
      const item = state.steps.execute.fanout.items[d.itemIndex];
      delete item.dispatchToken;
      Object.assign(item, { status: envelope.failure ? 'failed' : 'succeeded', acceptedDispatchToken: token });
      finished++;
      if (finished < tasks.length) return ready();
      if (state.steps.execute.fanout.items.some(i => i.status === 'failed')) {
        state.status = 'failed'; persist(); return { status: 'failed', runId };
      }
      state.steps.execute.status = 'succeeded';
      state.steps.execute_merge = { status: 'waiting_gate', gateToken: 'merge-token', epoch: 0 }; persist();
      return { status: 'running', runId };
    },
    gateResolve: (_flow, id, outcome, rationale, by, token) => {
      state.events.push({ type: 'gate_resolved', stepId: id, detail: { decision: outcome } });
      state.steps[id] = { status: 'succeeded', epoch: 0 };
      state.status = 'completed'; persist(); return { status: 'completed', runId };
    },
    usageReport: (_flow, receipt) => {
      const previous = state.receipts.find(r => r.dispatchId === receipt.dispatchId);
      if (previous) return { status: 'duplicate', seq: previous.seq };
      const { usage, ...rest } = receipt;
      state.receipts.push({ ...rest, amount: usage, seq: state.receipts.length + 1 }); persist();
      return { status: 'ok', seq: state.receipts.length };
    },
  });
  stratum.resume = async () => current();
  persist();
  const run = (opts = {}) => runBuild(code, { cwd, mode: 'bug', template: 'bug-fix', stratum, skipTriage: true,
    consumerArtifactsRoot: artifactRoot, gateOpts: { nonInteractive: true }, ...opts });
  const journal = () => new ConsumerFanoutArtifacts({ runId, targetCwd: cwd, artifactRoot }).journal;
  return { cwd, code, base, spec, state, stateRoot, persist, stratum, run, runId, journal, artifactRoot, descriptors };
}
