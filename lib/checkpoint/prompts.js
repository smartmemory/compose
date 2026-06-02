/**
 * COMP-RESUME S6 — agent prompt builders (pure string functions).
 *
 * These build the prompts handed to the scribe and reconciliation agents.
 * They are PURE: no fs, no git, no network, no imports from other checkpoint
 * modules. The caller captures the fingerprint and passes it in; these
 * functions only format it into instructions.
 *
 * Design anchors:
 *  - Decision 1/4: the scribe writes ONLY the soft layer {goal,nextStep,risks},
 *    merged onto a fresh anchor by the caller.
 *  - Decision 2/4: the fingerprint records, never interprets. The scribe must
 *    NOT assert verdicts ("tests pass"); every factual claim must reference an
 *    anchor in the provided fingerprint (e.g. point at testRef).
 *  - Decision 5: the reconciliation agent treats the live ENVIRONMENT as ground
 *    truth; the stale checkpoint is advisory and may be wrong. It emits a synced
 *    checkpoint {soft, confidence, resumeAction} and lowers confidence when
 *    uncertain.
 *
 * @see docs/features/COMP-RESUME/blueprint.md (slice S6)
 * @see docs/features/COMP-RESUME/design.md (Decisions 1, 2, 4, 5)
 */

/**
 * Pretty-print a value as a fenced JSON block for embedding in a prompt.
 * Falls back to String(value) if the value isn't serializable.
 * @param {unknown} value
 * @returns {string}
 */
function jsonBlock(value) {
  let body;
  try {
    body = JSON.stringify(value ?? null, null, 2);
  } catch {
    body = String(value);
  }
  return '```json\n' + body + '\n```';
}

/**
 * Render the git portion of a fingerprint as a compact human-readable line.
 * @param {object} fp - EnvFingerprint
 * @returns {string}
 */
function gitSummary(fp) {
  const git = (fp && fp.git) || {};
  const head = git.head == null ? '(no repo)' : git.head;
  const branch = git.branch == null ? '(detached/none)' : git.branch;
  const dirty = git.dirty ? 'dirty' : 'clean';
  return `head=${head} branch=${branch} tree=${dirty}`;
}

/**
 * Build the scribe prompt.
 *
 * The scribe is invoked at major boundaries to author the soft layer. It must
 * return ONLY a JSON object `{ "goal": string, "nextStep": string, "risks":
 * string[] }` and nothing else, with every factual claim anchored to the
 * provided fingerprint (never a remembered verdict).
 *
 * @param {object} args
 * @param {object} args.fingerprint - EnvFingerprint captured at this boundary (ground truth).
 * @param {string} [args.journalTail] - Recent journal/build-stream tail for context.
 * @param {object|null} [args.priorCheckpoint] - The previous narrative checkpoint, if any.
 * @returns {string} prompt text
 */
export function scribePrompt({ fingerprint, journalTail = '', priorCheckpoint = null }) {
  const fp = fingerprint || {};
  const sections = [];

  sections.push(
    'You are the Compose **scribe**. Your sole job is to record the *intent* of the current build state — what the goal is, what the single next step is, and what risks are live right now.',
  );

  sections.push(
    [
      'CRITICAL RULES:',
      '1. Return ONLY a single JSON object and nothing else — no prose, no markdown, no code fences. The object MUST be exactly:',
      jsonBlock({ goal: 'string', nextStep: 'string', risks: ['string'] }),
      '2. The ENVIRONMENT FINGERPRINT below is ground truth. Every factual claim you make MUST reference an anchor that appears in the fingerprint (a git head/branch, an artifact path, the testRef). Do NOT invent state that is not anchored there.',
      "3. Do NOT claim results or verdicts. Specifically: do NOT claim tests pass or fail — reference the fingerprint's testRef (the raw test-output path) instead and let the reader inspect it. The fingerprint records what exists; it never interprets.",
      '4. `goal` and `nextStep` are required and must be non-empty. `risks` is an array (use [] if none).',
    ].join('\n'),
  );

  sections.push(
    [
      'ENVIRONMENT FINGERPRINT (ground truth — anchor every claim to this):',
      `Git: ${gitSummary(fp)}`,
      jsonBlock(fp),
    ].join('\n'),
  );

  if (journalTail && String(journalTail).trim()) {
    sections.push(
      ['RECENT JOURNAL / BUILD-STREAM TAIL (context only — not authoritative):', String(journalTail).trim()].join('\n'),
    );
  }

  if (priorCheckpoint && priorCheckpoint.soft) {
    const soft = priorCheckpoint.soft;
    sections.push(
      [
        'PRIOR NARRATIVE CHECKPOINT (the last recorded intent — may be stale; reconcile against the fingerprint):',
        `- goal: ${soft.goal ?? ''}`,
        `- nextStep: ${soft.nextStep ?? ''}`,
        Array.isArray(soft.risks) && soft.risks.length
          ? `- risks: ${soft.risks.join('; ')}`
          : '- risks: (none recorded)',
      ].join('\n'),
    );
  }

  sections.push('Now emit the JSON object describing the current intent, and nothing else.');

  return sections.join('\n\n');
}

