// lib/gsd.js
//
// COMP-GSD-2 T6: runGsd lifecycle entry — `compose gsd <featureCode>`.
//
// Self-contained status loop. Does NOT modify lib/build.js. Reuses primitives:
//   - StratumMcpClient (lib/stratum-mcp-client.js) for plan/stepDone/runAgentText
//   - executeParallelDispatchServer (lib/build.js) for the execute step
//   - validateBoundaryMap (lib/boundary-map.js) for precondition check
//   - enrichTaskGraph (lib/gsd-decompose-enrich.js) for decompose validation
//   - buildTaskDescription (lib/gsd-prompt.js) for description repair fallback
//   - gsd-blackboard.writeAll for post-step finalization
//
// V1 limitation: runtime task-to-task handoff is not implemented; tasks see
// only spec-level upstream context (Boundary Map declarations) per blueprint.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { StratumMcpClient } from './stratum-mcp-client.js';
import { validateBoundaryMap } from './boundary-map.js';
import { enrichTaskGraph } from './gsd-decompose-enrich.js';
import { buildTaskDescription } from './gsd-prompt.js';
import { writeAll, validate as validateTaskResult, read as readBlackboard } from './gsd-blackboard.js';
import { executeParallelDispatchServer, executeShipStep } from './build.js';
import { GsdStuckDetector, DEFAULT_THRESHOLDS } from './gsd-stuck.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');

const DEFAULT_GATE_COMMANDS = ['pnpm lint', 'pnpm build', 'pnpm test'];

// ---------- Public API ----------

