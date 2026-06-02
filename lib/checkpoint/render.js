/**
 * COMP-RESUME S11-render — render a Checkpoint to Markdown for human inspection.
 *
 * PURE: no fs, no git, no network, no imports from other checkpoint modules.
 * Markdown is NOT the store of record (the JSONL backend is); this view exists
 * only so a human can read a checkpoint (e.g. in `compose_resume` output).
 *
 * Anchor checkpoints (soft === null) render an explicit "(anchor — no narrative)"
 * marker in place of the Intent body. Narrative checkpoints render their
 * agent-authored goal/nextStep/risks. The Environment section reflects the
 * deterministic fingerprint (records, never interprets).
 *
 * @see docs/features/COMP-RESUME/blueprint.md (slice S11)
 * @see contracts/checkpoint.schema.json
 */

const SHORT_SHA_LEN = 7;

/**
 * Shorten a git sha for display; passes through non-sha / null values.
 * @param {string|null|undefined} sha
 * @returns {string}
 */
function shortSha(sha) {
  if (!sha || typeof sha !== 'string') return '(none)';
  return sha.slice(0, SHORT_SHA_LEN);
}

/**
 * Render a markdown bullet list, or a placeholder line when empty.
 * @param {string[]} items
 * @param {string} emptyText
 * @returns {string}
 */
function bulletList(items, emptyText) {
  if (!Array.isArray(items) || items.length === 0) return emptyText;
  return items.map((i) => `- ${i}`).join('\n');
}

/**
 * Render a checkpoint to a Markdown string for human inspection.
 *
 * @param {object} cp - A Checkpoint (see contracts/checkpoint.schema.json).
 * @returns {string} markdown
 */
export function renderCheckpoint(cp) {
  const checkpoint = cp || {};
  const fp = checkpoint.fingerprint || {};
  const git = fp.git || {};
  const artifacts = fp.phaseArtifacts || {};

  const lines = [];

  // Heading: featureCode + phase + createdAt
  const featureCode = checkpoint.featureCode ?? '(unknown feature)';
  const phase = checkpoint.phase ?? '(unknown phase)';
  lines.push(`# Checkpoint — ${featureCode} · ${phase}`);
  lines.push('');
  const trigger = checkpoint.trigger ? ` · trigger: \`${checkpoint.trigger}\`` : '';
  lines.push(`_Created: ${checkpoint.createdAt ?? '(unknown)'}${trigger}_`);
  lines.push('');

  // Intent section
  lines.push('## Intent');
  if (checkpoint.soft) {
    const soft = checkpoint.soft;
    lines.push(`- **Goal:** ${soft.goal ?? ''}`);
    lines.push(`- **Next step:** ${soft.nextStep ?? ''}`);
    lines.push('- **Risks:**');
    lines.push(bulletList(soft.risks, '  - (none recorded)'));
  } else {
    lines.push('(anchor — no narrative)');
  }
  lines.push('');

  // Environment section (deterministic fingerprint)
  lines.push('## Environment');
  lines.push(`- **Git head:** \`${shortSha(git.head)}\``);
  lines.push(`- **Branch:** ${git.branch ?? '(none)'}`);
  lines.push(`- **Tree:** ${git.dirty ? 'dirty' : 'clean'}`);

  // Present phaseArtifacts only (skip null/empty)
  const present = [];
  if (artifacts.design) present.push(`design: \`${artifacts.design}\``);
  if (artifacts.blueprint) present.push(`blueprint: \`${artifacts.blueprint}\``);
  if (artifacts.plan) present.push(`plan: \`${artifacts.plan}\``);
  if (Array.isArray(artifacts.implementFiles) && artifacts.implementFiles.length) {
    present.push(`implement: ${artifacts.implementFiles.map((f) => `\`${f}\``).join(', ')}`);
  }
  if (Array.isArray(artifacts.contracts) && artifacts.contracts.length) {
    present.push(`contracts: ${artifacts.contracts.map((f) => `\`${f}\``).join(', ')}`);
  }
  lines.push('- **Artifacts present:**');
  lines.push(present.length ? present.map((p) => `  - ${p}`).join('\n') : '  - (none)');

  if (fp.testRef) {
    lines.push(`- **Test output (raw):** \`${fp.testRef}\``);
  }

  // Confidence line — only when present (resume-sync checkpoints).
  if (typeof checkpoint.confidence === 'number') {
    lines.push('');
    lines.push(`**Confidence:** ${checkpoint.confidence}`);
  }

  return lines.join('\n');
}