/**
 * Build the reconciliation prompt.
 *
 * Used on resume only when the environment has DIVERGED from the stale
 * checkpoint. The agent treats the live environment as ground truth, reconciles
 * the stale checkpoint's intent against what the environment shows now, and
 * returns ONLY a JSON object `{ "soft": {goal,nextStep,risks}, "confidence":
 * number 0..1, "resumeAction": string }`.
 *
 * @param {object} args
 * @param {object} args.staleCheckpoint - The last stored checkpoint (advisory, may be wrong).
 * @param {object} args.liveFingerprint - The freshly captured EnvFingerprint (ground truth).
 * @param {string} [args.envScan] - Extra environment scan text (diffs, file listings, test output excerpt).
 * @returns {string} prompt text
 */
export function reconcilePrompt({ staleCheckpoint, liveFingerprint, envScan = '' }) {
  const stale = staleCheckpoint || {};
  const staleSoft = stale.soft || {};
  const live = liveFingerprint || {};
  const sections = [];

  sections.push(
    'You are the Compose **reconciliation agent**. A build is being resumed after an interruption. Your job is to reconcile the recorded intent against the current environment and produce a corrected, synced checkpoint.',
  );

  sections.push(
    [
      'GROUND TRUTH RULE:',
      'The live ENVIRONMENT (git state + on-disk artifacts + logs) is GROUND TRUTH. The stale checkpoint below is ADVISORY ONLY and may be wrong, out of date, or contradicted by the environment. When they disagree, the environment wins — every time.',
    ].join('\n'),
  );

  sections.push(
    [
      'OUTPUT RULES:',
      'Return ONLY a single JSON object and nothing else — no prose, no markdown, no code fences. The object MUST be exactly:',
      jsonBlock({
        soft: { goal: 'string', nextStep: 'string', risks: ['string'] },
        confidence: 'number between 0 and 1',
        resumeAction: 'string',
      }),
      '- `confidence` is a number from 0 to 1 expressing how sure you are that the synced intent matches the environment. Lower confidence when the environment is ambiguous, the divergence is large, or you cannot tell what was in progress.',
      '- `resumeAction` is a short imperative describing the concrete next action to take to resume the build.',
      '- `soft.goal` and `soft.nextStep` are required and must be non-empty; `soft.risks` is an array (use [] if none).',
    ].join('\n'),
  );

  sections.push(
    [
      'LIVE ENVIRONMENT FINGERPRINT (ground truth):',
      `Git: ${gitSummary(live)}`,
      jsonBlock(live),
    ].join('\n'),
  );

  sections.push(
    [
      'STALE CHECKPOINT (advisory — what the build *expected*; may be wrong):',
      `- phase: ${stale.phase ?? '(unknown)'}`,
      `- goal: ${staleSoft.goal ?? '(none recorded)'}`,
      `- nextStep: ${staleSoft.nextStep ?? '(none recorded)'}`,
      Array.isArray(staleSoft.risks) && staleSoft.risks.length
        ? `- risks: ${staleSoft.risks.join('; ')}`
        : '- risks: (none recorded)',
      '',
      'Its captured fingerprint (what the environment looked like when this was recorded):',
      jsonBlock(stale.fingerprint ?? null),
    ].join('\n'),
  );

  if (envScan && String(envScan).trim()) {
    sections.push(
      ['ADDITIONAL ENVIRONMENT SCAN (ground truth — diffs / listings / raw test output):', String(envScan).trim()].join(
        '\n',
      ),
    );
  }

  sections.push(
    [
      'TASK:',
      'Compare what the environment shows NOW against what the checkpoint expected. Reconcile any divergence: where they conflict, follow the environment. Produce the corrected `soft` intent reflecting the current reality, set `resumeAction` to the next concrete step, and set `confidence` honestly — lower the confidence whenever you are uncertain or the divergence cannot be cleanly explained.',
      'Now emit the JSON object, and nothing else.',
    ].join('\n'),
  );

  return sections.join('\n\n');
}
