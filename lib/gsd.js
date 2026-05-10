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

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { StratumMcpClient } from './stratum-mcp-client.js';
import { validateBoundaryMap } from './boundary-map.js';
import { enrichTaskGraph } from './gsd-decompose-enrich.js';
import { buildTaskDescription } from './gsd-prompt.js';
import { writeAll, validate as validateTaskResult } from './gsd-blackboard.js';
import { executeParallelDispatchServer, executeShipStep } from './build.js';

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

  // 2. Refuse to start in a dirty workspace BEFORE any Stratum side effects.
  // v1 rationale: alternatives (baseline subtract + post-execute delta) drop
  // legitimate edits to pre-existing dirty files. Refuse-if-dirty makes
  // post-execute dirty set unambiguous: every entry is GSD-produced.
  if (!opts.allowDirtyWorkspace) {
    const startingDirty = collectChangedFiles(cwd);
    if (startingDirty.length > 0) {
      throw new Error(
        `runGsd: working tree must be clean to ensure ship_gsd stages only GSD-produced changes. ` +
          `Dirty files: ${startingDirty.slice(0, 5).join(', ')}${startingDirty.length > 5 ? `, +${startingDirty.length - 5} more` : ''}. ` +
          `Commit or stash and re-run, or pass {allowDirtyWorkspace: true} (advanced; risks staging unrelated edits).`,
      );
    }
  }

  // 3. Resolve gateCommands. loadProjectConfig() does not merge defaults, so
  // explicit fallback here.
  const gateCommands = resolveGateCommands(cwd, opts.gateCommands);

  // 4. Load pipeline spec
  const specPath = join(PACKAGE_ROOT, 'pipelines', 'gsd.stratum.yaml');
  const specYaml = readFileSync(specPath, 'utf-8');

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
    };

    // 5. Status loop
    while (response.status !== 'complete' && response.status !== 'killed') {
      response = await runOneStep(response, stepCtx);
    }

    // 6. Post-step blackboard finalization — read each task's TaskResult JSON
    // and write the consolidated blackboard.
    const blackboard = collectBlackboard(cwd, featureCode);
    if (Object.keys(blackboard).length > 0) {
      await writeAll(featureCode, blackboard, { cwd });
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
      );
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
