/**
 * Step Prompt Builder — constructs agent prompts from Stratum step dispatch responses.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkStaleness } from './staleness.js';
import { readHypotheses, formatRejectedHypotheses } from './bug-ledger.js';

// ---------------------------------------------------------------------------
// Ambient context cache — loaded once per build, keyed by contextDir path.
// Cleared between builds by passing context.contextDir on first call.
// ---------------------------------------------------------------------------

const _contextCache = new Map();

/**
 * Load and concatenate all .md files from docs/context/ (or the configured
 * contextDir). Returns the combined text or null if the directory is absent.
 * Results are cached so disk reads happen once per build context dir.
 *
 * @param {string} contextDir - Absolute path to the context directory
 * @returns {string|null}
 */
export function loadAmbientContext(contextDir) {
  if (!contextDir || !existsSync(contextDir)) return null;
  if (_contextCache.has(contextDir)) return _contextCache.get(contextDir);

  let files;
  try {
    files = readdirSync(contextDir).filter(f => f.endsWith('.md')).sort();
  } catch {
    return null;
  }

  const parts = [];
  for (const filename of files) {
    try {
      const content = readFileSync(join(contextDir, filename), 'utf-8').trimEnd();
      if (content) parts.push(content);
    } catch {
      // skip unreadable files
    }
  }

  const combined = parts.length > 0 ? parts.join('\n\n') : null;
  _contextCache.set(contextDir, combined);
  return combined;
}

/**
 * Clear the ambient context cache for a given contextDir (call at build start).
 *
 * @param {string} contextDir
 */
export function clearAmbientContextCache(contextDir) {
  if (contextDir) _contextCache.delete(contextDir);
}

/**
 * Build an agent prompt from a step dispatch and execution context.
 *
 * @param {object} stepDispatch - Stratum step dispatch (step_id, intent, inputs, output_fields, ensure)
 * @param {object} context      - Execution context (cwd, featureCode, contextDir?)
 * @returns {string}
 */
export function buildStepPrompt(stepDispatch, context) {
  const sections = [];

  sections.push(`You are executing step "${stepDispatch.step_id}" in a Stratum workflow.`);

  sections.push(`## Intent\n${stepDispatch.intent}`);

  // D7(a): restore the exact TaskResult filename contract. The engine renders
  // only whole `${item}` (dotted `${item.id}` is REF_INVALID), so the per-item
  // output path is rendered compose-side from the item's id. When the consumer
  // loop supplies it, spell out the exact path so the agent cannot misname the
  // file the blackboard reader expects.
  if (context.taskResultPath) {
    sections.push(
      `## TaskResult Output File\n`
      + `Write your TaskResult JSON to EXACTLY this path (do not choose a different name):\n`
      + `\`${context.taskResultPath}\``,
    );
  }

  // A retried issuance (e.g. a consumer-fanout item that failed its contract,
  // ensure, or connector on a prior attempt) carries the engine's structured
  // previousFailure. Render its reason so the retry can fix the cause rather
  // than repeat it.
  if (stepDispatch.previousFailure) {
    const pf = stepDispatch.previousFailure;
    const reason = typeof pf === 'string'
      ? pf
      : (typeof pf.reason === 'string' ? pf.reason : JSON.stringify(pf));
    if (reason) {
      const attemptNote = typeof pf === 'object' && Number.isInteger(pf.attempt)
        ? ` (attempt ${pf.attempt})`
        : '';
      sections.push(`## Previous Attempt Failed${attemptNote}\nYour previous attempt was rejected. Fix the cause before finishing:\n${reason}`);
    }
  }

  sections.push(`## Inputs\n${JSON.stringify(stepDispatch.inputs, null, 2)}`);

  if (Array.isArray(stepDispatch.output_fields) && stepDispatch.output_fields.length > 0) {
    const fieldLines = stepDispatch.output_fields
      .map(f => `- ${f.name} (${f.type})`)
      .join('\n');
    sections.push(`## Expected Output\nReturn a JSON object with these fields:\n${fieldLines}`);
  }

  if (Array.isArray(stepDispatch.ensure) && stepDispatch.ensure.length > 0) {
    const ensureLines = stepDispatch.ensure.map(e => `- ${e}`).join('\n');
    sections.push(`## Postconditions\nYour result must satisfy:\n${ensureLines}`);
  }

  // Inject ambient project context (docs/context/*.md) — cached per build
  if (context.contextDir) {
    const ambient = loadAmbientContext(context.contextDir);
    if (ambient) {
      sections.push(`## Project Context\n${ambient}`);
    }
  }

  // COMP-MCP-MIGRATION: typed-tool enforcement (prompt-only in v1).
  // When `enforcement.mcpForFeatureMgmt` is true in .compose/compose.json,
  // inject a hard instruction telling the agent to use typed MCP tools
  // instead of free-text Edit/Write for ROADMAP/CHANGELOG/feature.json.
  if (context.enforceMcpForFeatureMgmt) {
    sections.push(
      '## Enforcement\n' +
      'Do NOT use Edit, Write, or any shell write that targets `ROADMAP.md`, ' +
      '`CHANGELOG.md`, or any `feature.json` under `docs/features/`. Use the ' +
      'typed MCP tools instead: `add_roadmap_entry`, `set_feature_status`, ' +
      '`add_changelog_entry`, `record_completion`, `propose_followup`, ' +
      '`link_features`, `link_artifact`, `write_journal_entry`.'
    );
  }

  const ctxLines = [
    `Working directory: ${context.cwd}`,
    `Feature: ${context.featureCode}`,
  ];
  if (context.featureDir) {
    ctxLines.push(`Feature docs: ${context.featureDir}`);
  }
  sections.push(`## Context\n${ctxLines.join('\n')}`);

  // Inject prior step results so the agent doesn't re-explore from scratch
  if (Array.isArray(context.stepHistory) && context.stepHistory.length > 0) {
    const historyLines = context.stepHistory.map(h => {
      let line = `- **${h.stepId}**: ${h.summary}`;
      if (h.artifact) line += ` → \`${h.artifact}\``;
      return line;
    });
    sections.push(`## Prior Steps\n${historyLines.join('\n')}`);

    // If any prior step captured a file manifest, include it for downstream steps
    // (context.filesChanged is maintained as a pre-deduplicated array in build.js)
    if (context.filesChanged?.length > 0) {
      sections.push(`## Files Changed by This Feature\n${context.filesChanged.map(f => '- ' + f).join('\n')}`);
    }
  }

  // COMP-FIX-HARD T6: on a bug-mode DIAGNOSE (re)attempt, surface the previously
  // REJECTED hypotheses from the per-bug ledger at the very TOP of the prompt so
  // the agent does not re-propose a diagnosis already ruled out. The TS diagnose
  // retry reissues through buildStepPrompt (there is no separate buildRetryPrompt
  // in v1), so the ledger context — which previousFailure.reason alone dropped —
  // is restored here. Only bug mode + the diagnose step + a populated ledger of
  // rejected entries renders anything; every other step is byte-identical.
  if (context.mode === 'bug' && context.bug_code && stepDispatch.step_id === 'diagnose') {
    const rejectedBlock = formatRejectedHypotheses(readHypotheses(context.cwd, context.bug_code));
    if (rejectedBlock) sections.unshift(rejectedBlock.trimEnd());
  }

  return sections.join('\n\n');
}

