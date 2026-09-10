/**
 * fake-codex-project.js — a real `codex` on PATH that never calls a model.
 *
 * Shared by the S06 signal-teardown child-process case and the S07 goldens
 * (blueprint §9 Tests, §10). `resolveCodexCommand` prefers a PATH `codex` over
 * the bundled SDK CLI (`stratum/ts/src/connectors/codex.ts:565-568`) and the
 * connector reads the server's own env, so putting an executable named `codex`
 * first on the PATH handed to `connect({ env })` gives a genuine detached
 * process group to cancel — with no model call, no network and no cost.
 *
 * The fake speaks the codex `exec --json` JSONL protocol on stdout: the
 * connector only reads `item.completed`/`agent_message` and `turn.completed`
 * (`codex.ts:318-328`).
 *
 * Lane behaviour is keyed off the prompt, because a fanout's lanes differ only
 * by their prompt: a lane whose `match` substring appears in the prompt runs
 * that lane's script. A lane with `sleep: true` never exits, which is what a
 * cancel has to kill.
 */

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_CODEX = `#!/usr/bin/env node
// A fake \`codex\`. Reads the prompt on stdin (the real CLI is invoked with \`-\`),
// records its pid, then behaves per the lane whose \`match\` the prompt contains.
const { appendFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

const behavior = JSON.parse(process.env.COMPOSE_FAKE_CODEX_BEHAVIOR ?? '{}');
const pidsFile = process.env.COMPOSE_FAKE_CODEX_PIDS;

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => { run(); });
process.stdin.on('error', () => { run(); });

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

function run() {
  const lanes = Array.isArray(behavior.lanes) ? behavior.lanes : [];
  const lane = lanes.find((entry) => entry.match && prompt.includes(entry.match))
    ?? lanes.find((entry) => !entry.match)
    ?? { sleep: true };
  if (pidsFile) {
    try {
      mkdirSync(dirname(pidsFile), { recursive: true });
      appendFileSync(pidsFile, JSON.stringify({ pid: process.pid, lane: lane.name ?? null, cwd: process.cwd() }) + '\\n');
    } catch { /* best-effort */ }
  }
  if (lane.marker) {
    try {
      mkdirSync(dirname(lane.marker), { recursive: true });
      writeFileSync(lane.marker, lane.markerBody ?? 'lane\\n');
    } catch { /* best-effort */ }
  }
  if (lane.sleep) {
    // Never settle. Only a signal to this process group ends it.
    setInterval(() => {}, 1 << 30);
    return;
  }
  emit({ type: 'item.completed', item: { type: 'agent_message', text: lane.text ?? '{"value":"done"}' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  // Live at least as long as the server's libproc start-time probe (~40ms on darwin).
  // stratum 0.5.0 registers a tagged agent in onSpawn and fails the whole run with
  // REGISTRY_WRITE_FAILED ("agent would be uncancellable") when the pid is already
  // gone by the time the probe returns — a fixture that exits the instant stdin
  // closes trips it deterministically; no real agent exits that fast. Stratum
  // follow-up: an agent that exited before registration is finished, not uncancellable.
  setTimeout(() => process.exit(0), 150);
}
`;

/**
 * Build a tmp compose project whose agents are all `codex`, with a fake `codex`
 * first on the PATH of the env it returns.
 *
 * @param {object} options
 * @param {string} options.featureCode
 * @param {string} options.spec            the `pipelines/<template>.stratum.yaml` body
 * @param {string} [options.template]      pipeline file basename (default 'build')
 * @param {Array<{name?:string,match?:string,sleep?:boolean,marker?:string,markerBody?:string,text?:string}>} [options.lanes]
 * @param {string} [options.description]
 * @param {boolean} [options.git] initialize a disposable HEAD for real worktree capture
 */
