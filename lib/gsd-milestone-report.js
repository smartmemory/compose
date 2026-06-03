// lib/gsd-milestone-report.js
//
// COMP-GSD-7: milestone report generator. On GSD feature completion (and via
// `compose gsd report <feature>`), assemble a read-only data model from the
// persisted run artifacts and render a single self-contained HTML report to
// docs/gsd-reports/<feature>.html — auto-discovered by the cockpit DocsView.
//
// Data sources (all read-only):
//   .compose/gsd/<f>/state.json        run state + completedAt (gsd-state.js)
//   .compose/gsd/<f>/blackboard.json   per-task TaskResults (gsd-blackboard.js)
//   .compose/gsd/<f>/timing.json       per-task elapsed (gsd-timing.js sidecar)
//   .compose/gsd/<f>/diffs/<id>.diff   per-task diff snapshots (build.js capture)
//   budget-final.json | budget.json    budget actuals vs caps (gsd-budget shape)
//
// HTML shape mirrors server/graph-export.js: one template literal, inline CSS,
// no external assets. Atomic write mirrors gsd-state.js:44.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readGsdState } from './gsd-state.js';
import { read as readBlackboard } from './gsd-blackboard.js';
import { readTimingSidecar } from './gsd-timing.js';
import { gsdTaskDiffPath } from './gsd-diff-capture.js';
import { readGsdEvents } from './gsd-events.js';

const DIFF_INLINE_CAP_BYTES = 200 * 1024; // 200 KB per task

function gsdDir(cwd, featureCode) {
  return join(cwd, '.compose', 'gsd', featureCode);
}