export async function runGsd(featureCode, opts = {}) {
  if (!featureCode || typeof featureCode !== 'string') {
    throw new Error('runGsd: featureCode required');
  }
  const cwd = opts.cwd ?? process.cwd();

  // 1. Validate preconditions: blueprint exists + Boundary Map ok
  const blueprintPath = join(cwd, 'docs', 'features', featureCode, 'blueprint.md');
  if (!existsSync(blueprintPath)) {
    throw new Error(
      `runGsd: blueprint missing at ${blueprintPath}. ` +
        `Run \`compose build ${featureCode}\` to generate it, or author it by hand.`,
    );
  }
  const blueprintText = readFileSync(blueprintPath, 'utf-8');
  const bmResult = validateBoundaryMap({
    blueprintText,
    blueprintPath,
    repoRoot: cwd,
  });
  if (!bmResult.ok) {
    const summary = bmResult.violations
      .slice(0, 5)
      .map((v) => `${v.kind}: ${v.message}`)
      .join('\n  - ');
    throw new Error(
      `runGsd: Boundary Map invalid in ${blueprintPath}:\n  - ${summary}`,
    );
  }

  // 2. COMP-GSD-5 resume branch — runs BEFORE the dirty-tree check so a
  // pid/mode-guard failure (the more specific precondition) is reported first.
  // --resume reads pause.json, guards on ownership (no live pid) +
  // mode==='gsd' (mirrors `compose fix --resume`), and seeds a precomputed task
  // graph = decomposedTasks MINUS completedTaskIds so the execute step
  // re-dispatches only the unfinished work. Completed results already live in
  // the blackboard. resumeTaskGraph (when set) makes runOneStep skip the
  // decompose agent entirely → stable task IDs, no re-decompose.
  let resumeTaskGraph = null;
  if (opts.resume) {
    resumeTaskGraph = loadResumeTaskGraph(cwd, featureCode);
  }

  // 3. Refuse to start in a dirty workspace BEFORE any Stratum side effects.
  // v1 rationale: alternatives (baseline subtract + post-execute delta) drop
  // legitimate edits to pre-existing dirty files. Refuse-if-dirty makes
  // post-execute dirty set unambiguous: every entry is GSD-produced.
  //
  // On --resume the GSD control plane (.compose/gsd/<feature>/) legitimately
  // carries the prior run's pause.json/blackboard.json/results — that's the
  // resume STATE, not an unrelated edit — so exclude it from the dirty set.
  if (!opts.allowDirtyWorkspace) {
    let startingDirty = collectChangedFiles(cwd);
    if (opts.resume) {
      const ctrlPrefix = `.compose/gsd/${featureCode}/`;
      startingDirty = startingDirty.filter((f) => !f.startsWith(ctrlPrefix));
    }
    if (startingDirty.length > 0) {
      throw new Error(
        `runGsd: working tree must be clean to ensure ship_gsd stages only GSD-produced changes. ` +
          `Dirty files: ${startingDirty.slice(0, 5).join(', ')}${startingDirty.length > 5 ? `, +${startingDirty.length - 5} more` : ''}. ` +
          `Commit or stash and re-run, or pass {allowDirtyWorkspace: true} (advanced; risks staging unrelated edits).`,
      );
    }
  }

  // 4. Resolve gateCommands. loadProjectConfig() does not merge defaults, so
  // explicit fallback here.
  const gateCommands = resolveGateCommands(cwd, opts.gateCommands);

  // 4. Load pipeline spec
  const specPath = join(PACKAGE_ROOT, 'pipelines', 'gsd.stratum.yaml');
  const specYaml = readFileSync(specPath, 'utf-8');

  // 4b. COMP-GSD-5 stuck detector — thresholds from .compose/compose.json
  // `gsd.stuck.*` with documented defaults. ONLY gsd passes this into the
  // shared executeParallelDispatchServer, so build mode is byte-identical.
  const stuckDetector = buildStuckDetector(cwd);

  // 5. Connect Stratum + plan (only after preconditions pass)
  const stratum = opts.stratum ?? new StratumMcpClient();
  const ownsStratum = !opts.stratum;
  if (ownsStratum) await stratum.connect();
  try {
    let response = await stratum.plan(specYaml, 'gsd', {
      featureCode,
      gateCommands,
    });
    const flowId = response.flow_id;

    // Track files merged into the base cwd by the execute step so ship_gsd
    // can stage them. executeShipStep's default filter only stages feature
    // docs unless context.filesChanged is provided.
    const stepCtx = {
      stratum, cwd, featureCode, blueprintText, gateCommands,
      filesChanged: [],
      stuckDetector,
      resumeTaskGraph,
      stuck: null, // set by runOneStep on a stuck verdict
    };

    // 5. Status loop. `stuck` is a terminal status (set by runOneStep when the
    // execute step's parallel dispatch returns a stuck outcome).
    while (
      response.status !== 'complete' &&
      response.status !== 'killed' &&
      response.status !== 'stuck'
    ) {
      response = await runOneStep(response, stepCtx);
    }

    if (response.status === 'stuck') {
      // Artifacts (stuck.md/json + pause.json) were written by runOneStep.
      return {
        status: 'stuck',
        flowId,
        stuckTaskId: stepCtx.stuck?.taskId ?? null,
        signal: stepCtx.stuck?.signal ?? null,
      };
    }

    // 6. Post-step blackboard finalization — read each task's TaskResult JSON
    // and write the consolidated blackboard.
    const blackboard = collectBlackboard(cwd, featureCode);
    if (Object.keys(blackboard).length > 0) {
      await writeAll(featureCode, blackboard, { cwd });
    }

    // 6b. COMP-GSD-5: a clean (non-stuck) finish clears any pause.json — the
    // resume completed, or a fresh run superseded a stale pause.
    if (response.status === 'complete') {
      clearPauseFile(cwd, featureCode);
    }

    return {
      status: response.status,
      flowId,
      blackboardEntries: Object.keys(blackboard).length,
    };
  } finally {
    if (ownsStratum) {
      try { await stratum.disconnect?.(); } catch { /* best-effort */ }
    }
  }
}

// ---------- Internals ----------