export async function makeFakeCodexProject({
  featureCode,
  spec,
  template = 'build',
  lanes = [{ sleep: true }],
  description = '# fake codex fixture\n',
  git = false,
}) {
  const workspace = await mkdtemp(join(tmpdir(), 'compose-fakecodex-ws-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'compose-fakecodex-state-'));
  const binDir = await mkdtemp(join(tmpdir(), 'compose-fakecodex-bin-'));

  await mkdir(join(workspace, '.compose', 'data'), { recursive: true });
  await mkdir(join(workspace, 'pipelines'), { recursive: true });
  await mkdir(join(workspace, 'docs', 'features', featureCode), { recursive: true });
  await writeFile(
    join(workspace, '.compose', 'compose.json'),
    JSON.stringify({ version: 2, capabilities: { stratum: true } }, null, 2),
  );
  await writeFile(join(workspace, 'pipelines', `${template}.stratum.yaml`), spec);
  await writeFile(join(workspace, 'docs', 'features', featureCode, 'description.md'), description);

  if (git) {
    await writeFile(join(workspace, '.gitignore'), '.compose/data/\n.compose/build-stream.jsonl\ndocs/features/*/audit.json\n');
    const runGit = (args) => execFileSync('git', args, {
      cwd: workspace, encoding: 'utf8', stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'S07 Fixture', GIT_AUTHOR_EMAIL: 's07@example.test',
        GIT_COMMITTER_NAME: 'S07 Fixture', GIT_COMMITTER_EMAIL: 's07@example.test' },
    }).trim();
    runGit(['init', '-q']);
    runGit(['add', '-A']);
    // Only the disposable fixture needs a HEAD for real detached worktrees.
    const tree = runGit(['write-tree']);
    const commit = runGit(['commit-tree', tree, '-m', 'fake codex fixture']);
    runGit(['update-ref', 'HEAD', commit]);
  }

  const codexPath = join(binDir, 'codex');
  await writeFile(codexPath, FAKE_CODEX);
  await chmod(codexPath, 0o755);

  const pidsFile = join(binDir, 'agent-pids.jsonl');
  const fgRoot = join(stateRoot, 'fg');
  await mkdir(fgRoot, { recursive: true });

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    STRATUM_STATE_ROOT: stateRoot,
    STRATUM_AGENT_FG_ROOT: fgRoot,
    COMPOSE_FAKE_CODEX_PIDS: pidsFile,
    COMPOSE_FAKE_CODEX_BEHAVIOR: JSON.stringify({ lanes }),
  };
  delete env.COMPOSE_BUILD_ID;

  return {
    workspace,
    stateRoot,
    fgRoot,
    binDir,
    codexPath,
    pidsFile,
    env,
    /** Every fake-codex process that has started, in start order. */
    async readAgentPids() {
      if (!existsSync(pidsFile)) return [];
      const raw = await readFile(pidsFile, 'utf8');
      return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    async readForegroundEntries() {
      const entries = [];
      for (const name of await readdir(fgRoot)) {
        try { entries.push(JSON.parse(await readFile(join(fgRoot, name, 'meta.json'), 'utf8'))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return entries;
    },
    async cleanup() {
      for (const entry of await this.readAgentPids()) {
        try { process.kill(-entry.pid, 'SIGKILL'); } catch { /* already gone */ }
        try { process.kill(entry.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    },
  };
}

/** Bounded receipt polling; failures include the caller's live child diagnostics. */
export async function waitForReceipt(read, description, { timeout = 30000, diagnostics = () => '' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}\n${diagnostics()}`);
}

/** Purpose-written S07 dialect fixture; never depends on a shipped preset. */
export const CANCEL_FANOUT_SPEC = `version: 1
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
        agent: codex
        do: S07_ENUMERATE
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
            - agent: codex
              do: "execute \${item}"
              out: Result
      - id: merge
        after: [fan]
        gate:
          on_approve: null
          on_revise: fan
          on_kill: null
`;

/** True when no process in `pid`'s group is reachable. EPERM on a GROUP probe means
 *  unreachable, not alive (reference_pid_vs_pgid_eperm). */
export function processGroupGone(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch {
    return true;
  }
}
