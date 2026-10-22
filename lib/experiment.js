/**
 * experiment.js — Orchestrator for COMP-MODEL-AB sandboxed A/B experiments.
 *
 * Usage (programmatic):
 *   const { runExperiment } = await import('./experiment.js');
 *   await runExperiment('/path/to/spec.json');
 *
 * The build invocation is INJECTABLE via opts._runBuild so tests can pass a
 * fake runner that writes canned artifacts without spawning a real build.
 *
 *   // production default (spawns real compose build)
 *   runExperiment(specPath)
 *   // tests — zero real builds, zero LLM calls
 *   runExperiment(specPath, { _runBuild: fakeBuildRunner })
 *
 * SANDBOX ISOLATION CONTRACT (enforced, not assumed):
 *   - COMPOSE_TARGET=<sandbox-workspace> → build data dir is isolated.
 *   - COMPOSE_PORT=19997 (dead port) → VisionWriter falls back to direct file
 *     writes inside the sandbox; the live :4001 server is never contacted.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname }  from 'node:path';
import { spawn }                   from 'node:child_process';
import { fileURLToPath }           from 'node:url';
import { provision }               from './experiment-sandbox.js';
import { collect }                 from './experiment-metrics.js';
import { judge }                   from './experiment-judge.js';
import { validateAgentString }     from './agent-string.js';
import { aggregate, render }       from './experiment-report.js';
import { StratumMcpClient }        from './stratum-mcp-client.js';
import { resolveStratumMcpConnection } from './stratum-engine.js';
import {
  isArchetypeSpec, loadSpecArchetype, validateStageSpec, resolveCandidate,
  fixtureDigestOf, executeStageRun, refusal, checkBudget, stageRunKeyInputs, runKeyOf,
  canonicalJson, sha256Hex,
} from './experiment-stage.js';
import { createRunControl, runSlot, checkRerun } from './experiment-budget.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const COMPOSE_ROOT = resolve(__dirname, '..');
const COMPOSE_BIN  = join(COMPOSE_ROOT, 'bin', 'compose.js');

// Fixed feature code in every sandbox — each run uses its own isolated
// workspace so reusing the same code never causes collisions.
const FEATURE_CODE = 'EXP-FIXTURE';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate an experiment spec (fail-closed).
 * Throws on any structural error; returns a validated spec with defaults filled.
 *
 * Runner discriminator (stage-run-contract.json rules.runnerDiscriminator): a spec
 * with `fixture.archetype` is a stage spec and is validated against the archetype
 * the caller loaded (`options.archetype`, or `options.archetypeError` when loading
 * failed); refusals carry `err.code`. A spec without it takes the legacy path.
 *
 * @param {object} raw
 * @param {{ archetype?: object|null, archetypeError?: string|null }} [options]
 * @returns {object} validated spec
 */
