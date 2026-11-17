/**
 * gate-tiers.js — COMP-OBS-GATES: tiered gate evaluation with short-circuit.
 *
 * Defines the five evaluation tiers used by the review pipeline.
 * Tiers are ordered cheapest → most expensive. When a tier fails, all
 * subsequent (more expensive) tiers are skipped — short-circuit.
 *
 * Tiers:
 *   T0  schema     — output contract validation (free, instant)
 *   T1  lint       — lint/format checks (fast)
 *   T2  tests      — test suite execution (medium)
 *   T3  llm-review — Claude multi-lens review (expensive)
 *   T4  cross-model — Codex cross-model review (very expensive)
 */

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------

export const GATE_TIERS = [
  {
    id: 'T0',
    name: 'schema',
    cost: 'free',
    description: 'Output contract validation',
  },
  {
    id: 'T1',
    name: 'lint',
    cost: 'fast',
    description: 'Lint/format checks',
  },
  {
    id: 'T2',
    name: 'tests',
    cost: 'medium',
    description: 'Test suite execution',
  },
  {
    id: 'T3',
    name: 'llm-review',
    cost: 'expensive',
    description: 'Claude multi-lens review',
  },
  {
    id: 'T4',
    name: 'cross-model',
    cost: 'very-expensive',
    description: 'Codex cross-model review',
  },
];

// Map tier ID → index for fast ordering lookups
const TIER_ORDER = new Map(GATE_TIERS.map((t, i) => [t.id, i]));

// ---------------------------------------------------------------------------
// Cost estimates (rough USD per invocation)
// ---------------------------------------------------------------------------

// Base cost constants (USD)
const TIER_BASE_COST_USD = {
  T0: 0.00,   // free — purely local contract validation
  T1: 0.00,   // free — local lint process
  T2: 0.05,   // test suite: estimate varies; use conservative floor
  T3: 0.50,   // Opus multi-lens: ~$0.50 per review pass
  T4: 0.30,   // Codex synthesis: ~$0.30 per cross-model pass
};

/**
 * Estimate the cost of running a tier in USD.
 *
 * @param {string} tierId       Tier ID (e.g. 'T0', 'T3')
 * @param {object} [context]    Optional context for future scaling (e.g. file count, lens count)
 * @param {number} [context.lensCount]  Number of review lenses (scales T3 cost)
 * @returns {number}            Estimated cost in USD
 */
export function estimateTierCost(tierId, context = {}) {
  const base = TIER_BASE_COST_USD[tierId] ?? 0;
  if (tierId === 'T3' && typeof context.lensCount === 'number' && context.lensCount > 1) {
    // Each additional lens beyond 1 adds ~50% of base cost
    return base + (base * 0.5 * (context.lensCount - 1));
  }
  return base;
}

// ---------------------------------------------------------------------------
// Step → tier classification
// ---------------------------------------------------------------------------

/**
 * Map of step IDs to their tier.
 * Step IDs come from .stratum.yaml pipeline specs.
 */
const STEP_TIER_MAP = {
  // T0: schema validation — happens implicitly via Stratum output_contract
  output_contract: 'T0',
  schema_check: 'T0',
  validate: 'T0',

  // T1: lint / format
  lint: 'T1',
  format: 'T1',
  typecheck: 'T1',

  // T2: test suite
  run_tests: 'T2',
  coverage: 'T2',
  coverage_check: 'T2',
  test: 'T2',

  // T3: LLM review (Claude multi-lens)
  review: 'T3',
  parallel_review: 'T3',
  triage: 'T3',
  merge: 'T3',
  // COMP-SETUP-PREFLIGHT-1 fix round 1 (P-1): the shipped build pipelines' own ids.
  review_triage: 'T3',
  review_lenses: 'T3',
  review_merge: 'T3',

  // T4: cross-model review (Codex)
  codex_review: 'T4',
  cross_model: 'T4',
  cross_model_review: 'T4',
};

/**
 * Classify a pipeline step ID as a tier.
 *
 * @param {string} stepId  Step ID from the pipeline spec
 * @returns {string|null}  Tier ID (e.g. 'T3') or null if unmapped
 */
