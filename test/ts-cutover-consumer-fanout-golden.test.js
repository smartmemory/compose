/**
 * Golden acceptance tests for TS-native consumer-dispatch fanout execution.
 *
 * The Stratum workflow is real and runs through the TS MCP bin with isolated
 * state. Only agent inference is stubbed; the stub writes real files in the
 * cwd Compose assigns to each consumer item.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { existsSync } from 'node:fs';
import { runBuild } from '../lib/build.js';
import { ConsumerFanoutArtifacts } from '../lib/consumer-fanout.js';
import { installAgentHarness } from './helpers/ts-agent-harness.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';

// Consumer crash hooks are a test-only seam, honored only under NODE_ENV=test
// (mirrors the _testClient gate in stratum-mcp-client.js). Every crash/recovery
// test below relies on them, so pin the env for this file's process.
process.env.NODE_ENV = 'test';

import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';

const CONSUMER_BUILD_SPEC = `
version: 1
contracts:
  Batch:
    items: string[]
  StageResult:
    value: string
  Result:
    value: string
flows:
  entry: main
  main:
    max_rounds: 3
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${fan.output[0]}
      contract: Result
    steps:
      - id: enumerate
        do: "enumerate the consumer items"
        out: Batch
      - id: fan
        after: [enumerate]
        fanout:
          over: \${enumerate.output.items}
          dispatch: consumer
          concurrency: 2
          isolation: worktree
          require: all
          merge: sequential
          steps:
            - do: "seed \${item}"
              out: StageResult
            - do: "finish \${item} from \${prev}"
              out: Result
      - id: merge
        after: [fan]
        gate:
          on_approve: null
          on_revise: fan
          on_kill: null
          max_rounds: 3
`;

const CONSUMER_SINGLE_STAGE_SPEC = `
version: 1
contracts:
  Batch:
    items: string[]
  Result:
    value: string
flows:
  entry: main
  main:
    max_rounds: 3
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${fan.output[0]}
      contract: Result
    steps:
      - id: enumerate
        do: "enumerate the consumer items"
        out: Batch
      - id: fan
        after: [enumerate]
        fanout:
          over: \${enumerate.output.items}
          dispatch: consumer
          concurrency: 3
          isolation: worktree
          require: all
          merge: sequential
          steps:
            - do: "work \${item}"
              out: Result
      - id: merge
        after: [fan]
        gate:
          on_approve: null
          on_revise: fan
          on_kill: null
          max_rounds: 3
`;

const CONSUMER_FIVE_ITEM_SPEC = CONSUMER_SINGLE_STAGE_SPEC.replace(
  '          concurrency: 3',
  '          concurrency: 5',
);

// Same fanout as CONSUMER_BUILD_SPEC, but the merge gate's on_revise routes to
// an ordinary repair step that is a strict ancestor of the gate — NOT back to
// the fanout. A revise here must NOT re-enumerate the fanout, so the succeeded
// items keep their generation and acceptedDispatchToken and their accepted diffs
// must survive to the next gate round (F1).
const CONSUMER_REPAIR_SPEC = `
version: 1
contracts:
  Batch:
    items: string[]
  StageResult:
    value: string
  Result:
    value: string
  RepairResult:
    value: string
flows:
  entry: main
  main:
    max_rounds: 3
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${fan.output[0]}
      contract: Result
    steps:
      - id: enumerate
        do: "enumerate the consumer items"
        out: Batch
      - id: fan
        after: [enumerate]
        fanout:
          over: \${enumerate.output.items}
          dispatch: consumer
          concurrency: 2
          isolation: worktree
          require: all
          merge: sequential
          steps:
            - do: "seed \${item}"
              out: StageResult
            - do: "finish \${item} from \${prev}"
              out: Result
      - id: repair
        after: [fan]
        do: "repair the merge conflict"
        out: RepairResult
      - id: merge
        after: [fan, repair]
        gate:
          on_approve: null
          on_revise: repair
          on_kill: null
          max_rounds: 3
`;

// Final stage produces a nested contract: Result -> Report -> Finding[], with a
// typed-array field and a nested named record. Exercises the descriptor's full
// contract CLOSURE reaching the agent schema and the engine's strict validation.
const CONSUMER_NESTED_SPEC = `
version: 1
contracts:
  Batch:
    items: string[]
  StageResult:
    value: string
  Finding:
    file: string
    line: number
  Report:
    items: Finding[]
    summary: string
  Result:
    report: Report
flows:
  entry: main
  main:
    max_rounds: 3
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${fan.output[0]}
      contract: Result
    steps:
      - id: enumerate
        do: "enumerate the consumer items"
        out: Batch
      - id: fan
        after: [enumerate]
        fanout:
          over: \${enumerate.output.items}
          dispatch: consumer
          concurrency: 2
          isolation: worktree
          require: all
          merge: sequential
          steps:
            - do: "seed \${item}"
              out: StageResult
            - do: "finish \${item} from \${prev}"
              out: Result
      - id: merge
        after: [fan]
        gate:
          on_approve: null
          on_revise: fan
          on_kill: null
          max_rounds: 3
`;

// Single-item consumer fanout whose only stage declares a VALID but empty output
// contract ({}). The agent's {} must be accepted, not discarded as "no structured
// output" — otherwise the item retries until attempts exhaust and the run fails.
const CONSUMER_EMPTY_SPEC = `
version: 1
contracts:
  Batch:
    items: string[]
  Empty: {}
flows:
  entry: main
  main:
    max_rounds: 3
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${fan.output[0]}
      contract: Empty
    steps:
      - id: enumerate
        do: "enumerate the consumer items"
        out: Batch
      - id: fan
        after: [enumerate]
        fanout:
          over: \${enumerate.output.items}
          dispatch: consumer
          concurrency: 1
          isolation: worktree
          require: all
          merge: sequential
          steps:
            - do: "seed \${item}"
              out: Empty
      - id: merge
        after: [fan]
        gate:
          on_approve: null
          on_revise: fan
          on_kill: null
          max_rounds: 3
`;

// Empty-input consumer fanout: `over` resolves to []. No descriptor is ever
// issued, so the journal is first created at the merge-gate path and must still
// be pinned there (T2). The flow output reads from enumerate, not the (empty)
// fanout, so it resolves cleanly.
const CONSUMER_EMPTY_INPUT_SPEC = `
version: 1
contracts:
  Batch:
    items: string[]
  StageResult:
    value: string
  Result:
    value: string
flows:
  entry: main
  main:
    max_rounds: 3
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${enumerate.output}
      contract: Batch
    steps:
      - id: enumerate
        do: "enumerate the consumer items"
        out: Batch
      - id: fan
        after: [enumerate]
        fanout:
          over: \${enumerate.output.items}
          dispatch: consumer
          concurrency: 2
          isolation: worktree
          require: all
          merge: sequential
          steps:
            - do: "seed \${item}"
              out: StageResult
            - do: "finish \${item} from \${prev}"
              out: Result
      - id: merge
        after: [fan]
        gate:
          on_approve: null
          on_revise: fan
          on_kill: null
          max_rounds: 3
`;

// Same fanout, but the merge gate's on_revise routes to ENUMERATE, so a revise
// re-runs enumerate. Paired with a stub that returns fewer items on re-run, this
// re-enumerates the fanout to a smaller generation (T3).
const CONSUMER_REENUMERATE_SPEC = CONSUMER_BUILD_SPEC.replace(
  '          on_revise: fan\n          on_kill: null',
  '          on_revise: enumerate\n          on_kill: null',
);

// Pure isolation:none consumer fanout. Items run in the shared target cwd (no
// worktree, no diff), and the merge gate approves as a trivially clean merge.
const CONSUMER_NONE_SPEC = `
version: 1
contracts:
  Batch:
    items: string[]
  Result:
    value: string
flows:
  entry: main
  main:
    max_rounds: 3
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${fan.output[0]}
      contract: Result
    steps:
      - id: enumerate
        do: "enumerate the consumer items"
        out: Batch
      - id: fan
        after: [enumerate]
        fanout:
          over: \${enumerate.output.items}
          dispatch: consumer
          concurrency: 2
          isolation: none
          require: all
          merge: sequential
          steps:
            - do: "none-work \${item}"
              out: Result
      - id: merge
        after: [fan]
        gate:
          on_approve: null
          on_revise: fan
          on_kill: null
          max_rounds: 3
`;

// A none fanout (in-cwd) followed by a worktree fanout (+ merge gate). The merge
// must apply exactly the worktree items' diffs; the none items' files persist
// directly in the target cwd.
const CONSUMER_MIXED_SPEC = `
version: 1
contracts:
  Batch:
    items: string[]
  Result:
    value: string
flows:
  entry: main
  main:
    max_rounds: 3
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${fan_wt.output[0]}
      contract: Result
    steps:
      - id: enumerate
        do: "enumerate the consumer items"
        out: Batch
      - id: fan_none
        after: [enumerate]
        fanout:
          over: \${enumerate.output.items}
          dispatch: consumer
          concurrency: 2
          isolation: none
          require: all
          merge: sequential
          steps:
            - do: "none-work \${item}"
              out: Result
      - id: fan_wt
        after: [fan_none]
        fanout:
          over: \${enumerate.output.items}
          dispatch: consumer
          concurrency: 2
          isolation: worktree
          require: all
          merge: sequential
          steps:
            - do: "wt-work \${item}"
              out: Result
      - id: merge
        after: [fan_wt]
        gate:
          on_approve: null
          on_revise: fan_wt
          on_kill: null
          max_rounds: 3
`;

// A consumer fanout AND an ordinary step both become ready after enumerate
// (mixed readiness). The ordinary sidestep is processed on the serial path while
// the consumer items are still in flight — used to exercise the pump's fatal
// drain (C2) when the ordinary agent throws.
const CONSUMER_MIXED_READY_SPEC = `
version: 1
contracts:
  Batch:
    items: string[]
  Result:
    value: string
  SideResult:
    note: string
flows:
  entry: main
  main:
    max_rounds: 3
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${fan.output[0]}
      contract: Result
    steps:
      - id: enumerate
        do: "enumerate the consumer items"
        out: Batch
      - id: fan
        after: [enumerate]
        fanout:
          over: \${enumerate.output.items}
          dispatch: consumer
          concurrency: 2
          isolation: worktree
          require: all
          merge: sequential
          steps:
            - do: "seed \${item}"
              out: Result
      - id: sidestep
        after: [enumerate]
        do: "do the sidestep work"
        out: SideResult
      - id: merge
        after: [fan]
        gate:
          on_approve: null
          on_revise: fan
          on_kill: null
          max_rounds: 3
`;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

async function setupScenario(t, slug, spec = CONSUMER_BUILD_SPEC) {
  const workspace = await mkdtemp(join(tmpdir(), `compose-ts-consumer-${slug}-`));
  const stateRoot = await mkdtemp(join(tmpdir(), `compose-ts-consumer-state-${slug}-`));
  const artifactRoot = await mkdtemp(join(tmpdir(), `compose-ts-consumer-artifacts-${slug}-`));
  const evidenceRoot = await mkdtemp(join(tmpdir(), `compose-ts-consumer-evidence-${slug}-`));
  const invocationLog = join(evidenceRoot, 'agent-invocations.jsonl');

  t.after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
    await rm(evidenceRoot, { recursive: true, force: true });
  });

  await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
  await mkdir(join(workspace, 'pipelines'), { recursive: true });
  await mkdir(join(workspace, 'docs', 'features', 'TS-CONSUMER'), { recursive: true });
  await writeFile(
    join(workspace, '.gitignore'),
    '.compose/data/\ndocs/features/*/audit.json\n',
  );
  await writeFile(
    join(workspace, '.compose', 'compose.json'),
    JSON.stringify({ version: 2, capabilities: { stratum: true } }),
  );
  await writeFile(
    join(workspace, '.compose', 'data', 'settings.json'),
    JSON.stringify({ policies: { merge: 'skip' } }),
  );
  await writeFile(join(workspace, 'pipelines', 'build.stratum.yaml'), spec);
  await writeFile(
    join(workspace, 'docs', 'features', 'TS-CONSUMER', 'description.md'),
    '# TS consumer fanout golden\n',
  );

  git(workspace, ['init', '-q']);
  git(workspace, ['config', 'user.name', 'Compose Golden']);
  git(workspace, ['config', 'user.email', 'compose-golden@example.test']);
  git(workspace, ['add', '-A']);
  git(workspace, ['commit', '-qm', 'consumer golden baseline']);

  return { workspace, stateRoot, artifactRoot, evidenceRoot, invocationLog };
}