export function resolveGateCommands(cwd, override) {
  if (Array.isArray(override) && override.length > 0) return override;
  // loadProjectConfig() returns raw .compose/compose.json — does NOT merge
  // defaults — so we must do our own fallback.
  const configPath = join(cwd, '.compose', 'compose.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (Array.isArray(cfg.gateCommands) && cfg.gateCommands.length > 0) {
        return cfg.gateCommands;
      }
    } catch {
      /* fall through to default */
    }
  }
  return [...DEFAULT_GATE_COMMANDS];
}

async function runOneStep(response, ctx) {
  const { stratum, cwd, featureCode, blueprintText, gateCommands } = ctx;
  const flowId = response.flow_id;
  const stepId = response.step_id;
  const stepType = response.type ?? response.step_type;

  if (response.status === 'execute_step') {
    // parallel_dispatch step (the `execute` step)
    if (stepType === 'parallel_dispatch' || response.tasks) {
      const outcome = await executeParallelDispatchServer(
        response,
        stratum,
        { cwd, featureCode },
        null, // progress
        { write: () => {} }, // streamWriter — no-op for v1
        cwd,
        { stuckDetector: ctx.stuckDetector }, // COMP-GSD-5 (null in non-gsd callers)
      );

      // COMP-GSD-5: a stuck verdict halts the run. Persist the diagnostic +
      // resume state, then return a terminal `stuck` envelope so runGsd's loop
      // exits. The task was already cancelled (conflict) inside dispatch.
      if (outcome && outcome.stuck) {
        ctx.stuck = outcome.stuck;
        writeStuckArtifacts(ctx, response, outcome.stuck);
        return { status: 'stuck', flow_id: flowId, step_id: stepId };
      }

      // After diffs are merged, capture the touched files for ship_gsd
      // staging. The clean-workspace precondition above guarantees every
      // file in the post-execute dirty set is genuinely a GSD-produced change.
      ctx.filesChanged = collectChangedFiles(cwd);
      // executeParallelDispatchServer returns the next-step dispatch envelope
      return outcome;
    }

    // ship_gsd: delegate to executeShipStep with filesChanged from execute step
    // so source files are staged. Agent sandbox blocks git, so commit must
    // run in-process (mirrors runBuild's special case at lib/build.js:963-981).
    if (stepId === 'ship_gsd') {
      const shipResult = await executeShipStep(
        featureCode,
        cwd,
        cwd,
        { cwd, featureCode, mode: 'feature', filesChanged: ctx.filesChanged ?? [] },
        '',
        null,
      );
      // executeShipStep stages + commits but does NOT push. Push is a
      // user-facing operation deferred to the user in v1; runBuild's ship
      // step doesn't auto-push either. Document via ship intent later.
      return await stratum.stepDone(flowId, stepId, shipResult);
    }

    // COMP-GSD-5 resume: skip the decompose AGENT entirely and substitute the
    // persisted task graph (already enriched/repaired during the original run
    // and already filtered to exclude completedTaskIds). We do NOT re-run
    // validateAndRepairTaskGraph: enrichTaskGraph would flag the completed
    // tasks' Boundary Map slices as orphaned (no task in the SUBSET owns them).
    // Stable task IDs + no re-decompose are the whole point.
    if (stepId === 'decompose_gsd' && ctx.resumeTaskGraph) {
      ctx.lastTaskGraph = ctx.resumeTaskGraph;
      return await stratum.stepDone(flowId, stepId, ctx.resumeTaskGraph);
    }

    // Single-agent step: dispatch via runAgentText. The agent returns text;
    // we expect JSON matching the step's output_contract.
    const prompt = response.intent ?? '';
    const text = await stratum.runAgentText(response.agent ?? 'claude', prompt, { cwd });
    let result;
    try {
      result = parseJsonFromText(text);
    } catch (err) {
      throw new Error(
        `runGsd: step ${stepId} agent did not return parseable JSON: ${err.message}`,
      );
    }

    // T6 step 7: validate decompose_gsd output and repair missing descriptions.
    if (stepId === 'decompose_gsd') {
      result = validateAndRepairTaskGraph(result, blueprintText, gateCommands);
      // COMP-GSD-5: remember the ENRICHED graph so a later stuck halt can
      // persist the full task definitions (with descriptions/produces/consumes)
      // into pause.json — resume re-dispatches these without re-enriching.
      ctx.lastTaskGraph = result;
    }

    return await stratum.stepDone(flowId, stepId, result);
  }

  if (response.status === 'await_gate') {
    // GSD has no gates in v1. If we hit one, surface it.
    throw new Error(
      `runGsd: unexpected gate at step ${stepId}. v1 has no gates in the gsd flow.`,
    );
  }

  throw new Error(`runGsd: unknown response status: ${response.status}`);
}

