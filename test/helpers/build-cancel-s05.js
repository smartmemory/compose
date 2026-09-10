import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runBuild } from '../../lib/build.js';
import { ConsumerFanoutArtifacts } from '../../lib/consumer-fanout.js';
import { VisionWriter } from '../../lib/vision-writer.js';

export const FLOW = 's05-flow';
export const SPEC = `version: 1
contracts:
  Result:
    value: string
flows:
  entry: main
  main:
    steps:
      - id: work
        agent: claude
        do: work
        out: Result
      - id: fan
        fanout:
          over: [alpha]
          dispatch: consumer
          isolation: worktree
          merge: sequential
          require: all
          steps:
            - do: work
              out: Result
      - id: merge
        after: [fan]
        gate:
          on_approve: null
          on_revise: fan
          on_kill: null
`;
export function fixture(t, spec = SPEC) {
  process.env.NODE_ENV = 'test';
  const root = mkdtempSync(join(tmpdir(), 'compose-s05-'));
  const cwd = join(root, 'project');
  const dataDir = join(cwd, '.compose', 'data');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(cwd, 'pipelines'));
  mkdirSync(join(cwd, 'docs', 'features', 'S05'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { stratum: true } }));
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ policies: { merge: 'skip' } }));
  writeFileSync(join(dataDir, 'vision-state.json'), JSON.stringify({ items: [{ id: 's05-item', status: 'planned', lifecycle: { featureCode: 'S05' } }], connections: [], gates: [] }));
  writeFileSync(join(cwd, 'pipelines', 'build.stratum.yaml'), spec);
  writeFileSync(join(cwd, '.gitignore'), '.compose/data/\n.compose/build-stream.jsonl\ndocs/features/*/audit.json\n');
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'S05 Test']);
  git(['config', 'user.email', 's05@example.test']);
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);
  t.mock.method(VisionWriter.prototype, '_serverAvailable', async () => false);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const read = name => JSON.parse(readFileSync(join(dataDir, name), 'utf8'));
  return { root, cwd, dataDir, git, read, artifactRoot: join(root, 'artifacts'),
    run: (stratum, opts = {}) => runBuild('S05', { cwd, stratum, template: 'build', skipTriage: true, description: 'cancel detection', consumerArtifactsRoot: join(root, 'artifacts'), ...opts }),
  };
}
export function fakeClient(overrides = {}) {
  const calls = [];
  const methods = {
    connect: async () => {}, close: async () => {}, onEvent: () => () => {},
    hasTool: () => true,
    plan: async () => ({ runId: FLOW, status: 'ready', ready: [{ id: 'work', agent: 'claude', do: 'work', dispatchToken: 'work-token' }] }),
    audit: async () => ({ status: 'running', steps: {} }),
    resume: async () => { throw new Error('unexpected resume'); },
    agentRun: async () => ({ text: '{"value":"ok"}' }),
    stepDone: async () => ({ runId: FLOW, status: 'completed' }),
    gateResolve: async () => ({ runId: FLOW, status: 'completed' }),
    usageReport: async () => ({}), ...overrides,
  };
  return Object.assign(Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, (...args) => { calls.push({ name, args }); return fn(...args); }])), { calls });
}
export function mergeFixture(t) {
  const f = fixture(t);
  const artifacts = new ConsumerFanoutArtifacts({ runId: FLOW, targetCwd: f.cwd, artifactRoot: f.artifactRoot, revisionDigest: 'revision' });
  writeFileSync(join(f.cwd, 'landed.txt'), 'captured evidence\n');
  f.git(['add', 'landed.txt']);
  const diff = f.git(['diff', '--cached', '--binary']) + '\n';
  f.git(['reset', '-q', 'HEAD', '--', 'landed.txt']);
  rmSync(join(f.cwd, 'landed.txt'));
  const journal = JSON.parse(readFileSync(artifacts.journalPath, 'utf8'));
  journal.issuances = [{ dispatchToken: 'item-token', scopedId: 'fan/0', fanoutStepId: 'fan', itemIndex: 0, generation: 1, stage: 0, attempt: 1, isolation: 'worktree', state: 'accepted', diff, hadCumulativeDiff: true, diffDigest: 'digest' }];
  writeFileSync(artifacts.journalPath, JSON.stringify(journal));
  const audit = { status: 'running', steps: { fan: { fanout: { items: [{ status: 'succeeded', generation: 1, acceptedDispatchToken: 'item-token' }] } }, merge: { status: 'waiting_gate', gateToken: 'gate-token' } } };
  const client = fakeClient({ plan: async () => ({ runId: FLOW, status: 'running', revisionDigest: 'revision' }), audit: async () => structuredClone(audit) });
  return { ...f, artifacts, audit, client, journal: () => JSON.parse(readFileSync(artifacts.journalPath, 'utf8')) };
}