export function validateSpec(raw, options = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Spec must be a JSON object');
  if (isArchetypeSpec(raw)) {
    return validateStageSpec(raw, { ...options, validateJudge: validateJudgeSpec });
  }

  const id = raw.id;
  if (typeof id !== 'string' || !id.trim()) throw new Error('spec.id must be a non-empty string');

  const fixture = raw.fixture;
  if (!fixture || typeof fixture !== 'object') throw new Error('spec.fixture must be an object');
  if (typeof fixture.goal !== 'string' || !fixture.goal.trim()) {
    throw new Error('spec.fixture.goal must be a non-empty string');
  }

  const configs = raw.configs;
  if (!Array.isArray(configs) || configs.length === 0) {
    throw new Error('spec.configs must be a non-empty array');
  }
  const labels = new Set();
  // Fix #5: detect post-sanitization runId collisions. Distinct labels like
  // "a/b" and "a?b" both sanitize to "a_b" and would overwrite each other's
  // workspace directory. Fail-closed at validation rather than silently clobber.
  const sanitizedToLabel = new Map();
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    if (typeof cfg.label !== 'string' || !cfg.label.trim()) {
      throw new Error(`spec.configs[${i}].label must be a non-empty string`);
    }
    if (labels.has(cfg.label)) throw new Error(`spec.configs: duplicate label "${cfg.label}"`);
    labels.add(cfg.label);
    const sanitized = cfg.label.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (sanitizedToLabel.has(sanitized)) {
      throw new Error(
        `spec.configs: labels "${sanitizedToLabel.get(sanitized)}" and "${cfg.label}" ` +
        `both sanitize to "${sanitized}" — rename one to avoid runId collision`
      );
    }
    sanitizedToLabel.set(sanitized, cfg.label);
    if (Object.hasOwn(cfg, 'candidate')) {
      throw refusal('CONFIG_SHAPE_MISMATCH',
        `spec.configs[${i}] ("${cfg.label}") is a build config and may not carry candidate`);
    }
    try { validateAgentString(cfg.implementer); } catch (err) {
      throw new Error(`spec.configs[${i}].implementer: ${err.message}`);
    }
    try { validateAgentString(cfg.reviewer); } catch (err) {
      throw new Error(`spec.configs[${i}].reviewer: ${err.message}`);
    }
  }

  const reps = raw.reps;
  if (!Number.isInteger(reps) || reps < 1) throw new Error('spec.reps must be an integer >= 1');

  const parallelism = raw.parallelism ?? 1;
  if (!Number.isInteger(parallelism) || parallelism < 1) {
    throw new Error('spec.parallelism must be an integer >= 1');
  }

  const buildTimeoutMs = raw.buildTimeoutMs ?? 1_800_000;
  if (!Number.isInteger(buildTimeoutMs) || buildTimeoutMs < 1) {
    throw new Error('spec.buildTimeoutMs must be a positive integer');
  }

  const judgeSpec = validateJudgeSpec(
    raw.judge ?? { enabled: false },
    configs.map(cfg => ({ label: cfg.label, agents: [cfg.implementer, cfg.reviewer] })),
  );

  // `budget` is optional on a legacy spec: without it the spec behaves exactly as before B1 (no checkpoint, no stop rule).
  if (raw.budget !== undefined) checkBudget(raw.budget);

  return {
    id,
    fixture: {
      goal:     fixture.goal,
      seedRepo: fixture.seedRepo ?? null,
      seedRef:  fixture.seedRef  ?? null,
    },
    configs,
    reps,
    parallelism,
    buildTimeoutMs,
    judge: judgeSpec,
    ...(raw.budget !== undefined ? { budget: { ...raw.budget } } : {}),
  };
}

/**
 * Validate spec.judge. `underTest` is [{ label, agents }] per config (bias guard).
 * @returns {object} the judge setting
 */
function validateJudgeSpec(judgeSpec, underTest) {
  if (!judgeSpec || typeof judgeSpec !== 'object' || typeof judgeSpec.enabled !== 'boolean') {
    throw new Error('spec.judge.enabled must be a boolean');
  }
  if (judgeSpec.enabled) {
    if (typeof judgeSpec.model !== 'string' || !judgeSpec.model.trim()) {
      throw new Error('spec.judge.model must be a non-empty string when judge.enabled=true');
    }
    try { validateAgentString(judgeSpec.model); } catch (err) {
      throw new Error(`spec.judge.model: ${err.message}`);
    }
    // Bias guard: warn (not fail) when judge model is a config under test
    for (const { label, agents } of underTest) {
      if (agents.includes(judgeSpec.model)) {
        process.stderr.write(
          `[experiment] WARN: judge model "${judgeSpec.model}" is used in config "${label}" ` +
          `— this may introduce score bias.\n`
        );
      }
    }
  }
  return judgeSpec;
}

// ---------------------------------------------------------------------------
// Matrix expansion
// ---------------------------------------------------------------------------

/**
 * Expand the run matrix (configs × reps) into an ordered list of run descriptors.
 * runId is stable: `${spec.id}_${config.label}_rep${rep}` with non-safe chars replaced.
 *
 * @param {object} spec  Validated spec
 * @returns {{ runId: string, config: object, rep: number }[]}
 */