function readJsonOrNull(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

// ---------- Model assembly ----------

function resolveBudget(cwd, featureCode, opts) {
  // Precedence: in-process budget_state → budget-final.json → halt budget.json → none.
  const fromOpts = opts?.budgetState;
  const src = fromOpts
    ?? readJsonOrNull(join(gsdDir(cwd, featureCode), 'budget-final.json'))
    ?? readJsonOrNull(join(gsdDir(cwd, featureCode), 'budget.json'));
  if (!src || (!src.caps && !src.consumed)) return { configured: false, caps: {}, consumed: {}, axis: null };
  return { configured: true, caps: src.caps ?? {}, consumed: src.consumed ?? {}, axis: src.axis ?? null };
}

function readDiff(cwd, featureCode, taskId) {
  const p = gsdTaskDiffPath(cwd, featureCode, taskId);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf-8'); } catch { return null; }
}

// COMP-GSD-7-EVENTLOG: map a run-event to a timeline row. Unknown future kinds
// render their kind verbatim rather than dropping out.
function eventLabel(e) {
  switch (e.kind) {
    case 'run_started': return `Run started (${e.mode ?? 'fresh'})`;
    case 'phase': return `Phase: ${e.phase ?? '?'}`;
    case 'task_completed': return `Task completed: ${e.taskId ?? '?'}`;
    case 'paused': return `Paused (${e.pauseKind ?? '?'})`;
    case 'completed': return 'Run completed';
    case 'failed': return `Run failed${e.reason ? `: ${e.reason}` : ''}`;
    default: return String(e.kind ?? 'event');
  }
}

function buildTimeline(state, cwd, featureCode) {
  // COMP-GSD-7-EVENTLOG: prefer the real append-only event stream. Fall back to
  // the snapshot-derived timeline only when there are ZERO usable events (a run
  // that predates the log, or a truncated/torn/corrupt file) — never render an
  // empty timeline because the file happens to exist.
  const events = readGsdEvents(cwd, featureCode);
  if (events.length > 0) {
    return events.map((e) => ({ label: eventLabel(e), ts: e.ts ?? null }));
  }

  const dir = gsdDir(cwd, featureCode);
  const tl = [];
  if (state.startedAt) tl.push({ label: 'Run started', ts: state.startedAt });
  if (existsSync(join(dir, 'stuck.json'))) {
    const s = readJsonOrNull(join(dir, 'stuck.json'));
    tl.push({ label: `Stuck halt${s?.taskId ? ` (${s.taskId})` : ''}`, ts: s?.ts ?? null });
  }
  if (existsSync(join(dir, 'budget.json'))) {
    const b = readJsonOrNull(join(dir, 'budget.json'));
    tl.push({ label: `Budget halt${b?.axis ? ` (${b.axis})` : ''}`, ts: b?.ts ?? null });
  }
  if (existsSync(join(dir, 'pause.json'))) {
    const p = readJsonOrNull(join(dir, 'pause.json'));
    tl.push({ label: `Paused${p?.kind ? ` (${p.kind})` : ''}`, ts: p?.ts ?? null });
  }
  if (state.completedAt) {
    tl.push({ label: `Run ${state.status === 'complete' ? 'completed' : `ended (${state.status})`}`, ts: state.completedAt });
  }
  return tl;
}

/**
 * Read all persisted artifacts for a completed GSD feature and return a flat,
 * render-ready model. Returns null if there is no run state at all.
 */
export function assembleReportModel(featureCode, cwd, opts = {}) {
  const state = readGsdState(cwd, featureCode);
  if (!state) return null;

  const blackboard = readBlackboard(featureCode, { cwd });
  const timing = readTimingSidecar(cwd, featureCode);

  // Order by decomposedTasks; append any blackboard tasks not in the graph.
  const order = Array.isArray(state.decomposedTasks)
    ? state.decomposedTasks.map((t) => t.id).filter(Boolean)
    : [];
  const ids = [...order];
  for (const id of Object.keys(blackboard)) if (!ids.includes(id)) ids.push(id);

  const tasks = ids.map((id) => {
    const tr = blackboard[id] ?? {};
    const tm = timing[id] ?? {};
    const diff = readDiff(cwd, featureCode, id);
    return {
      id,
      status: tr.status ?? 'unknown',
      attempts: tr.attempts ?? null,
      filesChanged: Array.isArray(tr.files_changed) ? tr.files_changed : [],
      summary: tr.summary ?? '',
      startedAt: tm.startedAt ?? null,
      completedAt: tm.completedAt ?? null,
      durationMs: typeof tm.durationMs === 'number' ? tm.durationMs : null,
      hasDiff: diff != null,
      diff: diff ?? null,
    };
  });

  const completedSet = new Set(Array.isArray(state.completedTaskIds) ? state.completedTaskIds : []);
  const completed = completedSet.size || tasks.filter((t) => t.status === 'passed').length;
  const taskCount = tasks.length;
  const totalWallClockMs = state.startedAt && state.completedAt
    ? Math.max(0, Date.parse(state.completedAt) - Date.parse(state.startedAt))
    : null;

  return {
    feature: featureCode,
    status: state.status ?? 'unknown',
    phase: state.phase ?? null,
    startedAt: state.startedAt ?? null,
    completedAt: state.completedAt ?? null,
    flowId: state.flowId ?? null,
    tasks,
    budget: resolveBudget(cwd, featureCode, opts),
    timeline: buildTimeline(state, cwd, featureCode),
    totals: {
      taskCount,
      completed,
      completionRate: taskCount > 0 ? completed / taskCount : 0,
      totalWallClockMs,
    },
  };
}

// ---------- HTML render ----------

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

const BUDGET_ROWS = [
  { axis: 'tokens', cap: 'max_tokens', use: 'tokens', fmt: (v) => String(v ?? 0) },
  { axis: 'agent dispatches', cap: 'max_agent_dispatches', use: 'dispatches', fmt: (v) => String(v ?? 0) },
  { axis: 'wall-clock (s)', cap: 'ms', use: 'wall_s', fmt: (v) => String(Math.round(v ?? 0)), capFmt: (v) => String(Math.round((v ?? 0) / 1000)) },
  { axis: 'cost (USD)', cap: 'usd', use: 'dollars', fmt: (v) => Number(v ?? 0).toFixed(4), capFmt: (v) => Number(v ?? 0).toFixed(4) },
];

function renderBudget(budget) {
  if (!budget.configured) {
    return `<p class="muted">Unbudgeted run — no GSD budget caps were enforced.</p>`;
  }
  const rows = BUDGET_ROWS
    .filter((r) => budget.caps[r.cap] != null)
    .map((r) => {
      const cap = r.capFmt ? r.capFmt(budget.caps[r.cap]) : String(budget.caps[r.cap]);
      const used = r.fmt(budget.consumed[r.use]);
      return `<tr><td>${esc(r.axis)}</td><td>${esc(used)}</td><td>${esc(cap)}</td></tr>`;
    })
    .join('\n');
  if (!rows) return `<p class="muted">Budget configured but no enforced axes recorded.</p>`;
  return `<table><thead><tr><th>Axis</th><th>Consumed</th><th>Cap</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderTaskDiff(task) {
  if (!task.hasDiff) {
    const files = task.filesChanged.length
      ? `<p class="muted">No diff captured. Files changed: ${task.filesChanged.map(esc).join(', ')}</p>`
      : `<p class="muted">No diff captured.</p>`;
    return files;
  }
  let body = task.diff;
  let note = '';
  if (Buffer.byteLength(body, 'utf-8') > DIFF_INLINE_CAP_BYTES) {
    body = body.slice(0, DIFF_INLINE_CAP_BYTES);
    note = `<p class="muted">Diff truncated at ${Math.round(DIFF_INLINE_CAP_BYTES / 1024)} KB — see .compose/gsd/&lt;feature&gt;/diffs/${esc(task.id)}.diff for the full text.</p>`;
  }
  return `<details><summary>diff (${task.filesChanged.length} file${task.filesChanged.length !== 1 ? 's' : ''})</summary>${note}<pre class="diff">${esc(body)}</pre></details>`;
}

function renderTasks(tasks) {
  return tasks.map((t) => `
    <div class="task">
      <h3>${esc(t.id)} <span class="status status-${esc(t.status)}">${esc(t.status)}</span></h3>
      <div class="meta">attempts: ${esc(t.attempts ?? '—')} · files: ${t.filesChanged.length} · elapsed: ${esc(fmtMs(t.durationMs))}</div>
      ${t.summary ? `<p class="summary">${esc(t.summary)}</p>` : ''}
      ${renderTaskDiff(t)}
    </div>`).join('\n');
}

function renderTimeline(timeline) {
  if (!timeline.length) return '';
  const items = timeline.map((e) => `<li><span class="ts">${esc(e.ts ?? '—')}</span> ${esc(e.label)}</li>`).join('\n');
  return `<ul class="timeline">${items}</ul>`;
}

/** Pure: model → self-contained HTML string. */
export function renderReportHtml(model) {
  const t = model.totals;
  const pct = `${Math.round(t.completionRate * 100)}%`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(model.feature)} — GSD Milestone Report</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 980px; margin: 2rem auto; padding: 0 1rem; }
  h1 { margin-bottom: .25rem; } h2 { margin-top: 2rem; border-bottom: 1px solid #8884; padding-bottom: .25rem; }
  .sub { color: #888; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #8883; }
  .muted { color: #888; }
  .cards { display: flex; gap: 1rem; flex-wrap: wrap; }
  .card { border: 1px solid #8884; border-radius: 8px; padding: .75rem 1rem; min-width: 120px; }
  .card .n { font-size: 1.6rem; font-weight: 600; }
  .task { border: 1px solid #8884; border-radius: 8px; padding: .75rem 1rem; margin: .75rem 0; }
  .task h3 { margin: 0 0 .25rem; } .task .meta { color: #888; font-size: .85rem; }
  .status { font-size: .7rem; padding: .1rem .4rem; border-radius: 4px; background: #8883; vertical-align: middle; }
  .status-passed { background: #2e7d3233; } .status-failed { background: #c6282833; }
  pre.diff { overflow: auto; background: #8881; padding: .6rem; border-radius: 6px; font-size: 12px; }
  ul.timeline { list-style: none; padding-left: 0; } ul.timeline .ts { color: #888; font-variant-numeric: tabular-nums; }
  footer { margin-top: 3rem; color: #888; font-size: .8rem; }
</style>
</head>
<body>
<h1>${esc(model.feature)}</h1>
<p class="sub">GSD milestone report · status <strong>${esc(model.status)}</strong>${model.phase ? ` · phase ${esc(model.phase)}` : ''}</p>

<div class="cards">
  <div class="card"><div class="n">${t.taskCount}</div>tasks</div>
  <div class="card"><div class="n">${t.completed}</div>completed</div>
  <div class="card"><div class="n">${pct}</div>completion</div>
  <div class="card"><div class="n">${esc(fmtMs(t.totalWallClockMs))}</div>wall-clock</div>
</div>

<h2>Budget — actuals vs caps</h2>
${renderBudget(model.budget)}

<h2>Timeline</h2>
${renderTimeline(model.timeline) || '<p class="muted">No timeline events recorded.</p>'}

<h2>Tasks</h2>
${renderTasks(model.tasks) || '<p class="muted">No tasks recorded.</p>'}

<footer>
Generated by COMP-GSD-7. Per-task elapsed time is poll-granularity-approximate
(bounded by the dispatch poll interval). Diffs over ${Math.round(DIFF_INLINE_CAP_BYTES / 1024)} KB are truncated.
</footer>
</body>
</html>`;
}

// ---------- Write + orchestrate ----------

export function reportPath(cwd, featureCode) {
  return join(cwd, 'docs', 'gsd-reports', `${featureCode}.html`);
}

/** Atomic write to docs/gsd-reports/<feature>.html. Returns the path. */
export function writeGsdReport(cwd, featureCode, html) {
  const target = reportPath(cwd, featureCode);
  mkdirSync(join(cwd, 'docs', 'gsd-reports'), { recursive: true });
  const tmp = `${target}.tmp`;
  if (existsSync(tmp)) { try { unlinkSync(tmp); } catch { /* ignore */ } }
  writeFileSync(tmp, html);
  renameSync(tmp, target);
  return target;
}

/**
 * Assemble → render → write. Returns { ok, path, model, html } on success or
 * { ok:false, error } when there is no run state to report on. Never throws on
 * a missing-state condition (callers use it best-effort).
 */
export function generateGsdMilestoneReport(featureCode, cwd, opts = {}) {
  const model = assembleReportModel(featureCode, cwd, opts);
  if (!model) return { ok: false, error: `no GSD run state for ${featureCode} (no state.json)` };
  const html = renderReportHtml(model);
  const path = writeGsdReport(cwd, featureCode, html);
  return { ok: true, path, model, html };
}
