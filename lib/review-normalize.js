/**
 * review-normalize.js — Parse and normalize model output to canonical ReviewResult.
 *
 * IMPORTANT: Stratum-layer schema validation runs against the post-normalize result
 * via `ensure` expressions evaluated by the Stratum server after `stratum_step_done`.
 * It does NOT run against raw text. The hook in result-normalizer.js must therefore
 * run BEFORE the normalizer returns — do not move this hook later in the pipeline.
 * See: result-normalizer.js hook position, BEFORE the `if (!hasSchema)` early return.
 *
 * Repair-retry model choice (blueprint Decision, Iter 3 F1): use the same model as
 * the original call. It has conversation context, and latency cost is one short call.
 *
 * See: docs/features/STRAT-CLAUDE-EFFORT-PARITY/design.md
 */

// ---------------------------------------------------------------------------
// JSON parsing helpers
// ---------------------------------------------------------------------------

/**
 * Strip markdown code fences and attempt JSON.parse.
 * Handles ```json ... ``` and ``` ... ``` wrappers and leading/trailing prose.
 *
 * @param {string} text
 * @returns {object|null} Parsed object or null on failure
 */
export function parseReviewJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  let candidate = text;

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = candidate.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  // Try direct parse
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* continue */ }

  // Try extracting a JSON object from surrounding prose
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* continue */ }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Text-mode fallback parser (low-confidence findings from prose)
// ---------------------------------------------------------------------------

/**
 * Extract findings from unstructured text using heuristics.
 * Used when JSON parse fails AND no repair-retry is available (or retry also failed).
 * All extracted findings get confidence=5 (below most gates) so they don't block ship.
 *
 * @param {string} text
 * @param {string} lens
 * @param {number} confidenceGate
 * @returns {Array<object>} findings[]
 */
