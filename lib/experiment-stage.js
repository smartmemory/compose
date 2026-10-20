/**
 * experiment-stage.js — stage-run mode of the experiment engine (COMP-STAGE-GRADING-2).
 *
 * A spec whose `fixture.archetype` is set runs every config as ONE agentRun graded
 * by the archetype's oracle, instead of a whole `compose build`. Shapes are fixed by
 * docs/features/COMP-MODEL-AB-DECISION/stage-run-contract.json (spec, record, refusals,
 * cost rule, runKey) and archetype-contract.json (descriptor and method table).
 *
 * Per run: provision sandbox → archetype.buildInput → baseline commit → ONE
 * stratum.agentRun → diff → archetype.oracle / canary / mechanismEngaged → record.
 *
 * Cost is the sum of this sandbox's dispatch-ledger rows with site "experiment-stage"
 * that appeared during the run (the client writes them to telemetry.project_cwd,
 * which is the workspace). The agentRun return value is never read for cost. Unknown
 * usage stays null: a missing receipt is never a 0.
 *
 * The loaded archetype (G3 owns lib/archetypes/index.js) is the descriptor
 * {id, stage, runner, judged, version} plus the five methods, plus the data this
 * runner consumes:
 *   scenario     passed to buildInput(workspace, scenario) and prompt(scenario)
 *   hiddenPath   absolute path OUTSIDE the workspace, passed as oracle's `hidden`
 *   fixture | fixturePath   the parsed fixture file (or its path), hashed into fixtureDigest
 *   oracleName   optional; recorded as metrics.stage.oracle (defaults to the id)
 */

import { createHash }                                  from 'node:crypto';
import { execFileSync }                                from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute }         from 'node:path';
import { provision }                                   from './experiment-sandbox.js';
import { parseAgentString, resolveAgentConfig, validateAgentString } from './agent-string.js';
import { getModelCatalog }                             from './model-catalog.js';
import { readEvents }                                  from './dispatch-ledger.js';

export const STAGE_SITE = 'experiment-stage';
const ARCHETYPE_METHODS = ['buildInput', 'prompt', 'oracle', 'canary', 'mechanismEngaged'];
const STAGE_SPEC_KEYS   = new Set(['id', 'fixture', 'configs', 'reps', 'parallelism', 'judge', 'budget']);
const FIXTURE_KEYS      = new Set(['archetype', 'goal', 'seedRepo', 'seedRef']);
const BUDGET_KEYS       = ['maxRuns', 'perRunTimeoutMs', 'maxUsdTotal', 'maxTokensTotal', 'perRunTokenAssume'];
// Stage specs have no workflow until D1 adds one; recorded so the runKey is honest about it.
const NO_WORKFLOW = 'none';