export function expandMatrix(spec) {
  const runs = [];
  for (const config of spec.configs) {
    for (let rep = 1; rep <= spec.reps; rep++) {
      const raw   = `${spec.id}_${config.label}_rep${rep}`;
      const runId = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
      runs.push({ runId, config, rep });
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Sandbox scaffolding
// ---------------------------------------------------------------------------

/**
 * Set up a minimal compose project in the sandbox workspace so that
 * `compose build EXP-FIXTURE` can run inside it.
 *
 * @param {string} workspace  Sandbox workspace root
 * @param {string} goal       The fixture's natural-language goal
 */
export function _scaffoldSandboxProject(workspace, goal) {
  // Clear any pre-existing .compose/ from the workspace FIRST. A seeded-fixture
  // clone (fixture.seedRepo) may carry tracked .compose/data/* files that would:
  //   (a) appear in diff.patch/filesChanged because .gitignore only excludes
  //       UNTRACKED files — tracked ones still show in `git diff`.
  //   (b) cause collect() to read the SEED's stale build-history.jsonl and
  //       misreport this run's completed/cost/tests if the build exits before
  //       appending a fresh row.
  // rmSync with force:true is safe for greenfield: provision() creates an empty
  // .compose/data which we immediately re-create below.
  rmSync(join(workspace, '.compose'), { recursive: true, force: true });

  // Exclude Compose's own bookkeeping from git so it never contaminates the
  // diff measurement, judge input, or filesChanged/linesChanged metrics.
  // .compose/ holds build-history, build-stream, vision-state, active-build, etc.
  // — all Compose infrastructure, not product changes. Written before the
  // baseline commit so `git add -A` never stages any .compose/ file.
  //
  // Append-or-create: if the workspace already has a .gitignore (e.g. from a
  // seeded fixture clone), preserve its existing rules and only add .compose/ if
  // not already listed. Overwriting would silently delete node_modules/, dist/,
  // and similar rules, causing those artifact trees to appear in the diff and
  // pollute filesChanged/linesChanged/judge input.
  const gitignorePath = join(workspace, '.gitignore');
  let gitignoreContent = '';
  try { gitignoreContent = readFileSync(gitignorePath, 'utf-8'); } catch { /* new file */ }
  const existingLines = gitignoreContent.split('\n');
  if (!existingLines.includes('.compose/')) {
    const prefix = gitignoreContent && !gitignoreContent.endsWith('\n') ? '\n' : '';
    writeFileSync(gitignorePath, gitignoreContent + prefix + '.compose/\n');
  }

  // capabilities.lifecycle=false avoids MCP server dependency during headless runs.
  const composeDir = join(workspace, '.compose');
  mkdirSync(join(composeDir, 'data'), { recursive: true });
  writeFileSync(
    join(composeDir, 'compose.json'),
    JSON.stringify({
      version: 2,
      capabilities: { stratum: true, lifecycle: false, guard: false },
    }, null, 2) + '\n'
  );

  // Copy the real build pipeline into the sandbox so the experiment measures
  // the same pipeline that production uses.
  const pipelinesDir = join(workspace, 'pipelines');
  mkdirSync(pipelinesDir, { recursive: true });
  const srcPipeline = join(COMPOSE_ROOT, 'pipelines', 'build.stratum.yaml');
  if (existsSync(srcPipeline)) {
    copyFileSync(srcPipeline, join(pipelinesDir, 'build.stratum.yaml'));
  }

  // docs/features/EXP-FIXTURE/
  const featureDir = join(workspace, 'docs', 'features', FEATURE_CODE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'design.md'),
    `# ${FEATURE_CODE} — Experiment Fixture\n\n${goal}\n`);
  writeFileSync(join(featureDir, 'feature.json'),
    JSON.stringify({ code: FEATURE_CODE, description: goal, status: 'PLANNED' }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Real (default) headless build runner
// ---------------------------------------------------------------------------

/**
 * Spawn a headless `compose build` and await completion.
 *
 * This is the PRODUCTION default. Tests inject a fake via opts._runBuild so
 * no real LLM build is ever triggered during automated testing.
 *
 * @param {{ implementer: string, reviewer: string }} config
 * @param {NodeJS.ProcessEnv} sandboxEnv
 * @param {{ timeoutMs: number, cwd: string, featureCode: string }} opts
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, timedOut: boolean }>}
 */
export async function realHeadlessBuild(config, sandboxEnv, { timeoutMs, cwd, featureCode }) {
  return new Promise((resolve) => {
    const startMs = Date.now();  // track wall time so crashed/timed-out runs still get a duration (fix D)

    const args = [
      COMPOSE_BIN, 'build', featureCode, '--skip-triage',
      `--implementer=${config.implementer}`,
      `--reviewer=${config.reviewer}`,
    ];

    const child = spawn(process.execPath, args, { cwd, env: sandboxEnv, stdio: 'pipe' });
    const out = []; const err = [];
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        stdout:   Buffer.concat(out).toString('utf-8'),
        stderr:   Buffer.concat(err).toString('utf-8'),
        exitCode: code ?? 1,
        timedOut,
        wallMs:   Date.now() - startMs,
      });
    });
    child.on('error', err2 => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: err2.message, exitCode: 1, timedOut: false, wallMs: Date.now() - startMs });
    });
  });
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