export function validateAndRepairTaskGraph(taskGraph, blueprintText, gateCommands) {
  // Structural check via enrichTaskGraph. Throws on orphan slice/task —
  // that's a "fail loudly" case (no reliable repair path).
  const enriched = enrichTaskGraph(taskGraph, blueprintText);

  // Per-task description check. The agent must produce a description with
  // all six required sections (per T4 prompt contract). If ANY section
  // marker is missing, repair via buildTaskDescription. Length-only would
  // miss long-but-malformed strings.
  const enrichedById = new Map(enriched.tasks.map((t) => [t.id, t]));
  const repairedTasks = enriched.tasks.map((task) => {
    if (typeof task.description === 'string' && hasAllRequiredSections(task.description)) {
      return task;
    }
    // Repair: synthesize a fresh description.
    const sliceText = extractSliceTextForTask(blueprintText, task);
    const upstream = (task.depends_on || [])
      .map((dep) => enrichedById.get(dep))
      .filter(Boolean);
    const fresh = buildTaskDescription({
      task,
      slice: sliceText,
      upstreamTasks: upstream,
      gateCommands,
    });
    return { ...task, description: fresh };
  });

  return { tasks: repairedTasks };
}

const REQUIRED_DESCRIPTION_SECTIONS = [
  'Symbols you must produce',
  'Symbols you may consume from upstream tasks',
  'Boundary Map slice',
  'Upstream tasks',
  'GATES',
];

function hasAllRequiredSections(description) {
  for (const marker of REQUIRED_DESCRIPTION_SECTIONS) {
    if (!description.includes(marker)) return false;
  }
  return true;
}