/** A named refusal (stage-run-contract.json rules.refusals). */
export function refusal(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** True when the raw spec selects the archetype discriminator (case b/c). */
export function isArchetypeSpec(raw) {
  return Boolean(raw && typeof raw === 'object' && raw.fixture && typeof raw.fixture === 'object'
    && Object.hasOwn(raw.fixture, 'archetype'));
}

/** contract rules.canonicalJson: keys sorted at every depth, arrays keep order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Load the archetype named by a stage spec. Never throws: a failure is returned as
 * `error` so validateSpec can refuse it by name (ARCHETYPE_UNKNOWN).
 */
export async function loadSpecArchetype(raw, opts = {}) {
  const id = raw.fixture.archetype;
  if (typeof id !== 'string' || !id.trim()) return { archetype: null, error: 'fixture.archetype must be a non-empty string' };
  let load;
  try {
    load = opts._loadArchetype ?? (await import('./archetypes/index.js')).loadArchetype;
  } catch (err) {
    return { archetype: null, error: `archetype loader unavailable: ${err.message}` };
  }
  try {
    const archetype = await load(id);
    return archetype ? { archetype, error: null } : { archetype: null, error: `unknown archetype "${id}"` };
  } catch (err) {
    return { archetype: null, error: err.message };
  }
}

function checkArchetype(archetype, id, loadError) {
  if (!archetype) throw refusal('ARCHETYPE_UNKNOWN', loadError ?? `unknown archetype "${id}"`);
  if (archetype.id !== id) throw refusal('ARCHETYPE_UNKNOWN', `loader returned "${archetype.id}" for "${id}"`);
  if (archetype.runner === 'build') {
    throw refusal('ARCHETYPE_RUNNER_UNSUPPORTED', `archetype "${id}" has runner "build"; whole-build archetypes are not supported yet`);
  }
  const bad = [];
  if (archetype.runner !== 'stage') bad.push('runner');
  if (typeof archetype.judged !== 'boolean') bad.push('judged');
  if (typeof archetype.version !== 'string' || !archetype.version) bad.push('version');
  for (const m of ARCHETYPE_METHODS) if (typeof archetype[m] !== 'function') bad.push(m);
  if (!archetype.fixture && typeof archetype.fixturePath !== 'string') bad.push('fixture|fixturePath');
  if (bad.length) throw refusal('ARCHETYPE_UNKNOWN', `archetype "${id}" does not implement the contract: ${bad.join(', ')}`);
}

function checkLabels(configs) {
  const labels = new Set();
  const sanitizedToLabel = new Map();
  configs.forEach((cfg, i) => {
    if (!cfg || typeof cfg !== 'object') throw new Error(`spec.configs[${i}] must be an object`);
    if (typeof cfg.label !== 'string' || !cfg.label.trim()) {
      throw new Error(`spec.configs[${i}].label must be a non-empty string`);
    }
    if (labels.has(cfg.label)) throw new Error(`spec.configs: duplicate label "${cfg.label}"`);
    labels.add(cfg.label);
    const sanitized = cfg.label.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (sanitizedToLabel.has(sanitized)) {
      throw new Error(`spec.configs: labels "${sanitizedToLabel.get(sanitized)}" and "${cfg.label}" ` +
        `both sanitize to "${sanitized}" — rename one to avoid runId collision`);
    }
    sanitizedToLabel.set(sanitized, cfg.label);
  });
}

function checkBudget(budget) {
  if (!budget || typeof budget !== 'object') throw refusal('BUDGET_REQUIRED', 'an archetype spec needs a budget');
  const extra = Object.keys(budget).filter(k => !BUDGET_KEYS.includes(k));
  const posInt = v => Number.isInteger(v) && v >= 1;
  const bad = [
    ...extra,
    ...['maxRuns', 'perRunTimeoutMs', 'maxTokensTotal', 'perRunTokenAssume'].filter(k => !posInt(budget[k])),
    ...(budget.maxUsdTotal === null || (typeof budget.maxUsdTotal === 'number' && budget.maxUsdTotal > 0) ? [] : ['maxUsdTotal']),
  ];
  if (bad.length) throw refusal('BUDGET_REQUIRED', `spec.budget is malformed: ${bad.join(', ')}`);
}

/**
 * validateSpec for case (b) (stage-run-contract.json rules.runnerDiscriminator).
 * Called by experiment.js validateSpec when fixture.archetype is present.
 */
export function validateStageSpec(raw, { archetype = null, archetypeError = null, validateJudge } = {}) {
  const id = raw.id;
  if (typeof id !== 'string' || !id.trim()) throw new Error('spec.id must be a non-empty string');
  const fixture = raw.fixture;
  checkArchetype(archetype, fixture.archetype, archetypeError);

  const extraFixture = Object.keys(fixture).filter(k => !FIXTURE_KEYS.has(k));
  if (extraFixture.length) throw new Error(`spec.fixture: unknown key(s) for an archetype spec: ${extraFixture.join(', ')}`);
  const extraSpec = Object.keys(raw).filter(k => !STAGE_SPEC_KEYS.has(k));
  if (extraSpec.length) {
    throw new Error(`spec: unknown key(s) for an archetype spec: ${extraSpec.join(', ')} (per-run time is budget.perRunTimeoutMs)`);
  }

  const configs = raw.configs;
  if (!Array.isArray(configs) || configs.length === 0) throw new Error('spec.configs must be a non-empty array');
  checkLabels(configs);
  configs.forEach((cfg, i) => {
    const extra = Object.keys(cfg).filter(k => k !== 'label' && k !== 'candidate');
    if (extra.length) {
      throw refusal('CONFIG_SHAPE_MISMATCH',
        `spec.configs[${i}] ("${cfg.label}") is a stage config and may not carry ${extra.join(', ')}`);
    }
    if (!Object.hasOwn(cfg, 'candidate')) {
      throw refusal('CONFIG_SHAPE_MISMATCH', `spec.configs[${i}] ("${cfg.label}") has no candidate`);
    }
    try { validateAgentString(cfg.candidate); } catch (err) {
      throw new Error(`spec.configs[${i}].candidate: ${err.message}`);
    }
    if (typeof cfg.candidate !== 'string' || !/^(claude|codex|devin)(:[a-z0-9-]*){0,2}$/.test(cfg.candidate)) {
      throw new Error(`spec.configs[${i}].candidate must be provider[:template[:tier]]`);
    }
    if (archetype.judged && parseAgentString(cfg.candidate).provider !== 'claude') {
      throw refusal('JUDGED_STAGE_CLAUDE_ONLY',
        `archetype "${archetype.id}" is judged; candidate "${cfg.candidate}" (config "${cfg.label}") must be claude`);
    }
  });

  if (!Number.isInteger(raw.reps) || raw.reps < 1) throw new Error('spec.reps must be an integer >= 1');
  if (!Number.isInteger(raw.parallelism) || raw.parallelism < 1) {
    throw new Error('spec.parallelism must be an integer >= 1');
  }
  checkBudget(raw.budget);
  const judge = validateJudge(raw.judge ?? { enabled: false },
    configs.map(c => ({ label: c.label, agents: [c.candidate] })));

  return {
    id,
    runner: 'stage',
    fixture: {
      archetype: fixture.archetype,
      goal:      fixture.goal ?? '',
      seedRepo:  fixture.seedRepo ?? null,
      seedRef:   fixture.seedRef ?? null,
    },
    configs,
    reps: raw.reps,
    parallelism: raw.parallelism,
    budget: { ...raw.budget },
    judge,
  };
}

/**
 * candidateResolved (contract $defs.candidateResolved): resolveAgentConfig plus the
 * catalog digest. A tier with no thinking config resolves to effort null, recorded as
 * "unavailable"; a bare provider resolves to the catalog's default model.
 */
export function resolveCandidate(agentStr, { catalog = getModelCatalog } = {}) {
  const payload = catalog();
  const cfg = resolveAgentConfig(agentStr);
  // Only a bare provider takes the catalog default; a named tier the catalog marks
  // unavailable is refused rather than silently swapped for another model.
  const modelID = cfg.modelID ?? (cfg.tier ? null : payload.catalog[cfg.provider]?.default?.model ?? null);
  if (!modelID) throw new Error(`candidate "${agentStr}" resolves to no model in the catalog`);
  return {
    resolved: { provider: cfg.provider, modelID, effort: cfg.effort ?? 'unavailable', catalogDigest: payload.catalogDigest },
    dispatchEffort: cfg.effort ?? undefined,
  };
}

/** The archetype's fixture file content, hashed per contract rules.digests.fixtureDigest. */
export function fixtureDigestOf(archetype) {
  const parsed = archetype.fixture ?? JSON.parse(readFileSync(archetype.fixturePath, 'utf-8'));
  return sha256Hex(canonicalJson(parsed));
}

/**
 * metrics.cost from the sandbox ledger (contract rules.cost). `known` excludes rows
 * that were already there before the run. Any null in a summed field makes the sum
 * null; no rows at all means nothing was measured, so every sum is null.
 */
export function costFromLedger(workspace, known = new Set()) {
  const rows = readEvents(workspace, { kind: 'dispatch' })
    .filter(r => r.site === STAGE_SITE && !known.has(r.dispatch_id));
  const sum = (field, round) => {
    if (!rows.length || !rows.every(r => Number.isFinite(r[field]))) return null;
    const total = rows.reduce((acc, r) => acc + r[field], 0);
    return round ? Math.round(total) : total;
  };
  return {
    rows,
    tokensIn:    sum('tokens_in', true),
    tokensOut:   sum('tokens_out', true),
    tokensTotal: sum('tokens_total', true),
    usd:         sum('usd', false),
  };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** Compose bookkeeping (the dispatch ledger) lives in .compose/ and must never enter the diff. */
function prepareWorkspace(workspace) {
  rmSync(join(workspace, '.compose'), { recursive: true, force: true });
  mkdirSync(join(workspace, '.compose', 'data'), { recursive: true });
  const gitignorePath = join(workspace, '.gitignore');
  let content = '';
  try { content = readFileSync(gitignorePath, 'utf-8'); } catch { /* new file */ }
  if (!content.split('\n').includes('.compose/')) {
    writeFileSync(gitignorePath, content + (content && !content.endsWith('\n') ? '\n' : '') + '.compose/\n');
  }
}

function diffStats(numstat) {
  let filesChanged = 0;
  let linesChanged = 0;
  for (const line of numstat.split('\n')) {
    const [add, del] = line.split('\t');
    if (add === undefined || del === undefined) continue;
    filesChanged++;
    linesChanged += (Number(add) || 0) + (Number(del) || 0);
  }
  return { filesChanged, linesChanged };
}

function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function readManifest(runDir) {
  try { return JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf-8')); } catch { return null; }
}

/**
 * Execute one stage run. Never throws: a failure becomes a kept record with `_error`
 * and an oracle that did not run (accuracy null).
 *
 * @param {{runId: string, config: object, rep: number}} runDesc
 * @param {object} spec        validated stage spec
 * @param {string} expRoot
 * @param {object} stratum     connected client with agentRun
 * @param {object} ctx         { archetype, candidates: Map<label,{resolved,dispatchEffort}>, fixtureDigest, composeRoot }
 */
export async function executeStageRun(runDesc, spec, expRoot, stratum, ctx) {
  const { runId, config, rep } = runDesc;
  const { archetype, fixtureDigest, composeRoot } = ctx;
  const { resolved, dispatchEffort } = ctx.candidates.get(config.label);
  const startedAt = new Date().toISOString();
  let runDir = join(expRoot, 'runs', runId);
  const artifacts = {
    outputPath: join(runDir, 'output.md'), transcriptPath: null,
    diffPath: join(runDir, 'diff.patch'), logPath: join(runDir, 'run.log'),
  };
  const log = [];
  const note = line => { log.push(`[${new Date().toISOString()}] ${line}`); };

  let workspace = null;
  let known = new Set();
  let agentError = null;
  let timedOut = false;
  let wallMs = 0;
  let completed = false;
  let diffNumbers = { filesChanged: 0, linesChanged: 0 };
  let stage = null;
  let runError = null;

  try {
    process.stderr.write(`[experiment] ${runId}: provisioning (stage ${archetype.id})...\n`);
    const sandbox = await provision({
      fixture: { goal: spec.fixture.goal, seedRepo: spec.fixture.seedRepo, seedRef: spec.fixture.seedRef },
      runId, expRoot, composePath: composeRoot,
    });
    workspace = sandbox.workspace;
    runDir = sandbox.runDir;
    prepareWorkspace(workspace);
    if (archetype.hiddenPath && isInside(archetype.hiddenPath, workspace)) {
      throw new Error(`hidden material ${archetype.hiddenPath} is inside the workspace`);
    }

    await archetype.buildInput(workspace, archetype.scenario ?? null);
    git(workspace, ['add', '-A']);
    git(workspace, ['commit', '-q', '--allow-empty', '-m', 'baseline']);
    const baselineSha = git(workspace, ['rev-parse', 'HEAD']).trim();
    note(`baseline ${baselineSha}`);

    known = new Set(readEvents(workspace, { kind: 'dispatch' }).map(r => r.dispatch_id));
    const prompt = await archetype.prompt(archetype.scenario ?? null);
    const signal = AbortSignal.timeout(spec.budget.perRunTimeoutMs);
    const agentOpts = {
      modelID: resolved.modelID,
      ...(dispatchEffort !== undefined ? { effort: dispatchEffort } : {}),
      cwd: workspace,
      telemetry: { site: STAGE_SITE, project_cwd: workspace },
      ...(resolved.provider === 'codex' ? { sandboxMode: 'workspace-write' } : {}),
      signal,
    };

    process.stderr.write(`[experiment] ${runId}: agentRun (${config.candidate} -> ${resolved.modelID})...\n`);
    note(`agentRun ${resolved.provider} ${resolved.modelID} effort=${resolved.effort}`);
    const t0 = Date.now();
    let result = null;
    try {
      result = await stratum.agentRun(resolved.provider, prompt, agentOpts);
      completed = true;
    } catch (err) {
      agentError = err;
      timedOut = signal.aborted;
      note(`agentRun failed${timedOut ? ' (perRunTimeoutMs)' : ''}: ${err.message}`);
    }
    wallMs = Date.now() - t0;

    writeFileSync(artifacts.outputPath, typeof result?.text === 'string' ? result.text : '');
    const transcript = result?.transcript;
    if (transcript !== undefined && transcript !== null) {
      artifacts.transcriptPath = join(runDir, 'transcript.jsonl');
      writeFileSync(artifacts.transcriptPath, typeof transcript === 'string'
        ? transcript : [].concat(transcript).map(e => JSON.stringify(e)).join('\n') + '\n');
    }

    git(workspace, ['add', '-A']);
    writeFileSync(artifacts.diffPath, git(workspace, ['diff', baselineSha]));
    diffNumbers = diffStats(git(workspace, ['diff', '--numstat', baselineSha]));

    if (agentError) {
      stage = notRun(archetype, `not run: agentRun failed: ${agentError.message}`);
    } else {
      stage = await grade(archetype, workspace, artifacts, typeof transcript === 'string' ? transcript : transcript ?? null, note);
    }
  } catch (err) {
    runError = err;
    note(`run failed: ${err.message}`);
    stage = notRun(archetype, `not run: ${err.message}`);
  }

  mkdirSync(runDir, { recursive: true });
  for (const p of [artifacts.outputPath, artifacts.diffPath]) if (!existsSync(p)) writeFileSync(p, '');
  writeFileSync(artifacts.logPath, log.join('\n') + '\n');

  const cost = workspace ? costFromLedger(workspace, known) : { rows: [], tokensIn: null, tokensOut: null, tokensTotal: null, usd: null };
  const measuredTokens = cost.tokensIn !== null && cost.tokensOut !== null
    ? cost.tokensIn + cost.tokensOut : cost.tokensTotal;

  const endedAt = new Date().toISOString();
  const m = readManifest(runDir);
  if (m) {
    try { writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ ...m, endedAt }, null, 2) + '\n'); } catch { /* best-effort */ }
  }

  const runKeyInputs = {
    configLabel: config.label,
    candidate: config.candidate,
    ingredients: { provider: resolved.provider, modelID: resolved.modelID, effort: resolved.effort, workflow: NO_WORKFLOW },
    pipelineDigest: null,
    profilesDigest: null,
    archetype: { id: archetype.id, version: archetype.version },
    fixtureDigest,
    oracleVersion: archetype.version,
    catalogDigest: resolved.catalogDigest,
    rep,
  };
  const failure = runError ?? agentError;
  const record = {
    runId, configLabel: config.label, rep, runner: 'stage',
    archetype: { id: archetype.id, version: archetype.version },
    candidateResolved: resolved,
    metrics: {
      cost: { tokensIn: cost.tokensIn, tokensOut: cost.tokensOut, calls: cost.rows.length, wallMs, usd: cost.usd },
      outcome: { completed, health: null, testsPass: null, testsTotal: null, ...diffNumbers },
      process: { reviewIters: 0, gateFailures: 0, retries: 0, escalations: 0 },
      stage,
    },
    judge: null,
    artifacts,
    manifest: {
      composeSha: m?.composeSha ?? '', fixtureGoal: spec.fixture.goal, seedRef: spec.fixture.seedRef,
      startedAt: m?.startedAt ?? startedAt, endedAt,
    },
    budget: {
      stoppedBy: timedOut ? 'timeout' : null,
      spentUsd: cost.usd,
      // A run with no usable token receipt counts as perRunTokenAssume (plan ### B1 token meter).
      spentTokens: measuredTokens ?? spec.budget.perRunTokenAssume,
    },
    runKey: sha256Hex(canonicalJson(runKeyInputs)),
    runKeyInputs,
    ...(failure ? { _error: failure.message } : {}),
  };
  writeFileSync(join(runDir, `${runId}.json`), JSON.stringify(record, null, 2) + '\n');
  process.stderr.write(`[experiment] ${runId}: done (completed=${completed}, accuracy=${stage.accuracy})\n`);
  return record;
}