function makeSemaphore(maxConcurrent) {
  let running = 0;
  const waiters = [];
  return {
    acquire() {
      if (running < maxConcurrent) { running++; return Promise.resolve(); }
      return new Promise(res => waiters.push(res));
    },
    release() {
      running--;
      if (waiters.length > 0) { running++; waiters.shift()(); }
    },
  };
}

// ---------------------------------------------------------------------------
// Single-run execution
// ---------------------------------------------------------------------------

/**
 * Execute one experiment run: provision → scaffold → build → collect → judge → write record.
 *
 * @param {{ runId: string, config: object, rep: number }} runDesc
 * @param {object}   spec
 * @param {string}   expRoot
 * @param {object|null} stratum
 * @param {Function} buildRunner  Injected build function (default: realHeadlessBuild)
 * @param {{ stamp?: Function, timeoutMs?: number }} [hooks]  B1: `stamp(record, {timedOut})` adds checkpoint/budget fields before the write; `timeoutMs` overrides buildTimeoutMs
 * @returns {Promise<object>}  Per-run record
 */
async function executeRun(runDesc, spec, expRoot, stratum, buildRunner, hooks = {}) {
  const { runId, config, rep } = runDesc;

  process.stderr.write(`[experiment] ${runId}: provisioning...\n`);
  const sandbox = await provision({
    fixture: spec.fixture, runId, expRoot, composePath: COMPOSE_ROOT,
  });

  _scaffoldSandboxProject(sandbox.workspace, spec.fixture.goal);

  // Fix #1: baseline commit — stage scaffolded files and commit so we have a
  // well-defined SHA to diff against after the build.  The real compose build
  // commits during its ship step, leaving `git diff HEAD` empty on success.
  // Diffing from this baseline captures all changes the build produced (whether
  // committed in-process by ship or left as working-tree changes on failure).
  // The --allow-empty flag handles the edge case where scaffoldSandboxProject
  // wrote no files (unlikely but safe).
  let baselineSha    = null;
  let baselineFailed = false;
  try {
    await new Promise((res, rej) => {
      const p = spawn('git', ['add', '-A'], { cwd: sandbox.workspace, stdio: 'pipe' });
      p.on('close', code => code === 0 ? res() : rej(new Error(`git add failed: ${code}`)));
      p.on('error', rej);
    });
    await new Promise((res, rej) => {
      const p = spawn('git', ['commit', '-q', '--allow-empty', '-m', 'baseline'],
        { cwd: sandbox.workspace, stdio: 'pipe' });
      p.on('close', code => code === 0 ? res() : rej(new Error(`baseline commit failed: ${code}`)));
      p.on('error', rej);
    });
    baselineSha = await new Promise((res, rej) => {
      const p = spawn('git', ['rev-parse', 'HEAD'], { cwd: sandbox.workspace, stdio: 'pipe' });
      const chunks = [];
      p.stdout.on('data', c => chunks.push(c));
      p.on('close', () => res(Buffer.concat(chunks).toString('utf-8').trim()));
      p.on('error', rej);
    });
  } catch {
    // Baseline commit failed (no git, bad config, etc.) — diff/stat will fall
    // back to `git diff HEAD` which may be wrong for in-process commits. Flag
    // the run as suspect so consumers know metrics may undercount changes (fix E).
    baselineFailed = true;
  }

  process.stderr.write(
    `[experiment] ${runId}: building (impl=${config.implementer}, rev=${config.reviewer})...\n`
  );
  const buildResult = await buildRunner(config, sandbox.env, {
    timeoutMs:   hooks.timeoutMs ?? spec.buildTimeoutMs,
    cwd:         sandbox.workspace,
    featureCode: FEATURE_CODE,
  });

  // Save build log
  const logPath  = join(sandbox.runDir, 'build.log');
  const diffPath = join(sandbox.runDir, 'diff.patch');
  writeFileSync(logPath, buildResult.stdout + '\n---STDERR---\n' + buildResult.stderr);

  // Capture diff against the baseline commit (not HEAD) so that changes
  // committed in-process by the real build's ship step appear in the patch.
  // `git add -A` stages any untracked files the build wrote (new source files,
  // docs) so they appear in the diff even if the build did not stage them.
  let diff = '';
  try {
    await new Promise((res, rej) => {
      const p = spawn('git', ['add', '-A'], { cwd: sandbox.workspace, stdio: 'pipe' });
      p.on('close', () => res()); p.on('error', rej);
    });
    const diffArgs = baselineSha ? ['diff', baselineSha] : ['diff', 'HEAD'];
    diff = await new Promise((res, rej) => {
      const p = spawn('git', diffArgs, { cwd: sandbox.workspace, stdio: 'pipe' });
      const chunks = [];
      p.stdout.on('data', c => chunks.push(c));
      p.on('close', () => res(Buffer.concat(chunks).toString('utf-8')));
      p.on('error', rej);
    });
  } catch { /* leave diff empty */ }
  writeFileSync(diffPath, diff);

  process.stderr.write(`[experiment] ${runId}: collecting metrics...\n`);
  const metrics = collect({ sandbox, buildResult, baselineSha });

  let judgeResult = null;
  if (spec.judge.enabled && stratum) {
    process.stderr.write(`[experiment] ${runId}: judging...\n`);
    judgeResult = await judge({
      diff, goal: spec.fixture.goal, judgeModel: spec.judge.model, stratum,
      cwd: sandbox.workspace,
    });
  }

  // Stamp endedAt into manifest
  const manifest = {
    composeSha: '', fixtureGoal: spec.fixture.goal,
    seedRef: spec.fixture.seedRef, startedAt: '', endedAt: new Date().toISOString(),
  };
  try {
    const m = JSON.parse(readFileSync(join(sandbox.runDir, 'manifest.json'), 'utf-8'));
    manifest.composeSha = m.composeSha ?? '';
    manifest.startedAt  = m.startedAt  ?? '';
    writeFileSync(
      join(sandbox.runDir, 'manifest.json'),
      JSON.stringify({ ...m, endedAt: manifest.endedAt }, null, 2) + '\n'
    );
  } catch { /* best-effort */ }

  const record = {
    runId, configLabel: config.label, rep, metrics, judge: judgeResult,
    artifacts: { diffPath, logPath }, manifest,
    // baselineFailed=true signals that the pre-build baseline commit failed so
    // diff.patch and filesChanged/linesChanged may undercount the build's changes.
    ...(baselineFailed ? { baselineFailed: true } : {}),
  };
  hooks.stamp?.(record, { timedOut: buildResult.timedOut === true, measured: true });
  writeFileSync(
    join(sandbox.runDir, `${runId}.json`),
    JSON.stringify(record, null, 2) + '\n'
  );
  process.stderr.write(`[experiment] ${runId}: done (completed=${metrics.outcome.completed})\n`);
  return record;
}