/**
 * Build context preamble for a gate Q&A agent.
 *
 * Assembles the same execution context that regular steps get so the agent
 * answering gate questions knows what feature is being built, what just
 * completed, what files were touched, and what the gate controls.
 *
 * @param {object} gateDispatch - Stratum gate dispatch (step_id, on_approve, on_revise, on_kill)
 * @param {object} context      - Execution context (cwd, featureCode, featureDir, stepHistory, filesChanged)
 * @param {object} [gateExtras] - Optional enrichment (fromPhase, toPhase, summary)
 * @returns {string}
 */
export function buildGateContext(gateDispatch, context, gateExtras) {
  const sections = [];

  sections.push(
    `You are answering questions about a gate review in a Compose build workflow.\n` +
    `Gate: "${gateDispatch.step_id}"`,
  );

  // Feature identity
  const ctxLines = [
    `Working directory: ${context.cwd}`,
    `Feature: ${context.featureCode}`,
  ];
  if (context.featureDir) {
    ctxLines.push(`Feature docs: ${context.featureDir}`);
  }
  sections.push(`## Feature\n${ctxLines.join('\n')}`);

  // Phase transition
  if (gateExtras?.fromPhase || gateExtras?.toPhase) {
    const from = gateExtras.fromPhase ?? '(unknown)';
    const to = gateExtras.toPhase ?? '(unknown)';
    sections.push(`## Phase Transition\n${from} → ${to}`);
  }

  // Gate summary (from stratum dispatch enrichment)
  if (gateExtras?.summary) {
    sections.push(`## Gate Summary\n${gateExtras.summary}`);
  }

  // Routing — what happens on each decision
  const routing = [];
  routing.push(`- **Approve** → ${gateDispatch.on_approve ?? '(complete flow)'}`);
  routing.push(`- **Revise** → re-run from \`${gateDispatch.on_revise ?? '(kill)'}\``);
  routing.push(`- **Kill** → ${gateDispatch.on_kill ?? '(terminate flow)'}`);
  sections.push(`## Gate Routing\n${routing.join('\n')}`);

  // Prior step history
  if (Array.isArray(context.stepHistory) && context.stepHistory.length > 0) {
    const historyLines = context.stepHistory.map(h => {
      let line = `- **${h.stepId}**: ${h.summary}`;
      if (h.artifact) line += ` → \`${h.artifact}\``;
      return line;
    });
    sections.push(`## Prior Steps\n${historyLines.join('\n')}`);
  }

  // Files changed
  if (context.filesChanged?.length > 0) {
    sections.push(`## Files Changed by This Feature\n${context.filesChanged.map(f => '- ' + f).join('\n')}`);
  }

  // Staleness warnings — flag artifacts that belong to an earlier phase
  if (context.featureDir && gateExtras?.toPhase) {
    const staleArtifacts = checkStaleness(context.featureDir, gateExtras.toPhase);
    const stale = staleArtifacts.filter(a => a.stale);
    if (stale.length > 0) {
      const lines = stale.map(a =>
        `- **${a.file}** was written in phase \`${a.writtenPhase}\` but feature is now in \`${a.currentPhase}\``
      );
      sections.push(`## Stale Artifacts\nThe following artifacts may be outdated:\n${lines.join('\n')}`);
    }
  }

  return sections.join('\n\n');
}