function extractSliceTextForTask(blueprintText, task) {
  // Find any Boundary Map slice whose File Plan files match the task's
  // files_owned. We don't have a sliceId here, so we scan slice blocks for
  // the first one whose File Plan ⊆ task.files_owned. Best-effort — only
  // used in the description-repair path.
  const lines = blueprintText.split(/\r?\n/);
  const owned = new Set(task.files_owned || []);
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^### (S\d{2,})/);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { id: m[1], start: i, end: lines.length };
    } else if (cur && /^### S\d/.test(lines[i])) {
      cur.end = i;
      blocks.push(cur);
      cur = null;
    } else if (cur && /^## /.test(lines[i])) {
      cur.end = i;
      blocks.push(cur);
      cur = null;
    }
  }
  if (cur) blocks.push(cur);
  for (const b of blocks) {
    const block = lines.slice(b.start, b.end).join('\n');
    const fpMatch = block.match(/^File Plan\s*:\s*(.+)$/m);
    if (!fpMatch) continue;
    const files = [...fpMatch[1].matchAll(/`([^`]+)`/g)].map((mm) => mm[1].trim());
    if (files.length > 0 && files.every((f) => owned.has(f))) {
      return block;
    }
  }
  return '';
}

function parseJsonFromText(text) {
  // Strip code fences if present.
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const body = fenced ? fenced[1] : trimmed;
  return JSON.parse(body);
}

function collectChangedFiles(cwd) {
  try {
    const tracked = execSync('git diff --name-only HEAD', {
      cwd, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const all = [
      ...tracked.split('\n').filter(Boolean),
      ...untracked.split('\n').filter(Boolean),
    ];
    return [...new Set(all)];
  } catch {
    return [];
  }
}

function collectBlackboard(cwd, featureCode) {
  const dir = join(cwd, '.compose', 'gsd', featureCode, 'results');
  if (!existsSync(dir)) return {};
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const out = {};
  const failures = [];
  for (const f of files) {
    const taskId = f.replace(/\.json$/, '');
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    } catch (err) {
      failures.push(`${f}: unreadable JSON (${err.message})`);
      continue;
    }
    const v = validateTaskResult(parsed);
    if (v.ok) {
      out[taskId] = parsed;
    } else {
      failures.push(`${f}: ${v.errors.join('; ')}`);
    }
  }
  if (failures.length > 0) {
    // Plan T6 acceptance: blackboard must contain one VALIDATED entry per task.
    // A partial blackboard is worse than no blackboard — fail loudly.
    throw new Error(
      `runGsd: ${failures.length} TaskResult file(s) failed validation; refusing to write partial blackboard:\n  - ${failures.join('\n  - ')}`,
    );
  }
  return out;
}

// ===========================================================================
// COMP-GSD-5: stuck detection + resume
// ===========================================================================

function gsdDir(cwd, featureCode) {
  return join(cwd, '.compose', 'gsd', featureCode);
}

/**
 * Build a GsdStuckDetector from `.compose/compose.json` `gsd.stuck.*`, falling
 * back to documented defaults (sameFileEdits=3, errorRepeats=3,
 * noProgressCalls=8, wallClockMs=600000). Config keys use snake_case to match
 * the design table; the detector takes camelCase.
 */
export function buildStuckDetector(cwd) {
  const cfg = readGsdStuckConfig(cwd);
  return new GsdStuckDetector({
    sameFileEdits: cfg.same_file_edits ?? DEFAULT_THRESHOLDS.sameFileEdits,
    errorRepeats: cfg.error_repeats ?? DEFAULT_THRESHOLDS.errorRepeats,
    noProgressCalls: cfg.no_progress_calls ?? DEFAULT_THRESHOLDS.noProgressCalls,
    wallClockMs: cfg.wall_clock_ms ?? DEFAULT_THRESHOLDS.wallClockMs,
  });
}

function readGsdStuckConfig(cwd) {
  const configPath = join(cwd, '.compose', 'compose.json');
  if (!existsSync(configPath)) return {};
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    return cfg?.gsd?.stuck ?? {};
  } catch {
    return {};
  }
}

/**
 * Task ids whose VALIDATED TaskResult is already known — the union of the
 * persisted blackboard and any per-task result files that validate. Lenient
 * (does NOT throw on a bad file) because at stuck-halt time the run is being
 * abandoned, not finalized.
 */
function collectCompletedTaskIds(cwd, featureCode) {
  const done = new Set(Object.keys(readBlackboard(featureCode, { cwd }) ?? {}));
  const dir = join(gsdDir(cwd, featureCode), 'results');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        if (validateTaskResult(parsed).ok) done.add(f.replace(/\.json$/, ''));
      } catch { /* skip unreadable */ }
    }
  }
  return [...done];
}

/** Best-effort unified diff of the whole working tree (for the stuck.md triage). */
function captureWorkingDiff(cwd) {
  try {
    return execSync('git diff HEAD', {
      cwd, encoding: 'utf-8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Persist the stuck diagnostic (stuck.md + stuck.json, per
 * contracts/gsd-stuck.json#stuck) AND the resume state (pause.json, per
 * #pause). decomposedTasks is the FULL task list (from the dispatch envelope),
 * persisted so --resume does not re-decompose. completedTaskIds comes from the
 * blackboard / results dir.
 */
function writeStuckArtifacts(ctx, dispatchResponse, verdict) {
  const { cwd, featureCode } = ctx;
  const dir = gsdDir(cwd, featureCode);
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();

  // Persist the FULLY-ENRICHED task graph (captured at decompose) so --resume
  // re-dispatches the unfinished subset WITHOUT re-decomposing or re-enriching.
  // Fall back to the dispatch envelope's tasks only if enrichment wasn't seen.
  const sourceTasks = ctx.lastTaskGraph?.tasks ?? dispatchResponse.tasks ?? [];
  const decomposedTasks = sourceTasks.map((t) => ({ ...t }));
  const completedTaskIds = collectCompletedTaskIds(cwd, featureCode);
  const partialDiff = captureWorkingDiff(cwd);

  const stuck = {
    feature: featureCode,
    taskId: verdict.taskId,
    signal: verdict.signal,
    detail: verdict.detail,
    attemptCounts: verdict.attemptCounts ?? {},
    ts,
  };
  if (partialDiff) stuck.partialDiff = partialDiff;
  writeFileSync(join(dir, 'stuck.json'), JSON.stringify(stuck, null, 2) + '\n');

  const pause = {
    flowId: dispatchResponse.flow_id,
    stepId: dispatchResponse.step_id,
    stuckTaskId: verdict.taskId,
    signal: verdict.signal,
    detail: verdict.detail,
    decomposedTasks,
    completedTaskIds,
    pid: process.pid,
    mode: 'gsd',
    ts,
  };
  writeFileSync(join(dir, 'pause.json'), JSON.stringify(pause, null, 2) + '\n');

  writeFileSync(join(dir, 'stuck.md'), renderStuckMarkdown(stuck, pause));
}

function renderStuckMarkdown(stuck, pause) {
  const remaining = pause.decomposedTasks
    .map((t) => t.id)
    .filter((id) => !pause.completedTaskIds.includes(id));
  return `# GSD stuck: ${stuck.feature}

**Signal:** \`${stuck.signal}\`
**Stuck task:** \`${stuck.taskId}\`
**Detected:** ${stuck.ts}

## What happened

${stuck.detail}

Attempt counts at halt:
- same-file edits (max across files): ${stuck.attemptCounts.sameFileEdits ?? 0}
- error repeats (max across hashes): ${stuck.attemptCounts.errorRepeats ?? 0}
- consecutive no-progress calls: ${stuck.attemptCounts.noProgressCalls ?? 0}

The in-flight task was cancelled and the run halted cleanly.

## Resume or abort

Completed tasks (already in the blackboard, will be skipped): ${pause.completedTaskIds.length ? pause.completedTaskIds.map((x) => `\`${x}\``).join(', ') : '(none)'}
Tasks that will re-dispatch on resume: ${remaining.length ? remaining.map((x) => `\`${x}\``).join(', ') : '(none)'}

