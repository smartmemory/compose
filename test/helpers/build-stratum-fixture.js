import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const SIMPLE_BUILD_SPEC = `
version: 1
contracts:
  R:
    phase: string
    outcome: string
    summary: string
flows:
  entry: bug_fix
  bug_fix:
    input:
      task: string
    output:
      from: \${work.output}
      contract: R
    steps:
      - id: work
        agent: claude
        do: stub
        out: R
`;

export function makeBuildWorkspace(code, { spec = SIMPLE_BUILD_SPEC, compose = {}, profiles } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'usage-receipts-build-'));
  mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
  mkdirSync(join(cwd, 'pipelines'), { recursive: true });
  mkdirSync(join(cwd, 'docs', 'bugs', code), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ version: 2, ...compose }));
  writeFileSync(join(cwd, 'pipelines', 'bug-fix.stratum.yaml'), spec);
  writeFileSync(join(cwd, 'docs', 'bugs', code, 'description.md'), `# ${code}\n`);
  if (profiles) writeFileSync(join(cwd, 'pipelines', 'bug-fix.profiles.json'), JSON.stringify(profiles));
  return cwd;
}

export function readyWork(overrides = {}) {
  return {
    status: 'ready', runId: 'flow-receipts',
    ready: [{ id: 'work', agent: 'claude', do: 'stub', attempt: 1, dispatchToken: 'tok-1', ...overrides }],
  };
}

export function agentResult(payload, dispatchId, usage = { tokens: 6, usd: 0.01, ms: 4, usd_source: 'reported' }) {
  return {
    text: JSON.stringify(payload), dispatchId, usage,
    telemetry: { model: 'claude-test', durationMs: usage.ms ?? usage.duration_ms ?? 4 },
  };
}

export function fakeBuildStratum({ plan, agentRun, stepDone, audit, gateResolve, usageReport, receiptsMode = true }) {
  const calls = [];
  const stratum = {
    calls,
    hasTool: async (name) => receiptsMode && name === 'stratum_usage_report',
    plan: async (...args) => {
      calls.push({ type: 'plan', args });
      return typeof plan === 'function' ? plan(...args) : (plan ?? readyWork());
    },
    onEvent: () => () => {},
    cancelAgentRun: async (...args) => {
      calls.push({ type: 'cancelAgentRun', args });
    },
    agentRun: async (...args) => {
      calls.push({ type: 'agentRun', args });
      return agentRun(...args);
    },
    usageReport: async (runId, receipt) => {
      calls.push({ type: 'usageReport', runId, receipt });
      if (usageReport) return usageReport(runId, receipt);
      return { status: 'ok', ledger: { spent: {} } };
    },
    stepDone: async (...args) => {
      calls.push({ type: 'stepDone', args, envelope: args[2] });
      return stepDone ? stepDone(...args) : { status: 'completed', runId: 'flow-receipts' };
    },
    audit: async (...args) => {
      calls.push({ type: 'audit', args });
      return audit ? audit(...args) : { status: 'completed', steps: {}, events: [] };
    },
    gateResolve: async (...args) => {
      calls.push({ type: 'gateResolve', args });
      return gateResolve ? gateResolve(...args) : { status: 'completed', runId: 'flow-receipts' };
    },
    close: async () => {},
  };
  return stratum;
}
