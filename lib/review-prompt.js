/**
 * review-prompt.js — Shared review prompt scaffold for STRAT-CLAUDE-EFFORT-PARITY.
 *
 * Builds a unified system prompt injected at review time. Both Claude and Codex
 * review paths use the same severity vocabulary, confidence scale, and output format.
 * Per-model nudges are appended at the end.
 *
 * Cert (reasoning template) injection is NOT done here — call sites in build.js
 * compose buildReviewPrompt(...) then call injectCertInstructions(scaffold, template)
 * separately, matching the existing pattern at build.js:2625.
 *
 * See: docs/features/STRAT-CLAUDE-EFFORT-PARITY/design.md (Decision 3)
 */

// ---------------------------------------------------------------------------
// Severity vocabulary block — identical text across all calls
// ---------------------------------------------------------------------------

const SEVERITY_VOCAB_BLOCK = `
## Severity Vocabulary

Use EXACTLY these severity values — no others:
- **must-fix**: Blocks ship. Correctness bugs, security vulnerabilities, broken contracts, data loss risks.
- **should-fix**: Address in next iteration. Clarity gaps, missing edge-case tests, fragile patterns.
- **nit**: Logged only, does not block. Style, naming, minor consistency.
`.trim();

// ---------------------------------------------------------------------------
// Confidence scale block
// ---------------------------------------------------------------------------

const CONFIDENCE_SCALE_BLOCK = `
## Confidence Scale

Score your confidence in each finding from 1 to 10:
- 10: Certain — the issue is definitively present with direct evidence.
- 7-9: High — strong evidence, highly probable issue.
- 4-6: Medium — plausible but requires verification.
- 1-3: Low — speculative, insufficient evidence.
`.trim();

// ---------------------------------------------------------------------------
// Output format block
// ---------------------------------------------------------------------------

const OUTPUT_FORMAT_BLOCK = `
## Output Format

Return a JSON object matching this schema exactly:

{
  "summary": "<1-3 sentence narrative>",
  "findings": [
    {
      "lens": "<lens name or 'general'>",
      "file": "<relative file path or null>",
      "line": <integer or null>,
      "severity": "must-fix" | "should-fix" | "nit",
      "finding": "<concise, actionable description>",
      "confidence": <integer 1-10>,
      "applied_gate": <integer — the confidence gate used>,
      "rationale": "<optional structured reasoning or null>"
    }
  ]
}

If no findings meet the confidence gate, return: { "summary": "No findings above gate.", "findings": [] }
`.trim();

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build a unified review prompt string.
 *
 * @param {object} opts
 * @param {'claude'|'codex'} opts.agentType          - Which model type will receive this prompt
 * @param {string} [opts.lens='general']              - Lens name or 'general' for single-pass
 * @param {string} [opts.lensFocus]                   - Lens-specific focus instructions
 * @param {string} [opts.exclusions]                  - What NOT to flag (false-positive exclusions)
 * @param {number} [opts.confidenceGate=7]            - Minimum confidence to emit a finding
 * @param {string} [opts.taskDescription]             - What was implemented
 * @param {string} [opts.blueprint]                   - Blueprint/spec content
 * @param {object} [opts.reasoningTemplate]           - Ignored here; call injectCertInstructions() at the call site after buildReviewPrompt returns.
 * @returns {string} Complete prompt string
 */
export function buildReviewPrompt({
  agentType = 'claude',
  lens = 'general',
  lensFocus,
  exclusions,
  confidenceGate = 7,
  taskDescription,
  blueprint,
  reasoningTemplate,
} = {}) {
  const parts = [];

  // 1. Role line
  if (lens !== 'general') {
    parts.push(`You are a ${lens} reviewer performing a focused code review.`);
  } else {
    parts.push('You are a senior code reviewer performing a comprehensive code review.');
  }
  parts.push('');

  // 2. Severity vocabulary (identical across calls)
  parts.push(SEVERITY_VOCAB_BLOCK);
  parts.push('');

  // 3. Confidence scale
  parts.push(CONFIDENCE_SCALE_BLOCK);
  parts.push('');

  // 4. Output format
  parts.push(OUTPUT_FORMAT_BLOCK);
  parts.push('');

  // 5. Confidence gate instruction
  parts.push(
    `## Confidence Gate\n\n` +
    `Only emit findings with confidence >= ${confidenceGate}. ` +
    `Stamp \`applied_gate = ${confidenceGate}\` on every finding you emit. ` +
    `Silently discard findings below this threshold.`
  );
  parts.push('');

  // 6. Per-lens focus (when not general)
  if (lens !== 'general' && lensFocus) {
    parts.push(`## Lens Focus: ${lens}\n\n${lensFocus}`);
    parts.push('');
  }

  // 7. Exclusions
  if (exclusions) {
    parts.push(`## Exclusions\n\nDo NOT flag: ${exclusions}`);
    parts.push('');
  }

  // 8. Task / blueprint context
  if (taskDescription) {
    parts.push(`## Task\n\n${taskDescription}`);
    parts.push('');
  }
  if (blueprint) {
    parts.push(`## Blueprint\n\n${blueprint}`);
    parts.push('');
  }

  // 9. Per-model nudge
  if (agentType === 'codex') {
    parts.push(
      '## Output Instruction\n\n' +
      'Output exactly one JSON code-fence containing the result object described above. ' +
      'No prose before or after the code-fence.'
    );
  }
  // For Claude: cert (reasoning template) injection is handled at the call site in build.js
  // via injectCertInstructions(scaffold, reasoningTemplate) after buildReviewPrompt returns.

  return parts.join('\n');
}