- **Resume:** \`compose gsd ${stuck.feature} --resume\` — re-dispatches the unfinished tasks into fresh worktrees.
- **Abort:** delete \`.compose/gsd/${stuck.feature}/pause.json\` and start over.

State for resume is in \`pause.json\` (schema: \`contracts/gsd-stuck.json#/definitions/pause\`).
`;
}

/**
 * --resume: read pause.json, enforce the ownership + mode guard (mirrors
 * `compose fix --resume`, bin/compose.js:1933), and return the persisted task
 * graph filtered to exclude completedTaskIds. Throws (caller surfaces the
 * message + exits 1) when there is nothing to resume or the guard fails.
 */
export function loadResumeTaskGraph(cwd, featureCode) {
  const pausePath = join(gsdDir(cwd, featureCode), 'pause.json');
  if (!existsSync(pausePath)) {
    throw new Error(
      `runGsd: no pause.json to resume for ${featureCode}. ` +
        `Nothing to resume — run \`compose gsd ${featureCode}\` to start fresh.`,
    );
  }
  let pause;
  try {
    pause = JSON.parse(readFileSync(pausePath, 'utf-8'));
  } catch (err) {
    throw new Error(`runGsd: pause.json for ${featureCode} is unreadable: ${err.message}`);
  }

  // Mode guard: refuse to resume a non-gsd pause file.
  if (pause.mode && pause.mode !== 'gsd') {
    throw new Error(
      `runGsd: cannot --resume: pause.json for ${featureCode} is in ${pause.mode} mode, not gsd.`,
    );
  }

  // Ownership guard: refuse if the recorded pid is still alive. A resumable
  // pause is one whose writing process has EXITED — a live pid means another
  // run still owns this feature (mirrors `compose fix --resume`). We do not
  // make a self-pid exception: if a live process holds the pause, resuming is
  // unsafe regardless of whether that pid happens to match ours.
  if (typeof pause.pid === 'number' && isPidAlive(pause.pid)) {
    throw new Error(
      `runGsd: cannot --resume: pid ${pause.pid} still owns this gsd run (process is live). ` +
        `Wait for it to exit (or remove a stale pause.json) before resuming.`,
    );
  }

  const tasks = Array.isArray(pause.decomposedTasks) ? pause.decomposedTasks : [];
  if (tasks.length === 0) {
    throw new Error(`runGsd: pause.json for ${featureCode} has no decomposedTasks to resume.`);
  }
  const completed = new Set(pause.completedTaskIds ?? []);
  const remaining = tasks
    .filter((t) => !completed.has(t.id))
    .map((t) => {
      // A completed dependency is already satisfied (its result is in the
      // blackboard); strip it from depends_on so the re-dispatched subgraph is
      // self-consistent and a remaining task does not wait on a task that will
      // never be re-dispatched (COMP-GSD-5 Codex review residual).
      if (!Array.isArray(t.depends_on) || t.depends_on.length === 0) return t;
      const deps = t.depends_on.filter((id) => !completed.has(id));
      return deps.length === t.depends_on.length ? t : { ...t, depends_on: deps };
    });
  if (remaining.length === 0) {
    // Everything already completed — nothing to re-dispatch. Treat as clean.
    throw new Error(
      `runGsd: all tasks for ${featureCode} are already completed; nothing to re-dispatch. ` +
        `Delete pause.json to finish.`,
    );
  }
  // Atomic ownership claim (COMP-GSD-5 Codex review, HIGH). `mkdirSync` is an
  // atomically exclusive create, so two concurrent --resume invocations cannot
  // both claim — the loser gets EEXIST and refuses. We deliberately do NOT
  // auto-take-over a pre-existing claim: stale-claim recovery (a crashed
  // resume's leftover) has an inherent TOCTOU race and is GSD-6's
  // (crash-recovery) job, built on this same pause-state. A claim left by a
  // crashed resume is cleared manually (message below) until GSD-6 lands.
  const claimPath = join(gsdDir(cwd, featureCode), 'pause.lock');
  try {
    mkdirSync(claimPath);
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new Error(
        `runGsd: a resume claim already exists for ${featureCode} ` +
          `(.compose/gsd/${featureCode}/pause.lock). Another --resume may be in progress; ` +
          `if none is, remove that directory to clear a stale claim, then retry.`,
      );
    }
    throw err;
  }
  return { tasks: remaining };
}

function isPidAlive(pid) {
  try {
    // signal 0 probes existence without sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return err.code === 'EPERM';
  }
}

function clearPauseFile(cwd, featureCode) {
  const dir = gsdDir(cwd, featureCode);
  try { rmSync(join(dir, 'pause.json'), { force: true }); } catch { /* best-effort */ }
  // Release the resume ownership claim dir (COMP-GSD-5 Codex review) alongside it.
  try { rmSync(join(dir, 'pause.lock'), { recursive: true, force: true }); } catch { /* best-effort */ }
}