function notRun(archetype, reason) {
  return {
    accuracy: null, oracle: archetype.oracleName ?? archetype.id, oracleVersion: archetype.version,
    canaryOk: false, mechanismEngaged: false, oracleError: reason, detail: {},
  };
}

/** Oracle, canary and mechanism checks. An oracle that throws or reports oracleError gives accuracy null. */
async function grade(archetype, workspace, artifacts, transcript, note) {
  const engineErrors = {};
  let accuracy = null;
  let detail = {};
  let oracleError = null;
  try {
    const out = await archetype.oracle(workspace, archetype.hiddenPath ?? null, artifacts);
    detail = out?.detail && typeof out.detail === 'object' ? out.detail : {};
    if (typeof out?.oracleError === 'string') {
      oracleError = out.oracleError;
    } else if (typeof out?.accuracy === 'number' && out.accuracy >= 0 && out.accuracy <= 1) {
      accuracy = out.accuracy;
    } else {
      oracleError = `oracle returned no accuracy in 0..1 (got ${JSON.stringify(out?.accuracy)})`;
    }
  } catch (err) {
    oracleError = `oracle threw: ${err.message}`;
  }
  if (oracleError) note(`oracle error: ${oracleError}`);

  const check = async (name, fn) => {
    try { return (await fn()) === true; } catch (err) { engineErrors[name] = err.message; return false; }
  };
  const canaryOk = await check('canary', () => archetype.canary(workspace));
  const mechanismEngaged = await check('mechanismEngaged', () => archetype.mechanismEngaged(workspace, transcript));
  if (Object.keys(engineErrors).length) detail = { ...detail, engineErrors };

  return {
    accuracy, oracle: archetype.oracleName ?? archetype.id, oracleVersion: archetype.version,
    canaryOk, mechanismEngaged, oracleError, detail,
  };
}