function writingAgentFactory(invocationLog) {
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        let kind = 'unknown';
        let item = null;
        let payload;
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;

        if (intent.includes('enumerate the consumer items')) {
          kind = 'enumerate';
          payload = { items: ['a', 'b', 'c'] };
        } else if (intent.includes('repair the merge conflict')) {
          // Ordinary (non-consumer) repair step routed to by a merge gate's
          // on_revise. It writes nothing and re-enumerates nothing.
          kind = 'repair';
          payload = { value: 'repaired' };
        } else {
          const finish = intent.match(/\bfinish ([abc]) from /);
          const seed = intent.match(/\bseed ([abc])\b/);
          item = finish?.[1] ?? seed?.[1] ?? null;
          assert.ok(item, `stub must recognize the consumer item in prompt: ${prompt.slice(0, 240)}`);
          await mkdir(join(cwd, 'items'), { recursive: true });
          if (finish) {
            kind = 'finish';
            await appendFile(join(cwd, 'items', `${item}.txt`), `finish:${item}\n`);
            // Every final issuance has a genuinely multi-file cumulative diff,
            // allowing crash D to leave an unmatched partial application.
            await writeFile(join(cwd, 'items', `${item}-extra.txt`), `extra:${item}\n`);
            payload = { value: `done-${item}` };
          } else {
            kind = 'seed';
            // Deliberately non-idempotent. Crash-A recovery must restore the
            // pre-stage witness or this line will appear twice.
            await appendFile(join(cwd, 'items', `${item}.txt`), `seed:${item}\n`);
            payload = { value: `seed-${item}` };
          }
        }

        await appendFile(invocationLog, `${JSON.stringify({ kind, item, cwd, intent })}\n`);
        yield { type: 'assistant', content: JSON.stringify(payload) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

function overlapProbeAgentFactory(invocationLog, probe, items = ['a', 'b', 'c']) {
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        if (intent.includes('enumerate the consumer items')) {
          yield { type: 'assistant', content: JSON.stringify({ items }) };
          yield { type: 'system', subtype: 'complete', agent: 'stub' };
          return;
        }

        const item = intent.match(/\bwork ([a-z])\b/)?.[1] ?? null;
        assert.ok(item, `stub must recognize the consumer item in prompt: ${prompt.slice(0, 240)}`);
        probe.current += 1;
        probe.max = Math.max(probe.max, probe.current);
        try {
          // Yield one event-loop turn while remaining in flight. A concurrent
          // pump starts sibling issuances before this one exits; the serial pump
          // cannot raise the counter above one.
          await new Promise((resolve) => setImmediate(resolve));
          await mkdir(join(cwd, 'items'), { recursive: true });
          await writeFile(join(cwd, 'items', `${item}.txt`), `work:${item}\n`);
          await appendFile(invocationLog, `${JSON.stringify({ kind: 'work', item, cwd, intent })}\n`);
          yield { type: 'assistant', content: JSON.stringify({ value: `done-${item}` }) };
          yield { type: 'system', subtype: 'complete', agent: 'stub' };
        } finally {
          probe.current -= 1;
        }
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

function multiStageProbeAgentFactory(invocationLog, probe) {
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        if (intent.includes('enumerate the consumer items')) {
          yield { type: 'assistant', content: JSON.stringify({ items: ['a', 'b'] }) };
          yield { type: 'system', subtype: 'complete', agent: 'stub' };
          return;
        }

        const finish = intent.match(/\bfinish ([ab]) from /);
        const seed = intent.match(/\bseed ([ab])\b/);
        const item = finish?.[1] ?? seed?.[1] ?? null;
        const kind = finish ? 'finish' : 'seed';
        assert.ok(item, `stub must recognize the consumer item in prompt: ${prompt.slice(0, 240)}`);
        if (finish) assert.ok(probe.completed.has(`seed:${item}`), `${item} stage 2 started before stage 1 completed`);
        probe.events.push(`enter:${kind}:${item}`);
        probe.current += 1;
        probe.max = Math.max(probe.max, probe.current);
        try {
          await new Promise((resolve) => setImmediate(resolve));
          await mkdir(join(cwd, 'items'), { recursive: true });
          if (finish) {
            await appendFile(join(cwd, 'items', `${item}.txt`), `finish:${item}\n`);
            await writeFile(join(cwd, 'items', `${item}-extra.txt`), `extra:${item}\n`);
          } else {
            await appendFile(join(cwd, 'items', `${item}.txt`), `seed:${item}\n`);
          }
          await appendFile(invocationLog, `${JSON.stringify({ kind, item, cwd, intent })}\n`);
          probe.completed.add(`${kind}:${item}`);
          probe.events.push(`exit:${kind}:${item}`);
          yield { type: 'assistant', content: JSON.stringify({ value: `${kind}-${item}` }) };
          yield { type: 'system', subtype: 'complete', agent: 'stub' };
        } finally {
          probe.current -= 1;
        }
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

function drainingCrashAgentFactory(invocationLog, probe) {
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        if (intent.includes('enumerate the consumer items')) {
          yield { type: 'assistant', content: JSON.stringify({ items: ['a', 'b', 'c'] }) };
          yield { type: 'system', subtype: 'complete', agent: 'stub' };
          return;
        }

        const item = intent.match(/\bwork ([abc])\b/)?.[1] ?? null;
        assert.ok(item, `stub must recognize the consumer item in prompt: ${prompt.slice(0, 240)}`);
        probe.active += 1;
        if (probe.active === 3) probe.allEnteredResolve();
        await appendFile(invocationLog, `${JSON.stringify({ kind: 'work', item, cwd, intent })}\n`);
        try {
          await probe.allEntered;
          if (item !== 'a') await probe.release;
          await mkdir(join(cwd, 'items'), { recursive: true });
          await writeFile(join(cwd, 'items', `${item}.txt`), `work:${item}\n`);
          yield { type: 'assistant', content: JSON.stringify({ value: `done-${item}` }) };
          yield { type: 'system', subtype: 'complete', agent: 'stub' };
        } finally {
          probe.active -= 1;
        }
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

function retryIsolationAgentFactory(invocationLog, probe) {
  const attempts = new Map();
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        if (intent.includes('enumerate the consumer items')) {
          yield { type: 'assistant', content: JSON.stringify({ items: ['a', 'b', 'c'] }) };
          yield { type: 'system', subtype: 'complete', agent: 'stub' };
          return;
        }

        const item = intent.match(/\bwork ([abc])\b/)?.[1] ?? null;
        assert.ok(item, `stub must recognize the consumer item in prompt: ${prompt.slice(0, 240)}`);
        const attempt = (attempts.get(item) ?? 0) + 1;
        attempts.set(item, attempt);
        await appendFile(invocationLog, `${JSON.stringify({ kind: 'work', item, attempt, cwd, intent })}\n`);
        if (item === 'b' && attempt === 1) {
          yield { type: 'assistant', content: JSON.stringify({ outcome: 'failed', summary: 'retry b once' }) };
          yield { type: 'system', subtype: 'complete', agent: 'stub' };
          return;
        }
        if (item === 'b') {
          probe.retryStartedResolve();
          await probe.othersCompleted;
        } else {
          await probe.retryStarted;
        }
        await mkdir(join(cwd, 'items'), { recursive: true });
        await writeFile(join(cwd, 'items', `${item}.txt`), `work:${item}\n`);
        if (item !== 'b') {
          probe.completedOthers.push(item);
          if (probe.completedOthers.length === 2) probe.othersCompletedResolve();
        }
        probe.completionOrder.push(item);
        yield { type: 'assistant', content: JSON.stringify({ value: `done-${item}` }) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Writing agent whose FIRST attempt at one item's stage is faulted, then
// succeeds. `fault.mode` is 'fail' (report a local failure envelope with
// `fault.reason`) or 'throw' (raise a non-timeout connector error). Every
// prompt is captured into `prompts` so tests can inspect the retry prompt.
function faultInjectingAgentFactory(invocationLog, { prompts, fault }) {
  const attempts = new Map();
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        prompts.push(prompt);
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        let kind = 'unknown';
        let item = null;
        let payload;

        if (intent.includes('enumerate the consumer items')) {
          kind = 'enumerate';
          payload = { items: ['a', 'b', 'c'] };
        } else {
          const finish = intent.match(/\bfinish ([abc]) from /);
          const seed = intent.match(/\bseed ([abc])\b/);
          item = finish?.[1] ?? seed?.[1] ?? null;
          assert.ok(item, `stub must recognize the consumer item in prompt: ${prompt.slice(0, 240)}`);
          kind = finish ? 'finish' : 'seed';
          const attemptKey = `${kind}:${item}`;
          const attemptNum = (attempts.get(attemptKey) ?? 0) + 1;
          attempts.set(attemptKey, attemptNum);

          if (item === fault.item && kind === fault.stage && attemptNum === 1) {
            await appendFile(invocationLog, `${JSON.stringify({ kind, item, cwd, intent, faulted: fault.mode })}\n`);
            if (fault.mode === 'throw') {
              // A genuine connector error before any output. The pre-stage
              // witness (nothing written yet) must survive for the retry.
              throw new Error(fault.reason);
            }
            // mode === 'fail': a local failure envelope, no file writes.
            yield { type: 'assistant', content: JSON.stringify({ outcome: 'failed', summary: fault.reason }) };
            yield { type: 'system', subtype: 'complete', agent: 'stub' };
            return;
          }

          await mkdir(join(cwd, 'items'), { recursive: true });
          if (finish) {
            await appendFile(join(cwd, 'items', `${item}.txt`), `finish:${item}\n`);
            await writeFile(join(cwd, 'items', `${item}-extra.txt`), `extra:${item}\n`);
            payload = { value: `done-${item}` };
          } else {
            await appendFile(join(cwd, 'items', `${item}.txt`), `seed:${item}\n`);
            payload = { value: `seed-${item}` };
          }
        }

        await appendFile(invocationLog, `${JSON.stringify({ kind, item, cwd, intent })}\n`);
        yield { type: 'assistant', content: JSON.stringify(payload) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// Writing agent whose final stage returns a nested {report:{items:[Finding],summary}}
// output. Captures every prompt so the test can inspect the injected schema.
function nestedContractAgentFactory(invocationLog, { prompts }) {
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        prompts.push(prompt);
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        let kind = 'unknown';
        let item = null;
        let payload;

        if (intent.includes('enumerate the consumer items')) {
          kind = 'enumerate';
          payload = { items: ['a', 'b', 'c'] };
        } else {
          const finish = intent.match(/\bfinish ([abc]) from /);
          const seed = intent.match(/\bseed ([abc])\b/);
          item = finish?.[1] ?? seed?.[1] ?? null;
          assert.ok(item, `stub must recognize the consumer item in prompt: ${prompt.slice(0, 240)}`);
          await mkdir(join(cwd, 'items'), { recursive: true });
          if (finish) {
            kind = 'finish';
            await appendFile(join(cwd, 'items', `${item}.txt`), `finish:${item}\n`);
            await writeFile(join(cwd, 'items', `${item}-extra.txt`), `extra:${item}\n`);
            payload = { report: { items: [{ file: `${item}.js`, line: 1 }], summary: `done-${item}` } };
          } else {
            kind = 'seed';
            await appendFile(join(cwd, 'items', `${item}.txt`), `seed:${item}\n`);
            payload = { value: `seed-${item}` };
          }
        }

        await appendFile(invocationLog, `${JSON.stringify({ kind, item, cwd, intent })}\n`);
        yield { type: 'assistant', content: JSON.stringify(payload) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// Writing agent whose final stage additionally writes a large file for one item,
// so its cumulative diff exceeds execFileSync's default 1 MiB stdout buffer.
function largeFileAgentFactory(invocationLog, { item: targetItem, bytes }) {
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        let kind = 'unknown';
        let item = null;
        let payload;

        if (intent.includes('enumerate the consumer items')) {
          kind = 'enumerate';
          payload = { items: ['a', 'b', 'c'] };
        } else {
          const finish = intent.match(/\bfinish ([abc]) from /);
          const seed = intent.match(/\bseed ([abc])\b/);
          item = finish?.[1] ?? seed?.[1] ?? null;
          assert.ok(item, `stub must recognize the consumer item in prompt: ${prompt.slice(0, 240)}`);
          await mkdir(join(cwd, 'items'), { recursive: true });
          if (finish) {
            kind = 'finish';
            await appendFile(join(cwd, 'items', `${item}.txt`), `finish:${item}\n`);
            await writeFile(join(cwd, 'items', `${item}-extra.txt`), `extra:${item}\n`);
            if (item === targetItem) {
              await writeFile(join(cwd, 'items', `${item}-big.txt`), 'x'.repeat(bytes));
            }
            payload = { value: `done-${item}` };
          } else {
            kind = 'seed';
            await appendFile(join(cwd, 'items', `${item}.txt`), `seed:${item}\n`);
            payload = { value: `seed-${item}` };
          }
        }

        await appendFile(invocationLog, `${JSON.stringify({ kind, item, cwd, intent })}\n`);
        yield { type: 'assistant', content: JSON.stringify(payload) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// Writing agent whose single stage returns the empty object {} for a valid empty
// output contract. Writes one file so the item has a real cumulative diff to merge.
function emptyContractAgentFactory(invocationLog) {
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        let kind = 'unknown';
        let item = null;
        let payload;

        if (intent.includes('enumerate the consumer items')) {
          kind = 'enumerate';
          payload = { items: ['a'] };
        } else {
          const seed = intent.match(/\bseed ([a-z])\b/);
          item = seed?.[1] ?? null;
          assert.ok(item, `stub must recognize the consumer item in prompt: ${prompt.slice(0, 240)}`);
          kind = 'seed';
          await mkdir(join(cwd, 'items'), { recursive: true });
          await writeFile(join(cwd, 'items', `${item}.txt`), `seed:${item}\n`);
          payload = {}; // the empty output contract accepts exactly {}
        }

        await appendFile(invocationLog, `${JSON.stringify({ kind, item, cwd, intent })}\n`);
        yield { type: 'assistant', content: JSON.stringify(payload) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// Enumerate returns [] so the fanout is empty; no seed/finish stage should run.
function emptyInputAgentFactory(invocationLog) {
  return function factory(_agentType) {
    return {
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        if (!intent.includes('enumerate the consumer items')) {
          throw new Error(`empty-input fanout must not run a consumer stage: ${intent}`);
        }
        await appendFile(invocationLog, `${JSON.stringify({ kind: 'enumerate', intent })}\n`);
        yield { type: 'assistant', content: JSON.stringify({ items: [] }) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// Enumerate returns three items on its first call, then one item on every later
// call (a revise routed to enumerate re-enumerates the fanout to fewer items).
// `state` persists across process attempts within one test.
function shrinkingEnumerateFactory(invocationLog, state) {
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        let kind = 'unknown';
        let item = null;
        let payload;

        if (intent.includes('enumerate the consumer items')) {
          kind = 'enumerate';
          state.enumerateCalls += 1;
          payload = { items: state.enumerateCalls === 1 ? ['a', 'b', 'c'] : ['a'] };
        } else {
          const finish = intent.match(/\bfinish ([abc]) from /);
          const seed = intent.match(/\bseed ([abc])\b/);
          item = finish?.[1] ?? seed?.[1] ?? null;
          assert.ok(item, `stub must recognize the consumer item in prompt: ${prompt.slice(0, 240)}`);
          await mkdir(join(cwd, 'items'), { recursive: true });
          if (finish) {
            kind = 'finish';
            await appendFile(join(cwd, 'items', `${item}.txt`), `finish:${item}\n`);
            await writeFile(join(cwd, 'items', `${item}-extra.txt`), `extra:${item}\n`);
            payload = { value: `done-${item}` };
          } else {
            kind = 'seed';
            await appendFile(join(cwd, 'items', `${item}.txt`), `seed:${item}\n`);
            payload = { value: `seed-${item}` };
          }
        }

        await appendFile(invocationLog, `${JSON.stringify({ kind, item, cwd, intent })}\n`);
        yield { type: 'assistant', content: JSON.stringify(payload) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// Pure isolation:none agent: every item writes a file in its cwd (the target)
// and returns structured output. No worktree, no diff.
function noneIsolationAgentFactory(invocationLog) {
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        let kind = 'unknown';
        let item = null;
        let payload;

        if (intent.includes('enumerate the consumer items')) {
          kind = 'enumerate';
          payload = { items: ['a', 'b'] };
        } else {
          item = intent.match(/\bnone-work ([ab])\b/)?.[1] ?? null;
          assert.ok(item, `stub must recognize the none item in prompt: ${prompt.slice(0, 240)}`);
          kind = 'none';
          await mkdir(join(cwd, 'none-items'), { recursive: true });
          await writeFile(join(cwd, 'none-items', `${item}.txt`), `none:${item}\n`);
          payload = { value: `none-${item}` };
        }

        await appendFile(invocationLog, `${JSON.stringify({ kind, item, cwd, intent })}\n`);
        yield { type: 'assistant', content: JSON.stringify(payload) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// Mixed agent: none-work items write in-cwd (target), wt-work items write in
// their worktree cwd (captured as a diff).
function mixedIsolationAgentFactory(invocationLog) {
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        let kind = 'unknown';
        let item = null;
        let payload;

        if (intent.includes('enumerate the consumer items')) {
          kind = 'enumerate';
          payload = { items: ['a', 'b'] };
        } else {
          const none = intent.match(/\bnone-work ([ab])\b/);
          const wt = intent.match(/\bwt-work ([ab])\b/);
          item = none?.[1] ?? wt?.[1] ?? null;
          assert.ok(item, `stub must recognize the mixed item in prompt: ${prompt.slice(0, 240)}`);
          if (none) {
            kind = 'none';
            await mkdir(join(cwd, 'none-items'), { recursive: true });
            await writeFile(join(cwd, 'none-items', `${item}.txt`), `none:${item}\n`);
            payload = { value: `none-${item}` };
          } else {
            kind = 'wt';
            await mkdir(join(cwd, 'wt-items'), { recursive: true });
            await writeFile(join(cwd, 'wt-items', `${item}.txt`), `wt:${item}\n`);
            payload = { value: `wt-${item}` };
          }
        }

        await appendFile(invocationLog, `${JSON.stringify({ kind, item, cwd, intent })}\n`);
        yield { type: 'assistant', content: JSON.stringify(payload) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Item a's SEED blocks until item b has fully settled, so a's post-seed
// reconciliation runs after b advanced to its finish token — the window where a
// stale per-item snapshot (showing b at its seed token) could wrongly supersede
// b's newer finish issuance. `gate.releaseA` is resolved by the audit override.
function staleAuditRaceFactory(invocationLog, gate) {
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        let kind = 'unknown';
        let item = null;
        let payload;

        if (intent.includes('enumerate the consumer items')) {
          kind = 'enumerate';
          payload = { items: ['a', 'b'] };
        } else {
          const finish = intent.match(/\bfinish ([ab]) from /);
          const seed = intent.match(/\bseed ([ab])\b/);
          item = finish?.[1] ?? seed?.[1] ?? null;
          assert.ok(item, `stub must recognize the consumer item in prompt: ${prompt.slice(0, 240)}`);
          if (item === 'a' && seed) await gate.releaseAPromise;
          await mkdir(join(cwd, 'items'), { recursive: true });
          if (finish) {
            kind = 'finish';
            await appendFile(join(cwd, 'items', `${item}.txt`), `finish:${item}\n`);
            await writeFile(join(cwd, 'items', `${item}-extra.txt`), `extra:${item}\n`);
            payload = { value: `done-${item}` };
          } else {
            kind = 'seed';
            await appendFile(join(cwd, 'items', `${item}.txt`), `seed:${item}\n`);
            payload = { value: `seed-${item}` };
          }
        }

        await appendFile(invocationLog, `${JSON.stringify({ kind, item, cwd, intent })}\n`);
        yield { type: 'assistant', content: JSON.stringify(payload) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// Freeze the pre-advance audit (both items at their seed tokens) and re-deliver
// it once, LATE — for item a's post-seed reconcile, after item b has advanced to
// its finish token and succeeded. Also releases item a once b has settled.
function installStaleAuditRace(client, gate) {
  const realAudit = client.audit.bind(client);
  let staleSnapshot = null;
  let staleSeedTokenA = null;
  let staleServed = false;
  let released = false;
  client.audit = async (flowId) => {
    const fresh = await realAudit(flowId);
    const items = fresh?.steps?.fan?.fanout?.items ?? [];
    if (!staleSnapshot && items.length === 2
      && items.every((it) => it?.status === 'ready' && !it?.acceptedDispatchToken)) {
      staleSnapshot = structuredClone(fresh);
      staleSeedTokenA = items[0]?.dispatchToken ?? null;
    }
    const bSucceeded = items[1]?.status === 'succeeded';
    if (!released && bSucceeded) {
      released = true;
      gate.releaseA();
    }
    if (!staleServed && staleSnapshot && bSucceeded
      && items[0]?.dispatchToken && items[0].dispatchToken !== staleSeedTokenA) {
      staleServed = true;
      return structuredClone(staleSnapshot);
    }
    return fresh;
  };
}

// Mixed-readiness fatal-drain agent: fan (consumer) items delay so they are
// in flight when the ordinary `sidestep` agent throws on its first attempt.
// `state` persists the sidestep attempt count across the crash + resume.
function mixedFatalAgentFactory(invocationLog, { fanDelayMs, state }) {
  return function factory(_agentType, { cwd }) {
    return {
      async *run(prompt) {
        const intent = prompt.match(/## Intent\n([^\n]+)/)?.[1] ?? prompt;
        let kind = 'unknown';
        let item = null;
        let payload;

        if (intent.includes('enumerate the consumer items')) {
          kind = 'enumerate';
          payload = { items: ['a', 'b'] };
        } else if (intent.includes('do the sidestep work')) {
          kind = 'sidestep';
          state.sidestepAttempts += 1;
          if (state.sidestepAttempts === 1) {
            await appendFile(invocationLog, `${JSON.stringify({ kind, faulted: true })}\n`);
            throw new Error('sidestep boom');
          }
          payload = { note: 'sidestep recovered' };
        } else {
          item = intent.match(/\bseed ([ab])\b/)?.[1] ?? null;
          assert.ok(item, `stub must recognize the consumer item in prompt: ${prompt.slice(0, 240)}`);
          kind = 'seed';
          if (fanDelayMs) await sleep(fanDelayMs);
          await mkdir(join(cwd, 'items'), { recursive: true });
          await writeFile(join(cwd, 'items', `${item}.txt`), `seed:${item}\n`);
          payload = { value: `seed-${item}` };
        }

        await appendFile(invocationLog, `${JSON.stringify({ kind, item, cwd, intent })}\n`);
        yield { type: 'assistant', content: JSON.stringify(payload) };
        yield { type: 'system', subtype: 'complete', agent: 'stub' };
      },
      interrupt() {},
      get isRunning() { return false; },
    };
  };
}

// Capture a real, git-apply-able binary diff that adds one file (relative to
// HEAD), then remove the file so the workspace baseline stays clean. Mirrors the
// journal's own cumulativeDiff so prepareMerge/applyMerge accept it.
async function captureAddFileDiff(cwd, relPath, content) {
  await writeFile(join(cwd, relPath), content);
  const indexPath = join(tmpdir(), `compose-c5-index-${process.pid}-${Date.now()}-${Math.random()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  execSync('git read-tree HEAD', { cwd, env, stdio: 'pipe' });
  execSync('git add -A', { cwd, env, stdio: 'pipe' });
  const diff = execSync('git diff --cached --binary HEAD --', { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('rm', ['-f', indexPath]);
  await rm(join(cwd, relPath), { force: true });
  return diff;
}

async function journalPathOf(scenario) {
  const children = await readdir(scenario.artifactRoot, { withFileTypes: true });
  const runDirs = children.filter((entry) => entry.isDirectory());
  assert.equal(runDirs.length, 1, 'one run-keyed artifact directory must exist');
  return join(scenario.artifactRoot, runDirs[0].name, 'journal.json');
}

async function connectClient(stateRoot) {
  const client = new StratumMcpClient();
  await client.connect({
    command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
    args: [TS_MCP_BIN],
    env: { ...process.env, STRATUM_STATE_ROOT: stateRoot },
  });
  return client;
}

async function runAttempt(scenario, { resumeFlowId, crashHooks, onClient, gateOpts, agentFactory } = {}) {
  const client = await connectClient(scenario.stateRoot);
  installAgentHarness(client, agentFactory ?? writingAgentFactory(scenario.invocationLog), scenario.workspace);
  if (onClient) onClient(client);
  try {
    await runBuild('TS-CONSUMER', {
      cwd: scenario.workspace,
      stratum: client,
      template: 'build',
      skipTriage: true,
      description: 'the native consumer fanout cutover',
      consumerArtifactsRoot: scenario.artifactRoot,
      consumerCrashHooks: crashHooks,
      ...(gateOpts ? { gateOpts } : {}),
      ...(resumeFlowId ? { resumeFlowId } : {}),
    });
  } finally {
    await client.close();
  }
}

async function flowIdFromActive(scenario) {
  const active = JSON.parse(
    await readFile(join(scenario.workspace, '.compose', 'data', 'active-build.json'), 'utf8'),
  );
  assert.ok(active.flowId, 'build must persist its TS run id');
  return active.flowId;
}

async function auditFlow(scenario, flowId) {
  const client = await connectClient(scenario.stateRoot);
  try {
    return await client.audit(flowId);
  } finally {
    await client.close();
  }
}

async function readJournal(scenario) {
  const children = await readdir(scenario.artifactRoot, { withFileTypes: true });
  const runDirs = children.filter((entry) => entry.isDirectory());
  assert.equal(runDirs.length, 1, 'one run-keyed artifact directory must exist');
  return JSON.parse(
    await readFile(join(scenario.artifactRoot, runDirs[0].name, 'journal.json'), 'utf8'),
  );
}

async function invocations(scenario) {
  try {
    return (await readFile(scenario.invocationLog, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function countInvocation(rows, kind, item) {
  return rows.filter((row) => row.kind === kind && row.item === item).length;
}

async function assertMergedFiles(scenario) {
  const calls = await invocations(scenario);
  for (const item of ['a', 'b', 'c']) {
    assert.equal(
      await readFile(join(scenario.workspace, 'items', `${item}.txt`), 'utf8'),
      `seed:${item}\nfinish:${item}\n`,
      JSON.stringify(calls.filter((call) => call.item === item), null, 2),
    );
    assert.equal(
      await readFile(join(scenario.workspace, 'items', `${item}-extra.txt`), 'utf8'),
      `extra:${item}\n`,
    );
  }
}

async function assertSingleStageMerged(scenario, items) {
  for (const item of items) {
    assert.equal(
      await readFile(join(scenario.workspace, 'items', `${item}.txt`), 'utf8'),
      `work:${item}\n`,
    );
  }
}

function currentWorkingTreeId(cwd) {
  const indexPath = join(tmpdir(), `compose-consumer-test-index-${process.pid}-${Date.now()}-${Math.random()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    execSync('git read-tree HEAD', { cwd, env, stdio: 'pipe' });
    execSync('git add -A', { cwd, env, stdio: 'pipe' });
    return execSync('git write-tree', { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  } finally {
    execFileSync('rm', ['-f', indexPath]);
  }
}

function injectedCrash(label) {
  const error = new Error(`injected consumer crash: ${label}`);
  error.code = 'INJECTED_CONSUMER_CRASH';
  return error;
}

function scriptedGateIO(script) {
  const input = new PassThrough();
  const output = new PassThrough();
  let next = 0;
  let rendered = '';
  output.on('data', (chunk) => {
    rendered += chunk.toString();
    const expectedPrompt = script[next]?.prompt;
    if (expectedPrompt && rendered.includes(expectedPrompt)) {
      const line = script[next].line;
      next += 1;
      rendered = '';
      queueMicrotask(() => input.write(`${line}\n`));
    }
  });
  return {
    input,
    output,
    assertConsumed: () => assert.equal(next, script.length, 'all gate input must be consumed'),
  };
}

describe('TS-native consumer fanout journal and merge recovery', () => {
  test('consumer pump overlaps ready issuances', async (t) => {
    const scenario = await setupScenario(t, 'overlap-red', CONSUMER_SINGLE_STAGE_SPEC);
    const probe = { current: 0, max: 0 };
    await runAttempt(scenario, {
      agentFactory: overlapProbeAgentFactory(scenario.invocationLog, probe),
    });

    assert.ok(probe.max > 1, `expected overlapping consumer execution, saw max ${probe.max}`);
    await assertSingleStageMerged(scenario, ['a', 'b', 'c']);
  });

  test('consumer pool respects COMPOSE_FANOUT_CONCURRENCY', async (t) => {
    const scenario = await setupScenario(t, 'pool-bound', CONSUMER_FIVE_ITEM_SPEC);
    const prior = process.env.COMPOSE_FANOUT_CONCURRENCY;
    process.env.COMPOSE_FANOUT_CONCURRENCY = '2';
    t.after(() => {
      if (prior === undefined) delete process.env.COMPOSE_FANOUT_CONCURRENCY;
      else process.env.COMPOSE_FANOUT_CONCURRENCY = prior;
    });
    const probe = { current: 0, max: 0 };
    const items = ['a', 'b', 'c', 'd', 'e'];
    await runAttempt(scenario, {
      agentFactory: overlapProbeAgentFactory(scenario.invocationLog, probe, items),
    });

    assert.ok(probe.max > 1, 'the bound test must exercise overlapping work');
    assert.ok(probe.max <= 2, `pool cap 2 was exceeded: ${probe.max}`);
    await assertSingleStageMerged(scenario, items);
  });

  test('two items interleave across two ordered stages and merge once each', async (t) => {
    const scenario = await setupScenario(t, 'multi-stage-interleave', CONSUMER_BUILD_SPEC);
    const probe = { current: 0, max: 0, completed: new Set(), events: [] };
    await runAttempt(scenario, {
      agentFactory: multiStageProbeAgentFactory(scenario.invocationLog, probe),
    });

    assert.ok(probe.max > 1, `expected cross-item overlap, saw max ${probe.max}`);
    for (const item of ['a', 'b']) {
      assert.ok(probe.events.indexOf(`exit:seed:${item}`) < probe.events.indexOf(`enter:finish:${item}`));
      assert.equal(await readFile(join(scenario.workspace, 'items', `${item}.txt`), 'utf8'), `seed:${item}\nfinish:${item}\n`);
    }
    const journal = await readJournal(scenario);
    assert.equal(journal.issuances.filter((entry) => entry.state === 'merged').length, 2);
    assert.deepEqual(journal.mergeTransactions.at(-1).orderedDiffs.map((entry) => entry.itemIndex), [0, 1]);
  });

  test('fatal crash drains concurrent issuances and resume does not duplicate witnessed work', async (t) => {
    const scenario = await setupScenario(t, 'concurrent-crash', CONSUMER_SINGLE_STAGE_SPEC);
    const allEntered = deferred();
    const release = deferred();
    const probe = {
      active: 0,
      allEntered: allEntered.promise,
      allEnteredResolve: allEntered.resolve,
      release: release.promise,
      releaseResolve: release.resolve,
      crashedWithActive: 0,
    };
    let crashed = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        agentFactory: drainingCrashAgentFactory(scenario.invocationLog, probe),
        crashHooks: {
          afterStepDone({ descriptor }) {
            if (!crashed && descriptor.itemIndex === 0) {
              crashed = true;
              probe.crashedWithActive = probe.active;
              probe.releaseResolve();
              throw injectedCrash('concurrent pool drain');
            }
          },
        },
      }),
      /concurrent pool drain/,
    );
    assert.ok(probe.crashedWithActive >= 2, `crash did not observe concurrent peers: ${probe.crashedWithActive}`);
    const flowId = await flowIdFromActive(scenario);
    const before = await invocations(scenario);
    assert.equal(before.filter((row) => row.kind === 'work').length, 3);
    const crashedJournal = await readJournal(scenario);
    assert.equal(crashedJournal.witnesses.length, 3);
    assert.equal(crashedJournal.issuances.length, 3);
    assert.deepEqual(
      new Set(crashedJournal.witnesses.map((entry) => entry.dispatchToken)),
      new Set(crashedJournal.issuances.map((entry) => entry.dispatchToken)),
    );

    await runAttempt(scenario, { resumeFlowId: flowId });
    assert.deepEqual(await invocations(scenario), before, 'resume must not invoke any witnessed issuance again');
    await assertSingleStageMerged(scenario, ['a', 'b', 'c']);
    const journal = await readJournal(scenario);
    assert.equal(journal.issuances.filter((entry) => entry.state === 'merged').length, 3);
    assert.equal(journal.mergeTransactions.at(-1).orderedDiffs.length, 3);
  });

  test('one item retry does not starve concurrent peers', async (t) => {
    const scenario = await setupScenario(t, 'retry-isolation-concurrent', CONSUMER_SINGLE_STAGE_SPEC);
    const retryStarted = deferred();
    const othersCompleted = deferred();
    const probe = {
      retryStarted: retryStarted.promise,
      retryStartedResolve: retryStarted.resolve,
      othersCompleted: othersCompleted.promise,
      othersCompletedResolve: othersCompleted.resolve,
      completedOthers: [],
      completionOrder: [],
    };
    await runAttempt(scenario, {
      agentFactory: retryIsolationAgentFactory(scenario.invocationLog, probe),
    });

    const rows = await invocations(scenario);
    assert.equal(rows.filter((row) => row.kind === 'work' && row.item === 'b').length, 2);
    assert.equal(rows.filter((row) => row.kind === 'work' && row.item === 'a').length, 1);
    assert.equal(rows.filter((row) => row.kind === 'work' && row.item === 'c').length, 1);
    assert.deepEqual(new Set(probe.completionOrder.slice(0, 2)), new Set(['a', 'c']));
    assert.equal(probe.completionOrder.at(-1), 'b');
    await assertSingleStageMerged(scenario, ['a', 'b', 'c']);
  });

  test('happy path merges one cumulative diff per terminal item through a unique witness chain', async (t) => {
    const scenario = await setupScenario(t, 'happy');
    await runAttempt(scenario);
    const flowId = await flowIdFromActive(scenario);

    await assertMergedFiles(scenario);
    const journal = await readJournal(scenario);
    const audit = await auditFlow(scenario, flowId);
    const items = audit.steps.fan?.fanout?.items ?? [];

    assert.equal(items.length, 3);
    assert.ok(items.every((item) => item.status === 'succeeded' && item.acceptedDispatchToken));
    assert.equal(journal.runId, flowId);
    assert.equal(journal.issuances.length, 6);
    assert.ok(journal.issuances.filter((entry) => entry.state === 'merged').length === 3);
    assert.ok(
      journal.issuances
        .filter((entry) => entry.stage === 0)
        .every((entry) => entry.state === 'superseded'
          && entry.diff === null
          && entry.hadCumulativeDiff === false),
    );
    assert.ok(
      journal.issuances
        .filter((entry) => entry.state === 'merged')
        .every((entry) => entry.hadCumulativeDiff && entry.diff === null && entry.diffDroppedAt),
    );
    const transaction = journal.mergeTransactions.at(-1);
    assert.equal(transaction.state, 'complete');
    assert.ok(transaction.gateToken);
    assert.equal(transaction.orderedDiffs.length, 3);
    assert.deepEqual(transaction.orderedDiffs.map((entry) => entry.itemIndex), [0, 1, 2]);
    assert.deepEqual(
      transaction.orderedDiffs.map((entry) => entry.dispatchToken),
      items.map((item) => item.acceptedDispatchToken),
    );
    assert.equal(new Set(transaction.witnessChain).size, transaction.witnessChain.length);
    assert.ok(!scenario.artifactRoot.startsWith(`${scenario.workspace}/`));
    assert.ok(journal.worktrees.every((entry) => !entry.path.startsWith(`${scenario.workspace}/`)));
    // I3 (build-mode negative): a BUILD consumer fanout runs through the same
    // runConsumerIssuance seam but sets no gsd marker, so it must write NO GSD
    // milestone sidecars — even though its items produced real cumulative diffs.
    assert.ok(!existsSync(join(scenario.workspace, '.compose', 'gsd')),
      'build-mode fanout must not write any .compose/gsd instrumentation');
  });

  test('crash A restores the pre-stage witness before rerunning a mutated issuance', async (t) => {
    const scenario = await setupScenario(t, 'witness');
    let crashed = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        crashHooks: {
          afterAgentMutationBeforePrepared({ descriptor }) {
            if (!crashed && descriptor.itemIndex === 0 && descriptor.stage === 1) {
              crashed = true;
              throw injectedCrash('after mutation before prepared');
            }
          },
        },
      }),
      /after mutation before prepared/,
    );
    const flowId = await flowIdFromActive(scenario);
    const crashedJournal = await readJournal(scenario);
    const witnessed = crashedJournal.witnesses.find((entry) => entry.itemIndex === 0 && entry.stage === 1);
    assert.ok(witnessed?.witnessTree);
    assert.ok(!crashedJournal.issuances.some((entry) => entry.dispatchToken === witnessed.dispatchToken));
    assert.equal(countInvocation(await invocations(scenario), 'seed', 'a'), 1);
    assert.equal(countInvocation(await invocations(scenario), 'finish', 'a'), 1);

    await runAttempt(scenario, { resumeFlowId: flowId });
    await assertMergedFiles(scenario);
    assert.equal(countInvocation(await invocations(scenario), 'seed', 'a'), 1);
    assert.equal(countInvocation(await invocations(scenario), 'finish', 'a'), 2);
    const recoveredJournal = await readJournal(scenario);
    const restored = recoveredJournal.witnesses.find(
      (entry) => entry.dispatchToken === witnessed.dispatchToken,
    );
    assert.equal(restored.restoreCount, 1);
  });

  test('crash B re-reports a stored prepared envelope without re-executing the agent', async (t) => {
    const scenario = await setupScenario(t, 'prepared');
    let crashed = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        crashHooks: {
          afterPreparedBeforeReport({ descriptor }) {
            if (!crashed && descriptor.itemIndex === 0 && descriptor.stage === 1) {
              crashed = true;
              throw injectedCrash('after prepared before report');
            }
          },
        },
      }),
      /after prepared before report/,
    );
    const flowId = await flowIdFromActive(scenario);
    const before = await invocations(scenario);
    const crashedJournal = await readJournal(scenario);
    const prepared = crashedJournal.issuances.find((entry) => entry.itemIndex === 0 && entry.stage === 1);
    assert.equal(prepared?.state, 'prepared');
    assert.ok(prepared.envelope);
    assert.ok(prepared.diff);

    let recoveryReport = null;
    await runAttempt(scenario, {
      resumeFlowId: flowId,
      onClient(client) {
        const realStepDone = client.stepDone.bind(client);
        client.stepDone = async (reportedFlowId, stepId, envelope, dispatchToken) => {
          if (dispatchToken === prepared.dispatchToken) {
            recoveryReport = { reportedFlowId, stepId, envelope, dispatchToken };
          }
          return realStepDone(reportedFlowId, stepId, envelope, dispatchToken);
        };
      },
    });
    await assertMergedFiles(scenario);
    const after = await invocations(scenario);
    assert.equal(countInvocation(after, 'finish', 'a'), countInvocation(before, 'finish', 'a'));
    assert.deepEqual(recoveryReport, {
      reportedFlowId: flowId,
      stepId: prepared.scopedId,
      envelope: prepared.envelope,
      dispatchToken: prepared.dispatchToken,
    });
  });

  test('crash C promotes acceptedDispatchToken evidence and merges without agent re-execution', async (t) => {
    const scenario = await setupScenario(t, 'accepted');
    let crashed = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        crashHooks: {
          afterStepDone({ response }) {
            if (!crashed && response.status === 'running') {
              crashed = true;
              throw injectedCrash('after accepted step_done before merge');
            }
          },
        },
      }),
      /after accepted step_done before merge/,
    );
    const flowId = await flowIdFromActive(scenario);
    const before = await invocations(scenario);
    const auditBefore = await auditFlow(scenario, flowId);
    assert.ok(
      auditBefore.steps.fan.fanout.items.every(
        (item) => item.status === 'succeeded' && item.acceptedDispatchToken,
      ),
    );

    await runAttempt(scenario, { resumeFlowId: flowId });
    await assertMergedFiles(scenario);
    assert.deepEqual(await invocations(scenario), before);
    const journal = await readJournal(scenario);
    assert.equal(journal.issuances.filter((entry) => entry.state === 'merged').length, 3);
  });

  test('crash D restores an unmatched partial tree and replays the merge transaction from zero', async (t) => {
    const scenario = await setupScenario(t, 'partial-apply');
    let crashed = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        crashHooks: {
          async insideDiffApply({ cwd, orderedIndex }) {
            if (!crashed && orderedIndex === 0) {
              crashed = true;
              await mkdir(join(cwd, 'items'), { recursive: true });
              await writeFile(join(cwd, 'items', 'a.txt'), 'seed:a\nfinish:a\n');
              throw injectedCrash('inside multi-file diff apply');
            }
          },
        },
      }),
      /inside multi-file diff apply/,
    );
    const flowId = await flowIdFromActive(scenario);
    const crashedJournal = await readJournal(scenario);
    const transaction = crashedJournal.mergeTransactions.at(-1);
    const partialTree = currentWorkingTreeId(scenario.workspace);
    assert.ok(!transaction.witnessChain.includes(partialTree), 'partial apply must match no prefix witness');

    await runAttempt(scenario, { resumeFlowId: flowId });
    await assertMergedFiles(scenario);
    const recoveredJournal = await readJournal(scenario);
    const recovered = recoveredJournal.mergeTransactions.at(-1);
    assert.equal(recovered.state, 'complete');
    assert.ok(recovered.recovery?.baselineRestores >= 1);
    assert.equal((await auditFlow(scenario, flowId)).status, 'completed');
  });

  test('terminal kill after a partial apply restores the baseline before dropping evidence', async (t) => {
    const scenario = await setupScenario(t, 'partial-apply-kill');
    let crashed = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        crashHooks: {
          async insideDiffApply({ cwd, orderedIndex }) {
            if (!crashed && orderedIndex === 0) {
              crashed = true;
              await mkdir(join(cwd, 'items'), { recursive: true });
              await writeFile(join(cwd, 'items', 'a.txt'), 'seed:a\nfinish:a\n');
              throw injectedCrash('partial apply before terminal kill');
            }
          },
        },
      }),
      /partial apply before terminal kill/,
    );
    const flowId = await flowIdFromActive(scenario);
    const journalBeforeKill = await readJournal(scenario);
    const transactionBeforeKill = journalBeforeKill.mergeTransactions.at(-1);
    assert.ok(!transactionBeforeKill.witnessChain.includes(currentWorkingTreeId(scenario.workspace)));

    const client = await connectClient(scenario.stateRoot);
    try {
      const audit = await client.audit(flowId);
      const killed = await client.gateResolve(
        flowId,
        'merge',
        'kill',
        'terminate after injected crash',
        'test',
        audit.steps.merge.gateToken,
      );
      assert.equal(killed.status, 'failed');
    } finally {
      await client.close();
    }

    await runAttempt(scenario, { resumeFlowId: flowId });
    await assert.rejects(readFile(join(scenario.workspace, 'items', 'a.txt')), { code: 'ENOENT' });
    const recoveredJournal = await readJournal(scenario);
    const recovered = recoveredJournal.mergeTransactions.at(-1);
    assert.equal(recovered.state, 'rolled_back');
    assert.equal(recovered.gateOutcome, 'kill');
    assert.ok(recovered.recovery.baselineRestores >= 1);
    assert.equal(recovered.recovery.baselineVerifiedTree, transactionBeforeKill.baselineTree);
    assert.ok(recoveredJournal.worktrees.every((entry) => entry.cleanedAt));
    assert.ok(recovered.orderedDiffs.every((entry) => entry.diff === null));
  });

  test('a crash after gate resolution finalizes merged artifacts on a fresh resume', async (t) => {
    const scenario = await setupScenario(t, 'post-gate-resolve');
    let crashed = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        crashHooks: {
          afterGateResolve({ outcome }) {
            if (!crashed && outcome === 'approve') {
              crashed = true;
              throw injectedCrash('after gate resolve before artifact cleanup');
            }
          },
        },
      }),
      /after gate resolve before artifact cleanup/,
    );
    const flowId = await flowIdFromActive(scenario);
    const callsBeforeResume = await invocations(scenario);
    const auditBeforeResume = await auditFlow(scenario, flowId);
    const journalBeforeResume = await readJournal(scenario);
    const transactionBeforeResume = journalBeforeResume.mergeTransactions.at(-1);

    assert.equal(auditBeforeResume.status, 'completed');
    assert.equal(transactionBeforeResume.state, 'complete');
    assert.equal(transactionBeforeResume.gateResolvedAt, undefined);
    assert.ok(journalBeforeResume.worktrees.some((entry) => !entry.cleanedAt));

    await runAttempt(scenario, { resumeFlowId: flowId });
    await assertMergedFiles(scenario);
    assert.deepEqual(await invocations(scenario), callsBeforeResume);
    const recoveredJournal = await readJournal(scenario);
    const recovered = recoveredJournal.mergeTransactions.at(-1);
    assert.equal(recovered.gateOutcome, 'approve');
    assert.ok(recovered.gateResolvedAt);
    assert.ok(recoveredJournal.worktrees.every((entry) => entry.cleanedAt));
    assert.ok(
      recoveredJournal.issuances
        .filter((entry) => entry.state === 'merged')
        .every((entry) => entry.diff === null && entry.diffDroppedAt),
    );
  });

  test('revise retains superseded generation evidence and merges only the repair generation', async (t) => {
    const scenario = await setupScenario(t, 'revise-generation');
    await writeFile(
      join(scenario.workspace, '.compose', 'data', 'settings.json'),
      JSON.stringify({ policies: { merge: 'gate' } }),
    );
    const reviseIo = scriptedGateIO([
      { prompt: '\n> ', line: 'r' },
      { prompt: 'Rationale: ', line: 'repair this fanout round' },
    ]);

    await assert.rejects(
      () => runAttempt(scenario, {
        gateOpts: { input: reviseIo.input, output: reviseIo.output },
        crashHooks: {
          afterGateResolve({ outcome }) {
            if (outcome === 'revise') throw injectedCrash('after revise gate resolution');
          },
        },
      }),
      /after revise gate resolution/,
    );
    reviseIo.assertConsumed();
    const flowId = await flowIdFromActive(scenario);
    const afterReviseCrash = await readJournal(scenario);
    assert.equal(afterReviseCrash.mergeTransactions[0].state, 'rolled_back');
    assert.equal(afterReviseCrash.mergeTransactions[0].gateResolvedAt, undefined);
    assert.ok(afterReviseCrash.worktrees.every((entry) => !entry.cleanedAt));
    assert.ok(afterReviseCrash.mergeTransactions[0].orderedDiffs.every((entry) => entry.diff));

    const approveIo = scriptedGateIO([{ prompt: '\n> ', line: 'a' }]);
    await runAttempt(scenario, {
      resumeFlowId: flowId,
      gateOpts: { input: approveIo.input, output: approveIo.output },
    });
    approveIo.assertConsumed();
    await assertMergedFiles(scenario);
    const journal = await readJournal(scenario);
    const audit = await auditFlow(scenario, flowId);
    const generations = [...new Set(journal.worktrees.map((entry) => entry.generation))];
    const gateDecisions = audit.events
      .filter((event) => event.type === 'gate_resolved' && event.stepId === 'merge')
      .map((event) => event.detail.decision);

    assert.deepEqual(gateDecisions, ['revise', 'approve']);
    assert.equal(generations.length, 6, 'each item receives a new run-global generation');
    assert.equal(journal.mergeTransactions.length, 2);
    assert.equal(journal.mergeTransactions[0].state, 'rolled_back');
    assert.equal(journal.mergeTransactions[0].gateOutcome, 'revise');
    assert.equal(journal.mergeTransactions[1].state, 'complete');
    assert.equal(journal.mergeTransactions[1].gateOutcome, 'approve');
    assert.equal(journal.issuances.filter((entry) => entry.state === 'merged').length, 3);
    assert.ok(
      journal.issuances
        .filter((entry) => entry.generation <= 3)
        .every((entry) => entry.state === 'superseded'),
    );
    assert.ok(journal.worktrees.filter((entry) => entry.generation <= 3).every((entry) => entry.supersededAt));
  });

  test('revise routed to an ordinary repair step retains accepted diffs for the next approval', async (t) => {
    const scenario = await setupScenario(t, 'revise-repair', CONSUMER_REPAIR_SPEC);
    await writeFile(
      join(scenario.workspace, '.compose', 'data', 'settings.json'),
      JSON.stringify({ policies: { merge: 'gate' } }),
    );
    // revise (round 1) → repair reruns → approve (round 2). On the buggy code the
    // revise superseded the accepted diffs, so this approve is silently downgraded
    // to another revise and the run never completes (times out); the fix lets the
    // approve merge the retained diffs.
    const io = scriptedGateIO([
      { prompt: '\n> ', line: 'r' },
      { prompt: 'Rationale: ', line: 'repair without re-enumerating the fanout' },
      { prompt: '\n> ', line: 'a' },
    ]);

    await runAttempt(scenario, { gateOpts: { input: io.input, output: io.output } });
    io.assertConsumed();

    await assertMergedFiles(scenario);
    const flowId = await flowIdFromActive(scenario);
    const journal = await readJournal(scenario);
    const audit = await auditFlow(scenario, flowId);
    const gateDecisions = audit.events
      .filter((event) => event.type === 'gate_resolved' && event.stepId === 'merge')
      .map((event) => event.detail.decision);

    assert.deepEqual(gateDecisions, ['revise', 'approve']);
    // The fanout was NEVER re-enumerated: exactly one worktree per item, none
    // superseded, and — the crux of F1 — NO issuance was superseded, so the
    // accepted evidence from the first round survived the revise untouched.
    assert.equal(journal.worktrees.length, 3);
    assert.equal(new Set(journal.worktrees.map((entry) => entry.generation)).size, 3);
    assert.ok(journal.worktrees.every((entry) => !entry.supersededAt));
    // The crux of F1: the final-stage issuances carrying the accepted diffs were
    // NOT superseded by the revise (only the stage-0 seed issuances are, via the
    // ordinary stage-advance token rotation) — all three merged on the approval.
    const finalIssuances = journal.issuances.filter((entry) => entry.stage === 1);
    assert.equal(finalIssuances.length, 3);
    assert.ok(finalIssuances.every((entry) => entry.state === 'merged'));
    assert.equal(journal.issuances.filter((entry) => entry.state === 'merged').length, 3);
    assert.equal(journal.mergeTransactions.length, 2);
    assert.equal(journal.mergeTransactions[0].gateOutcome, 'revise');
    assert.equal(journal.mergeTransactions.at(-1).state, 'complete');
    assert.equal(journal.mergeTransactions.at(-1).gateOutcome, 'approve');
    assert.equal(journal.mergeTransactions.at(-1).orderedDiffs.length, 3);
  });

  test('a pipeline spec edited between crash and resume fails loudly instead of stranding diffs', async (t) => {
    const scenario = await setupScenario(t, 'revision-guard');
    let crashed = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        crashHooks: {
          afterStepDone({ response }) {
            if (!crashed && response.status === 'running') {
              crashed = true;
              throw injectedCrash('after accepted step_done before merge');
            }
          },
        },
      }),
      /after accepted step_done before merge/,
    );
    const flowId = await flowIdFromActive(scenario);
    const before = await invocations(scenario);
    const auditBefore = await auditFlow(scenario, flowId);
    assert.ok(
      auditBefore.steps.fan.fanout.items.every(
        (item) => item.status === 'succeeded' && item.acceptedDispatchToken,
      ),
    );
    assert.equal(auditBefore.steps.merge.status, 'waiting_gate');

    // Rewrite the pipeline file so the merge gate no longer follows the fanout.
    // The engine keeps its persisted (correct) revision; only Compose's local
    // spec drifts. Trusting it would approve the gate WITHOUT applying the
    // accepted diffs — the exact stranding this guard prevents.
    const specPath = join(scenario.workspace, 'pipelines', 'build.stratum.yaml');
    const edited = (await readFile(specPath, 'utf8')).replace(
      '      - id: merge\n        after: [fan]',
      '      - id: merge\n        after: [enumerate]',
    );
    assert.ok(edited.includes('after: [enumerate]'), 'the spec rewrite must detach the gate from the fanout');
    await writeFile(specPath, edited);

    // Fresh-process resume must refuse: the local spec no longer describes the run.
    await assert.rejects(
      () => runAttempt(scenario, { resumeFlowId: flowId }),
      (error) => error?.code === 'CONSUMER_RUN_REVISION_MISMATCH',
    );

    // The engine's merge gate is STILL waiting, no agent re-ran, and the accepted
    // diffs are intact — nothing was merged and no gate was resolved.
    const auditAfter = await auditFlow(scenario, flowId);
    assert.equal(auditAfter.steps.merge.status, 'waiting_gate');
    assert.deepEqual(await invocations(scenario), before);
    const journal = await readJournal(scenario);
    assert.equal(journal.mergeTransactions.length, 0);
    const finalIssuances = journal.issuances.filter((entry) => entry.stage === 1);
    assert.equal(finalIssuances.length, 3);
    assert.ok(finalIssuances.every((entry) => entry.diff && entry.state !== 'merged'));
  });

  test('a retried consumer item is told why its prior attempt failed', async (t) => {
    const scenario = await setupScenario(t, 'previous-failure');
    const prompts = [];
    const failReason = 'seed-a rejected: the value field was empty on attempt one';
    await runAttempt(scenario, {
      agentFactory: faultInjectingAgentFactory(scenario.invocationLog, {
        prompts,
        fault: { item: 'a', stage: 'seed', mode: 'fail', reason: failReason },
      }),
    });

    await assertMergedFiles(scenario);
    // seed 'a' ran twice: the deliberate failure then a clean retry.
    assert.equal(countInvocation(await invocations(scenario), 'seed', 'a'), 2);
    // The SECOND seed-a dispatch must carry the engine's previousFailure reason,
    // rendered as a clearly delimited retry section.
    const seedAPrompts = prompts.filter((prompt) => /## Intent\nseed a\b/.test(prompt));
    assert.equal(seedAPrompts.length, 2);
    assert.ok(!seedAPrompts[0].includes('Previous Attempt Failed'), 'first attempt has no failure section');
    assert.ok(seedAPrompts[1].includes('## Previous Attempt Failed'), 'retry must render the failure section');
    assert.ok(seedAPrompts[1].includes(failReason), 'retry must render the previous failure reason');
  });

  test('a non-timeout connector error fails only its item; the fanout continues and retries it', async (t) => {
    const scenario = await setupScenario(t, 'item-local-error');
    const prompts = [];
    await runAttempt(scenario, {
      agentFactory: faultInjectingAgentFactory(scenario.invocationLog, {
        prompts,
        fault: { item: 'b', stage: 'seed', mode: 'throw', reason: 'connector exploded on seed b' },
      }),
    });

    // The run completed: the thrown error was enveloped as a per-item failure,
    // the other items finished, and item b was re-issued and succeeded.
    await assertMergedFiles(scenario);
    const flowId = await flowIdFromActive(scenario);
    const audit = await auditFlow(scenario, flowId);
    assert.ok(audit.steps.fan.fanout.items.every((item) => item.status === 'succeeded'));
    const rows = await invocations(scenario);
    assert.equal(countInvocation(rows, 'seed', 'b'), 2, 'item b seed ran twice (throw then retry)');
    assert.equal(countInvocation(rows, 'seed', 'a'), 1, 'unaffected items ran once');
    assert.equal(countInvocation(rows, 'seed', 'c'), 1);
    // The failed first attempt wrote nothing (witness restored), so the retry
    // produced exactly one clean cumulative diff per item.
    const journal = await readJournal(scenario);
    assert.equal(journal.issuances.filter((entry) => entry.state === 'merged').length, 3);
  });

  test('a stale/duplicate consumer step_done rejection is skipped per item and the build completes', async (t) => {
    const scenario = await setupScenario(t, 'duplicate-step-done', CONSUMER_SINGLE_STAGE_SPEC);
    let duplicateError = null;

    await runAttempt(scenario, {
      agentFactory: overlapProbeAgentFactory(scenario.invocationLog, { current: 0, max: 0 }),
      onClient(client) {
        const realStepDone = client.stepDone.bind(client);
        let duplicated = false;
        client.stepDone = async (...args) => {
          const response = await realStepDone(...args);
          const stepId = args[1];
          if (!duplicated && stepId.startsWith('fan/')) {
            duplicated = true;
            try {
              // The first call was accepted. Repeating the same fenced report
              // produces the real MCP -32603 stale/duplicate rejection.
              return await realStepDone(...args);
            } catch (error) {
              duplicateError = error;
              throw error;
            }
          }
          return response;
        };
      },
    });

    assert.equal(duplicateError?.code, -32603, 'the reproduction must exercise the JSON-RPC code');
    assert.match(
      duplicateError?.message ?? '',
      /step (?:result is stale|is not awaiting a client result)/i,
    );
    const flowId = await flowIdFromActive(scenario);
    assert.equal((await auditFlow(scenario, flowId)).status, 'completed');
    await assertSingleStageMerged(scenario, ['a', 'b', 'c']);

    const events = (await readFile(join(scenario.workspace, '.compose', 'build-stream.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    const skipped = events.find((event) => event.type === 'build_step_done'
      && event.status === 'skipped' && event.error_code === -32603);
    assert.ok(skipped, 'the stale/duplicate report is logged as a skipped consumer item');
    assert.match(skipped.summary, /fan\/\d+.*-32603.*stale/i);
  });

  test('an unrelated -32603 consumer step_done rejection remains build-fatal', async (t) => {
    const scenario = await setupScenario(t, 'genuine-step-done-error', CONSUMER_SINGLE_STAGE_SPEC);

    await assert.rejects(
      () => runAttempt(scenario, {
        agentFactory: overlapProbeAgentFactory(scenario.invocationLog, { current: 0, max: 0 }),
        onClient(client) {
          const realStepDone = client.stepDone.bind(client);
          let injected = false;
          client.stepDone = async (...args) => {
            if (!injected && args[1].startsWith('fan/')) {
              injected = true;
              const error = new Error('MCP error -32603: engine persistence failed');
              error.code = -32603;
              throw error;
            }
            return realStepDone(...args);
          };
        },
      }),
      (error) => error?.code === -32603 && /engine persistence failed/.test(error.message),
    );
  });

  test('a nested contract closure reaches the agent schema and the engine accepts the output', async (t) => {
    const scenario = await setupScenario(t, 'nested-closure', CONSUMER_NESTED_SPEC);
    const prompts = [];
    await runAttempt(scenario, {
      agentFactory: nestedContractAgentFactory(scenario.invocationLog, { prompts }),
    });

    // The run completed: the engine strictly validated the nested
    // {report:{items:[Finding],summary}} output every item produced.
    await assertMergedFiles(scenario);
    const flowId = await flowIdFromActive(scenario);
    const audit = await auditFlow(scenario, flowId);
    assert.equal(audit.status, 'completed');
    assert.ok(audit.steps.fan.fanout.items.every((item) => item.status === 'succeeded'));

    // The finish-stage schema injected into the prompt exposed the nested named
    // record and typed-array fields — not a degraded `{}`.
    const finishPrompt = prompts.find((prompt) => /## Intent\nfinish a from/.test(prompt));
    assert.ok(finishPrompt, 'a finish-stage prompt must exist');
    for (const jsonKey of ['"report"', '"items"', '"summary"', '"file"', '"line"']) {
      assert.ok(finishPrompt.includes(jsonKey), `finish schema must expose nested field ${jsonKey}`);
    }
  });

  test('a cumulative diff larger than the default exec buffer is captured and merged', async (t) => {
    const scenario = await setupScenario(t, 'large-diff');
    const bigBytes = 2 * 1024 * 1024; // 2 MiB > execFileSync's 1 MiB default maxBuffer
    await runAttempt(scenario, {
      agentFactory: largeFileAgentFactory(scenario.invocationLog, { item: 'a', bytes: bigBytes }),
    });

    await assertMergedFiles(scenario);
    // The oversized file was captured in item a's cumulative diff and landed in
    // the merge target — no ENOBUFS wedge at capture or merge.
    const big = await readFile(join(scenario.workspace, 'items', 'a-big.txt'), 'utf8');
    assert.equal(big.length, bigBytes);
    const journal = await readJournal(scenario);
    assert.equal(journal.issuances.filter((entry) => entry.state === 'merged').length, 3);
  });

  test('a crash before the first revision bind still guards the resume against spec drift', async (t) => {
    const scenario = await setupScenario(t, 'prebind-drift');
    let crashed = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        crashHooks: {
          beforeRevisionBind() {
            if (!crashed) {
              crashed = true;
              throw injectedCrash('before first revision bind');
            }
          },
        },
      }),
      /before first revision bind/,
    );
    const flowId = await flowIdFromActive(scenario);
    // The journal was pinned in its FIRST durable write, before the bind that crashed.
    const crashedJournal = await readJournal(scenario);
    assert.ok(crashedJournal.revisionDigest, 'revisionDigest pinned at journal creation');
    assert.ok(crashedJournal.specDigest, 'specDigest pinned at journal creation');
    assert.equal(crashedJournal.issuances.length, 0, 'crash landed before any issuance');

    // Edit the pipeline between crash and resume.
    const specPath = join(scenario.workspace, 'pipelines', 'build.stratum.yaml');
    const edited = (await readFile(specPath, 'utf8')).replace(
      '      - id: merge\n        after: [fan]',
      '      - id: merge\n        after: [enumerate]',
    );
    assert.ok(edited.includes('after: [enumerate]'), 'the spec rewrite must change the file');
    await writeFile(specPath, edited);

    // Because the pins were durable before the crash, the drift is caught on resume
    // instead of the unpinned journal silently accepting the edited spec as truth.
    await assert.rejects(
      () => runAttempt(scenario, { resumeFlowId: flowId }),
      (error) => error?.code === 'CONSUMER_RUN_REVISION_MISMATCH',
    );
  });

  test('a crash after applyMerge but before gate resolution lets a later revise re-merge the diffs', async (t) => {
    const scenario = await setupScenario(t, 'merge-rollback', CONSUMER_REPAIR_SPEC);
    await writeFile(
      join(scenario.workspace, '.compose', 'data', 'settings.json'),
      JSON.stringify({ policies: { merge: 'gate' } }),
    );
    const approveIo = scriptedGateIO([{ prompt: '\n> ', line: 'a' }]);
    let crashed = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        gateOpts: { input: approveIo.input, output: approveIo.output },
        crashHooks: {
          afterMergeApplyBeforeGateResolve() {
            if (!crashed) {
              crashed = true;
              throw injectedCrash('after applyMerge before gate resolution');
            }
          },
        },
      }),
      /after applyMerge before gate resolution/,
    );
    const flowId = await flowIdFromActive(scenario);
    const crashedJournal = await readJournal(scenario);
    // applyMerge ran: the transaction completed and the diffs are journaled `merged`
    // even though the engine never accepted the gate decision.
    assert.equal(crashedJournal.mergeTransactions.at(-1).state, 'complete');
    assert.equal(crashedJournal.issuances.filter((entry) => entry.state === 'merged').length, 3);

    // Resume and drive revise → repair → approve. The revise rollback must restore
    // merge eligibility, so the approval can re-merge the retained diffs.
    const reviseThenApproveIo = scriptedGateIO([
      { prompt: '\n> ', line: 'r' },
      { prompt: 'Rationale: ', line: 'roll back the applied-but-unresolved merge' },
      { prompt: '\n> ', line: 'a' },
    ]);
    await runAttempt(scenario, {
      resumeFlowId: flowId,
      gateOpts: { input: reviseThenApproveIo.input, output: reviseThenApproveIo.output },
    });
    reviseThenApproveIo.assertConsumed();

    await assertMergedFiles(scenario);
    const journal = await readJournal(scenario);
    const audit = await auditFlow(scenario, flowId);
    const gateDecisions = audit.events
      .filter((event) => event.type === 'gate_resolved' && event.stepId === 'merge')
      .map((event) => event.detail.decision);

    assert.deepEqual(gateDecisions, ['revise', 'approve']);
    assert.equal(journal.issuances.filter((entry) => entry.state === 'merged').length, 3);
    assert.equal(
      journal.mergeTransactions.filter((entry) => entry.state === 'complete' && entry.gateOutcome === 'approve').length,
      1,
    );
  });

  test('a consumer item with a valid empty output contract completes', async (t) => {
    const scenario = await setupScenario(t, 'empty-contract', CONSUMER_EMPTY_SPEC);
    await runAttempt(scenario, {
      agentFactory: emptyContractAgentFactory(scenario.invocationLog),
    });

    const flowId = await flowIdFromActive(scenario);
    const audit = await auditFlow(scenario, flowId);
    assert.equal(audit.status, 'completed');
    assert.ok(audit.steps.fan.fanout.items.every((item) => item.status === 'succeeded'));
    // The agent's {} was accepted (not discarded as "no structured output"), so the
    // single item ran exactly once instead of retrying until attempts exhaust.
    assert.equal(countInvocation(await invocations(scenario), 'seed', 'a'), 1);
    const journal = await readJournal(scenario);
    assert.equal(journal.issuances.filter((entry) => entry.state === 'merged').length, 1);
  });

  test('recovery never rolls back an earlier revised round over a later approved merge', async (t) => {
    const scenario = await setupScenario(t, 'historical-rollback', CONSUMER_REPAIR_SPEC);
    await writeFile(
      join(scenario.workspace, '.compose', 'data', 'settings.json'),
      JSON.stringify({ policies: { merge: 'gate' } }),
    );
    // Round 1 revises (rolls back), round 2 re-merges and approves; crash in the
    // round-2 afterGateResolve, before cleanup.
    const io = scriptedGateIO([
      { prompt: '\n> ', line: 'r' },
      { prompt: 'Rationale: ', line: 'revise round one' },
      { prompt: '\n> ', line: 'a' },
    ]);
    let crashed = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        gateOpts: { input: io.input, output: io.output },
        crashHooks: {
          afterGateResolve({ outcome }) {
            if (!crashed && outcome === 'approve') {
              crashed = true;
              throw injectedCrash('after round-2 approve before cleanup');
            }
          },
        },
      }),
      /after round-2 approve before cleanup/,
    );
    io.assertConsumed();
    const flowId = await flowIdFromActive(scenario);
    // At crash: round 2 already applied its diffs and the engine completed.
    await assertMergedFiles(scenario);
    const crashedJournal = await readJournal(scenario);
    assert.equal(crashedJournal.mergeTransactions.length, 2);
    assert.equal(crashedJournal.mergeTransactions[0].gateOutcome, 'revise');
    assert.equal((await auditFlow(scenario, flowId)).status, 'completed');

    // Fresh-process recovery must NOT restore round 1's baseline over the round-2
    // target — the approved changes survive.
    await runAttempt(scenario, { resumeFlowId: flowId });
    await assertMergedFiles(scenario);
    const journal = await readJournal(scenario);
    assert.equal(journal.mergeTransactions[1].gateOutcome, 'approve');
    assert.ok(journal.worktrees.every((entry) => entry.cleanedAt));
  });

  test('an empty-input consumer fanout pins its journal at the gate and resumes cleanly', async (t) => {
    const scenario = await setupScenario(t, 'empty-input', CONSUMER_EMPTY_INPUT_SPEC);
    let crashed = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        agentFactory: emptyInputAgentFactory(scenario.invocationLog),
        crashHooks: {
          afterMergeApplyBeforeGateResolve() {
            if (!crashed) {
              crashed = true;
              throw injectedCrash('empty fanout: before gate resolution');
            }
          },
        },
      }),
      /empty fanout: before gate resolution/,
    );
    const flowId = await flowIdFromActive(scenario);
    const crashedJournal = await readJournal(scenario);
    // The journal was FIRST created at the gate path (no descriptor issued), yet
    // is pinned — a work-bearing merge transaction with revision pins.
    assert.equal(crashedJournal.mergeTransactions.length, 1);
    assert.ok(crashedJournal.revisionDigest, 'journal pinned at the gate path');
    assert.ok(crashedJournal.specDigest);

    // Fresh-process resume must NOT fail closed with a spurious revision mismatch.
    await runAttempt(scenario, {
      resumeFlowId: flowId,
      agentFactory: emptyInputAgentFactory(scenario.invocationLog),
    });
    assert.equal((await auditFlow(scenario, flowId)).status, 'completed');
  });

  test('rollback superseded evidence is not resurrected after re-enumeration to fewer items', async (t) => {
    const scenario = await setupScenario(t, 'shrink-reenumerate', CONSUMER_REENUMERATE_SPEC);
    const state = { enumerateCalls: 0 };
    let crashed = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        agentFactory: shrinkingEnumerateFactory(scenario.invocationLog, state),
        crashHooks: {
          afterMergeApplyBeforeGateResolve() {
            if (!crashed) {
              crashed = true;
              throw injectedCrash('after apply, before out-of-band revise');
            }
          },
        },
      }),
      /after apply, before out-of-band revise/,
    );
    const flowId = await flowIdFromActive(scenario);
    const crashedJournal = await readJournal(scenario);
    assert.equal(crashedJournal.issuances.filter((entry) => entry.state === 'merged').length, 3);

    // Out-of-band: a second client resolves the gate as revise, routing to
    // enumerate so the fanout re-enumerates on resume.
    const client = await connectClient(scenario.stateRoot);
    try {
      const audit = await client.audit(flowId);
      const revised = await client.gateResolve(
        flowId, 'merge', 'revise', 're-enumerate to fewer items', 'test', audit.steps.merge.gateToken,
      );
      assert.ok(revised);
    } finally {
      await client.close();
    }

    // Resume: enumerate re-runs with ONE item; the next gate must merge exactly the
    // current generation's single diff — the three stale generation-1..3 accepted
    // entries are superseded (their item indexes no longer exist), never re-merged.
    await runAttempt(scenario, {
      resumeFlowId: flowId,
      agentFactory: shrinkingEnumerateFactory(scenario.invocationLog, state),
    });
    assert.equal((await auditFlow(scenario, flowId)).status, 'completed');
    const journal = await readJournal(scenario);
    assert.equal(
      journal.issuances.filter((entry) => entry.state === 'merged').length,
      1,
      'only the re-enumerated single item merged',
    );
    assert.ok(
      journal.issuances
        .filter((entry) => entry.stage === 1 && entry.generation <= 3)
        .every((entry) => entry.state === 'superseded'),
      'the vanished item indexes are superseded, not accepted',
    );
  });

  test('consumer crash hooks are ignored outside NODE_ENV=test', async (t) => {
    const scenario = await setupScenario(t, 'hook-guard');
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let hookInvoked = false;
    try {
      await runAttempt(scenario, {
        crashHooks: {
          afterStepDone() {
            hookInvoked = true;
            throw injectedCrash('crash hooks must not run in production');
          },
        },
      });
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
    // The hook was never wired, so the run completed untouched.
    assert.equal(hookInvoked, false);
    await assertMergedFiles(scenario);
  });

  test('isolation:none consumer items run in-cwd and survive terminal cleanup', async (t) => {
    const scenario = await setupScenario(t, 'isolation-none', CONSUMER_NONE_SPEC);
    await runAttempt(scenario, {
      agentFactory: noneIsolationAgentFactory(scenario.invocationLog),
    });

    const flowId = await flowIdFromActive(scenario);
    const audit = await auditFlow(scenario, flowId);
    assert.equal(audit.status, 'completed');
    assert.ok(audit.steps.fan.fanout.items.every((item) => item.status === 'succeeded'));

    // Files written in-cwd survive: no worktree was created, so terminal cleanup
    // could not discard them.
    for (const item of ['a', 'b']) {
      assert.equal(
        await readFile(join(scenario.workspace, 'none-items', `${item}.txt`), 'utf8'),
        `none:${item}\n`,
      );
    }
    const journal = await readJournal(scenario);
    assert.equal(journal.worktrees.length, 0, 'isolation:none creates no worktrees');
    assert.ok(
      journal.issuances.every((entry) => entry.isolation === 'none' && entry.diff === null),
    );
    // The gate approved as a trivially clean merge with zero diffs.
    const transaction = journal.mergeTransactions.at(-1);
    assert.equal(transaction.state, 'complete');
    assert.equal(transaction.orderedDiffs.length, 0);
  });

  test('a flow with a none fanout and a worktree fanout merges only the worktree diffs', async (t) => {
    const scenario = await setupScenario(t, 'mixed-isolation', CONSUMER_MIXED_SPEC);
    await runAttempt(scenario, {
      agentFactory: mixedIsolationAgentFactory(scenario.invocationLog),
    });

    const flowId = await flowIdFromActive(scenario);
    assert.equal((await auditFlow(scenario, flowId)).status, 'completed');
    // none items' files persist in-cwd; worktree items' files merged into the target.
    for (const item of ['a', 'b']) {
      assert.equal(
        await readFile(join(scenario.workspace, 'none-items', `${item}.txt`), 'utf8'),
        `none:${item}\n`,
      );
      assert.equal(
        await readFile(join(scenario.workspace, 'wt-items', `${item}.txt`), 'utf8'),
        `wt:${item}\n`,
      );
    }
    const journal = await readJournal(scenario);
    // Only fan_wt (worktree) created worktrees and merged diffs; fan_none created none.
    assert.ok(journal.worktrees.every((entry) => entry.fanoutStepId === 'fan_wt'));
    const mergeTx = journal.mergeTransactions.find((entry) => entry.fanoutStepId === 'fan_wt');
    assert.equal(mergeTx.orderedDiffs.length, 2, 'exactly the two worktree items merged');
    assert.ok(
      journal.issuances.filter((entry) => entry.fanoutStepId === 'fan_none').every((entry) => entry.isolation === 'none'),
    );
  });

  test('a legacy unpinned journal adopts pins at the gate so the next resume does not fail closed', async (t) => {
    const scenario = await setupScenario(t, 'legacy-unpinned', CONSUMER_EMPTY_INPUT_SPEC);

    // Phase 1: reach the gate and crash, creating this run's journal + flowId.
    let crashed1 = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        agentFactory: emptyInputAgentFactory(scenario.invocationLog),
        crashHooks: {
          afterMergeApplyBeforeGateResolve() {
            if (!crashed1) { crashed1 = true; throw injectedCrash('phase-1 gate crash'); }
          },
        },
      }),
      /phase-1 gate crash/,
    );
    const flowId = await flowIdFromActive(scenario);

    // Rewrite it to the LEGACY shape: empty and UNPINNED (as pre-pinning code left
    // it). verifyConsumerRunRevision treats an empty unpinned journal as safe.
    const journalPath = await journalPathOf(scenario);
    const legacy = JSON.parse(await readFile(journalPath, 'utf8'));
    Object.assign(legacy, {
      revisionDigest: null,
      specDigest: null,
      gateBinding: null,
      worktrees: [],
      witnesses: [],
      issuances: [],
      mergeTransactions: [],
    });
    await writeFile(journalPath, `${JSON.stringify(legacy, null, 2)}\n`);

    // Phase 2: resume. The gate path must ADOPT pins onto the existing unpinned
    // journal, then crash again after prepareMerge makes it work-bearing.
    let crashed2 = false;
    await assert.rejects(
      () => runAttempt(scenario, {
        resumeFlowId: flowId,
        agentFactory: emptyInputAgentFactory(scenario.invocationLog),
        crashHooks: {
          afterMergeApplyBeforeGateResolve() {
            if (!crashed2) { crashed2 = true; throw injectedCrash('phase-2 gate crash'); }
          },
        },
      }),
      /phase-2 gate crash/,
    );
    const afterPhase2 = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.ok(afterPhase2.revisionDigest, 'pins adopted onto the legacy journal at the gate');
    assert.ok(afterPhase2.specDigest);
    assert.ok(afterPhase2.mergeTransactions.length >= 1, 'journal is now work-bearing');

    // Phase 3: the next resume must COMPLETE, not fail closed on a work-bearing
    // journal that is missing its pins.
    await runAttempt(scenario, {
      resumeFlowId: flowId,
      agentFactory: emptyInputAgentFactory(scenario.invocationLog),
    });
    assert.equal((await auditFlow(scenario, flowId)).status, 'completed');
  });

  test('a stale per-item audit snapshot cannot supersede a concurrent item\'s newer diff', async (t) => {
    const scenario = await setupScenario(t, 'stale-audit', CONSUMER_BUILD_SPEC);
    const gate = {};
    gate.releaseAPromise = new Promise((resolve) => { gate.releaseA = resolve; });

    await runAttempt(scenario, {
      agentFactory: staleAuditRaceFactory(scenario.invocationLog, gate),
      onClient(client) { installStaleAuditRace(client, gate); },
    });

    const flowId = await flowIdFromActive(scenario);
    assert.equal((await auditFlow(scenario, flowId)).status, 'completed');
    // Item b's newer finish diff survived item a's stale snapshot: b merged and
    // ran exactly once (a global reconcile would have superseded b's diff, forcing
    // an ACCEPTED_ARTIFACTS_INCOMPLETE revise that re-runs the whole fanout).
    const rows = await invocations(scenario);
    assert.equal(countInvocation(rows, 'finish', 'a'), 1, 'item a ran once (no revise-driven re-run)');
    assert.equal(countInvocation(rows, 'finish', 'b'), 1, 'item b ran once (its diff was not superseded)');
    assert.equal(
      await readFile(join(scenario.workspace, 'items', 'b.txt'), 'utf8'),
      'seed:b\nfinish:b\n',
    );
    const journal = await readJournal(scenario);
    assert.equal(journal.issuances.filter((entry) => entry.state === 'merged').length, 2);
  });

  test('an ordinary-path fatal error drains in-flight consumers before propagating', async (t) => {
    const scenario = await setupScenario(t, 'mixed-fatal', CONSUMER_MIXED_READY_SPEC);
    const state = { sidestepAttempts: 0 };
    await assert.rejects(
      () => runAttempt(scenario, {
        agentFactory: mixedFatalAgentFactory(scenario.invocationLog, { fanDelayMs: 800, state }),
      }),
      /sidestep boom/,
    );
    // The fix drained the in-flight consumers before the ordinary error escaped:
    // both fan items are durably journaled (witness + final issuance), not
    // orphaned mid-flight. On the buggy code the error escapes immediately and
    // these issuances do not exist yet.
    const journal = await readJournal(scenario);
    const finals = journal.issuances.filter((entry) => entry.stage === 0);
    assert.equal(finals.length, 2, 'both in-flight consumer items were drained to a journaled issuance');
    assert.ok(finals.every((entry) => entry.diff), 'each drained item captured its cumulative diff');
    assert.equal(journal.witnesses.length, 2, 'each in-flight item journaled its pre-stage witness');

    // Resume: the ordinary step succeeds and the drained consumers are re-reported
    // from the journal, not re-executed.
    await runAttempt(scenario, {
      resumeFlowId: await flowIdFromActive(scenario),
      agentFactory: mixedFatalAgentFactory(scenario.invocationLog, { fanDelayMs: 0, state }),
    });
    assert.equal((await auditFlow(scenario, await flowIdFromActive(scenario))).status, 'completed');
    const rows = await invocations(scenario);
    assert.equal(countInvocation(rows, 'seed', 'a'), 1, 'drained item a is not re-executed on resume');
    assert.equal(countInvocation(rows, 'seed', 'b'), 1, 'drained item b is not re-executed on resume');
  });

  test('two managers on one journal do not lose each other\'s entries', async (t) => {
    const scenario = await setupScenario(t, 'one-writer');
    const opts = {
      runId: 'one-writer-run',
      targetCwd: scenario.workspace,
      artifactRoot: scenario.artifactRoot,
    };
    // Both instances load the SAME (empty) snapshot, then write different entries.
    // Without a reconciling write, the second write clobbers the first.
    const m1 = new ConsumerFanoutArtifacts(opts);
    const m2 = new ConsumerFanoutArtifacts(opts);
    m1.recordGateBinding({ gateStepId: 'gate_a', fanoutStepId: 'fan' });
    m2.recordGateBinding({ gateStepId: 'gate_b', fanoutStepId: 'fan' });

    const journalPath = await journalPathOf(scenario);
    const disk = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.deepEqual(disk.gateBinding, { gate_a: 'fan', gate_b: 'fan' });
  });

  test('a stale writer cannot revert a same-key rollback or resurrect a redacted diff', async (t) => {
    const scenario = await setupScenario(t, 'same-key-conflict');
    const opts = {
      runId: 'same-key-run',
      targetCwd: scenario.workspace,
      artifactRoot: scenario.artifactRoot,
    };
    // Seed a merged issuance + a complete transaction on disk (as if a merge had
    // applied), then hand both A and B that same pre-rollback snapshot.
    new ConsumerFanoutArtifacts(opts);
    const journalPath = await journalPathOf(scenario);
    const tree = currentWorkingTreeId(scenario.workspace);
    const seeded = JSON.parse(await readFile(journalPath, 'utf8'));
    seeded.revisionDigest = 'rev-x';
    seeded.specDigest = 'spec-x';
    seeded.issuances = [{
      dispatchToken: 'tok-a', scopedId: 'fan/0', fanoutStepId: 'fan', itemIndex: 0,
      generation: 1, stage: 0, attempt: 1, isolation: 'worktree',
      state: 'merged', mergedAt: '2026-01-01T00:00:00.000Z',
      diff: 'DIFF-PAYLOAD', hadCumulativeDiff: true, diffDigest: 'digest',
    }];
    seeded.mergeTransactions = [{
      gateStepId: 'merge', gateToken: 'gt-1', fanoutStepId: 'fan', state: 'complete',
      baselineTree: tree, witnessChain: [tree],
      orderedDiffs: [{ dispatchToken: 'tok-a', scopedId: 'fan/0', itemIndex: 0, generation: 1, digest: 'digest', diff: null }],
      recovery: { baselineRestores: 0 }, preparedAt: '2026-01-01T00:00:00.000Z',
    }];
    await writeFile(journalPath, `${JSON.stringify(seeded, null, 2)}\n`);

    const a = new ConsumerFanoutArtifacts(opts); // holds the merged pre-rollback snapshot
    const b = new ConsumerFanoutArtifacts(opts);
    // B rolls the merge back (merged -> accepted, mergedAt dropped), resolves a
    // revise, and redacts the diff payload.
    b.restoreMergeBaseline(b.journal.mergeTransactions[0], undefined);
    b.markGateResolved(b.journal.mergeTransactions[0], 'revise');
    b.cleanupWorktrees('rolled back');
    // A, still holding the pre-rollback snapshot, writes an UNRELATED mutation.
    a.recordGateBinding({ gateStepId: 'other-gate', fanoutStepId: 'fan' });

    const disk = JSON.parse(await readFile(journalPath, 'utf8'));
    const issuance = disk.issuances.find((entry) => entry.dispatchToken === 'tok-a');
    assert.equal(issuance.state, 'accepted', 'rollback survived — not reverted to merged');
    assert.equal(issuance.mergedAt, undefined, 'mergedAt was not resurrected');
    assert.equal(issuance.diff, null, 'redacted diff payload was not resurrected');
    const tx = disk.mergeTransactions.find((entry) => entry.gateToken === 'gt-1');
    assert.equal(tx.gateOutcome, 'revise', 'gate outcome preserved');
    assert.equal(disk.gateBinding?.['other-gate'], 'fan', 'A\'s own mutation still landed');
  });

  test('applyMerge stops rather than record a merge over a concurrently-decided round', async (t) => {
    const scenario = await setupScenario(t, 'apply-merge-decided');
    const opts = {
      runId: 'apply-decided-run',
      targetCwd: scenario.workspace,
      artifactRoot: scenario.artifactRoot,
    };
    const diff = await captureAddFileDiff(scenario.workspace, 'merge-target.txt', 'hello\n');

    // Seed one accepted worktree issuance, then let a real prepareMerge compute
    // the baseline + witness chain into a prepared transaction.
    new ConsumerFanoutArtifacts(opts);
    const journalPath = await journalPathOf(scenario);
    const seeded = JSON.parse(await readFile(journalPath, 'utf8'));
    seeded.revisionDigest = 'rev-x';
    seeded.specDigest = 'spec-x';
    seeded.issuances = [{
      dispatchToken: 'tok-x', scopedId: 'fan/0', fanoutStepId: 'fan', itemIndex: 0,
      generation: 1, stage: 0, attempt: 1, isolation: 'worktree',
      state: 'accepted', diff, hadCumulativeDiff: true, diffDigest: 'digest',
    }];
    await writeFile(journalPath, `${JSON.stringify(seeded, null, 2)}\n`);
    const audit = { steps: { fan: { fanout: { items: [{ status: 'succeeded', generation: 1, acceptedDispatchToken: 'tok-x' }] } } } };
    const prepared = new ConsumerFanoutArtifacts(opts)
      .prepareMerge({ gateStepId: 'merge', gateToken: 'gt-1', fanoutStepId: 'fan', audit });
    assert.equal(prepared.state, 'prepared');
    assert.equal(prepared.orderedDiffs.length, 1);

    // A applies the merge but pauses at the insideDiffApply seam.
    let signalPaused;
    const paused = new Promise((resolve) => { signalPaused = resolve; });
    let releaseA;
    const releasePromise = new Promise((resolve) => { releaseA = resolve; });
    const a = new ConsumerFanoutArtifacts({
      ...opts,
      hooks: { async insideDiffApply() { signalPaused(); await releasePromise; } },
    });
    let applyError = null;
    const applyPromise = a
      .applyMerge(a.journal.mergeTransactions.find((entry) => entry.gateToken === 'gt-1'))
      .catch((error) => { applyError = error; });

    await paused;
    // While A is paused mid-merge, B (a second manager on the same journal) rolls
    // the round back and resolves a revise.
    const b = new ConsumerFanoutArtifacts(opts);
    const bTx = b.journal.mergeTransactions.find((entry) => entry.gateToken === 'gt-1');
    b.restoreMergeBaseline(bTx, undefined);
    b.markGateResolved(bTx, 'revise');
    releaseA();
    await applyPromise;

    // A stopped instead of recording a merge, and B's decision survives intact.
    assert.ok(applyError, 'applyMerge stopped instead of completing');
    assert.equal(applyError.code, 'MERGE_TRANSACTION_DECIDED');
    // A must also NOT have mutated the target tree with the stale diff — the
    // pre-apply DECIDED check throws before `git apply` touches the working tree,
    // so no leftover partial merge is left for the gate rollback to clobber.
    await assert.rejects(
      readFile(join(scenario.workspace, 'merge-target.txt')),
      { code: 'ENOENT' },
      'A must not apply a stale diff to the tree over a decided round',
    );
    const disk = JSON.parse(await readFile(journalPath, 'utf8'));
    const issuance = disk.issuances.find((entry) => entry.dispatchToken === 'tok-x');
    assert.equal(issuance.state, 'accepted', 'issuance was not flipped to merged over the rollback');
    assert.equal(issuance.mergedAt, undefined);
    const tx = disk.mergeTransactions.find((entry) => entry.gateToken === 'gt-1');
    assert.equal(tx.gateOutcome, 'revise', 'gate outcome preserved');
    assert.equal(tx.state, 'rolled_back', 'rollback preserved');
  });

  test('artifact roots inside the merge target are rejected before journal creation', async (t) => {
    const scenario = await setupScenario(t, 'root-guard');
    const inTreeRoot = join(scenario.workspace, '.compose', 'consumer-artifacts');

    assert.throws(
      () => new ConsumerFanoutArtifacts({
        runId: 'in-tree-root-must-fail',
        targetCwd: scenario.workspace,
        artifactRoot: inTreeRoot,
      }),
      (error) => error?.code === 'ARTIFACT_ROOT_INSIDE_TARGET',
    );
    await assert.rejects(readFile(join(inTreeRoot, 'journal.json')), { code: 'ENOENT' });

    const symlinkRoot = join(scenario.evidenceRoot, 'external-looking-link');
    await symlink(join(scenario.workspace, '.compose'), symlinkRoot, 'dir');
    assert.throws(
      () => new ConsumerFanoutArtifacts({
        runId: 'symlinked-in-tree-root-must-fail',
        targetCwd: scenario.workspace,
        artifactRoot: join(symlinkRoot, 'consumer-artifacts'),
      }),
      (error) => error?.code === 'ARTIFACT_ROOT_INSIDE_TARGET',
    );
  });
});
