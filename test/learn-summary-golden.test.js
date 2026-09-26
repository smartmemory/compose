/**
 * STRAT-LEARN-INLINE-TS-1 §A5 / STRAT-LEARN-DELIVER-1 D6 — Compose build summary golden.
 *
 * Real Stratum (TS MCP bin, isolated state) and real builds driven to each exit. Lessons
 * are produced the real way: failing runs through the same MCP server, staged by the
 * engine's own INLINE pass (no command run). Only agent inference is stubbed.
 *
 * Needs a Stratum that has `learn list --unreviewed/--reviews`: point
 * COMPOSE_STRATUM_TS_MCP_BIN / COMPOSE_STRATUM_TS_CLI_BIN at it when the installed one predates it.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { runBuild } from '../lib/build.js';
import { lookupBuildCancel } from '../lib/build-cancel.js';
import { learnSummaryLines } from '../lib/learn-summary.js';
import { StratumMcpClient } from '../lib/stratum-mcp-client.js';
import { installAgentHarness } from './helpers/ts-agent-harness.js';
import { TS_MCP_BIN } from './helpers/stratum-test-bin.js';

const spec = (gated) => `
version: 1
contracts:
  Result:
    outcome: "complete|failed|skipped"
flows:
  entry: build
  build:
    max_rounds: 2
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: \${work.output}
      contract: Result
    steps:
      - id: work
        do: "build \${input.description}"
        out: Result
        attempts: 1
${gated ? `      - id: review
        after: [work]
        gate:
          on_approve: null
          on_revise: work
          on_kill: null
          max_rounds: 2
` : ''}`;

const INPUTS = { featureCode: 'LEARN-SUM', description: 'x', implementer_agent: 'claude', reviewer_agent: 'claude' };

// D7 Compose row "consumer fan-out item": the step-agnostic lesson (same contract, same
// root flow) reaches each consumer item's descriptor `do`, which Compose renders as `## Intent`.
const FANOUT_SPEC = `
version: 1
contracts:
  Batch:
    items: string[]
  Result:
    outcome: "complete|failed|skipped"
flows:
  entry: build
  build:
    max_rounds: 2
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
          concurrency: 1
          isolation: none
          require: all
          merge: sequential
          steps:
            - do: "item \${item}"
              out: Result
`;

const prompts = [];
function agent(output) {
  return () => ({
    async *run(prompt) {
      const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt) ?? String(prompt);
      prompts.push(text);
      const answer = text.includes('enumerate the consumer items') ? { items: ['a'] } : output;
      yield { type: 'assistant', content: JSON.stringify(answer) };
      yield { type: 'system', subtype: 'complete', agent: 'stub' };
    },
    interrupt() {},
    get isRunning() { return false; },
  });
}

function gateIO(line) {
  const input = new PassThrough();
  const output = new PassThrough();
  const script = [{ prompt: '\n> ', line }, { prompt: 'Rationale: ', line: 'stop' }];
  let next = 0;
  let rendered = '';
  output.on('data', (chunk) => {
    rendered += chunk.toString();
    if (script[next] && rendered.includes(script[next].prompt)) {
      const answer = script[next++].line;
      rendered = '';
      queueMicrotask(() => input.write(`${answer}\n`));
    }
  });
  return { input, output };
}

describe('Compose build summary shows lessons awaiting the owner', () => {
  let workspace;
  let stateRoot;
  let lessonRevision;
  const saved = {};

  const env = (key, value) => {
    if (!(key in saved)) saved[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };

  async function build(featureCode, {
    gated = false, output = { outcome: 'complete' }, gateLine, pipeline,
    agentFactory, configureClient, mode, template, visionWriter,
  } = {}) {
    await mkdir(join(workspace, 'docs', 'features', featureCode), { recursive: true });
    await writeFile(join(workspace, 'docs', 'features', featureCode, 'description.md'), `# ${featureCode}\n`);
    await writeFile(join(workspace, 'pipelines', `${template ?? 'build'}.stratum.yaml`), pipeline ?? spec(gated));
    await writeFile(join(workspace, '.compose', 'data', 'settings.json'), JSON.stringify({ policies: { review: 'gate' } }));
    // runBuild owns (and closes) the client it is given: one fresh connection per build.
    const client = await connected();
    await configureClient?.(client);
    installAgentHarness(client, agentFactory ?? agent(output), workspace);
    const lines = [];
    const log = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); log(...args); };
    let result, error;
    try {
      result = await runBuild(featureCode, {
        cwd: workspace, stratum: client, template: template ?? 'build', skipTriage: true, description: featureCode,
        ...(mode ? { mode } : {}),
        ...(visionWriter ? { visionWriter } : {}),
        ...(gateLine ? { gateOpts: gateIO(gateLine) } : {}),
      });
    } catch (err) {
      error = err;
    } finally {
      console.log = log;
      await client.close();
    }
    return { result, error, printed: lines.join('\n') };
  }

  async function connected() {
    const client = new StratumMcpClient();
    await client.connect({
      command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      args: [TS_MCP_BIN],
      env: { ...process.env },
    });
    return client;
  }

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'compose-learn-summary-'));
    stateRoot = await mkdtemp(join(tmpdir(), 'compose-learn-summary-state-'));
    // REQUIRED: consumer fan-out items run on Compose's local Claude path, which uses the
    // stub (stratum._localQuery) only under NODE_ENV=test — otherwise it spawns a REAL claude
    // (result-normalizer.js). Other fixtures set this themselves; so must this one.
    env('NODE_ENV', 'test');
    assert.equal(process.env.NODE_ENV, 'test', 'refusing to run: a real agent would be dispatched');
    env('STRATUM_STATE_ROOT', stateRoot);
    env('COMPOSE_PORT', process.env.COMPOSE_PORT ?? '65534');
    env('STRATUM_CONFIG_FILE', join(stateRoot, 'no-user-config.toml'));
    env('STRATUM_LEARN_INLINE', undefined);
    env('STRATUM_LEARN_DELIVER', undefined);
    await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
    await mkdir(join(workspace, 'pipelines'), { recursive: true });
    await writeFile(join(workspace, '.compose', 'compose.json'), JSON.stringify({ version: 2, capabilities: { stratum: true } }));
    await writeFile(join(workspace, 'stratum.toml'), '[learn]\ninline = true\n');
    // Three real failing runs through one server; its INLINE pass stages the lesson.
    // The pass is fire-and-forget inside the server, so the sidecar is polled below.
    const trainer = await connected();
    try {
      for (let i = 0; i < 3; i += 1) {
        const planned = await trainer.plan(spec(false), 'build', INPUTS, { workspaceRoot: workspace });
        await trainer.stepDone(planned.runId, 'work', { output: { outcome: 'done' } }, planned.ready[0].dispatchToken);
      }
      const sidecar = join(workspace, '.stratum', 'learn', 'candidates.jsonl');
      for (let waited = 0; !existsSync(sidecar) && waited < 10_000; waited += 50) await new Promise((r) => setTimeout(r, 50));
      const rows = readFileSync(sidecar, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      lessonRevision = rows.find((row) => row.rendered.guidance)?.revisionId;
      assert.ok(lessonRevision, 'the INLINE pass staged a guided lesson');
    } finally {
      await trainer.close();
    }
  });

  after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(workspace, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  });

  test('a completed build prints the unreviewed lesson', async () => {
    const { result, printed } = await build('LEARN-SUM-OK');
    assert.equal(result.status, 'complete');
    assert.match(printed, /Lessons to review \(\d+\):/);
    assert.ok(printed.includes(lessonRevision.slice(0, 12)), printed);
    assert.match(printed, /guidance: When `outcome` has a non-null value/);
  });

  test('a failed build prints it too', async () => {
    const { result, printed } = await build('LEARN-SUM-FAIL', { output: { wrong: true } });
    assert.equal(result.status, 'failed');
    assert.ok(printed.includes(lessonRevision.slice(0, 12)), printed);
  });

  test('a killed build prints it too', async () => {
    const { printed } = await build('LEARN-SUM-KILL', { gated: true, gateLine: 'k' });
    assert.match(printed, /Build killed\./);
    assert.ok(printed.includes(lessonRevision.slice(0, 12)), printed);
  });

  // C1: a build that throws before the terminal-status line still exits — the
  // summary prints from the catch, exactly once.
  test('a thrown build prints it too', async () => {
    const exploding = () => ({
      async *run() { yield { type: 'error', message: 'agent exploded' }; },
      interrupt() {},
      get isRunning() { return false; },
    });
    const { error, printed } = await build('LEARN-SUM-THROW', { agentFactory: exploding });
    assert.ok(error, 'a thrown dispatch rejects runBuild');
    assert.equal((printed.match(/Lessons to review/g) ?? []).length, 1, printed);
    assert.ok(printed.includes(lessonRevision.slice(0, 12)), printed);
  });

  test('a build-body failure prints the summary once before signal handlers are removed', async () => {
    const beforeBuild = process.listenerCount('SIGTERM');
    const summaryListenerCounts = [];
    const log = console.log;
    console.log = (...args) => {
      if (args.join(' ').includes('Lessons to review')) {
        summaryListenerCounts.push(process.listenerCount('SIGTERM'));
      }
      log(...args);
    };
    const exploding = () => ({
      async *run() { yield { type: 'error', message: 'agent exploded inside build body' }; },
      interrupt() {},
      get isRunning() { return false; },
    });
    try {
      const { error, printed } = await build('LEARN-SUM-THROW-SIGNALS', { agentFactory: exploding });
      assert.ok(error, 'a thrown dispatch rejects runBuild');
      assert.equal((printed.match(/Lessons to review/g) ?? []).length, 1, printed);
      assert.equal(summaryListenerCounts.length, 1, 'the summary log is called exactly once');
      assert.ok(summaryListenerCounts[0] > beforeBuild, 'the build SIGTERM handler is still installed when the summary logs');
    } finally {
      console.log = log;
    }
  });

  test('a setup-phase YAML failure prints the summary exactly once', async () => {
    const { error, printed } = await build('LEARN-SUM-SETUP', { pipeline: 'flows: [invalid' });
    assert.match(error?.message, /^This pipeline cannot run: .*\/pipelines\/build\.stratum\.yaml\n  spec is not parseable YAML:/, 'invalid pipeline YAML rejects during setup');
    assert.equal((printed.match(/Lessons to review/g) ?? []).length, 1, printed);
    assert.ok(printed.includes(lessonRevision.slice(0, 12)), printed);
  });

  test('cancelling pending summary queries is silent and returns promptly', async () => {
    const fakeCli = join(stateRoot, 'pending-summary.mjs');
    const marker = join(stateRoot, 'pending-summary');
    // Both queries announce that they are pending; without cancellation they would
    // return printable rows after 10 s (still below the production 20 s timeout).
    await writeFile(fakeCli, `
      import { writeFileSync } from 'node:fs';
      const reviews = process.argv.includes('--reviews');
      writeFileSync(${JSON.stringify(marker)} + (reviews ? '-reviews' : '-unreviewed'), 'ready');
      setTimeout(() => console.log(JSON.stringify(reviews
        ? [{ kind: 'retire-candidate', clusterId: 'pending', detail: 'pending review' }]
        : [{ revisionId: 'pending', claim: 'pending lesson' }])), 10000);
    `);
    const priorCli = process.env.COMPOSE_STRATUM_TS_CLI_BIN;
    let runId;
    let cancelledAt;
    const watcher = setInterval(() => {
      if (!cancelledAt && existsSync(marker + '-reviews') && existsSync(marker + '-unreviewed')) {
        const handle = lookupBuildCancel(runId);
        if (handle) {
          cancelledAt = Date.now();
          handle.cancel('cancel pending summary');
        }
      }
    }, 10);
    process.env.COMPOSE_STRATUM_TS_CLI_BIN = fakeCli;
    try {
      const { printed } = await build('LEARN-SUM-PENDING', {
        configureClient: (client) => {
          const realPlan = client.plan.bind(client);
          client.plan = async (...args) => {
            const planned = await realPlan(...args);
            runId = planned.runId;
            return planned;
          };
        },
      });
      assert.ok(cancelledAt, 'cancelled only after both summary queries started');
      assert.ok(Date.now() - cancelledAt < 3000, 'build drains within 3 s of cancellation');
      assert.doesNotMatch(printed, /Lessons to review|Lesson reviews|pending lesson|pending review/);
    } finally {
      clearInterval(watcher);
      if (priorCli === undefined) delete process.env.COMPOSE_STRATUM_TS_CLI_BIN;
      else process.env.COMPOSE_STRATUM_TS_CLI_BIN = priorCli;
    }
  });

  // C1: a throw AFTER the summary already printed must not print it a second
  // time. Bug mode reaches `visionWriter.updateItemStatus(itemId, 'complete')`
  // after the summary (build.js pendingCompletion, tracksFeatureJson:false) —
  // a writer that throws there lands in the same catch with the flag already set.
  test('a throw after the printed summary does not print it again', async () => {
    const { VisionWriter } = await import('../lib/vision-writer.js');
    const real = new VisionWriter(join(workspace, '.compose', 'data'));
    const sentinel = new Error('post-summary failure');
    const visionWriter = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'updateItemStatus') {
          return (id, status) => (status === 'complete' ? Promise.reject(sentinel) : target.updateItemStatus(id, status));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const bugSpec = `
version: 1
contracts:
  Result:
    outcome: "complete|failed|skipped"
flows:
  entry: fix
  fix:
    max_rounds: 2
    input:
      task: string
    output:
      from: \${work.output}
      contract: Result
    steps:
      - id: work
        do: "fix \${input.task}"
        out: Result
        attempts: 1
`;
    const { error, printed } = await build('LEARN-SUM-LATETHROW', {
      mode: 'bug', template: 'bug-fix', pipeline: bugSpec, visionWriter,
    });
    assert.equal(error, sentinel, 'runBuild rethrows the post-summary failure');
    assert.match(printed, /Build complete\./);
    assert.equal((printed.match(/Lessons to review/g) ?? []).length, 1, printed);
  });

  // C1: a cancelled build prints nothing — the same guard covers both exits.
  test('an aborted build prints nothing', async () => {
    let runId = null;
    const cancelling = () => ({
      async *run() {
        lookupBuildCancel(runId)?.cancel('test abort');
        throw new Error('cancelled mid-dispatch');
      },
      interrupt() {},
      get isRunning() { return false; },
    });
    const { result, error, printed } = await build('LEARN-SUM-ABORT', {
      agentFactory: cancelling,
      configureClient: (client) => {
        const realPlan = client.plan.bind(client);
        client.plan = async (...args) => {
          const planned = await realPlan(...args);
          runId = planned?.runId ?? runId;
          return planned;
        };
      },
    });
    assert.ok(error || result?.status === 'aborted', `expected an aborted build, got ${JSON.stringify(result)}`);
    assert.doesNotMatch(printed, /Lessons to review|Lesson reviews/);
  });

  // C2: an older stratum CLI ignores `--unreviewed` and lists raw PatchCandidate
  // rows — filtered here because raw rows carry `rendered` (and `clusterKey`),
  // which UnreviewedLesson rows never do.
  test('an old CLI listing raw PatchCandidate rows is filtered from the unreviewed list', async () => {
    const fakeCli = join(stateRoot, 'old-stratum-cli.mjs');
    await writeFile(fakeCli, `process.stdout.write(JSON.stringify([
      {
        clusterId: 'c-raw', clusterKey: 'k-raw', revisionId: 'rawrevision001',
        claim: 'RAW PATCH CANDIDATE', rendered: { content: 'x', guidance: 'g' },
      },
      {
        clusterId: 'c-lesson', revisionId: 'lessonrev00001',
        claim: 'a real unreviewed lesson', guidance: 'do the thing',
      },
    ]));\n`);
    const lines = await learnSummaryLines(workspace, {
      env: { ...process.env, COMPOSE_STRATUM_TS_CLI_BIN: fakeCli },
      warn: () => {},
    });
    const text = lines.join('\n');
    assert.match(text, /Lessons to review \(1\):/);
    assert.ok(text.includes('a real unreviewed lesson'), text);
    assert.ok(!text.includes('RAW PATCH CANDIDATE'), text);
  });

  test('with [learn] off for the workspace, a populated sidecar prints nothing', async () => {
    await writeFile(join(workspace, 'stratum.toml'), '[learn]\ninline = false\n');
    try {
      const { result, printed } = await build('LEARN-SUM-OFF');
      assert.equal(result.status, 'complete');
      assert.doesNotMatch(printed, /Lessons to review|Lesson reviews/);
    } finally {
      await writeFile(join(workspace, 'stratum.toml'), '[learn]\ninline = true\n');
    }
  });

  test('D6 reviews are printed once a delivered lesson has held', async () => {
    // Apply through the CLI Compose itself resolves, then deliver and hold once.
    const { execFileSync } = await import('node:child_process');
    const { resolveStratumBin } = await import('../lib/stratum-engine.js');
    execFileSync(process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
      [resolveStratumBin('cli', workspace), 'learn', 'apply', lessonRevision, '--root', workspace],
      { env: { ...process.env, STRATUM_LEARN_APPLY_ENABLED: '1' } });
    await writeFile(join(workspace, 'stratum.toml'), '[learn]\ninline = true\ndeliver = true\nretireReviewAfter = 1\n');
    try {
      prompts.length = 0;
      const { result, printed } = await build('LEARN-SUM-REVIEW');
      assert.equal(result.status, 'complete');
      // D7 Compose row "ordinary dispatch": the guidance rides stratum's `do` into `## Intent`.
      const ordinaryPrompt = prompts.find((prompt) => prompt.includes('## Intent')) ?? '';
      const intent = ordinaryPrompt.match(/## Intent\n([\s\S]*?)(?=\n## (?!Lessons from prior runs(?:\n|$))|$)/)?.[1] ?? '';
      assert.match(intent, /## Lessons from prior runs\n- When `outcome` has a non-null value/, intent);
      assert.match(printed, /Lesson reviews \(1\):\n {2}retire-candidate/);
      assert.doesNotMatch(printed, /Lessons to review/, 'an applied lesson is no longer unreviewed');

      // D7 Compose row "consumer fan-out item".
      prompts.length = 0;
      const fan = await build('LEARN-SUM-FANOUT', { pipeline: FANOUT_SPEC });
      assert.equal(fan.result.status, 'complete');
      const itemPrompt = prompts.find((prompt) => prompt.includes('item a'))
        ?? assert.fail(`no item prompt among ${prompts.length}: ${prompts.map((p) => p.slice(0, 160)).join(' | ')}`);
      assert.match(itemPrompt, /## Intent\nitem a\n\n## Lessons from prior runs\n- When `outcome` has a non-null value/, itemPrompt);

      // D7 Compose row "ambient-free re-render": build.js re-renders review prompts with
      // contextDir nulled (build.js requiredPrompt). This is only a renderer check:
      // this harness's work/fan steps do not enter build.js's isReviewMain branch,
      // so it does NOT cover the review branch's requiredPrompt re-render or handoff.
      // It checks only that explicitly passing the captured intent preserves the block.
      const { buildStepPrompt } = await import('../lib/step-prompt.js');
      const itemIntent = itemPrompt.match(/## Intent\n([\s\S]*?)(?=\n## (?!Lessons)|$)/)?.[1] ?? '';
      assert.match(itemIntent, /## Lessons from prior runs/);
      const reRendered = buildStepPrompt({ step_id: 'fan', intent: itemIntent, inputs: {}, output_fields: {}, ensure: [] },
        { cwd: workspace, featureCode: 'LEARN-SUM-FANOUT', contextDir: null });
      assert.ok(reRendered.includes(`## Intent\n${itemIntent}`), reRendered);
    } finally {
      await writeFile(join(workspace, 'stratum.toml'), '[learn]\ninline = true\n');
    }
  });
});
