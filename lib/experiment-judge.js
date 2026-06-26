/**
 * experiment-judge.js — LLM-judge rubric for COMP-MODEL-AB.
 *
 * Rates a build's produced diff against the goal on three axes (1–10 each):
 *   correctness   — does the code solve the stated goal?
 *   clarity       — is the code clear and idiomatic?
 *   idiomaticity  — does it follow language/project conventions?
 *
 * Dispatched via the existing stratum agent runner pinned to judgeModel.
 * Any failure (LLM error, JSON parse, schema mismatch) degrades to null —
 * a judge failure never aborts the experiment.
 *
 * COMP-MODEL-AB design: the judge model is held constant across all configs
 * under test.  Caller is responsible for not using a config's implementer as
 * the judge model (bias guard — warn in the orchestrator, not enforced here).
 */

import { resolveAgentConfig } from './agent-string.js';
import { injectSchema } from './inject-schema.js';

// ---------------------------------------------------------------------------
// Rubric schema injected into the judge prompt
// ---------------------------------------------------------------------------

const JUDGE_SCHEMA = {
  type: 'object',
  required: ['correctness', 'clarity', 'idiomaticity', 'rationale'],
  properties: {
    correctness:   { type: 'integer', minimum: 1, maximum: 10 },
    clarity:       { type: 'integer', minimum: 1, maximum: 10 },
    idiomaticity:  { type: 'integer', minimum: 1, maximum: 10 },
    rationale:     { type: 'string'  },
  },
};

/**
 * Build the judge prompt.
 *
 * @param {string} diff   Full git diff of the build's produced changes.
 * @param {string} goal   The natural-language goal the build was given.
 * @returns {string}
 */
function buildJudgePrompt(diff, goal) {
  const base = [
    'You are an expert code reviewer evaluating an AI-generated implementation.',
    '',
    `## Goal`,
    goal,
    '',
    `## Implementation Diff`,
    '```diff',
    diff,
    '```',
    '',
    'Rate the implementation on three axes, each on a scale of 1–10:',
    '',
    '- **correctness** (1–10): Does the code correctly solve the stated goal?',
    '  Consider: does it handle the described requirements, pass tests if present, and avoid obvious bugs?',
    '- **clarity** (1–10): Is the code readable and well-structured?',
    '  Consider: naming, comments, function decomposition, absence of unnecessary complexity.',
    '- **idiomaticity** (1–10): Does the code follow language and project conventions?',
    '  Consider: style, idiomatic patterns, appropriate use of language features.',
    '',
    'Then provide a one-line rationale summarising your overall assessment.',
  ].join('\n');

  return injectSchema(base, JUDGE_SCHEMA);
}

/**
 * Try to extract the judge result from agent text.
 *
 * @param {string} text
 * @returns {{ correctness: number, clarity: number, idiomaticity: number, rationale: string }|null}
 */
function extractJudgeResult(text) {
  // Find last ```json ... ``` block
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!matches.length) return null;
  const lastJson = matches[matches.length - 1][1].trim();
  let parsed;
  try { parsed = JSON.parse(lastJson); } catch { return null; }

  // Validate required fields
  const { correctness, clarity, idiomaticity, rationale } = parsed;
  if (
    typeof correctness  !== 'number' || correctness  < 1 || correctness  > 10 ||
    typeof clarity      !== 'number' || clarity      < 1 || clarity      > 10 ||
    typeof idiomaticity !== 'number' || idiomaticity < 1 || idiomaticity > 10 ||
    typeof rationale    !== 'string'
  ) {
    return null;
  }

  return {
    correctness:  Math.round(correctness),
    clarity:      Math.round(clarity),
    idiomaticity: Math.round(idiomaticity),
    rationale:    rationale.trim(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the LLM judge over a build's diff + goal.
 *
 * @param {object} args
 * @param {string}  args.diff        Full git diff produced by the build.
 * @param {string}  args.goal        Natural-language goal string.
 * @param {string}  args.judgeModel  Agent string for the judge (e.g. "claude::critical").
 * @param {object}  args.stratum     Connected StratumMcpClient.
 * @param {string}  [args.cwd]       Working directory for the agent call.
 *
 * @returns {Promise<{ correctness: number, clarity: number, idiomaticity: number, rationale: string }|null>}
 *   Structured scores, or null on any failure (degrade, never throw).
 */
export async function judge({ diff, goal, judgeModel, stratum, cwd }) {
  try {
    const prompt = buildJudgePrompt(diff, goal);
    const { provider, modelID, thinking, effort } = resolveAgentConfig(judgeModel);

    let text;
    if (typeof stratum.agentRun === 'function') {
      // Use agentRun so we can pin the concrete model ID resolved from the tier.
      const result = await stratum.agentRun(provider, prompt, {
        modelID:  modelID ?? undefined,
        thinking: thinking ?? undefined,
        effort:   effort   ?? undefined,
        cwd:      cwd      ?? undefined,
      });
      text = result?.text ?? '';
    } else {
      // Fallback: runAgentText (no model pinning — test harnesses may use this).
      text = await stratum.runAgentText(provider, prompt, { cwd: cwd ?? undefined });
    }

    return extractJudgeResult(text);
  } catch {
    // Any failure — network error, LLM refusal, JSON parse — degrades to null.
    return null;
  }
}