// ---------------------------------------------------------------------------
// Budget / checkpoint helpers (B1)
// ---------------------------------------------------------------------------

function hasChampion(champion) {
  if (typeof champion === 'string') return champion.length > 0;
  return Boolean(champion) && typeof champion === 'object' && Object.keys(champion).length > 0;
}

/** Digests a legacy (whole-build) runKey needs once per experiment. */
function legacyRunKeyContext(spec) {
  const pipelinePath = join(COMPOSE_ROOT, 'pipelines', 'build.stratum.yaml');
  return {
    pipelineDigest: existsSync(pipelinePath) ? sha256Hex(readFileSync(pipelinePath)) : null,
    fixtureDigest: sha256Hex(canonicalJson({
      goal: spec.fixture.goal, seedRepo: spec.fixture.seedRepo, seedRef: spec.fixture.seedRef,
    })),
  };
}

/** runKey inputs of a legacy build slot (an opt-in budgeted legacy spec): what a build's result depends on. */
function legacyRunKeyInputs({ config, rep }, ctx) {
  return {
    configLabel: config.label, implementer: config.implementer, reviewer: config.reviewer,
    pipelineDigest: ctx.pipelineDigest, profilesDigest: null,
    fixtureDigest: ctx.fixtureDigest, runner: 'legacy-build', rep,
  };
}

/**
 * Add runKey/runKeyInputs/budget to a legacy record. Only called for specs that carry a budget, so a legacy spec
 * without one keeps today's record shape byte for byte. A run with no measured tokens counts perRunTokenAssume.
 */
