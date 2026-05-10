// lib/gsd-decompose-enrich.js
//
// COMP-GSD-2 T3: enrichTaskGraph(taskGraph, blueprintText) → TaskGraphGsd.
//
// Pure function. No filesystem I/O. Takes the bare TaskGraph emitted by
// Stratum's decompose step (tasks have id/files_owned/files_read/depends_on/
// description) and the blueprint text. Calls parseBoundaryMap (pure) to get
// slices and parse violations. Maps each slice to exactly one task by
// the slice's File Plan files ⊆ task.files_owned. Attaches produces/consumes
// arrays to each task.
//
// Purity note: the blueprint says T6/runGsd should use validateBoundaryMap
// (which does filesystem checks). T3 only uses parseBoundaryMap so it stays
// pure and deterministic — runGsd separately calls validateBoundaryMap as
// its lifecycle precondition.
//
// Throws on: parseBoundaryMap parseViolations, empty Boundary Map, orphaned
// slice (slice's File Plan files not all owned by any single task), orphaned
// task (no slice maps to it).

import { parseBoundaryMap } from './boundary-map.js';

// Match per-slice File Plan lines:
//   File Plan: `path/a` (new), `path/b` (modify), ...
//   File Plan: path/a, path/b
const FILEPLAN_LINE_RE = /^File Plan\s*:\s*(.+)$/;
const BACKTICK_PATH_RE = /`([^`]+)`/g;
const BARE_PATH_RE = /([^\s,()`]+)/g;

function extractSliceFilePlanFiles(blueprintText, sliceId) {
  // Find the slice block: from `### {sliceId}` to the next `### S` heading or
  // a `## ` heading or EOF.
  const lines = blueprintText.split(/\r?\n/);
  const headingRe = new RegExp(`^### ${sliceId}(?::|\\s|$)`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^### S\d/.test(lines[i]) || /^## /.test(lines[i])) { end = i; break; }
  }
  // Find File Plan line within the slice block
  for (let i = start; i < end; i++) {
    const m = lines[i].match(FILEPLAN_LINE_RE);
    if (!m) continue;
    const tail = m[1];
    // Prefer backtick-quoted paths; fall back to bare comma-separated if none.
    const ticked = [...tail.matchAll(BACKTICK_PATH_RE)].map((mm) => mm[1].trim());
    if (ticked.length > 0) return ticked;
    // Strip parenthesized actions like " (new)" before bare-token matching.
    const cleaned = tail.replace(/\([^)]*\)/g, '');
    const bare = [...cleaned.matchAll(BARE_PATH_RE)].map((mm) => mm[1].trim()).filter(Boolean);
    return bare;
  }
  return [];
}

export function enrichTaskGraph(taskGraph, blueprintText) {
  if (!taskGraph || !Array.isArray(taskGraph.tasks)) {
    throw new Error('enrichTaskGraph: taskGraph.tasks must be an array');
  }
  if (typeof blueprintText !== 'string') {
    throw new Error('enrichTaskGraph: blueprintText must be a string');
  }

  const { slices, parseViolations } = parseBoundaryMap(blueprintText);
  if (parseViolations.length > 0) {
    const summary = parseViolations
      .slice(0, 5)
      .map((v) => `${v.kind}: ${v.message}`)
      .join('; ');
    throw new Error(`enrichTaskGraph: Boundary Map invalid (parse violations): ${summary}`);
  }

  const liveSlices = slices.filter((s) => !s._duplicate);
  if (liveSlices.length === 0) {
    throw new Error('enrichTaskGraph: Boundary Map empty (zero slices)');
  }

  // For each slice, extract its File Plan files and map to a task whose
  // files_owned ⊇ those files. If the slice's File Plan files are split
  // across multiple tasks → ambiguous → throw. If no task owns all of
  // them → orphaned slice.
  const sliceToTask = new Map();
  const sliceFilePlanFiles = new Map(); // sliceId → string[]
  for (const slice of liveSlices) {
    const filePlanFiles = extractSliceFilePlanFiles(blueprintText, slice.id);
    if (filePlanFiles.length === 0) {
      throw new Error(
        `enrichTaskGraph: slice ${slice.id} has no File Plan entries. ` +
          `Each slice must declare its File Plan files for slice→task mapping.`,
      );
    }
    sliceFilePlanFiles.set(slice.id, filePlanFiles);
    const fpSet = new Set(filePlanFiles);
    let matchedTaskId = null;
    let partialMatchTaskIds = [];
    for (const task of taskGraph.tasks) {
      const owned = new Set(task.files_owned || []);
      const allOwned = [...fpSet].every((f) => owned.has(f));
      const someOwned = [...fpSet].some((f) => owned.has(f));
      if (allOwned) {
        if (matchedTaskId) {
          throw new Error(
            `enrichTaskGraph: slice ${slice.id} matches multiple tasks ` +
              `(${matchedTaskId}, ${task.id}); decomposition has overlapping files_owned`,
          );
        }
        matchedTaskId = task.id;
      } else if (someOwned) {
        partialMatchTaskIds.push(task.id);
      }
    }
    if (!matchedTaskId) {
      if (partialMatchTaskIds.length > 0) {
        throw new Error(
          `enrichTaskGraph: slice ${slice.id} File Plan files ` +
            `[${[...fpSet].join(', ')}] are split across multiple tasks ` +
            `(partial owners: ${partialMatchTaskIds.join(', ')}). ` +
            `Each slice must map to exactly one task.`,
        );
      }
      throw new Error(
        `enrichTaskGraph: slice ${slice.id} is orphaned — no task owns its File Plan files [${[...fpSet].join(', ')}]`,
      );
    }
    sliceToTask.set(slice.id, matchedTaskId);
  }

  // Reverse map: each task must have ≥1 matching slice.
  const taskToSlices = new Map();
  for (const [sliceId, taskId] of sliceToTask.entries()) {
    if (!taskToSlices.has(taskId)) taskToSlices.set(taskId, []);
    taskToSlices.get(taskId).push(sliceId);
  }
  const orphanedTasks = taskGraph.tasks
    .filter((t) => !taskToSlices.has(t.id))
    .map((t) => t.id);
  if (orphanedTasks.length > 0) {
    throw new Error(
      `enrichTaskGraph: tasks have no matching Boundary Map slice (orphaned): ${orphanedTasks.join(', ')}`,
    );
  }

  // Build the enriched TaskGraph. For each task, concatenate produces/consumes
  // from all matching slices.
  const slicesById = new Map(liveSlices.map((s) => [s.id, s]));
  const enrichedTasks = taskGraph.tasks.map((task) => {
    const matchedSliceIds = taskToSlices.get(task.id) || [];
    const produces = [];
    const consumes = [];
    for (const sid of matchedSliceIds) {
      const s = slicesById.get(sid);
      for (const p of s.produces) {
        produces.push({ file: p.file, symbols: p.symbols, kind: p.kind });
      }
      for (const c of s.consumes) {
        consumes.push({ from: c.from, file: c.file, symbols: c.symbols });
      }
    }
    return {
      ...task,
      produces,
      consumes,
    };
  });

  return { tasks: enrichedTasks };
}