function textModeFindings(text, lens, confidenceGate) {
  const findings = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let severity = null;
    let content = trimmed;

    // Detect severity markers
    if (/must.fix|must_fix|critical|error:/i.test(trimmed)) {
      severity = 'must-fix';
      content = trimmed.replace(/^[-*]\s*/, '').replace(/\*\*(must.fix|critical)\*\*:?\s*/i, '');
    } else if (/should.fix|should_fix|warning:|warn:/i.test(trimmed)) {
      severity = 'should-fix';
      content = trimmed.replace(/^[-*]\s*/, '').replace(/\*\*(should.fix|warning)\*\*:?\s*/i, '');
    } else if (/\bnit\b|style:/i.test(trimmed)) {
      severity = 'nit';
      content = trimmed.replace(/^[-*]\s*/, '').replace(/\*\*nit\*\*:?\s*/i, '');
    } else if (/^[-*]\s+/.test(trimmed)) {
      // Bullet point without explicit severity — treat as should-fix
      severity = 'should-fix';
      content = trimmed.replace(/^[-*]\s+/, '');
    }

    if (severity && content.length > 10) {
      findings.push({
        lens,
        file: null,
        line: null,
        severity,
        finding: content.slice(0, 300),
        confidence: 5, // low confidence — text mode
        applied_gate: confidenceGate,
        rationale: null,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize raw model output text to a canonical ReviewResult.
 *
 * Algorithm:
 * 1. Try JSON parse (strip fences, extract object from prose).
 * 2. On failure: if repairFn provided, call once with repair prompt, reparse.
 *    If no repairFn or second failure, fall through to text-mode parser.
 * 3. Stamp applied_gate on findings missing it (per blueprint Iter 3 F3).
 * 4. Drop findings whose confidence < applied_gate (defensive — prompt should filter).
 * 5. Compute clean = zero blocking findings post-filter.
 * 6. Synthesize summary if model didn't provide.
 * 7. Attach meta.
 * 8. Initialize lenses_run/auto_fixes/asks (populated by merge step, not per-task).
 *
 * @param {string} rawText - Raw model output
 * @param {object} opts
 * @param {'claude'|'codex'} [opts.agentType='claude']
 * @param {string|null} [opts.modelId]
 * @param {number} [opts.confidenceGate=7]
 * @param {string} [opts.lens='general']
 * @param {Function} [opts.repairFn] - async (repairPrompt: string) => string — calls model once
 * @returns {Promise<object>} Canonical ReviewResult
 */
export async function normalizeReviewResult(rawText, {
  agentType = 'claude',
  modelId = null,
  confidenceGate = 7,
  lens = 'general',
  repairFn,
} = {}) {
  // Step 1: Try direct JSON parse
  let parsed = parseReviewJson(rawText);

  // Step 2: Repair-retry on parse failure
  if (!parsed && typeof repairFn === 'function') {
    const repairPrompt = buildRepairPrompt(rawText);
    let repairText = null;
    try {
      repairText = await repairFn(repairPrompt);
    } catch { /* repair call failed — fall through to text mode */ }

    if (repairText) {
      parsed = parseReviewJson(repairText);
    }
  }

  // Step 2 fallback: text-mode extraction
  if (!parsed) {
    const fallbackFindings = textModeFindings(rawText, lens, confidenceGate);
    parsed = {
      summary: null,
      findings: fallbackFindings,
    };
  }

  // Normalize findings array
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];

  // Step 3: Stamp applied_gate on findings missing it
  // Step 4: Drop findings below gate
  const findings = rawFindings
    .map(f => {
      const gate = typeof f.applied_gate === 'number' ? f.applied_gate : confidenceGate;
      return {
        lens: f.lens ?? lens,
        file: f.file ?? null,
        line: f.line ?? null,
        severity: normalizeSeverity(f.severity),
        finding: f.finding ?? f.description ?? String(f),
        confidence: typeof f.confidence === 'number' ? f.confidence : 5,
        applied_gate: gate,
        rationale: f.rationale ?? null,
      };
    })
    .filter(f => f.confidence >= f.applied_gate);

  // Step 5: Compute clean
  const blocking = findings.filter(f =>
    f.severity === 'must-fix' || f.severity === 'should-fix'
  );
  const clean = blocking.length === 0;

  // Step 6: Synthesize summary if not provided
  const mustFixCount = findings.filter(f => f.severity === 'must-fix').length;
  const shouldFixCount = findings.filter(f => f.severity === 'should-fix').length;
  const nitCount = findings.filter(f => f.severity === 'nit').length;
  const summary = (typeof parsed.summary === 'string' && parsed.summary.trim())
    ? parsed.summary.trim()
    : `${findings.length} findings (${mustFixCount} must-fix, ${shouldFixCount} should-fix, ${nitCount} nit).`;

  // Steps 7-8: Attach meta and initialize optional fields
  return {
    clean,
    summary,
    findings,
    meta: {
      agent_type: agentType,
      model_id: modelId ?? null,
    },
    lenses_run: [],
    auto_fixes: [],
    asks: [],
  };
}

// ---------------------------------------------------------------------------
// Cross-model synthesis normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize raw synthesis output from runCrossModelReview to a canonical
 * CrossModelReviewResult — a ReviewResult extended with consensus, claude_only,
 * and codex_only arrays of canonical finding items.
 *
 * Algorithm:
 * 1. Parse the synthesis JSON (strip fences, extract from prose).
 * 2. On failure: if repairFn provided, call once with a cross-model repair prompt.
 *    If no repairFn or retry failed, fall back to placing all text-mode findings in codex_only.
 * 3. Normalize each finding in the three arrays: stamp applied_gate if missing,
 *    enforce canonical severity vocab.
 * 4. Merge all findings into top-level `findings` array (for ReviewResult compatibility).
 * 5. Compute clean = zero blocking findings across all three arrays.
 * 6. Attach meta with agent_type='claude' (synthesis is always run by Claude).
 *
 * @param {string} rawText - Raw synthesis model output
 * @param {object} opts
 * @param {string|null} [opts.modelId]
 * @param {number} [opts.confidenceGate=7]
 * @param {Array} [opts.claudeFindingsFallback=[]] - Claude findings to use when parse fails
 * @param {Array} [opts.codexFindingsFallback=[]]  - Codex-as-fallback findings to use when parse fails
 * @param {Function} [opts.repairFn] - async (repairPrompt: string) => string
 * @returns {Promise<object>} Canonical CrossModelReviewResult
 */
export async function normalizeCrossModelResult(rawText, {
  modelId = null,
  confidenceGate = 7,
  claudeFindingsFallback = [],
  codexFindingsFallback = [],
  repairFn,
} = {}) {
  // Step 1: Try direct JSON parse
  let parsed = parseReviewJson(rawText);

  // Step 2: Repair-retry on parse failure
  if (!parsed && typeof repairFn === 'function') {
    const repairPrompt = buildCrossModelRepairPrompt(rawText);
    let repairText = null;
    try {
      repairText = await repairFn(repairPrompt);
    } catch { /* repair call failed — fall through to fallback */ }

    if (repairText) {
      parsed = parseReviewJson(repairText);
    }
  }

  // Step 2 fallback: treat the synthesis as all-or-nothing.
  // A partial response (e.g., consensus parsed but claude_only/codex_only missing) cannot be
  // trusted to have correctly partitioned findings — mixing parsed `consensus` with full Claude
  // fallback would duplicate items that the model already moved into consensus.
  // If any of the three required arrays is missing, fall back wholesale.
  let consensusRaw, claudeOnlyRaw, codexOnlyRaw;
  const hasAllArrays = parsed && typeof parsed === 'object'
    && Array.isArray(parsed.consensus)
    && Array.isArray(parsed.claude_only)
    && Array.isArray(parsed.codex_only);
  if (!hasAllArrays) {
    consensusRaw  = [];
    claudeOnlyRaw = claudeFindingsFallback;
    codexOnlyRaw  = codexFindingsFallback;
  } else {
    consensusRaw  = parsed.consensus;
    claudeOnlyRaw = parsed.claude_only;
    codexOnlyRaw  = parsed.codex_only;
  }

  // Step 3: Normalize each finding in all three arrays
  const normalizeFinding = (f) => {
    const gate = typeof f.applied_gate === 'number' ? f.applied_gate : confidenceGate;
    return {
      lens:         f.lens ?? 'general',
      file:         f.file ?? null,
      line:         f.line ?? null,
      severity:     normalizeSeverity(f.severity),
      finding:      f.finding ?? f.description ?? String(f),
      confidence:   typeof f.confidence === 'number' ? f.confidence : 5,
      applied_gate: gate,
      rationale:    f.rationale ?? null,
    };
  };

  const consensus  = consensusRaw.map(normalizeFinding).filter(f => f.confidence >= f.applied_gate);
  const claude_only = claudeOnlyRaw.map(normalizeFinding).filter(f => f.confidence >= f.applied_gate);
  const codex_only  = codexOnlyRaw.map(normalizeFinding).filter(f => f.confidence >= f.applied_gate);

  // Step 4: Merge all findings into top-level findings array
  const findings = [...consensus, ...claude_only, ...codex_only];

  // Step 5: Compute clean across all three arrays
  const blocking = findings.filter(f => f.severity === 'must-fix' || f.severity === 'should-fix');
  const clean = blocking.length === 0;

  // Synthesize summary
  const mustFixCount  = findings.filter(f => f.severity === 'must-fix').length;
  const shouldFixCount = findings.filter(f => f.severity === 'should-fix').length;
  const nitCount      = findings.filter(f => f.severity === 'nit').length;
  const summary = (typeof parsed?.summary === 'string' && parsed.summary.trim())
    ? parsed.summary.trim()
    : `Cross-model synthesis: ${consensus.length} consensus, ${claude_only.length} Claude-only, ${codex_only.length} Codex-only. ${findings.length} total (${mustFixCount} must-fix, ${shouldFixCount} should-fix, ${nitCount} nit).`;

  // Step 6: Attach meta
  return {
    clean,
    summary,
    findings,
    meta: {
      agent_type: 'claude',
      model_id: modelId ?? null,
    },
    lenses_run: [],
    auto_fixes: [],
    asks: [],
    consensus,
    claude_only,
    codex_only,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a repair prompt asking the model to fix malformed JSON.
 *
 * @param {string} badText - The malformed model output
 * @returns {string}
 */
function buildRepairPrompt(badText) {
  return (
    'The following text was supposed to be a JSON object matching the ReviewResult schema ' +
    'but failed to parse. Please fix it and return ONLY valid JSON — no prose.\n\n' +
    'Expected schema:\n' +
    '{\n' +
    '  "summary": string,\n' +
    '  "findings": [\n' +
    '    { "lens": string, "file": string|null, "line": integer|null,\n' +
    '      "severity": "must-fix"|"should-fix"|"nit",\n' +
    '      "finding": string, "confidence": 1-10, "applied_gate": 1-10 }\n' +
    '  ]\n' +
    '}\n\n' +
    'Malformed input:\n' +
    badText.slice(0, 2000)
  );
}

/**
 * Build a repair prompt for malformed cross-model synthesis JSON.
 *
 * @param {string} badText - The malformed synthesis output
 * @returns {string}
 */
function buildCrossModelRepairPrompt(badText) {
  return (
    'The following text was supposed to be a JSON object matching the CrossModelReviewResult schema ' +
    'but failed to parse. Please fix it and return ONLY valid JSON — no prose.\n\n' +
    'Expected schema:\n' +
    '{\n' +
    '  "summary": string,\n' +
    '  "consensus": [\n' +
    '    { "lens": string, "file": string|null, "line": integer|null,\n' +
    '      "severity": "must-fix"|"should-fix"|"nit",\n' +
    '      "finding": string, "confidence": 1-10, "applied_gate": 1-10 }\n' +
    '  ],\n' +
    '  "claude_only": [ <same shape> ],\n' +
    '  "codex_only":  [ <same shape> ]\n' +
    '}\n\n' +
    'Malformed input:\n' +
    badText.slice(0, 2000)
  );
}

/**
 * Normalize severity strings to canonical values.
 * Accepts: must-fix, must_fix, MUST-FIX, should-fix, should_fix, nit, etc.
 *
 * @param {string} raw
 * @returns {'must-fix'|'should-fix'|'nit'}
 */
function normalizeSeverity(raw) {
  if (!raw) return 'nit';
  const s = String(raw).toLowerCase().replace(/_/g, '-');
  if (s === 'must-fix' || s === 'critical' || s === 'error') return 'must-fix';
  if (s === 'should-fix' || s === 'warning' || s === 'warn') return 'should-fix';
  return 'nit';
}
