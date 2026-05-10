// lib/gsd-prompt.js
//
// COMP-GSD-2 T4: buildTaskDescription — pure string assembly.
//
// Stratum's parallel_dispatch only interpolates {task.id|description|
// files_owned|files_read|depends_on|index} and {input.<field>}. Every other
// piece of context — the per-slice produces/consumes contract, the upstream
// tasks summary, the gate commands — must be packed inside `task.description`.
//
// This module produces the rich `description` string. It is also used by
// runGsd as a deterministic fallback when the decompose_gsd agent failed to
// bake a description into a task.
//
// Pure function. No fs, no globals.

const SECTION_DIVIDER = '---';

function formatProduces(produces) {
  if (!produces || produces.length === 0) return '(none)';
  const lines = produces.map((p) => {
    const syms = (p.symbols || []).join(', ');
    return `  ${p.file} → ${syms} (${p.kind})`;
  });
  return lines.join('\n');
}

function formatConsumes(consumes) {
  if (!consumes || consumes.length === 0) return '(none)';
  const lines = consumes.map((c) => {
    const syms = (c.symbols || []).join(', ');
    return `  from ${c.from}: ${c.file} → ${syms}`;
  });
  return lines.join('\n');
}

function formatUpstream(task, upstreamTasks) {
  const deps = new Set(task.depends_on || []);
  const filtered = (upstreamTasks || []).filter((t) => deps.has(t.id));
  if (filtered.length === 0) return '(none)';
  return filtered
    .map((t) => {
      const producesStr = (t.produces || [])
        .map((p) => `${p.file} → ${(p.symbols || []).join(', ')} (${p.kind})`)
        .join('; ');
      return `  ${t.id}: produces ${producesStr || '(none)'}`;
    })
    .join('\n');
}

function formatGates(gateCommands) {
  if (!gateCommands || gateCommands.length === 0) return '(none)';
  return gateCommands.map((c) => `  - ${c}`).join('\n');
}

export function buildTaskDescription({ task, slice, upstreamTasks, gateCommands }) {
  if (!task || typeof task !== 'object') {
    throw new Error('buildTaskDescription: task object required');
  }

  // The function PRODUCES task.description — it must not embed any preexisting
  // description (which may itself be malformed; this is the repair path). The
  // output is the fresh, canonical description.
  const lines = [];
  lines.push('Symbols you must produce:');
  lines.push(formatProduces(task.produces));
  lines.push('');
  lines.push('Symbols you may consume from upstream tasks:');
  lines.push(formatConsumes(task.consumes));
  lines.push('');
  lines.push('Boundary Map slice (the contract for this task):');
  lines.push(typeof slice === 'string' ? slice : '(slice text not provided)');
  lines.push('');
  lines.push('Upstream tasks (spec-level summary; their code lands at end-of-step merge):');
  lines.push(formatUpstream(task, upstreamTasks));
  lines.push('');
  lines.push('GATES — you MUST run each command and they MUST pass before declaring done:');
  lines.push(formatGates(gateCommands));
  lines.push('');
  lines.push('Fix and re-run within this invocation. Do NOT declare done while gates are red.');

  return lines.join('\n');
}