export function classifyStepAsTier(stepId) {
  if (!stepId || typeof stepId !== 'string') return null;
  if (STEP_TIER_MAP[stepId]) return STEP_TIER_MAP[stepId];
  // COMP-SETUP-PREFLIGHT-1 fix round 1 (P-1): the build reports sub-flow and fanout
  // steps as a path (`coverage/run_tests`, `codex_review/review`, `review_lenses/0`).
  // The parent names the stage, so it is read first: `codex_review/review` is the
  // Codex pass (T4), not a Claude review (T3). Reading only the whole id left the
  // shipped pipeline's tests step unclassified, so a failing T2 skipped nothing.
  for (const part of stepId.split('/')) {
    if (STEP_TIER_MAP[part]) return STEP_TIER_MAP[part];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tiered evaluator with short-circuit
// ---------------------------------------------------------------------------

/**
 * Evaluate tier results and short-circuit on the first failure.
 *
 * @param {object} tierResults  Map of tier IDs to pass/fail booleans or null (not run).
 *                              Example: { T0: true, T1: true, T2: false, T3: null, T4: null }
 * @param {object} [costContext]  Context for cost estimation (e.g. { lensCount: 3 })
 * @returns {{
 *   passed: boolean,
 *   tierThatFailed: string|null,
 *   tiersRun: string[],
 *   tiersSkipped: string[],
 *   costSaved: number
 * }}
 */
export function evaluateTiers(tierResults, costContext = {}) {
  // Sort tiers by their canonical order
  const orderedTiers = GATE_TIERS.map(t => t.id);

  const tiersRun = [];
  const tiersSkipped = [];
  let tierThatFailed = null;
  let shortCircuiting = false;

  for (const tierId of orderedTiers) {
    const result = tierResults[tierId];

    if (shortCircuiting || result === null || result === undefined) {
      // Either we already failed, or this tier was never run
      if (shortCircuiting) {
        tiersSkipped.push(tierId);
      }
      // null/undefined = not run, not explicitly skipped — don't count either way
      continue;
    }

    tiersRun.push(tierId);

    if (result === false) {
      tierThatFailed = tierId;
      shortCircuiting = true;
    }
  }

  // Cost saved = sum of estimated costs for skipped tiers
  const costSaved = tiersSkipped.reduce(
    (sum, tierId) => sum + estimateTierCost(tierId, costContext),
    0
  );

  return {
    passed: tierThatFailed === null,
    tierThatFailed,
    tiersRun,
    tiersSkipped,
    costSaved,
  };
}

// ---------------------------------------------------------------------------
// COMP-SETUP-PREFLIGHT-1: what the build stream says it skipped
// ---------------------------------------------------------------------------

/**
 * Tier ids a parsed pipeline spec actually declares (every step of every flow,
 * sub-flows included), in canonical order.
 *
 * @param {object} spec  parsed .stratum.yaml
 * @returns {string[]}
 */
export function declaredTiers(spec) {
  const found = new Set();
  for (const [name, flow] of Object.entries(spec?.flows ?? {})) {
    if (name === 'entry' || !Array.isArray(flow?.steps)) continue;
    for (const step of flow.steps) {
      const tier = classifyStepAsTier(step?.id);
      if (tier) found.add(tier);
    }
  }
  return GATE_TIERS.map((t) => t.id).filter((id) => found.has(id));
}

/**
 * The plain line the build stream shows after a cheap tier failed:
 * `skipped T3,T4: T1 failed`. Lists only tiers the spec declares and the run never
 * dispatched (`tierResults` holds what ran), so it never claims to have skipped a
 * tier the flow does not have. null when nothing failed or nothing was skipped.
 *
 * Proof that work was not dispatched is the dispatch log, not this line; this line
 * is what a person reads.
 */
export function tierSkipLine(tierResults, declared) {
  const summary = evaluateTiers(tierResults);
  if (!summary.tierThatFailed) return null;
  const failedIdx = TIER_ORDER.get(summary.tierThatFailed);
  const skipped = (declared ?? [])
    .filter((id) => TIER_ORDER.get(id) > failedIdx)
    .filter((id) => tierResults[id] === undefined || tierResults[id] === null);
  if (skipped.length === 0) return null;
  return `skipped ${skipped.join(',')}: ${summary.tierThatFailed} failed`;
}

/**
 * COMP-SETUP-PREFLIGHT-1 fix round 1 (P-1): does this pipeline put a paid review (T3 or
 * T4) ahead of its tests (T2)? Reads the entry flow's step list in written order. The
 * bundled pipelines run the tests first; a project-local copy written before that keeps
 * the old order, and a failing test suite then still pays for every review. The build
 * says so once, rather than quietly running the older, costlier order.
 *
 * @param {object} spec  parsed .stratum.yaml
 * @returns {{paid: string, tests: string}|null}  the first paid step and the tests step it precedes
 */
export function paidReviewBeforeTests(spec) {
  const entry = spec?.flows?.entry;
  const steps = spec?.flows?.[entry]?.steps;
  if (!Array.isArray(steps)) return null;
  const testsIdx = steps.findIndex((s) => classifyStepAsTier(s?.id) === 'T2');
  if (testsIdx < 0) return null;
  const paid = steps.slice(0, testsIdx).find((s) => ['T3', 'T4'].includes(classifyStepAsTier(s?.id)));
  return paid ? { paid: paid.id, tests: steps[testsIdx].id } : null;
}