function stampLegacyRecord(record, { timedOut, measured, runKeyInputs, budget }) {
  const cost = record.metrics?.cost ?? {};
  const tokens = measured && Number.isFinite(cost.tokensIn) && Number.isFinite(cost.tokensOut)
    ? cost.tokensIn + cost.tokensOut : null;
  record.budget = {
    stoppedBy: timedOut ? 'timeout' : null,
    spentUsd: measured && Number.isFinite(cost.usd) ? cost.usd : null,
    spentTokens: tokens ?? budget.perRunTokenAssume,
  };
  record.runKey = runKeyOf(runKeyInputs);
  record.runKeyInputs = runKeyInputs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a full A/B experiment from a spec file.
 *
 * @param {string} specPath  Absolute path to the experiment spec JSON file.
 * @param {object} [opts={}]
 * @param {boolean}  [opts.pruneWorkspaces=false]  Remove sandbox workspaces after metrics.
 * @param {object}   [opts.stratum=null]            Connected stratum client (judge, stage runs).
 *   When absent and the spec needs one (stage archetype, or judge.enabled), the engine
 *   creates and connects its own client and closes it in `finally`. A passed client is
 *   never closed by the engine.
 * @param {string}   [opts.rerun]  B1 (budgeted specs only): `failed` (also reruns timeouts), `all`, or one runId.
 * @param {object}   [opts.registry]  Opt-in registry write `{registryPath, champion, ...}`; `champion` is required, and the write
 *   always gets the whole matrix (reused, new and skipped records), so no recorded attempt is omitted.
 * @param {Function} [opts._stratumFactory]  Test seam: `() => client` replacing `new StratumMcpClient()`.
 * @param {Function} [opts._loadArchetype]   Test seam: `(id) => archetype` replacing lib/archetypes loadArchetype.
 * @param {Function} [opts._runBuild]
 *   Override the build runner. Signature:
 *     `(config, sandboxEnv, { timeoutMs, cwd, featureCode }) → Promise<buildResult>`
 *   Default: `realHeadlessBuild` (spawns real compose build).
 *   In tests: pass a fake that writes canned artifacts to `cwd/.compose/` so the
 *   orchestrator is exercised end-to-end with NO real LLM calls.
 *
 * @returns {Promise<{ expRoot, resultsPath, reportPath, runs }>}
 */
export async function runExperiment(specPath, opts = {}) {
  const { pruneWorkspaces = false, _runBuild = realHeadlessBuild } = opts;

  let raw;
  try { raw = JSON.parse(readFileSync(specPath, 'utf-8')); }
  catch (err) { throw new Error(`Failed to load spec from ${specPath}: ${err.message}`); }
  // The archetype loader is imported only for stage specs (legacy specs never touch it).
  const loaded = isArchetypeSpec(raw) ? await loadSpecArchetype(raw, opts) : { archetype: null, error: null };
  const spec = validateSpec(raw, { archetype: loaded.archetype, archetypeError: loaded.error });
  const isStage = spec.runner === 'stage';

  // Resolve every candidate before any sandbox exists: a catalog failure refuses the
  // whole experiment instead of producing N error records.
  let stageCtx = null;
  if (isStage) {
    stageCtx = {
      archetype: loaded.archetype,
      candidates: new Map(spec.configs.map(cfg => [cfg.label, resolveCandidate(cfg.candidate)])),
      fixtureDigest: fixtureDigestOf(loaded.archetype),
      composeRoot: COMPOSE_ROOT,
    };
  }

  const expRoot = resolve(dirname(specPath), `${spec.id}-exp`);
  mkdirSync(join(expRoot, 'runs'), { recursive: true });

  const runDescs = expandMatrix(spec);
  process.stderr.write(
    `[experiment] ${spec.id}: ${runDescs.length} runs ` +
    `(${spec.configs.length} cfg × ${spec.reps} rep(s), parallelism=${spec.parallelism})\n`
  );

  const sem = makeSemaphore(spec.parallelism);

  // B1: one checkpoint + budget gate for every dispatch path. A legacy spec without `budget` has no gate and
  // dispatches every run exactly as before.
  const rerun = checkRerun(opts.rerun, runDescs);
  if (rerun && !spec.budget) {
    throw new Error('rerun needs a spec with a budget: a legacy spec without one re-runs every run anyway');
  }
  const ctl = spec.budget ? createRunControl({ spec, expRoot, rerun }) : null;
  // A registry write is a COMPLETE cell snapshot and always names the champion (registry-contract rules.snapshot).
  if (opts.registry && !hasChampion(opts.registry.champion)) {
    throw refusal('CHAMPION_REQUIRED', 'opts.registry must name the champion cell on every write (a cellKey, or {stage: cellKey})');
  }
  const legacyCtx = ctl && !isStage ? legacyRunKeyContext(spec) : null;

  const dispatchRun = async runDesc => {
    if (isStage) {
      const runKey = runKeyOf(stageRunKeyInputs(runDesc, stageCtx));
      const exec = () => executeStageRun(runDesc, spec, expRoot, stratum, stageCtx);
      return ctl ? runSlot(ctl, runDesc, runKey, exec) : exec();
    }
    const runKeyInputs = ctl ? legacyRunKeyInputs(runDesc, legacyCtx) : null;
    const hooks = ctl ? {
      timeoutMs: Math.min(spec.buildTimeoutMs, spec.budget.perRunTimeoutMs),
      stamp: (record, info) => stampLegacyRecord(record, { ...info, runKeyInputs, budget: spec.budget }),
    } : {};
    const exec = () => executeRun(runDesc, spec, expRoot, stratum, _runBuild, hooks)
      .catch(err => {
        process.stderr.write(`[experiment] ${runDesc.runId}: FAILED — ${err.message}\n`);
        const runDir = join(expRoot, 'runs', runDesc.runId);
        mkdirSync(runDir, { recursive: true });
        const record = {
          runId: runDesc.runId, configLabel: runDesc.config.label, rep: runDesc.rep,
          metrics: {
            cost:    { tokensIn: 0, tokensOut: 0, calls: 0, wallMs: 0, usd: null },
            outcome: { completed: false, health: null, testsPass: null, testsTotal: null,
                       filesChanged: 0, linesChanged: 0 },
            process: { reviewIters: 0, gateFailures: 0, retries: 0, escalations: 0 },
          },
          judge: null, artifacts: { diffPath: null, logPath: null },
          manifest: {
            composeSha: '', fixtureGoal: spec.fixture.goal, seedRef: spec.fixture.seedRef,
            startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
          },
          _error: err.message,
        };
        if (ctl) hooks.stamp(record, { timedOut: false, measured: false });
        writeFileSync(
          join(runDir, `${runDesc.runId}.json`),
          JSON.stringify(record, null, 2) + '\n'
        );
        return record;
      });
    return ctl ? runSlot(ctl, runDesc, runKeyOf(runKeyInputs), exec) : exec();
  };

  // Client lifecycle (F6): one connect and one close per runExperiment that needs a
  // client and was not handed one (pattern: gsd.js ownsStratum).
  const ownsStratum = !opts.stratum && (isStage || spec.judge.enabled);
  const stratum = opts.stratum ?? (ownsStratum ? (opts._stratumFactory ?? (() => new StratumMcpClient()))() : null);
  try {
    if (ownsStratum) await stratum.connect(resolveStratumMcpConnection(process.cwd()));

    // The budget check runs inside the semaphore, after the previous run's spend is known.
    const runs = await Promise.all(runDescs.map(async runDesc => {
      await sem.acquire();
      try { return await dispatchRun(runDesc); }
      finally { sem.release(); }
    }));

    if (pruneWorkspaces) {
      const { rmSync } = await import('node:fs');
      for (const rd of runDescs) {
        try {
          rmSync(join(expRoot, 'runs', rd.runId, 'workspace-tmp'), { recursive: true, force: true });
        } catch { /* best-effort */ }
      }
    }

    // `runs` is the whole matrix (reused, new and budget-skipped), so a registry write sees every attempt of every cell.
    const results     = aggregate(runs, spec.id, opts.registry ? { registry: opts.registry } : {});
    const resultsPath = join(expRoot, 'results.json');
    writeFileSync(resultsPath, JSON.stringify(results, null, 2) + '\n');

    const reportMd   = render(results);
    const reportPath = join(expRoot, 'report.md');
    writeFileSync(reportPath, reportMd);

    process.stderr.write(`[experiment] ${spec.id}: complete → ${resultsPath}\n`);
    return { expRoot, resultsPath, reportPath, runs };
  } finally {
    if (ownsStratum) await stratum.close();
  }
}
