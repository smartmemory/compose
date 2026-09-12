/**
 * build.js — Headless lifecycle runner for `compose build`.
 *
 * Orchestrates feature execution through a Stratum workflow:
 * load spec → stratum_plan → dispatch steps to agents → enforce gates → audit.
 *
 * No server required. Vision state written directly to disk.
 * Gates resolved via CLI readline prompt.
 */

import { routingCallOptions, routingParentForToken, acknowledgeRoutingFailure, routingCallsTerminated, routingArtifactsFor, callsForRouting, installRoutingCalls, flushObservedReceipts, reportObservedUsage, recoverRoutingEvidence, routingIntegrityError } from './routing-runtime.js';
import { captureRoutingGate, prepareRoutingGate, acknowledgeRoutingGate } from './routing-gates.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync, symlinkSync, openSync, closeSync, fsyncSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { StratumMcpClient, StratumError, resolvePlanSpecValues, resolveStepProfile, asTransportRefusal, isUnknownFlowError } from './stratum-mcp-client.js';
import { resolveStratumMcpConnection } from './stratum-engine.js';
import { runAndNormalize, mergeUsage, AgentTimeoutError, AgentAbortedError, UserInterruptError, AgentError } from './result-normalizer.js';
import { checkCapabilityViolation } from './capability-checker.js';
import { getCatalog as getPolicyCatalog, getPolicyCheckConfig } from './policy-catalog.js';
import {
  resolveBuildUserMode, scanResponse, toViolationStrings, buildRevisionNotice, attachPolicyCount,
} from './policy-check.js';
import { preflightCodexWorktreeProbe, codexProbeAbortMessage } from './codex-preflight.js';
import { buildStepPrompt, buildGateContext, clearAmbientContextCache } from './step-prompt.js';
import { promptGate } from './gate-prompt.js';
import { VisionWriter, ServerUnreachableError } from './vision-writer.js';
import { readFlowRound, readFlowSnapshot, readFlowSpend, readRoutingSnapshot as readRoutingSnapshotRaw, routingStepEpoch } from './flow-state.js';
import { resolvePort } from './resolve-port.js';
import { probeServer } from './server-probe.js';
import { CliProgress } from './cli-progress.js';
import { BuildStreamWriter } from './build-stream-writer.js';
import { appendBuildHistory, projectHistorySteps, stepOutcomeToStatus } from './build-history.js';
import { KNOWN_VERSIONS } from './build-stream-schema.js';
import { resolveAgentConfig, parseAgentString, validateAgentString } from './agent-string.js';
import { emitSections as emitPlanSections, appendTrailers as appendSectionTrailers, analyzeRollup, writeRollup } from './sections.js';
import { SECTIONS_DIR } from './constants.js';
import { rtkPrefix } from './rtk.js';
import { tsCompatibilityOf, quarantineMessage, INIT_PROVISIONED_SPECS } from './pipeline-compat.js';

import YAML from 'yaml';
// feature-json direct imports removed — mutations now go through TrackerProvider (T9)
import { loadFeaturesDir, resolveContextPath, resolveRoadmapPath, resolveFeaturesPath } from './project-paths.js';
import { getMode, resolveMode } from './lifecycle-modes.js';
import { vocabularyEnabled, tagVocabularyViolations, VOCABULARY_FILE } from './vocabulary-inject.js';
import { vocabularyCompliance } from './vocabulary-compliance.js';

// Lazy provider accessor — avoids circular import risk (factory → local-provider
// does NOT import build.js, so a static import is safe, but lazy is used for
// consistency with the pattern established in T7/T8 and to avoid any future risk).
async function getBuildProvider(cwd) {
  const { providerFor } = await import('./tracker/factory.js');
  return providerFor(cwd);
}
import { evaluatePolicy } from '../server/policy-evaluator.js';
import { isTriageStale } from './triage.js';
import { applyFrontTriage, maybeEscalateLane } from './lane-gate.js';
import { LENS_DEFINITIONS } from './review-lenses.js';
import { injectCertInstructions } from './cert-inject.js';
// COMP-BUILD-CANCEL: the build-level cancel handle, its registry and the bounded
// SIGINT/SIGTERM teardown (blueprint §3.4-§3.6).
import {
  createBuildCancel,
  confirmCancellation,
  isRunCancelled,
  flowTag,
  runCancelTeardown,
  cancelBudgets,
  withDeadline,
  registerBuildCancel,
  unregisterBuildCancel,
  lookupBuildCancel,
} from './build-cancel.js';
import { buildReviewPrompt } from './review-prompt.js';
import { detectTestFramework, scaffoldTestFramework, parseTestSummary, deriveTestsPass, deriveTestsAttested, isTestFile } from './test-bootstrap.js';
import { classifyStepAsTier, evaluateTiers } from './gate-tiers.js';
import { mapFilesToRoutes, classifyRoutes, isDocsOnlyDiff } from './qa-scoping.js';
import { computeCompositeScore } from './health-score.js';
import { recordScore } from './health-history.js';
import { FixChainDetector, AttemptCounter, DebugLedger, TraceValidator } from './debug-discipline.js';
import { CrossLayerAudit, loadDebugConfig } from './cross-layer-audit.js';
import { emitCheckpoint } from './bug-checkpoint.js';
import { appendHypothesisEntry, readHypotheses } from './bug-ledger.js';
import { tier1CodexReview, tier2FreshAgent } from './bug-escalation.js';
import { writeGsdTaskDiff } from './gsd-diff-capture.js';
import { readTimingSidecar, writeTimingSidecar, recordTaskStates } from './gsd-timing.js';
import { resolvePreMergeGate } from './gsd.js';
import {
  ConsumerArtifactError,
  ConsumerFanoutArtifacts,
  ConsumerMergeDecisionError,
  MergeAfterCancelError,
  isConsumerDescriptor,
  recoverAdvancedConsumerArtifacts,
  verifyConsumerRunRevision,
  routingJournalPath,
} from './consumer-fanout.js';
import { preflightPipelineProfiles as preflightProfiles, mergeRuntimeProfiles, validateWaveAdmission, resolveConsumerProfile, profilesDigest, PipelineProfileError, routingProfileProjection } from './pipeline-profiles.js';
import { canonicalRoutingJson, routingDigest, routingRecordId, dispatchKey, resolveRoute, routingRefuse, assertRoutingSlice } from './model-router.js';
import { createRoutingStart, readRoutingStart, recordRoutingPlanIntent, recordRoutingPlanRequested, bindRoutingRun, recoverRoutingPlan, validateRoutingRun, routingModelMappings, routingIssuanceState, pendingRoutingPlans, readRoutingRunBinding, validateRoutingTransport } from './routing-ledger.js';
import { decideGateFromOutput } from './output-gate.js';
import { readCheckpointRef, worktreeBaseFor, squashOntoBase, removeCheckpointRef, WaveCheckpointError } from './wave-checkpoint.js';
import { appendEvent as appendDispatchEvent, readEvents as readDispatchEvents } from './dispatch-ledger.js';
import { appendEvent as appendFeatureEvent } from './feature-events.js';

// ---------------------------------------------------------------------------
// COMP-ROADMAP-PLAN S8: gate the `ship` interception by mode.
// ---------------------------------------------------------------------------

/**
 * The `ship` step interception runs executeShipStep (git stage/commit/audit),
 * which is build/fix-specific. It must run for build AND bug (bug-fix depends on
 * it) but NOT for plan — plan's `ship` is a handoff/verify agent step.
 *
 * Gate on `mode !== 'plan'`, NOT on cfg.tracksFeatureJson: fix mode is
 * tracksFeatureJson:false yet still needs the ship path (COMP-ROADMAP-PLAN C12).
 *
 * @param {string} stepId — the current pipeline step id
 * @param {string} mode   — runtime mode token (feature | bug | plan)
 * @returns {boolean} true when the ship interception should run
 */
export function shouldInterceptShip(stepId, mode) {
  return stepId === 'ship' && mode !== 'plan';
}

// ---------------------------------------------------------------------------
// COMP-POLICY-CHECK: pre-response policy check (adherence enforcement).
// ---------------------------------------------------------------------------

/**
 * Does this step declare a gate? A gate step is SKILL_GATED by construction —
 * asking the user for a decision is the point of the step, so policy matches on
 * its response are suppressed rather than flagged.
 *
 * @param {object} spec      the local pipeline spec
 * @param {string} flowName  active flow
 * @param {string} stepId    ready-step id (scoped ids resolve to their bare tail)
 * @returns {boolean}
 */
export function isGateStep(spec, flowName, stepId) {
  const bare = String(stepId ?? '').split('/').pop();
  const steps = spec?.flows?.[flowName]?.steps;
  if (!Array.isArray(steps)) return false;
  return steps.some(st => st?.id === bare && !!st.gate);
}

/**
 * COMP-POLICY-CHECK-2/3: scan one step response against the local catalog.
 * Total — a broken catalog or scan degrades to "no findings" with a WARNING and
 * never fails the step.
 *
 * The user mode is EXPLICIT here, never inferred: a build has no user turns to
 * classify (see `resolveBuildUserMode`). Config override → gate step → default.
 *
 * @param {{cwd: string, text: string, skillGated: boolean}} args
 * @returns {{records: object[], violations: string[], userMode: string}}
 */
export function policyScanForStep({ cwd, text, skillGated }) {
  const empty = { records: [], violations: [], userMode: 'AUTONOMOUS' };
  try {
    const config = getPolicyCheckConfig(cwd);
    const catalog = getPolicyCatalog(cwd);
    if (catalog.length === 0) return empty;
    const userMode = resolveBuildUserMode(config.userMode, { skillGated });
    const records = scanResponse(text ?? '', catalog, userMode);
    return { records, violations: toViolationStrings(records), userMode };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[policy-check] scan skipped: ${err.message}`);
    return empty;
  }
}

/**
 * COMP-POLICY-CHECK-5: trace every match (flagged AND suppressed) to the
 * append-only feature-events bus — which syncs into SmartMemory, closing the
 * measurement loop — plus the build stream for live cockpit visibility.
 *
 * @param {object} args
 * @param {string} args.pass 'initial' | 'policy_revision'
 */
export function recordPolicyScan({ cwd, streamWriter, stepId, records, userMode, featureCode, buildId, pass = 'initial' }) {
  for (const record of records ?? []) {
    try {
      appendFeatureEvent(cwd, {
        tool: 'policy_check',
        build_id: buildId ?? null,
        step_id: stepId,
        rule: record.rule,
        matched: record.matched,
        suppressed: record.suppressed,
        user_mode: userMode,
        pass,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[policy-check] trace append failed: ${err.message}`);
    }
    try {
      streamWriter?.writePolicyViolation(stepId, record, userMode, featureCode ?? null, buildId ?? null);
    } catch { /* stream emit is best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// COMP-ROADMAP-PLAN S5: ratify a plan-authored design instead of clobbering it.
// ---------------------------------------------------------------------------

/**
 * When a feature was authored by the `plan` lifecycle (feature.json.plannedBy is
 * set), rewrite the build pipeline's `explore_design` step so it RATIFIES the
 * existing plan-approved design.md rather than writing one from scratch (which
 * would clobber the plan output). Mutates `specObj` in place; returns true if it
 * rewrote a step. Pure and testable — no I/O.
 *
 * @param {object} specObj   — parsed Stratum spec
 * @param {string} flowName  — the flow Stratum will run (from extractFlowName)
 * @param {string|null} plannedBy — the originating plan session code, or null
 * @returns {boolean} true when the explore_design intent was rewritten
 */
export function applyPlannedByRatify(specObj, flowName, plannedBy) {
  if (!plannedBy) return false;
  const flows = specObj?.flows ?? {};
  const flowKey = Object.keys(flows).includes(flowName) ? flowName : Object.keys(flows)[0];
  const steps = flows?.[flowKey]?.steps ?? [];
  const step = steps.find((s) => s && s.id === 'explore_design');
  if (!step) return false;
  const ratify =
    `A plan-approved design already exists at docs/features/{featureCode}/design.md ` +
    `(authored by plan session ${plannedBy}). READ it fully FIRST, then RATIFY it: ` +
    `refine only if something is missing, wrong, or unimplementable; otherwise keep it ` +
    `as-is. Do NOT rewrite the design from scratch and do NOT discard the plan's intent. ` +
    `Return the design path (docs/features/{featureCode}/design.md) in the "artifact" field.`;
  if (specObj?.version === 1) {
    step.do = ratify.replaceAll('{featureCode}', '${input.featureCode}');
  } else {
    step.intent = ratify;
  }
  return true;
}

// ---------------------------------------------------------------------------
// COMP-FIX-HARD T6: hypothesis ledger append on diagnose success.
// ---------------------------------------------------------------------------

/**
 * Append an `accepted` hypothesis ledger entry whenever a diagnose step
 * completes successfully in bug mode. No-op outside bug mode or for any
 * other step. Best-effort: ledger I/O failures are logged, never thrown.
 *
 * Called after a successful TS ready-entry dispatch.
 *
 * @param {object} context  — execution context (must carry mode + bug_code + cwd)
 * @param {string} stepId   — TS ready-entry id
 * @param {object} result   — agent result envelope (root_cause, trace_evidence)
 */
export function recordDiagnoseSuccessIfBugMode(context, stepId, result) {
  if (!context || context.mode !== 'bug') return;
  if (!context.bug_code || !context.cwd) return;
  if (stepId !== 'diagnose') return;

  try {
    const prior = readHypotheses(context.cwd, context.bug_code);
    // Use max(prior.attempt) + 1 so escalation_tier_1 entries (which use the
    // same length-based formula in bug-escalation.js) don't collide on a later
    // accepted entry. Idempotency key is (attempt, ts) so dups would still
    // append; this just keeps the rendered attempt sequence sane.
    const maxAttempt = prior.reduce((acc, e) => Math.max(acc, Number(e.attempt) || 0), 0);
    const attempt = maxAttempt + 1;
    const entry = {
      attempt,
      ts: new Date().toISOString(),
      hypothesis: result?.root_cause ?? '',
      verdict: 'accepted',
      evidence_for: Array.isArray(result?.trace_evidence) ? result.trace_evidence : [],
    };
    appendHypothesisEntry(context.cwd, context.bug_code, entry);
  } catch (err) {
    // Best-effort: ledger I/O must never abort a successful step.
    // eslint-disable-next-line no-console
    console.warn(`[bug-ledger] recordDiagnoseSuccessIfBugMode failed: ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// COMP-FIX-HARD T10: post-retro_check escalation gate (Tier 1 + Tier 2)
// ---------------------------------------------------------------------------

/**
 * Prompt the user for a yes/no decision via readline. Returns true on
 * approve/y/yes; false on skip/n/no/empty/EOF. Non-interactive (no TTY)
 * answers default to skip so headless runs don't hang.
 */
async function _confirm(message) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await new Promise(resolve => rl.question(`${message} `, resolve));
    const v = String(ans ?? '').trim().toLowerCase();
    return v === 'a' || v === 'approve' || v === 'y' || v === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * After retro_check completes in bug mode, check whether the per-bug
 * attempt counter has reached the 'escalate' threshold. If so, gate the
 * user for a Codex second opinion (Tier 1) and, if Codex surfaces a
 * materially-new hypothesis, gate again for a fresh-agent worktree
 * dispatch (Tier 2).
 *
 * Best-effort: any failure inside this helper is logged and swallowed —
 * escalation is advisory and must never abort an otherwise-successful build.
 */
export async function maybeRunEscalation(stratum, context, progress, streamWriter, attemptCounter, dataDir) {
  if (!context || context.mode !== 'bug' || !context.bug_code) return;
  const intervention = attemptCounter.getInterventionForBug(context.bug_code);
  if (intervention !== 'escalate') return;

  const bugCode = context.bug_code;
  try {
    const approveTier1 = await _confirm(
      `Bug ${bugCode} has escalated. Run Codex second opinion (~30s, read-only)? approve / skip:`,
    );
    if (!approveTier1) {
      if (progress) progress.warn(`Escalation skipped for ${bugCode}.`);
      return;
    }

    // Gather inputs for Tier 1.
    const bugDir = join(context.cwd, 'docs', 'bugs', bugCode);
    let bugDescription = '';
    try { bugDescription = readFileSync(join(bugDir, 'description.md'), 'utf-8'); } catch { /* optional */ }
    let reproTest = '';
    try { reproTest = readFileSync(join(bugDir, 'repro.test.js'), 'utf-8'); } catch {
      try { reproTest = readFileSync(join(bugDir, 'repro.md'), 'utf-8'); } catch { /* optional */ }
    }
    let currentDiff = '';
    try {
      // COMP-RTK-INTEROP: this diff is fed to Codex (LLM) for the tier-1 review, so
      // route it through RTK when available to compress before the 8000-char cap.
      // rtkPrefix is a no-op (byte-identical) when rtk is absent.
      currentDiff = execSync(rtkPrefix('git diff --no-color HEAD'), {
        cwd: context.cwd, encoding: 'utf-8', timeout: 10_000,
      }).slice(0, 8000);
    } catch { /* not a git repo or no diff */ }

    const hypotheses = readHypotheses(context.cwd, bugCode);

    if (streamWriter) streamWriter.write({ type: 'build_step_start', stepId: 'escalation_tier_1', stepNum: '?', totalSteps: '?', agent: 'codex', intent: 'Codex second-opinion review', flowId: null });
    const review = await tier1CodexReview(stratum, context, bugDescription, reproTest, currentDiff, hypotheses);
    if (progress) progress.warn(`Tier 1 (Codex) — ${review.summary}`);
    if (streamWriter) streamWriter.write({ type: 'build_step_done', stepId: 'escalation_tier_1', summary: review.summary, retries: 0, violations: [], flowId: null });

    // Tier 2 gate — only if Codex surfaced a must-fix or should-fix finding.
    const blocking = (review.findings ?? []).filter(f => f.severity === 'must-fix' || f.severity === 'should-fix');
    if (blocking.length === 0) {
      if (progress) progress.warn('Codex returned no actionable findings — Tier 2 skipped.');
      return;
    }

    const approveTier2 = await _confirm(
      `Codex found a new angle. Dispatch fresh agent in worktree to draft a patch (no commits)? approve / skip:`,
    );
    if (!approveTier2) {
      if (progress) progress.warn(`Tier 2 skipped for ${bugCode}.`);
      return;
    }

    const checkpointPath = join(bugDir, 'checkpoint.md');
    const tier2 = await tier2FreshAgent(stratum, context, review, hypotheses, existsSync(checkpointPath) ? checkpointPath : null);
    if (tier2.skipped) {
      if (progress) progress.warn(`Tier 2 skipped: ${tier2.reason}`);
    } else {
      if (progress) progress.warn(`Tier 2 patch artifact ready at ${tier2.patch_path}`);
      if (streamWriter) streamWriter.write({ type: 'build_step_done', stepId: 'escalation_tier_2', summary: `Patch artifact at ${tier2.patch_path}`, retries: 0, violations: [], flowId: null });
    }
  } catch (err) {
    if (context.routing && routingIntegrityError(err)) throw err;
    // eslint-disable-next-line no-console
    console.warn(`[bug-escalation] failed: ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// STRAT-IMMUTABLE: pipeline and policy integrity helpers
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hex hash of a string.
 */
function _sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Verify the pipeline YAML file on disk matches the hash captured at build start.
 * Throws StratumError('PIPELINE_MODIFIED') if the file has changed or cannot be read.
 */
export function verifyPipelineIntegrity(specPath, expectedHash) {
  let current;
  try {
    current = readFileSync(specPath, 'utf-8');
  } catch (err) {
    throw new StratumError('PIPELINE_MODIFIED',
      `Pipeline spec could not be re-read: ${err.message}`, specPath);
  }
  const actualHash = _sha256(current);
  if (actualHash !== expectedHash) {
    throw new StratumError('PIPELINE_MODIFIED',
      `Pipeline spec was modified during execution. Revert changes and retry.`,
      `expected=${expectedHash} actual=${actualHash}`);
  }
}

/**
 * Verify the gate policy fields in settings.json match the hash captured at build start.
 * Gracefully degrades (no-op) if settings.json is missing — it may not exist in all envs.
 * Throws StratumError('POLICY_MODIFIED') if the file exists and the policies hash differs.
 */
export function verifyPolicyIntegrity(settingsPath, expectedHash) {
  if (!existsSync(settingsPath)) {
    // Settings file absent — graceful degradation, no verification possible.
    return;
  }
  let policies;
  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    policies = parsed.policies ?? {};
  } catch (err) {
    throw new StratumError('POLICY_MODIFIED',
      `settings.json could not be re-read: ${err.message}`, settingsPath);
  }
  const actualHash = _sha256(JSON.stringify(policies));
  if (actualHash !== expectedHash) {
    throw new StratumError('POLICY_MODIFIED',
      `Gate policy was modified during execution. Revert changes and retry.`,
      `expected=${expectedHash} actual=${actualHash}`);
  }
}

// ---------------------------------------------------------------------------
// Spec helpers
// ---------------------------------------------------------------------------

/**
 * Extract the flow name from a parsed Stratum spec.
 * Priority:
 *   1. flows.entry pointer (the flow the TS engine executes)
 *   2. v0.3 workflow.name (explicit declaration)
 *   3. Flow matching templateName (convention: template "build" → flow "build")
 *   4. First actual flow under flows: (single-flow specs)
 * Falls back to 'build' if parsing fails or no flow is found.
 */
function extractFlowName(specYaml, templateName = 'build') {
  try {
    const parsed = YAML.parse(specYaml);
    const flows = parsed?.flows;
    if (flows && typeof flows === 'object') {
      const entryName = typeof flows.entry === 'string' ? flows.entry : null;
      if (entryName && flows[entryName] && typeof flows[entryName] === 'object') {
        return entryName;
      }
    }
    // v0.3 workflow.name — explicit declaration wins
    if (parsed?.workflow?.name) return parsed.workflow.name;
    // flows-based specs
    if (flows && typeof flows === 'object') {
      const keys = Object.keys(flows).filter(key => key !== 'entry' && flows[key] && typeof flows[key] === 'object');
      // Prefer flow matching the template name
      if (keys.includes(templateName)) return templateName;
      // Single-flow or non-default template: use first key
      if (keys.length > 0) return keys[0];
    }
  } catch { /* fall through */ }
  return 'build';
}

/**
 * Resolve a TS-ready step's output contract from Compose's local pipeline spec.
 * The TS engine intentionally does not echo contract metadata in ready[].
 */
export function resolveStepOutputContract(spec, flowName, stepId) {
  return resolveContractInFlow(spec, flowName, String(stepId));
}

/**
 * F1: resolve a (possibly scoped) ready-step id to its output contract, following
 * subflow boundaries. The TS engine emits subflow ready ids as
 * `<parentStepId>/<childStepId>` (engine scopedId join). A scoped id means the
 * parent step's `run:` points at a subflow where the remaining path resolves;
 * recurse so nested subflows resolve too (our pipelines are single-level, but the
 * depth is not hardcoded). A bare id resolves against `flowName` directly.
 */
function resolveContractInFlow(spec, flowName, path) {
  const empty = { hasOutContract: false, outputFields: {}, contractName: null };
  const steps = spec?.flows?.[flowName]?.steps;
  if (!Array.isArray(steps)) return empty;
  const slash = path.indexOf('/');
  if (slash === -1) {
    const rawName = steps.find(step => step?.id === path)?.out;
    const hasName = typeof rawName === 'string' && rawName.length > 0;
    const contract = hasName ? spec?.contracts?.[rawName] : null;
    return {
      hasOutContract: hasName,
      // G1: the contract NAME (not just its fields) so callers can recognize a
      // review step by contract identity (e.g. ReviewResult) on the TS path,
      // where no python-era review_mode/output_contract marker survives.
      contractName: hasName ? rawName : null,
      outputFields: contract && typeof contract === 'object' && !Array.isArray(contract)
        ? { ...contract }
        : {},
    };
  }
  const parentId = path.slice(0, slash);
  const rest = path.slice(slash + 1);
  const subflowName = steps.find(step => step?.id === parentId)?.run;
  if (typeof subflowName !== 'string' || !spec?.flows?.[subflowName]) return empty;
  return resolveContractInFlow(spec, subflowName, rest);
}

/**
 * F4: derive review-normalization options for a consumer fanout item from the
 * descriptor itself. TS ready events carry none of the python-era review_mode /
 * output_contract markers the ordinary path keys off, so review-ness is derived
 * structurally (the item's output contract closure root === 'ReviewResult'), and
 * the lens + confidence gate come from the fanned-out item's own inputs (the v1
 * review_lenses items carry lens_name / confidence_gate). Confidence gate default
 * (7) matches the ordinary review path.
 */
/**
 * H1/G1: decide, for an ordinary TS ready step, whether it is a review (gets
 * review normalization + confidence handling) and whether it is a REDUCER (a
 * ReviewResult-out step that merges/deduplicates rather than reviews — it gets
 * normalization but NOT the reviewer scaffold). On the TS path the python-era
 * review_mode/reduce_mode inputs are gone, so review-ness comes from the resolved
 * output contract identity and reducer-ness from the profile sidecar's
 * `_reduceSteps` (scoped-id normalized, mirroring resolveStepProfile).
 *
 * @returns {{isReviewMain:boolean, isReduceMain:boolean, isReviewScaffoldMain:boolean}}
 */
export function deriveOrdinaryReviewScaffold({ contractName = null, stepId = '', reduceSteps } = {}) {
  const reducers = reduceSteps instanceof Set ? reduceSteps : new Set(reduceSteps ?? []);
  const isReviewMain = contractName === 'ReviewResult';
  const bareStepId = String(stepId).split('/').pop();
  const isReduceMain = reducers.has(stepId)
    || reducers.has(bareStepId);
  return { isReviewMain, isReduceMain, isReviewScaffoldMain: isReviewMain && !isReduceMain };
}

// COMP-AGENT-LANES: one lane per parallel worker slot. Identity is
// flowId:stepId:itemIndex (stepId/itemIndex RECUR across builds, so flowId is
// load-bearing); version is the ordered tuple (generation, attempt) — the UI
// resets a lane on a higher version and rejects lower (stale) events. The
// label is the human mandate: the review lens id when the item is a review,
// else the step intent truncated.
const LANE_LABEL_MAX = 80;

export function buildLaneEnvelope(descriptor, flowId, { lens = null } = {}) {
  const rawLabel = (typeof lens === 'string' && lens)
    || (typeof descriptor?.do === 'string' && descriptor.do)
    || String(descriptor?.id ?? '');
  const label = rawLabel.length > LANE_LABEL_MAX
    ? `${rawLabel.slice(0, LANE_LABEL_MAX - 1)}…`
    : rawLabel;
  return {
    flowId,
    stepId: descriptor.id,
    itemIndex: descriptor.itemIndex,
    generation: descriptor.generation ?? 0,
    attempt: descriptor.attempt ?? 1,
    label,
    agent: descriptor.agent ?? 'claude',
  };
}

function deriveConsumerLane(descriptor, flowId) {
  const reviewOpts = deriveConsumerReviewOptions(descriptor);
  return buildLaneEnvelope(descriptor, flowId, {
    lens: reviewOpts.reviewMode ? reviewOpts.lens : null,
  });
}

export function deriveConsumerReviewOptions(descriptor) {
  const reviewMode = descriptor?.contract?.root === 'ReviewResult';
  const item = (descriptor?.item && typeof descriptor.item === 'object') ? descriptor.item : {};
  const lens = (typeof item.lens_name === 'string' && item.lens_name)
    || (typeof item.lens === 'string' && item.lens)
    || 'general';
  const parsedGate = Number(item.confidence_gate ?? item.confidenceGate);
  const confidenceGate = Number.isFinite(parsedGate) && parsedGate > 0 ? parsedGate : 7;
  return { reviewMode, lens, confidenceGate };
}

function resolveConsumerOutputContract(descriptor) {
  const closure = descriptor?.contract;
  const fields = closure?.contracts?.[closure?.root];
  return {
    hasOutContract: closure !== null,
    outputFields: fields && typeof fields === 'object' && !Array.isArray(fields)
      ? { ...fields }
      : {},
    // The FULL closure (root + every reachable named contract) so the normalizer
    // renders nested record shapes and typed arrays, not just the root fields.
    closure: closure ?? null,
  };
}

/**
 * Surface 8 exposes the stage index and contract closure but no stage-count or
 * final-stage bit. Diff preparation must happen before step_done, so Compose's
 * already-loaded effective pipeline is the only available finality source.
 */
function isFinalConsumerStage(spec, descriptor) {
  const steps = spec?.flows?.[descriptor.flow]?.steps;
  const fanout = Array.isArray(steps)
    ? steps.find((step) => step?.id === descriptor.step)?.fanout
    : null;
  if (!Array.isArray(fanout?.steps) || fanout.steps.length === 0) {
    throw new Error(`consumer descriptor ${descriptor.id} cannot be matched to its local fanout stage list`);
  }
  return descriptor.stage === fanout.steps.length - 1;
}

/**
 * D3: raised when the GSD stuck detector trips during a consumer item's agent
 * run. Carries the tripped verdict + the item's task key so the GSD driver can
 * write the stuck diagnostic and halt the run. Build mode never passes a
 * stuck detector, so this never fires there.
 */
export class ConsumerStuckError extends Error {
  constructor(taskId, verdict) {
    super(`consumer item ${taskId} halted stuck: ${verdict?.signal ?? 'unknown'}`);
    this.name = 'ConsumerStuckError';
    this.taskId = taskId;
    this.verdict = verdict;
  }
}

function gateChangedFiles(cwd) {
  const files = [];
  const seen = new Set();
  for (const cmd of [
    'git -c core.hooksPath=/dev/null diff --name-only HEAD',
    'git -c core.hooksPath=/dev/null ls-files --others --exclude-standard',
  ]) {
    try {
      const output = execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe' });
      for (const line of output.split('\n')) {
        const file = line.trim();
        if (file && !seen.has(file)) { seen.add(file); files.push(file); }
      }
    } catch { /* best-effort diagnostic */ }
  }
  return files;
}

/** Run TS consumer pre-merge checks inside the isolated worktree. */
export function runPreMergeGateLocal(cwd, commands, baseCwd, timeoutMs) {
  if (!Array.isArray(commands) || commands.length === 0) return null;
  if (baseCwd) {
    try {
      const baseModules = join(baseCwd, 'node_modules');
      const worktreeModules = join(cwd, 'node_modules');
      if (existsSync(baseModules) && !existsSync(worktreeModules)) {
        symlinkSync(baseModules, worktreeModules, 'dir');
      }
    } catch { /* optional dependency bridge */ }
  }
  for (const command of commands) {
    try {
      execSync(command, { cwd, encoding: 'utf-8', timeout: timeoutMs, stdio: 'pipe' });
    } catch (error) {
      const stdout = error.stdout == null ? '' : String(error.stdout);
      const stderr = error.stderr == null ? '' : String(error.stderr);
      const excerpt = `${stdout}${stdout && stderr ? '\n' : ''}${stderr || (!stdout ? error.message ?? '' : '')}`.slice(-2048);
      return {
        reason: 'gate_failed',
        command,
        exit_code: typeof error.status === 'number' ? error.status : null,
        files: gateChangedFiles(cwd),
        excerpt,
      };
    }
  }
  return null;
}

/**
 * A consumer report can lose a race with another response that already advanced
 * the same fenced issuance. MCP surfaces that engine rejection as JSON-RPC
 * -32603. Keep the match deliberately narrow: the code alone is not enough.
 */
function isStaleOrDuplicateConsumerReportError(error) {
  if (error?.code !== -32603) return false;
  const message = error?.message ?? '';
  return /\bstale\/duplicate report\b/i.test(message)
    || /\b(?:stale|duplicate) (?:step_done |step done )?report\b/i.test(message)
    || /\bstep result is stale\b/i.test(message)
    || /\bstep is not awaiting a client result\b/i.test(message);
}

function responseReissuesStep(response, stepId) {
  if (response?.status !== 'ready' || !Array.isArray(response.ready)) return false;
  return response.ready.some((ready) => ready?.id === stepId && ready?.previousFailure);
}

async function callFlowWithCancellation(stratum, method, flowId, buildCancel, ...args) {
  if (buildCancel.cancelled) throw buildCancel.signal.reason;
  try {
    return await stratum[method](flowId, ...args);
  } catch (error) {
    await confirmCancellation(error, { stratum, flowId, buildCancel });
    throw error;
  }
}

async function reportConsumerStepDone({
  descriptor,
  flowId,
  envelope,
  stratum,
  artifacts,
  progress,
  streamWriter,
  buildCancel,
}) {
  if (buildCancel?.cancelled) throw buildCancel.signal.reason;
  const routingPin = artifacts?.journal?.routing;
  const issuance = routingPin?.tokenIndex[descriptor.dispatchToken] ? artifacts.readRoutingRecord(routingPin.tokenIndex[descriptor.dispatchToken]) : null;
  const routeContext = issuance ? { stratum, routing: artifacts.routingContext ?? { start: readRoutingStart({ cwd: artifacts.targetCwd, ...routingPin }),
    binding: routingPin.runBinding, artifacts, resolvedRoutes: new Map() } } : null;
  if (issuance) routingEvent(routeContext, issuance, 'result-prepared', { envelope });
  try {
    const response = await stratum.stepDone(flowId, descriptor.id, envelope, descriptor.dispatchToken);
    if (issuance) {
      acknowledgeRoutingFailure(routeContext, issuance, envelope, response);
      await reconcileRoutingIssuances({ context: routeContext, only: issuance.id });
      const snapshot = readRoutingSnapshot(flowId);
      const state = snapshot.steps[issuance.scopedStep];
      const records = artifacts.exportRoutingJournal();
      const issued = Object.values(records.records).filter(r => r.type === 'issuance' && r.runId === flowId && r.scopedStep === issuance.scopedStep && r.epoch === issuance.epoch);
      if (state?.fanout?.items?.every(item => item.status === 'succeeded') && issued.every(r => routingIssuanceState(records, r.id).state === 'settled')) {
        sealRoutingEpochs(routeContext.routing, { scopedStep: issuance.scopedStep });
      }
    }
    return {
      response,
      skipped: false,
    };
  } catch (error) {
    if (await confirmCancellation(error, { stratum, flowId, buildCancel })) throw error;
    if (!isStaleOrDuplicateConsumerReportError(error)) throw error;

    const summary = `consumer item ${descriptor.id} (index ${descriptor.itemIndex}) step_done skipped:`
      + ` code ${error.code} stale/duplicate report (${error.message})`;
    console.warn(`[consumer-fanout] ${summary}`);
    progress.warn(summary);

    // The rejecting report is stale; engine state is authoritative. Reconcile
    // only this item, then resume to obtain a current pump response. Failures in
    // either recovery call remain fatal rather than being swallowed here.
    const audit = await stratum.audit(flowId);
    artifacts.reconcileAudit(audit, {
      fanoutStepId: descriptor.step,
      itemIndex: descriptor.itemIndex,
    });
    const response = await stratum.resume(flowId);

    progress.stepDone(descriptor.id);
    streamWriter.write({
      type: 'build_step_done',
      stepId: descriptor.id,
      summary,
      status: 'skipped',
      outcome: 'skipped',
      error_code: error.code,
      error_message: error.message,
      retries: Math.max(0, (descriptor.attempt ?? 1) - 1),
      violations: [`JSON-RPC ${error.code}: ${error.message}`],
      flowId,
      consumer: true,
      parallel: true,
      itemIndex: descriptor.itemIndex,
      stage: descriptor.stage,
      generation: descriptor.generation,
      lane: deriveConsumerLane(descriptor, flowId),
    });
    return { response, skipped: true };
  }
}

export function waveProfilesEnabled(profiles) {
  return Object.entries(routingProfileProjection(profiles ?? {}, { mode: 'off' }).staticProfiles).some(([id, entry]) =>
    id === '_consumer' || id === '_costCeiling' || (!id.startsWith('_') && typeof entry === 'object'));
}

/** One durable delivery spool for metadata and paid-call receipts. */
export async function flushWaveReceipts(context, dispatchIds) {
  routingArtifactsFor(context);
  const artifacts = context.artifacts;
  for (const pending of artifacts?.journal?.pendingUsageReceipts ?? []) {
    if (pending.state === 'acknowledged' || dispatchIds && !dispatchIds.includes(pending.dispatchId)) continue;
    if (context.buildCancel?.cancelled || typeof context.stratum?.usageReport !== 'function') {
      throw new ConsumerArtifactError('WAVE_EVIDENCE_INCOMPLETE', 'Receipt retained locally; replication unavailable or cancelled');
    }
    try {
      const ack = await context.stratum.usageReport(context.flowId, pending.receipt);
      if (!['ok', 'accepted', 'duplicate'].includes(ack?.status)) throw new Error('Receipt acknowledgement missing');
      artifacts.acknowledgeUsageReceipt({ dispatchId: pending.dispatchId, seq: ack.receipt?.seq ?? ack.seq });
    } catch (error) {
      await confirmCancellation(error, context);
      throw new ConsumerArtifactError('WAVE_EVIDENCE_INCOMPLETE', `Receipt ${pending.dispatchId} retained locally: ${error.message}`);
    }
  }
}

export async function reportWaveEvidence(context, kind, token, detail, state) {
  const dispatchId = `compose:${kind}:${context.flowId}:${token}${state ? `:${state}` : ''}`;
  const receipt = { dispatchId, source: `compose:${kind}`, usage: {}, detail };
  context.artifacts.recordPendingUsageReceipt({ dispatchId, receipt });
  await flushWaveReceipts(context, [dispatchId]);
  return dispatchId;
}

/** Validate the recorded full input, before a concurrency-truncated ready list runs. */
// Present recorded child steps under their engine-scoped ids without changing persisted state.
function readRoutingSnapshot(runId, options) {
  const snapshot = readRoutingSnapshotRaw(runId, options);
  const steps = { ...snapshot.steps };
  for (const [parentId, parent] of Object.entries(snapshot.steps)) {
    for (const [id, child] of Object.entries(parent.sub?.steps ?? {})) steps[`${parentId}/${id}`] = child;
  }
  return { ...snapshot, steps };
}
function routingStepState(snapshot, scopedStep) {
  const [parent, child] = scopedStep.split('/');
  return snapshot.steps[scopedStep] ?? (child ? snapshot.steps[parent]?.sub?.steps?.[child] : undefined);
}
// Routing transport stays on flow input; model prompts/options never receive it.
export function routingOptionsFor(profiles = {}, opts = {}) {
  const mode = opts.route_mode ?? profiles._routing?.mode ?? 'off';
  assertRoutingSlice({ mode, policy: { route_trials: opts.route_trials, route_explore: opts.route_explore },
    calibration_feedback: opts.calibration_feedback, calibration: opts.calibration });
  return { mode, route_trials: opts.route_trials ?? [], route_explore: opts.route_explore ?? 0,
    calibration_feedback: opts.calibration_feedback ?? false };
}
const sameRouting = (a, b) => canonicalRoutingJson(a) === canonicalRoutingJson(b);
const routeBase = (start, type, id) => ({ schemaVersion: 1, startId: start.startId, rootDigest: start.rootDigest, type, id });

/** Resolve authoring scope separately from the engine's physical step identity. */
function routingScope(spec, descriptor) {
  const scopedStep = descriptor.step ?? descriptor.id;
  const bare = scopedStep.split('/').at(-1);
  const parent = scopedStep.includes('/') ? spec.flows[spec.flows.entry]?.steps.find(s => s.id === scopedStep.split('/')[0]) : null;
  const flow = descriptor.flow ?? parent?.run ?? spec.flows.entry;
  const steps = spec.flows[flow]?.steps ?? [];
  const step = steps.find(s => s.id === scopedStep || s.id === bare);
  if (!step) routingRefuse('ROUTING_BINDING_MISSING', `Missing scoped step ${flow}/${scopedStep}`);
  const stage = isConsumerDescriptor(descriptor) ? descriptor.stage : null;
  const scope = `${flow}/${step.id}${stage === null ? '' : `/stage-${stage}`}`;
  return { scopedStep, step, stage, scope, flow };
}

/** An external initialization witness distinguishes a lost journal from an interrupted first write. */
function routingArtifacts({ cwd, targetCwd = cwd, artifactRoot, start, binding, ancestry, snapshot, specDigest }) {
  const markerDir = join(cwd, '.compose/routing/starts', start.startId, 'journals');
  const marker = join(markerDir, `${binding.runId}.json`);
  if ([markerDir, marker].some(path => existsSync(path) && lstatSync(path).isSymbolicLink())) routingRefuse('ROUTING_STORAGE_UNSAFE', 'Symlink journal witness refused');
  const journalPath = routingJournalPath({ runId: binding.runId, targetCwd, artifactRoot });
  if (!existsSync(journalPath)) {
    if (existsSync(marker)) routingRefuse('ROUTING_BINDING_MISSING', 'Initialized routing journal was lost');
    // No supported Compose execution may already have happened before first initialization.
    if (Object.values(snapshot.steps).some(s => s.acceptedDispatchToken || s.fanout?.items?.some(i => i.acceptedDispatchToken))) {
      routingRefuse('ROUTING_BINDING_MISSING', 'Missing journal after engine execution');
    }
  }
  const artifacts = new ConsumerFanoutArtifacts({ runId: binding.runId, targetCwd, artifactRoot,
    revisionDigest: binding.revisionDigest, specDigest, routingBinding: binding, routingAncestry: ancestry, routingObservation: true,
    profilesDigest: waveProfilesEnabled(start.mergedProfiles) ? start.profilesDigest : undefined });
  mkdirSync(markerDir, { recursive: true });
  const bytes = canonicalRoutingJson({ bindingId: binding.id, journalPath });
  if (existsSync(marker)) {
    if (readFileSync(marker, 'utf8') !== bytes) routingRefuse('ROUTING_BINDING_DRIFT', 'Routing journal location changed');
  } else {
    const fd = openSync(marker, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    const dir = openSync(markerDir, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  return artifacts;
}

/** Public shared fresh-plan seam used by both runners. Off calls retain their exact envelope. */
export async function planWithRouting({ stratum, specYaml, flowName, input, cwd, featureCode,
  profiles = {}, options = {}, targetCwd = cwd, artifactRoot, continuation = null, priorRouting = null }) {
  const mode = priorRouting ? 'shadow' : options.mode ?? 'off';
  routingProfileProjection(profiles, { ...options, mode });
  const pending = cwd ? pendingRoutingPlans({ cwd, featureCode }).filter(plan => {
    if (!plan.bound) return true;
    const marker = join(cwd, '.compose/routing/starts', plan.start.startId, 'journals', `${plan.binding.runId}.json`);
    if (!existsSync(marker)) return true;
    const { journalPath } = JSON.parse(readFileSync(marker, 'utf8'));
    if (!existsSync(journalPath)) routingRefuse('ROUTING_BINDING_MISSING', 'Initialized routing journal was lost');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    return !Object.values(journal.routing?.records ?? {}).some(r => r.type === 'issuance');
  }) : [];
  if (pending.length > 1) routingRefuse('ROUTING_PLAN_UNCERTAIN', 'Multiple pending plans for feature');
  let start = priorRouting?.start;
  let intent;
  let requested = false;
  if (pending.length) {
    ({ start, intent, requested } = pending[0]);
    if ((intent.previousRunId ?? null) !== (priorRouting?.binding.runId ?? null)) routingRefuse('ROUTING_PLAN_UNCERTAIN', 'Pending plan has different predecessor');
    if (!sameRouting(start.originalInput, input) || !sameRouting(start.spec.original, YAML.parse(specYaml))
      || !sameRouting(start.originalProfiles, profiles)) routingRefuse('ROUTING_ROOT_DRIFT', 'Pending plan static configuration differs');
  } else if (mode === 'off') {
    return { response: await stratum.plan(specYaml, flowName, input, { workspaceRoot: cwd }), routing: null };
  } else {
    const runtime = {};
    const effective = resolvePlanSpecValues(YAML.parse(specYaml), input, runtime);
    Object.assign(runtime, options.runtimeOverrides ?? {});
    const runtimeOrigins = { ...Object.fromEntries(Object.entries(runtime).map(([id, profile]) => [id,
      { supplied: false, origin: 'recorded-role', recordedRole: profile }])), ...options.runtimeOrigins };
    const preflight = preflightProfiles(profiles, effective, runtime, { ...options, mode, runtimeOrigins });
    start ??= createRoutingStart({ cwd, spec: specYaml, inputs: input, originalProfiles: profiles,
      runtimeOverrides: options.runtimeOverrides ?? {}, runtimeOrigins, preflight, mode, presetId: flowName });
    const outgoing = { ...start.originalInput, route_mode: 'shadow', routing_start: canonicalRoutingJson(start),
      routing_root: start.rootDigest, routing_plan_intent: randomUUID(), ...(continuation ? { routing_continuation: continuation.id } : {}) };
    intent = recordRoutingPlanIntent({ cwd, start, input: outgoing, specDigest: start.spec.effectiveDigest,
      featureCode, previousRunId: priorRouting?.binding.runId ?? null, continuation });
  }
  validateRoutingTransport(YAML.parse(specYaml));
  let response, binding;
  if (requested) {
    binding = recoverRoutingPlan({ cwd, intent });
    // Recover an existing plan; never mint another engine run on acknowledgement loss.
  } else {
    recordRoutingPlanRequested({ cwd, start, intent });
    try { response = await stratum.plan(specYaml, flowName, intent.input, { workspaceRoot: cwd }); }
    catch (error) {
      try { binding = recoverRoutingPlan({ cwd, intent }); }
      catch { routingRefuse('ROUTING_PLAN_UNCERTAIN', `Plan acknowledgement unavailable: ${error.message}`); }
    }
    if (!binding) binding = bindRoutingRun({ cwd, start, intent,
      snapshot: readRoutingSnapshot(response.runId, { revisionDigest: response.revisionDigest }) });
  }
  const snapshot = readRoutingSnapshot(binding.runId);
  const artifacts = routingArtifacts({ cwd, targetCwd, artifactRoot, start, binding, snapshot,
    ancestry: priorRouting?.artifacts.exportRoutingJournal(), specDigest: createHash('sha256').update(JSON.stringify(YAML.parse(specYaml))).digest('hex') });
  const routing = { start, binding, artifacts, resolvedRoutes: new Map(), cwd };
  artifacts.routingContext = routing;
  await recoverRoutingEvidence({ routing, stratum });
  await reconcileRoutingIssuances({ context: { routing, stratum }, snapshot });
  response ??= await stratum.resume(binding.runId);
  return { response, routing };
}

// Adding optional transport declarations is the only compatible authored-spec change for an old off run.
function legacyRoutingSpecPin({ runId, cwd, targetCwd, artifactRoot, localSpec, fallback }) {
  const path = join(process.env.STRATUM_STATE_ROOT ?? join(homedir(), '.stratum/ts/flows'), `${runId}.json`);
  const journalPath = routingJournalPath({ runId, targetCwd, artifactRoot });
  if (!existsSync(path) || !existsSync(journalPath)) return fallback;
  const snapshot = JSON.parse(readFileSync(path, 'utf8'));
  if (!snapshot.spec || !snapshot.input) return fallback;
  const stripDeclarations = spec => {
    const result = structuredClone(spec);
    for (const flow of Object.values(result.flows ?? {})) for (const key of ['route_mode', 'routing_start', 'routing_root', 'routing_plan_intent', 'routing_continuation']) {
      if (flow?.input?.[key] === 'string?') delete flow.input[key];
    }
    return result;
  };
  const effective = resolvePlanSpecValues(structuredClone(localSpec), snapshot.input);
  if (!sameRouting(stripDeclarations(effective), stripDeclarations(snapshot.spec))) return fallback;
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  return journal.routing ? fallback : journal.specDigest ?? fallback;
}

/** Participation is recorded, independent of current flags and sidecar defaults. */
export async function resumeRouting({ runId, cwd, targetCwd = cwd, artifactRoot, localSpec, profiles, stratum, featureCode }) {
  const path = join(process.env.STRATUM_STATE_ROOT ?? join(homedir(), '.stratum/ts/flows'), `${runId}.json`);
  const journalPath = routingJournalPath({ runId, targetCwd, artifactRoot });
  const indexed = featureCode ? pendingRoutingPlans({ cwd, featureCode }).some(p => p.binding?.runId === runId) : false;
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (indexed || existsSync(journalPath) && JSON.parse(readFileSync(journalPath, 'utf8')).routing) routingRefuse('ROUTING_STATE_UNVERIFIED', error.message);
    return null; // Preserve historical off behavior on engines without local snapshots.
  }
  const journalPin = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')).routing : null;
  if (!Object.keys(raw.input ?? {}).some(k => k.startsWith('routing_') || k === 'route_mode')) {
    if (journalPin || indexed) routingRefuse('ROUTING_ROOT_MISSING', 'Participating input lost its root');
    return null;
  }
  const snapshot = readRoutingSnapshot(runId);
  const recorded = JSON.parse(snapshot.input.routing_start);
  const start = readRoutingStart({ cwd, startId: recorded.startId, rootDigest: snapshot.input.routing_root });
  if (!sameRouting(start.spec.original, localSpec)) routingRefuse('ROUTING_ROOT_DRIFT', 'Original spec changed');
  if (!sameRouting(start.originalProfiles, profiles)) routingRefuse('ROUTING_ROOT_DRIFT', 'Original sidecar changed');
  const runtime = {};
  const effective = resolvePlanSpecValues(structuredClone(localSpec), start.originalInput, runtime);
  const preflight = preflightProfiles(profiles, effective, { ...runtime, ...start.runtimeOverrides }, { mode: 'shadow' });
  if (preflight.profilesDigest !== start.profilesDigest) routingRefuse('ROUTING_ROOT_DRIFT', 'Recorded static profiles changed');
  const binding = readRoutingRunBinding({ cwd, start, runId });
  const artifacts = routingArtifacts({ cwd, targetCwd, artifactRoot, start, binding, snapshot,
    specDigest: createHash('sha256').update(JSON.stringify(localSpec)).digest('hex') });
  validateRoutingRun({ cwd, snapshot, journal: artifacts.journal, currentSpec: localSpec, currentMappings: routingModelMappings(preflight) });
  const routing = { start, binding, artifacts, resolvedRoutes: new Map(), cwd };
  artifacts.routingContext = routing;
  await recoverRoutingEvidence({ routing, stratum });
  await reconcileRoutingIssuances({ context: { routing, stratum }, snapshot });
  return routing;
}

function checkedRouting(context, snapshot) {
  const routing = context.routing;
  if (!routing) return null;
  const { start, binding, artifacts } = routing;
  snapshot ??= readRoutingSnapshot(binding.runId, { rootDigest: start.rootDigest });
  const journal = { routing: artifacts.exportRoutingJournal() };
  validateRoutingRun({ cwd: routing.cwd ?? start.workspaceRoot, snapshot, journal,
    currentSpec: start.spec.original, currentMappings: routingModelMappings(preflightProfiles(start.originalProfiles,
      start.spec.effective, { ...Object.fromEntries(Object.entries(start.staticResolutions).filter(([, p]) => p.manualFallback.profile)
        .map(([scope, p]) => [scope.split('/')[1], p.manualFallback.profile])), ...start.runtimeOverrides }, { mode: 'shadow' })) });
  return snapshot;
}
function routingKey(start, scope, scopedStep, stage, route) {
  const fingerprint = start.contracts[scope]?.fingerprint;
  if (!fingerprint) routingRefuse('ROUTING_BINDING_MISSING', `Missing contract closure ${scope}`);
  return dispatchKey({ preset: start.presetId, scopedStep, stage, provider: route.resolution.provider,
    template: route.resolution.template ?? '', prior: route.provenance.prior, fingerprint });
}
function baselineRoute(start, scope, resolution, itemTier = false) {
  const pin = start.staticResolutions[scope];
  if (!pin) routingRefuse('ROUTING_BINDING_MISSING', `Missing static route ${scope}`);
  return { resolution, provenance: { ...pin, winner: resolution, prior: itemTier ? resolution.tier : pin.prior,
    source: itemTier ? 'preset' : pin.source, via: itemTier ? 'item.tier' : pin.via,
    manualFallback: pin.manualFallback } };
}
function admittedRoute(routing, admission, baseline) {
  const key = canonicalRoutingJson([admission.id, admission.scopedStep, admission.stage, admission.logicalTaskId]);
  const retained = routing.artifacts.readRoutingRecord(admission.id);
  if (!sameRouting(retained.baseline, baseline) || retained.rootDigest !== routing.start.rootDigest) routingRefuse('ROUTING_BINDING_DRIFT', 'Admitted route baseline differs');
  const existing = routing.resolvedRoutes.get(key);
  if (existing && !sameRouting(existing, retained.admitted)) routingRefuse('ROUTING_BINDING_DRIFT', 'Stage route map differs');
  routing.resolvedRoutes.set(key, retained.admitted);
  return routing.resolvedRoutes.get(key).resolution;
}
function makeAdmission({ routing, scopedStep, stage, scope, epoch, logicalEpoch = epoch, logicalWaveId,
  logicalTaskId = null, itemIndex = null, generation = null, input, inputProvenance, resolution, itemTier = false }) {
  const { start, binding } = routing;
  const allocationId = routingDigest({ startId: start.startId, scopedStep, stage, logicalWaveId, logicalEpoch, logicalTaskId });
  const baseline = baselineRoute(start, scope, resolution, itemTier);
  const key = routingKey(start, scope, scopedStep, stage, baseline);
  const decision = resolveRoute({ start, key, baseline, allocationId });
  return { ...routeBase(start, 'admission', routingDigest({ allocationId, type: 'admission' })), scopedStep, stage,
    logicalWaveId, logicalEpoch, logicalTaskId, allocationId, runId: binding.runId, epoch, itemIndex, generation,
    inputDigest: routingDigest(input), inputProvenance, candidate: baseline, baseline,
    proposal: decision.proposal, admitted: decision.admitted, would: decision.would, refusal: null,
    repairContext: { state: 'not-evaluated-s1a' } };
}

export function admitOrdinaryRoute({ descriptor, snapshot, localSpec, context }) {
  if (!context.routing) return null;
  snapshot = checkedRouting(context, snapshot);
  const { routing } = context;
  const { scopedStep, scope, step } = routingScope(localSpec, descriptor);
  if (step.fanout || !step.agent) return null;
  const epoch = routingStepEpoch(snapshot, scopedStep);
  if (snapshot.steps[scopedStep].dispatchToken !== descriptor.dispatchToken || descriptor.epoch !== undefined && descriptor.epoch !== epoch) {
    routingRefuse('ROUTING_BINDING_DRIFT', 'Ordinary descriptor token/epoch differs');
  }
  const previous = Object.values(routing.artifacts.exportRoutingJournal().records).filter(r => r.type === 'admission' && r.scopedStep === scopedStep && r.stage === null);
  const sameEpoch = previous.filter(r => r.runId === snapshot.id && r.epoch === epoch);
  const input = { input: snapshot.input, scopedInput: snapshot.steps[scopedStep.split('/')[0]]?.sub?.input ?? null,
    stepInputs: descriptor.inputs ?? {}, intent: descriptor.do ?? null };
  if (sameEpoch.length) {
    if (sameEpoch.length !== 1 || sameEpoch[0].inputDigest !== routingDigest(input)) routingRefuse('ROUTING_BINDING_DRIFT', 'Ordinary epoch input differs');
    admittedRoute(routing, sameEpoch[0], sameEpoch[0].baseline);
    return sameEpoch[0];
  }
  const logicalEpoch = previous.length ? Math.max(...previous.map(a => a.logicalEpoch)) + 1 : epoch;
  const resolution = routing.start.staticResolutions[scope]?.winner;
  const admission = makeAdmission({ routing, scopedStep, scope, stage: null, epoch, logicalEpoch,
    logicalWaveId: routingDigest({ startId: routing.start.startId, scopedStep }), input,
    inputProvenance: { runId: snapshot.id, inputDigest: routingDigest(snapshot.input), fullInput: input }, resolution });
  routing.artifacts.recordRoutingAdmissions([admission]);
  admittedRoute(routing, admission, admission.baseline);
  return admission;
}

export function prepareRoutingIssuance({ descriptor, admission, context }) {
  if (!admission || !context.routing) return null;
  const { routing } = context;
  const snapshot = checkedRouting(context);
  const state = snapshot.steps[admission.scopedStep];
  const item = admission.stage === null ? state : state?.fanout?.items?.[descriptor.itemIndex];
  const epoch = routingStepEpoch(snapshot, admission.scopedStep);
  if (!item || item.dispatchToken !== descriptor.dispatchToken || (admission.stage !== null &&
    (item.generation !== descriptor.generation || (item.epoch ?? epoch) !== epoch || item.index !== undefined && item.index !== descriptor.itemIndex))) {
    routingRefuse('ROUTING_BINDING_DRIFT', 'Issuance differs from recorded token/item');
  }
  const identity = { runId: routing.binding.runId, scopedStep: admission.scopedStep, stage: admission.stage, epoch,
    itemIndex: admission.stage === null ? null : descriptor.itemIndex, generation: admission.stage === null ? null : descriptor.generation,
    issuanceToken: descriptor.dispatchToken };
  const id = routingRecordId(identity);
  const journal = routing.artifacts.exportRoutingJournal();
  if (journal.tokenIndex[descriptor.dispatchToken]) return routing.artifacts.readRoutingRecord(id);
  const siblings = Object.values(journal.records).filter(r => r.type === 'issuance' && r.admissionId === admission.id);
  const tips = siblings.filter(r => !siblings.some(next => next.priorRecordId === r.id));
  if (tips.length > 1) routingRefuse('ROUTING_BINDING_DRIFT', 'Ambiguous prior issuance');
  const { scope } = routingScope(routing.start.spec.effective, descriptor);
  const issuance = routing.artifacts.recordRoutingIssuance({ issuance: { ...routeBase(routing.start, 'issuance', id), ...identity,
    revisionDigest: routing.binding.revisionDigest, logicalWaveId: admission.logicalWaveId, logicalEpoch: admission.logicalEpoch,
    logicalTaskId: admission.logicalTaskId, key: routingKey(routing.start, scope, admission.scopedStep, admission.stage, admission.baseline),
    admissionId: admission.id, priorRecordId: tips[0]?.id ?? null, selected: admission.admitted, would: admission.would } });
  if (admission.stage === null && !tips.length) {
    const prior = Object.values(journal.records).filter(r => r.type === 'epoch-binding' && r.scopedStep === admission.scopedStep && r.stage === null).at(-1);
    routing.artifacts.recordRoutingRecord({ ...routeBase(routing.start, 'epoch-binding', routingDigest({ admissionId: admission.id, type: 'epoch-binding' })),
      scopedStep: admission.scopedStep, stage: null, logicalWaveId: admission.logicalWaveId, logicalEpoch: admission.logicalEpoch, logicalTaskId: null,
      runId: identity.runId, epoch: identity.epoch, priorEpochBindingId: prior?.id ?? null, admissionIds: [admission.id], issuanceIds: [issuance.id],
      sourceBinding: null, graph: null, graphDigest: null });
  }
  return issuance;
}
export function routingEvent(context, issuance, event, detail = {}) {
  if (!issuance) return;
  const artifacts = context.routing?.artifacts ?? context.artifacts;
  const journal = artifacts.exportRoutingJournal();
  const id = routingDigest({ issuanceId: issuance.id, event });
  const old = journal.records[id];
  return artifacts.recordRoutingEvent({ ...routeBase(journal, 'issuance-event', id), issuanceId: issuance.id,
    issuanceToken: issuance.issuanceToken, event, sequence: old?.sequence ?? journal.eventTips[issuance.id].count, ...detail });
}
export async function reconcileRoutingIssuances({ context, snapshot, only = null }) {
  if (!context.routing) return;
  const { routing, stratum } = context;
  snapshot = checkedRouting(context, snapshot);
  const journal = routing.artifacts.exportRoutingJournal();
  for (const issuance of Object.values(journal.records).filter(r => r.type === 'issuance' && (!only || r.id === only))) {
    let projected = routingIssuanceState(journal, issuance.id);
    if (issuance.stage !== null && ['launched', 'uncertain'].includes(projected.state)) {
      const artifact = routing.artifacts.journal.issuances.find(e => e.dispatchToken === issuance.issuanceToken);
      if (artifact?.envelope) {
        routingEvent(context, issuance, 'result-prepared', { envelope: artifact.envelope });
        projected = routingIssuanceState(routing.artifacts.exportRoutingJournal(), issuance.id);
      }
    }
    if (projected.state === 'settled' || projected.state === 'prepared') continue;
    if (issuance.runId !== snapshot.id) routingRefuse('ROUTING_ISSUANCE_UNCERTAIN', 'Unsettled predecessor run');
    let step = routingStepState(snapshot, issuance.scopedStep);
    let item = issuance.stage === null ? step : step?.fanout?.items?.[issuance.itemIndex];
    if (item?.acceptedDispatchToken !== issuance.issuanceToken && projected.envelope && item?.dispatchToken === issuance.issuanceToken) {
      const id = issuance.stage === null ? issuance.scopedStep : `${issuance.scopedStep}/${issuance.itemIndex}`;
      const response = await stratum.stepDone(issuance.runId, id, projected.envelope, issuance.issuanceToken);
      if (acknowledgeRoutingFailure(context, issuance, projected.envelope, response)) continue;
      snapshot = readRoutingSnapshot(issuance.runId);
      step = routingStepState(snapshot, issuance.scopedStep);
      item = issuance.stage === null ? step : step?.fanout?.items?.[issuance.itemIndex];
    }
    if (item?.acceptedDispatchToken !== issuance.issuanceToken || (step.epoch ?? 0) !== issuance.epoch
      || issuance.stage !== null && (item.generation !== issuance.generation || (item.epoch ?? step.epoch ?? 0) !== issuance.epoch)) {
      routingRefuse('ROUTING_ISSUANCE_UNCERTAIN', `Unverified execution ${issuance.id}`);
    }
    routingEvent(context, issuance, 'settled', { evidence: { runId: issuance.runId, revisionDigest: snapshot.revisionDigest,
      scopedStep: issuance.scopedStep, epoch: issuance.epoch, itemIndex: issuance.itemIndex, generation: issuance.generation,
      issuanceToken: issuance.issuanceToken, acceptedDispatchToken: item.acceptedDispatchToken, status: item.status } });
  }
}
export async function launchRoutingIssuance(context, issuance) {
  if (!issuance) return;
  const state = routingIssuanceState(context.routing.artifacts.exportRoutingJournal(), issuance.id);
  if (state.state !== 'prepared') routingRefuse('ROUTING_ISSUANCE_UNCERTAIN', 'Issuance already launched; reconcile before dispatch');
  const snapshot = checkedRouting(context);
  const step = routingStepState(snapshot, issuance.scopedStep);
  const item = issuance.stage === null ? step : step?.fanout?.items?.[issuance.itemIndex];
  if (item?.dispatchToken !== issuance.issuanceToken || (step?.epoch ?? 0) !== issuance.epoch
    || issuance.stage !== null && item?.generation !== issuance.generation) routingRefuse('ROUTING_BINDING_DRIFT', 'Launch token/epoch differs');
  const bundle = context.routing.artifacts.prepareRoutingMetadata(issuance.id);
  await flushObservedReceipts(context, bundle.metadata.dispatchId);
  routingEvent(context, issuance, 'launch-intent');
}
export async function reportRoutingStep(context, descriptor, issuance, envelope) {
  if (issuance) routingEvent(context, issuance, 'result-prepared', { envelope });
  const response = await context.stratum.stepDone(context.flowId, descriptor.id, envelope, descriptor.dispatchToken);
  if (issuance) {
    acknowledgeRoutingFailure(context, issuance, envelope, response);
    await reconcileRoutingIssuances({ context, only: issuance.id });
  }
  return response;
}

/** Seal a completed physical epoch only at its transition boundary; retries remain an append-only chain. */
export function sealRoutingEpochs(routing, { exceptEpoch = null, scopedStep = null } = {}) {
  const journal = routing.artifacts.exportRoutingJournal();
  const records = Object.values(journal.records);
  const admissions = records.filter(r => r.type === 'admission' && r.stage !== null &&
    (!scopedStep || r.scopedStep === scopedStep));
  const issuances = records.filter(r => r.type === 'issuance' && r.runId === routing.binding.runId && r.stage !== null);
  const groups = new Map();
  for (const issuance of issuances) {
    if (issuance.epoch === exceptEpoch) continue;
    const key = `${issuance.scopedStep}:${issuance.stage}:${issuance.epoch}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(issuance);
  }
  for (const group of groups.values()) {
    const first = group[0];
    const existing = records.find(r => r.type === 'epoch-binding' && !r.id.startsWith('capture_') && r.runId === first.runId && r.scopedStep === first.scopedStep && r.stage === first.stage && r.epoch === first.epoch);
    if (existing) {
      if (!sameRouting(existing.issuanceIds, group.map(i => i.id).sort())) routingRefuse('ROUTING_BINDING_DRIFT', 'Sealed epoch issuance set differs');
      continue;
    }
    const epochAdmissions = admissions.filter(a => a.scopedStep === first.scopedStep && a.stage === first.stage &&
      a.logicalWaveId === first.logicalWaveId && a.logicalEpoch === first.logicalEpoch);
    const continuation = journal.records[routing.binding.continuationIntentId];
    const retainedTasks = continuation?.bindings.filter(b => b.scopedStep === first.scopedStep).map(b => b.logicalTaskId);
    const active = retainedTasks ? epochAdmissions.filter(a => retainedTasks.includes(a.logicalTaskId)) : epochAdmissions;
    if (active.some(a => !group.some(i => i.admissionId === a.id))) routingRefuse('ROUTING_CONTINUATION_AMBIGUOUS', 'Wave has unissued allocations');
    if (group.some(i => routingIssuanceState(journal, i.id).state !== 'settled')) routingRefuse('ROUTING_ISSUANCE_UNCERTAIN', 'Epoch has unresolved calls');
    const snapshot = readRoutingSnapshot(routing.binding.runId);
    // The physical source for a continuation is retained in its dispatch bindings.
    const dispatch = Object.values(routing.artifacts.journal.dispatchBindings ?? {}).find(b => b.routing?.recordId === first.id);
    const provenance = dispatch?.itemBinding?.sourceProvenance ?? active[0]?.inputProvenance;
    const sourceBinding = provenance?.routingSource ?? null;
    const graph = provenance?.routingGraph ?? null;
    if (sourceBinding) {
      const source = snapshot.steps[sourceBinding.scopedStep];
      if (source?.acceptedDispatchToken !== sourceBinding.acceptedDispatchToken || !sameRouting(source.output, sourceBinding.output)) {
        routingRefuse('ROUTING_BINDING_DRIFT', 'Allocation source changed before epoch transition');
      }
    }
    const prior = records.filter(r => r.type === 'epoch-binding' && !r.id.startsWith('capture_') && r.scopedStep === first.scopedStep && r.stage === first.stage &&
      (r.runId !== first.runId || r.epoch < first.epoch)).at(-1);
    const record = { ...routeBase(routing.start, 'epoch-binding', routingDigest({ runId: first.runId,
      scopedStep: first.scopedStep, stage: first.stage, epoch: first.epoch, type: 'epoch-binding' })),
      scopedStep: first.scopedStep, stage: first.stage, logicalWaveId: first.logicalWaveId, logicalEpoch: first.logicalEpoch,
      logicalTaskId: null, runId: first.runId, epoch: first.epoch, priorEpochBindingId: prior?.id ?? null,
      admissionIds: active.map(a => a.id).sort(), issuanceIds: group.map(i => i.id).sort(), sourceBinding,
      graph, graphDigest: graph === null ? null : routingDigest(graph) };
    routing.artifacts.recordRoutingRecord(record);
  }
}
function admitRoutingWave({ routing, descriptor, descriptors, localSpec, items, epoch, sourceProvenance, profilesByStage, itemStates }) {
  const { scopedStep, scope, stage } = routingScope(localSpec, descriptor);
  checkedRouting({ routing });
  sealRoutingEpochs(routing, { exceptEpoch: epoch, scopedStep });
  const journal = routing.artifacts.exportRoutingJournal();
  const records = Object.values(journal.records);
  const continuation = journal.records[routing.binding.continuationIntentId];
  const carried = epoch === 0 ? continuation?.bindings.filter(b => b.scopedStep === scopedStep && b.stage === stage) : null;
  if (carried?.length && (!sameRouting(continuation.filteredGraph.tasks, items) || carried.length !== items.length)) {
    routingRefuse('ROUTING_CONTINUATION_AMBIGUOUS', 'Continuation wave differs from recorded transformation');
  }
  const priorAdmissions = records.filter(r => r.type === 'admission' && r.scopedStep === scopedStep && r.stage === stage);
  const currentSource = sourceProvenance.routingSource;
  for (const prior of priorAdmissions) {
    const source = prior.inputProvenance.routingSource;
    if (currentSource && source && currentSource.runId === source.runId && currentSource.scopedStep === source.scopedStep
      && currentSource.epoch === source.epoch && !sameRouting(currentSource, source)) routingRefuse('ROUTING_BINDING_DRIFT', 'Same source epoch changed its accepted token/output');
  }
  const sourceIdentity = { ...sourceProvenance };
  const sourceDigest = routingDigest(sourceIdentity);
  const current = priorAdmissions.filter(r => r.runId === routing.binding.runId && r.epoch === epoch);
  // A succeeded source supplies the same logical wave across merge revisions.
  const sameSource = priorAdmissions.filter(a => routingDigest(a.inputProvenance) === sourceDigest);
  const lastEpoch = priorAdmissions.length ? Math.max(...priorAdmissions.map(a => a.logicalEpoch)) : -1;
  const logicalWaveId = carried?.[0]?.logicalWaveId ?? sameSource[0]?.logicalWaveId
    ?? routingDigest({ startId: routing.start.startId, scopedStep, stage, sourceDigest });
  const logicalEpoch = carried?.[0]?.logicalEpoch ?? current[0]?.logicalEpoch ?? Math.max(epoch, lastEpoch + 1);
  const admissions = items.map((item, itemIndex) => {
    const retained = carried?.find(b => b.logicalTaskId === item?.id);
    const resolution = Object.fromEntries(Object.entries(profilesByStage[stage][itemIndex]).filter(([k]) => k !== 'profilesDigest'));
    const pin = routing.start.staticResolutions[scope];
    const baseline = baselineRoute(routing.start, scope, resolution, Boolean(pin.itemTier && Object.hasOwn(item ?? {}, 'tier')));
    if (retained) {
      const admission = routing.artifacts.readRoutingRecord(retained.admissionId);
      if (!sameRouting(baseline, admission.baseline)) routingRefuse('ROUTING_BINDING_DRIFT', 'Continued static route changed');
      return admission;
    }
    const logicalTaskId = typeof item?.id === 'string' && item.id ? item.id : routingDigest({ logicalWaveId, itemIndex });
    const previous = current.find(a => a.itemIndex === itemIndex);
    if (previous) {
      if (previous.inputDigest !== routingDigest(item) || !sameRouting(previous.inputProvenance, sourceProvenance)
        || !sameRouting(previous.baseline, baseline)) routingRefuse('ROUTING_BINDING_DRIFT', 'Recorded wave admission changed');
      return previous;
    }
    const admission = makeAdmission({ routing, scopedStep, scope, stage, epoch, logicalEpoch, logicalWaveId,
      logicalTaskId, itemIndex, generation: itemStates[itemIndex].generation, input: item, inputProvenance: sourceProvenance, resolution,
      itemTier: Boolean(pin.itemTier && Object.hasOwn(item ?? {}, 'tier')) });
    return admission;
  });
  if (new Set(admissions.map(a => a.logicalTaskId)).size !== admissions.length) routingRefuse('ROUTING_CONTINUATION_AMBIGUOUS', 'Duplicate logical task ids');
  routing.artifacts.recordRoutingAdmissions(admissions);
  const links = {};
  for (const d of descriptors.filter(d => d.step === descriptor.step)) {
    const admission = admissions[d.itemIndex];
    const resolution = admittedRoute(routing, admission, admission.baseline);
    profilesByStage[d.stage][d.itemIndex] = { ...resolution, profilesDigest: routing.artifacts.journal.profilesDigest };
    const issuance = prepareRoutingIssuance({ descriptor: d, admission, context: { routing } });
    links[d.dispatchToken] = { rootDigest: routing.start.rootDigest, recordId: issuance.id, admissionId: admission.id,
      logicalTaskId: admission.logicalTaskId, logicalWaveId: admission.logicalWaveId, logicalEpoch: admission.logicalEpoch };
  }
  return links;
}

export async function admitConsumerWave({ descriptor, descriptors = [descriptor], audit, localSpec,
  profiles = {}, artifacts, stratum, flowId, routing = null }) {
  const policy = profiles._consumer?.[descriptor.step] ?? {};
  const legacy = Boolean(profiles[descriptor.step]?.tier_from || profiles._consumer?.[descriptor.step]);
  if (!legacy && !routing) return null;
  audit ??= await stratum.audit(flowId);
  const { step, flow } = routingScope(localSpec, descriptor);
  if (!legacy && step.fanout?.steps?.length !== 1) return null;
  const participating = routing && step.fanout?.dispatch === 'consumer' && step.fanout.steps.length === 1;
  if (participating) checkedRouting({ routing });
  const state = audit?.steps?.[descriptor.step];
  // Fresh engine fanouts omit the parent epoch but stamp every audit item with 0.
  // Derive from that recorded item evidence; never admit an unrecorded epoch.
  const epoch = state?.epoch ?? state?.fanout?.items?.[0]?.epoch;
  const findings = [];
  const add = message => findings.push({ code: 'WAVE_INPUT_INVALID', message });
  let items;
  let sourceProvenance;
  let routingSource = null;
  let routingGraph = null;
  try {
    const reference = step?.fanout?.over;
    const expression = typeof reference === 'string' && reference.match(/^\$\{([a-z][a-z0-9_-]*)((?:\.[A-Za-z_]\w*|\[\d+\])*)\}$/);
    if (!expression || ['item', 'prev'].includes(expression[1])) throw new Error('Unsupported recorded fanout reference');
    const root = expression[1];
    const path = [...expression[2].matchAll(/\.([A-Za-z_]\w*)|\[(\d+)\]/g)].map(m => m[1] ?? Number(m[2]));
    const access = (value, segments) => {
      for (const key of segments) {
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)
          || ['__proto__', 'prototype', 'constructor'].includes(key)) return undefined;
        value = value[key];
      }
      return value;
    };
    if (root === 'input' && path.length) {
      const snapshot = readFlowSnapshot(flowId, { revisionDigest: artifacts.journal.revisionDigest });
      items = access(snapshot.input, path);
      sourceProvenance = { reference, inputDigest: profilesDigest(snapshot.input) };
    } else if (path[0] === 'output') {
      const sourceStep = descriptor.step.includes('/') ? `${descriptor.step.slice(0, descriptor.step.lastIndexOf('/'))}/${root}` : root;
      const source = audit.steps?.[sourceStep];
      // Ordinary source steps also omit their initial epoch (the engine uses 0).
      const sourceEpoch = source?.epoch ?? 0;
      if (source?.status !== 'succeeded' || (!participating && sourceEpoch !== epoch)) throw new Error('Wave source is not current and succeeded');
      items = access(source.output, path.slice(1));
      if (participating) {
        if (!source.acceptedDispatchToken) throw new Error('Missing accepted source token');
        routingSource = { runId: flowId, scopedStep: sourceStep, epoch: sourceEpoch, acceptedDispatchToken: source.acceptedDispatchToken,
          output: source.output, outputDigest: routingDigest(source.output) };
        if (Array.isArray(source.output?.tasks) && sameRouting(source.output.tasks, items)) routingGraph = source.output;
      }
      sourceProvenance = { reference, step: root, epoch: sourceEpoch,
        acceptedDispatchToken: source.acceptedDispatchToken, outputDigest: profilesDigest(source.output) };
    } else {
      // Engine carry expressions are bare names (${wave.tasks}), not ${carry.wave.tasks}.
      const carry = Object.hasOwn(audit.carry ?? {}, root) ? audit.carry[root] : undefined;
      items = access(carry?.value, path);
      sourceProvenance = { reference, carry: carry ?? null };
    }
    if (!Array.isArray(items) || !Number.isInteger(epoch) || epoch < 0
      || !Array.isArray(state?.fanout?.items) || items.length !== state.fanout.items.length) {
      throw new Error('Recorded wave length/epoch differs from fanout');
    }
    for (const [index, item] of state.fanout.items.entries()) {
      if ((item.epoch ?? state.epoch) !== epoch || item.index !== undefined && item.index !== index) {
        throw new Error('Recorded fanout item index/epoch differs from wave');
      }
    }
    for (const d of descriptors.filter(d => d.step === descriptor.step)) {
      const recorded = state.fanout.items[d.itemIndex];
      if (!recorded || !Number.isInteger(d.itemIndex) || d.itemIndex < 0
        || !Number.isInteger(d.stage) || d.stage < 0 || d.stage >= step.fanout.steps.length
        || recorded.generation !== d.generation
        || d.epoch !== undefined && d.epoch !== epoch
        || profilesDigest(d.item) !== profilesDigest(items[d.itemIndex])) throw new Error('Descriptor differs from recorded wave item');
    }
  } catch (error) { add(error.message); }
  if (participating && sourceProvenance) sourceProvenance = { ...sourceProvenance, routingSource, routingGraph, routingItems: items };
  const profilesByStage = [];
  if (!findings.length) for (const stage of step.fanout.steps) {
    const result = validateWaveAdmission(profiles[step.id] ?? stage.agent ?? 'claude', items,
      { provider: stage.agent?.startsWith('$.input')
        ? resolveConsumerProfile(profiles[step.id], {}).provider : stage.agent ?? 'claude',
        ownership: policy.ownership, independent: policy.independent });
    findings.push(...result.findings);
    profilesByStage.push(result.profiles.map(p => ({ ...p, profilesDigest: artifacts.journal.profilesDigest })));
  }
  if (findings.length) {
    if (participating) routingRefuse(findings[0].code, findings.map(f => f.message).join('; '));
    const failure = `${findings[0].code}: ${findings.map(f => `item ${(f.itemIndex ?? -1) + 1} ${f.message}`).join('; ')}`;
    await reportWaveEvidence({ artifacts, stratum, flowId }, 'wave_admission',
      `${descriptor.step}:${epoch ?? 'unknown'}`, { findings, failure, items: items ?? null });
    return { failure, findings };
  }
  if (policy.checkpoint_gate) artifacts.initializeWave({ ref: `refs/heads/compose/wave/${flowId}`,
    profilesDigest: artifacts.journal.profilesDigest });
  if (artifacts.journal.wave?.checkpoints.some(c => c.state !== 'published' || !c.evidenceReceiptId)) {
    throw new WaveCheckpointError('WAVE_CHECKPOINT_EVIDENCE_MISSING', 'Checkpoint publication/evidence pending before admission');
  }
  const routingLinks = participating ? admitRoutingWave({ routing, descriptor, descriptors, localSpec, items, epoch, sourceProvenance, profilesByStage, itemStates: state.fanout.items }) : {};
  if (legacy) {
    const previous = artifacts.journal.waveAdmissions?.find(a => a.fanoutStepId === step.id && a.epoch === epoch);
    const baseCommit = previous?.baseCommit ?? (artifacts.journal.wave
      ? worktreeBaseFor({ journal: artifacts.journal, ref: readCheckpointRef({ cwd: artifacts.targetCwd, ref: artifacts.journal.wave.ref }) })
      : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: artifacts.targetCwd, encoding: 'utf8' }).trim());
    artifacts.recordWaveAdmission({ fanoutStepId: step.id, epoch, inputDigest: profilesDigest(items),
      sourceProvenance, baseCommit, items: items.map((item, itemIndex) => ({ itemIndex,
        itemDigest: profilesDigest(item), filesOwned: item.files_owned ?? [],
        profilesByStage: profilesByStage.map(stage => stage[itemIndex]) })) });
  }
  const bindings = {};
  for (const d of descriptors.filter(d => d.step === descriptor.step)) {
    bindings[d.dispatchToken] = artifacts.recordDispatchBinding({ dispatchToken: d.dispatchToken,
      itemBinding: { item: items[d.itemIndex], itemDigest: profilesDigest(items[d.itemIndex]), epoch, sourceProvenance },
      resolvedProfile: profilesByStage[d.stage][d.itemIndex],
      ...(routing && !participating ? { deferred: { flow, step: step.id, stage: d.stage } } : {}), ...(routingLinks[d.dispatchToken] ? { routing: routingLinks[d.dispatchToken] } : {}) });
  }
  return { bindings, ...(participating ? { routingOnly: !legacy } : {}) };
}

/** recoverCheckpoint owns prepared-fsync -> CAS -> published, using the merge witness. */
export async function publishConsumerCheckpoint(context, transaction) {
  routingArtifactsFor(context);
  const artifacts = context.artifacts;
  if (!artifacts?.journal?.wave || !transaction) return;
  artifacts.recoverCheckpoint(transaction);
  await replicateCheckpoints(context);
}

function capturedWavePaths(artifacts) {
  if (!artifacts?.journal?.wave) return [];
  return [...new Set((artifacts.journal.wave?.checkpoints ?? []).flatMap(checkpoint =>
    execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', checkpoint.baselineTree, checkpoint.tree, '--'],
      { cwd: artifacts.targetCwd, encoding: 'utf8' }).split('\0').filter(Boolean)))];
}

async function replicateCheckpoints(context) {
  routingArtifactsFor(context);
  const artifacts = context.artifacts;
  for (const checkpoint of artifacts?.journal?.wave?.checkpoints ?? []) {
    if (checkpoint.evidenceReceiptId) continue;
    const { publishedAt, materializedTree, preparedAt, state, ...identity } = checkpoint;
    const evidenceReceiptId = await reportWaveEvidence(context, 'checkpoint', checkpoint.gateToken, identity, 'published');
    artifacts.markCheckpointPublished({ gateToken: checkpoint.gateToken, commit: checkpoint.commit, evidenceReceiptId });
    context.streamWriter?.write({ type: 'wave_checkpoint', ...identity, flowId: context.flowId });
  }
  if (artifacts?.journal?.wave) {
    context.filesChanged = capturedWavePaths(artifacts);
    context.recordFilesChanged?.(context.filesChanged);
  }
}

/** Current audit only; a token's durable human hold survives a ceiling override. */
export async function evaluateConfiguredGate(context, { localSpec, gateStepId, gateToken, audit, costCeilingUsd }) {
  const profiles = context.pipelineProfiles ?? {};
  const config = profiles[gateStepId]?.decide_from ? profiles[gateStepId] : null;
  const budget = profiles._costCeiling?.gates.includes(gateStepId) ? profiles._costCeiling : null;
  if (!config && !budget) return null;
  audit ??= await context.stratum.audit(context.flowId);
  let decision = null;
  let ceiling;
  if (budget) {
    try {
      if (!context.receiptsMode) throw new Error('Usage receipt surface unavailable');
      await flushWaveReceipts(context);
      const read = readFlowSpend(context.flowId, { revisionDigest: context.artifacts.journal.revisionDigest,
        gateStepId, gateToken }, context.artifacts.journal.pendingUsageReceipts);
      const limit = costCeilingUsd ?? read.input?.[budget.input] ?? budget.default;
      if (!Number.isFinite(limit) || limit <= 0) throw new Error('Ceiling must be finite and positive');
      ceiling = { spent: read.spent, ceiling: limit };
      const control = { ceiling: limit, input: budget.input, override: costCeilingUsd ?? null };
      await reportWaveEvidence(context, 'cost_ceiling', gateToken, control, profilesDigest(control));
      if (read.spent > limit) decision = { outcome: null, reason: 'WAVE_COST_CEILING_EXCEEDED', ...ceiling };
    } catch (error) {
      decision = { outcome: null, reason: 'WAVE_COST_UNVERIFIED', message: error.message };
    }
  }
  const held = context.artifacts.journal.pendingUsageReceipts?.find(p =>
    p.dispatchId === `compose:gate_hold:${context.flowId}:${gateToken}`);
  if (held) return { ...held.receipt.detail, outcome: null };
  if (!decision && config) {
    const steps = localSpec.flows[localSpec.flows.entry].steps;
    const execute = steps.find(s => s.id === 'execute' && s.fanout?.dispatch === 'consumer')
      ?? steps.find(s => profiles._consumer?.[s.id]?.independent)
      ?? steps.find(s => profiles[s.id]?.tier_from)
      ?? steps.find(s => profiles._consumer?.[s.id]) ?? steps.find(s => s.fanout?.dispatch === 'consumer');
    const executeProfile = profiles[execute?.id] ?? execute?.fanout?.steps?.[0]?.agent ?? 'claude';
    const executeProvider = resolveConsumerProfile(executeProfile, {}).provider;
    // The engine omits `epoch` on a step that has never been revised (initial epoch
    // = 0, the same convention admission applies at the wave seam); the gate's
    // staleness fence compares integers, so materialise the convention here rather
    // than reading a fresh run as stale (GATE_SOURCE_STALE on every first pass).
    const states = Object.fromEntries(Object.entries(audit.steps ?? {}).map(([id, state]) =>
      [id, state && typeof state === 'object' ? { ...state, epoch: state.epoch ?? 0 } : state]));
    decision = decideGateFromOutput(config, states, { gateStepId, gateToken, ceiling, executeProfile, executeProvider });
  }
  if (!decision) return null;
  if (!decision.outcome) {
    // Queue first even if the cost-delivery barrier itself is unavailable.
    try { await reportWaveEvidence(context, 'gate_hold', gateToken, decision); }
    catch (error) { if (context.buildCancel?.cancelled) throw error; }
  } else {
    await reportWaveEvidence(context, 'gate_decision', gateToken, decision, 'proposed');
    const fresh = await context.stratum.audit(context.flowId);
    if (fresh.steps?.[gateStepId]?.gateToken !== gateToken
      || [config.decide_from.step, ...(config.validators ?? []).map(v => v.review_step)].some(id =>
        profilesDigest(fresh.steps?.[id] ?? null) !== profilesDigest(audit.steps?.[id] ?? null))) {
      return { outcome: null, reason: 'GATE_SOURCE_STALE' };
    }
  }
  return decision;
}

export function prepareWaveShip(context) {
  const artifacts = context?.artifacts;
  const wave = artifacts?.journal?.wave;
  if (!wave?.checkpoints.length) return;
  const checkpoint = wave.checkpoints.at(-1);
  if (checkpoint.state !== 'published' || !checkpoint.evidenceReceiptId) {
    throw new WaveCheckpointError('WAVE_CHECKPOINT_EVIDENCE_MISSING', 'Ship requires acknowledged checkpoint evidence');
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: artifacts.targetCwd, encoding: 'utf8' }).trim();
  if (head !== wave.baseCommit) {
    const shipped = artifacts.journal.pendingUsageReceipts?.find(p =>
      p.receipt.source === 'compose:wave_ship' && p.receipt.detail.commit === head);
    const parent = execFileSync('git', ['rev-parse', `${head}^`], { cwd: artifacts.targetCwd, encoding: 'utf8' }).trim();
    if (!shipped || parent !== wave.baseCommit || shipped.receipt.detail.checkpointTree !== checkpoint.tree) {
      throw new WaveCheckpointError('WAVE_CHECKPOINT_DIVERGED', 'HEAD differs from base and recorded ship');
    }
    context.filesChanged = shipped.receipt.detail.filesChanged;
    return { replay: shipped };
  }
  const tree = squashOntoBase({ cwd: artifacts.targetCwd, ref: wave.ref, base: wave.baseCommit });
  if (tree !== checkpoint.tree) throw new WaveCheckpointError('WAVE_CHECKPOINT_DIVERGED', 'Ship tree differs from checkpoint');
  context.filesChanged = [...new Set([...(context.filesChanged ?? []), ...capturedWavePaths(artifacts)])];
  context.recordFilesChanged?.(context.filesChanged);
  return tree;
}

export async function runConsumerIssuance({
  descriptor,
  flowId,
  stratum,
  artifacts,
  audit,
  localSpec,
  context,
  progress,
  streamWriter,
  // D2(a): GSD supplies a per-ITEM wall-clock ceiling (per_task_ms). Compose
  // runs each agent, so the per-item bound is enforced here (not as an engine
  // step budget — the engine can't know N). Absent → the static per-step
  // circuit breaker below. D3: an optional stuck detector observes agent tool
  // events for this item and halts a spinning run.
  perItemTimeoutMs = null,
  stuckDetector = null,
  // COMP-BUILD-CANCEL S03-5: the build-level cancel handle, so an item's agent dies with
  // the build. Optional — lib/gsd.js calls this without one.
  buildCancel = null,
  // D6: the full agent profile string for this fanout step (from the compose
  // sidecar), applied at invocation so e.g. an isolation:none review fanout runs
  // read-only. Absent → the descriptor's bare provider literal (no restrictions).
  profile = null,
  admission = null,
}) {
  routingArtifactsFor({ ...context, artifacts });
  if (profile && typeof profile !== 'string') throw new Error('Consumer profile must be a resolved string; pass pipelineProfiles for item admission');
  const configured = context.pipelineProfiles?.[descriptor.step]?.tier_from
    || context.pipelineProfiles?._consumer?.[descriptor.step] || context.routing;
  if (configured && !admission) admission = await admitConsumerWave({
    descriptor, descriptors: [descriptor], audit: await stratum.audit(flowId),
    localSpec, profiles: context.pipelineProfiles, artifacts, stratum, flowId, routing: context.routing,
  });
  const bound = admission?.bindings?.[descriptor.dispatchToken];
  if (context.routing && !bound?.routing && localSpec.flows[descriptor.flow ?? localSpec.flows.entry]?.steps.find(s => s.id === descriptor.step)?.fanout?.steps.length === 1) routingRefuse('ROUTING_BINDING_MISSING', 'Missing routing dispatch binding');
  const routingIssuance = bound?.routing ? artifacts.readRoutingRecord(bound.routing.recordId) : null;
  if (routingIssuance) {
    const retained = artifacts.readRoutingRecord(routingIssuance.admissionId);
    const selected = admittedRoute(context.routing, retained, retained.baseline);
    if (selected.profile !== bound.resolvedProfile.profile) routingRefuse('ROUTING_BINDING_DRIFT', 'Dispatch profile differs from admitted route');
  }
  if (bound) profile = bound.resolvedProfile.profile;
  const evidenceContext = { ...context, stratum, flowId, artifacts, buildCancel };
  if (admission?.failure) {
    const envelope = { failure: admission.failure };
    const entry = artifacts.prepareArtifactFailure(descriptor, envelope,
      new ConsumerArtifactError(admission.findings[0]?.code ?? 'WAVE_INPUT_INVALID', admission.failure));
    await reportWaveEvidence(evidenceContext, 'wave_rejected', descriptor.dispatchToken,
      { findings: admission.findings });
    const report = await reportConsumerStepDone({ descriptor, flowId, envelope: entry.envelope,
      stratum, artifacts, progress, streamWriter, buildCancel });
    if (!report.skipped) artifacts.reconcileAudit(await stratum.audit(flowId),
      { fanoutStepId: descriptor.step, itemIndex: descriptor.itemIndex });
    return report.response;
  }
  let recovery;
  try {
    recovery = artifacts.reconcileDescriptor(descriptor, audit);
  } catch (error) {
    // The worktree disappeared before Compose had enough journaled material to
    // reconstruct it, or its witness could not be restored. Report through the
    // ordinary item-local retry channel instead of stranding the whole fanout.
    const artifactError = error instanceof ConsumerArtifactError
      ? error
      : new ConsumerArtifactError(
        'ITEM_ARTIFACT_RECOVERY_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    const envelope = { failure: `${artifactError.code}: ${artifactError.message}` };
    artifacts.prepareArtifactFailure(descriptor, envelope, artifactError);
    const report = await reportConsumerStepDone({
      descriptor, flowId, envelope, stratum, artifacts, progress, streamWriter, buildCancel,
    });
    if (report.skipped) return report.response;
    const { response } = report;
    if (typeof artifacts.hooks.afterStepDone === 'function') {
      await artifacts.hooks.afterStepDone({ descriptor, envelope, response, recoveredArtifactFailure: true });
    }
    artifacts.reconcileAudit(await stratum.audit(flowId), { fanoutStepId: descriptor.step, itemIndex: descriptor.itemIndex });
    return response;
  }

  if (recovery.action === 'accepted') {
    throw new Error(`accepted consumer issuance ${descriptor.id} unexpectedly remained ready`);
  }
  if (recovery.action === 'report') {
    const entry = artifacts.journal.issuances.find(e => e.dispatchToken === descriptor.dispatchToken);
    if (entry?.findings?.length) await reportWaveEvidence(evidenceContext, 'ownership', descriptor.dispatchToken, { findings: entry.findings });
    const report = await reportConsumerStepDone({
      descriptor,
      flowId,
      envelope: recovery.envelope,
      buildCancel,
      stratum,
      artifacts,
      progress,
      streamWriter,
    });
    if (report.skipped) return report.response;
    const { response } = report;
    if (typeof artifacts.hooks.afterStepDone === 'function') {
      await artifacts.hooks.afterStepDone({
        descriptor,
        envelope: recovery.envelope,
        response,
        recoveredPrepared: true,
      });
    }
    artifacts.reconcileAudit(await stratum.audit(flowId), { fanoutStepId: descriptor.step, itemIndex: descriptor.itemIndex });
    return response;
  }

  const contract = resolveConsumerOutputContract(descriptor);
  const dispatch = {
    ...descriptor,
    step_id: descriptor.id,
    flow_id: flowId,
    intent: descriptor.do,
    output_fields: contract.outputFields,
    has_out_contract: contract.hasOutContract,
    output_contract_closure: contract.closure,
  };
  // F4: a review fanout item (ReviewResult output contract) runs through review
  // normalization + the confidence gate; lens/gate come from the fanned-out item.
  const reviewOpts = deriveConsumerReviewOptions(descriptor);
  const worktreeContext = { ...context, cwd: recovery.worktree };
  let prompt = buildStepPrompt(dispatch, worktreeContext);
  // G2: a review item's spec intent is thin ("honor lens_name, lens_focus, …").
  // The operational scaffold — lens focus, exclusions, confidence-gate + severity
  // instructions, canonical ReviewResult shape, and (claude-family) the lens cert
  // reasoning template lives in Compose's buildReviewPrompt wrapper rather than
  // the YAML. Apply it here so consumer review
  // items are framed identically. This is dispatch infrastructure, not spec re-authoring.
  if (reviewOpts.reviewMode) {
    const item = (descriptor.item && typeof descriptor.item === 'object') ? descriptor.item : {};
    const reviewAgentType = descriptor.agent ?? 'claude';
    let reviewScaffold = buildReviewPrompt({
      agentType: reviewAgentType,
      lens: reviewOpts.lens,
      lensFocus: item.lens_focus ?? '',
      exclusions: item.exclusions ?? '',
      confidenceGate: reviewOpts.confidenceGate,
      taskDescription: '',
      blueprint: '',
    });
    if (reviewAgentType.startsWith('claude') && item.lens_name) {
      const lensDef = LENS_DEFINITIONS[item.lens_name];
      if (lensDef?.reasoning_template) {
        reviewScaffold = injectCertInstructions(reviewScaffold, lensDef.reasoning_template);
      }
    }
    prompt = reviewScaffold + '\n\n' + prompt;
  }
  const maxDurationMs = perItemTimeoutMs ?? STEP_TIMEOUT_MS[descriptor.id] ?? DEFAULT_TIMEOUT_MS;

  // D3: stable per-item key for the stuck detector's per-task bookkeeping. In
  // GSD mode this becomes the operator-facing stuck task id (stuck.json/pause.json/
  // stuck.md), so it MUST be the decompose task id (T01), matching the blackboard
  // + milestone report. GSD threads descriptor.item.id via context.gsdTaskId
  // (same precedence as gsdTaskId below); build-mode fanout passes no gsdTaskId and
  // keeps the item-id/index key unchanged (byte-identical).
  const stuckTaskId = context?.gsdTaskId ?? descriptor.item?.id ?? `${descriptor.step ?? descriptor.id}:${descriptor.itemIndex}`;
  // The detector observes this item's agent tool events (tagged with the item's
  // task key) and returns a stuck verdict; runAndNormalize then aborts the run.
  const onAgentEvent = stuckDetector
    ? (env) => {
        stuckDetector.record({ ...env, task_id: stuckTaskId });
        const verdict = stuckDetector.check(stuckTaskId, Date.now());
        return verdict.stuck ? verdict : null;
      }
    : undefined;
  if (stuckDetector) stuckDetector.startTask(stuckTaskId, Date.now());

  // H3: GSD milestone instrumentation. In GSD mode compose records per-item
  // wall-clock timing and (at final stage) a diff snapshot to
  // `.compose/gsd/<feature>/{timing.json,diffs/<id>.diff}` for the milestone
  // report. Gated on context.gsd — the BUILD consumer fanout passes no gsd marker
  // and writes nothing (byte-identical). Stratum's parallel poll carries no
  // per-item timing, so compose's own observation here is the only carrier.
  const gsdInstrument = context?.gsd === true && !!context?.featureCode;
  // The task id MUST match what the milestone report + blackboard key on
  // (decompose task ids like T01), not the fanout item index. The engine's GSD
  // consumer descriptor does NOT carry `.item`, so the real runGsd call site
  // passes the resolved task id via context.gsdTaskId; fall back to the item id /
  // index only outside GSD.
  const gsdTaskId = context?.gsdTaskId ?? descriptor.item?.id ?? String(descriptor.itemIndex);
  const gsdStartIso = gsdInstrument ? new Date().toISOString() : null;

  // H6: a consumer-fanout item is a PARALLEL task from the cockpit's point of
  // view. The UI initializes its parallel-task progress only for events carrying
  // `parallel: true` AND a `∥`-prefixed stepNum (AgentStream.processMessage); the
  // bridge forwards `parallel` but nothing else keys the task. So the per-item
  // start/done must carry both (stepNum keyed by item index), matching the
  // contract the python parallel-dispatch path emitted — otherwise the fanout runs
  // invisibly and the parallel progress bar never appears.
  const parallelStepNum = `∥${descriptor.itemIndex}`;
  // COMP-AGENT-LANES: the same lane envelope rides every lifecycle write for
  // this item AND (via runAndNormalize opts) every relayed output write, so the
  // cockpit can attribute each event to its worker slot.
  const lane = buildLaneEnvelope(descriptor, flowId, {
    lens: reviewOpts.reviewMode ? reviewOpts.lens : null,
  });
  progress.stepStart(parallelStepNum, '?', descriptor.id);
  streamWriter.write({
    type: 'build_step_start',
    stepId: descriptor.id,
    stepNum: parallelStepNum,
    totalSteps: '?',
    agent: descriptor.agent ?? 'claude',
    intent: descriptor.do,
    flowId,
    consumer: true,
    parallel: true,
    itemIndex: descriptor.itemIndex,
    stage: descriptor.stage,
    generation: descriptor.generation,
    lane,
  });

  if (bound && !admission?.routingOnly) {
    streamWriter.write({ type: 'step_model', stepId: descriptor.id, flowId,
      itemIndex: descriptor.itemIndex, ...bound.resolvedProfile });
    const { routingSource, routingGraph, routingItems, ...staticSource } = bound.itemBinding.sourceProvenance;
    await reportWaveEvidence(evidenceContext, 'item_model', descriptor.dispatchToken,
      { intended: bound.resolvedProfile, itemBinding: { ...bound.itemBinding, sourceProvenance: staticSource } }, 'proposed');
  }
  let mainResult;
  await launchRoutingIssuance(evidenceContext, routingIssuance);
  const routingCalls = callsForRouting(evidenceContext, routingIssuance, routingIssuance ? null : 'multi-stage-consumer', descriptor);
  try {
    mainResult = await runAndNormalize(null, prompt, dispatch, routingCallOptions({
      ...(routingCalls ? { routingCalls } : {}),
      progress,
      streamWriter,
      maxDurationMs,
      stratum,
      lane,
      cwd: recovery.worktree,
      sandboxMode: descriptor.policy?.isolation === 'worktree' ? 'workspace-write' : 'read-only',
      onAgentEvent,
      profile,
      reviewMode: reviewOpts.reviewMode,
      confidenceGate: reviewOpts.confidenceGate,
      lens: reviewOpts.lens,
      // COMP-BUILD-CANCEL S03-4: tag the item so `stratum_flow_cancel` can reach it
      // from another process, and chain the build handle so a local `isolation: none`
      // item — which never enters stratum — dies with the build.
      ...(flowTag(flowId, descriptor.step ?? descriptor.id, descriptor.itemIndex)
        ? { flow: flowTag(flowId, descriptor.step ?? descriptor.id, descriptor.itemIndex) }
        : {}),
      flowId, buildCancel,
      buildSignal: buildCancel?.signal,
      telemetry: {
        site: context.gsd ? 'gsd' : 'consumer',
        project_cwd: context.projectCwd ?? context.cwd,
        build_id: context.build_id,
        feature_code: context.featureCode,
        step_id: descriptor.id,
        ...(typeof descriptor.attempt === 'number' ? { attempt: descriptor.attempt } : {}),
      },
      // Local Claude owns its SDK process group for review fanout and drains
      // graceful teardown before timeout/interrupt returns, as MCP does.
      localExecution: descriptor.policy?.isolation === 'none',
    }));
  } catch (error) {
    if (routingIssuance) routingEvent(evidenceContext, routingIssuance, 'uncertain', { reason: error.message });
    if (context.routing && routingIntegrityError(error)) throw error;
    // A stuck halt writes diagnostics without settling or retrying the issuance,
    // so it does not require confirmed termination. Integrity refusals above
    // still win, even if they also carry an observer-abort type/reason.
    const stuckAbort = error instanceof AgentAbortedError && error.reason?.stuck === true;
    if (routingCalls && !routingCalls.terminated() && !stuckAbort) throw error;
    if (buildCancel?.cancelled) throw error;
    const failedUsage = failureUsageFields(error);
    // Control failures do not settle the item, so record known dispatch usage
    // before aborting the pump. Never retry work with uncertain termination.
    if (error instanceof UserInterruptError || ['INJECTED_CONSUMER_CRASH', 'CANCELLATION_UNCONFIRMED', 'CANCELLATION_TEARDOWN_TIMEOUT'].includes(error?.code)) {
      if (failedUsage.usage && typeof context?.onUsage === 'function') {
        try {
          await context.onUsage(usagePayload(failedUsage.usage, failedUsage.usages), {
            dispatchId: error.dispatchId, stepId: descriptor.step ?? descriptor.id, source: 'consumer',
          });
        } catch (usageError) {
          if (context.routing && routingIntegrityError(usageError)) throw usageError;
          console.warn(`[consumer] Could not record cancelled usage: ${usageError?.message ?? usageError}`);
        }
      }
      throw error;
    }
    // D3: a stuck verdict halts the whole GSD run (not a per-item retry) — the
    // GSD driver catches this, writes the diagnostic, and returns status:stuck.
    if (error instanceof AgentAbortedError) {
      // G3: no step_done envelope is sent on the stuck/abort path (the run halts),
      // so the billable usage the aborted run consumed would be lost. Record it
      // into compose's cumulative ledger before converting to the stuck signal.
      if (failedUsage.usage && typeof context?.onUsage === 'function') {
        await context.onUsage(usagePayload(failedUsage.usage, failedUsage.usages), {
          dispatchId: error.dispatchId,
          stepId: descriptor.step ?? descriptor.id,
          source: 'consumer',
        });
      }
      throw new ConsumerStuckError(stuckTaskId, error.reason);
    }
    if (error instanceof AgentTimeoutError) {
      mainResult = {
        result: { outcome: 'failed', summary: `Timed out after ${Math.round(error.durationMs / 1000)}s` },
        normalizationFailure: error.message,
        dispatchIds: { primary: error.dispatchId ?? null, repair: null },
        settlementFailureClass: 'agent',
        // G3: a timed-out run still consumed billable usage — forward it so the
        // failure envelope debits the engine ledger (same mechanism as F3).
        ...failedUsage,
      };
    } else {
      // A non-timeout agent/connector error must fail ONLY this item, not abort
      // the whole fanout. Restore the pre-stage witness so the retry starts from
      // clean state, then fall through to the per-item failure envelope + the
      // normal prepare→step_done path so other ready items keep progressing.
      artifacts.restoreToPreStageWitness(descriptor);
      const reason = error instanceof Error ? error.message : String(error);
      mainResult = {
        result: { outcome: 'failed', summary: `Agent error: ${reason}` },
        normalizationFailure: reason,
        dispatchIds: { primary: error?.dispatchId ?? null, repair: null },
        settlementFailureClass: 'agent',
        // F3: a failed run still consumed billable usage — the connector attaches
        // it to the error. Forward it so the failure envelope (and compose's
        // cumulative ledger) debit the attempt instead of letting failures evade
        // budget exhaustion.
        ...failedUsage,
      };
    }
  }

  const { result, normalizationFailure } = mainResult;
  // Forward usage to the Build or GSD accumulator; connector evidence owns routing receipts.
  if (context.pipelineProfiles?._costCeiling && !mainResult?.usage) {
    await context.onUsage?.({ dispatch_id: mainResult.dispatchIds?.primary ?? descriptor.dispatchToken }, { stepId: descriptor.step, source: 'fanout' });
  }
  if (typeof context?.onUsage === 'function' && mainResult?.usage) {
    await context.onUsage(usagePayload(mainResult.usage, mainResult.usages), {
      dispatchId: mainResult.dispatchIds?.primary,
      stepId: descriptor.step ?? descriptor.id,
      source: 'fanout',
    });
  }
  const finalStage = isFinalConsumerStage(localSpec, descriptor);
  let localFailure = normalizationFailure
    ?? (result?.outcome === 'failed' ? result?.summary ?? `Step "${descriptor.id}" failed` : null);
  // pre_merge is a worktree-merge gate; an isolation:none item does not merge, so
  // it has no pre-merge verification step.
  if (!localFailure && finalStage && descriptor.policy?.isolation !== 'none'
    && Array.isArray(descriptor.policy?.pre_merge)) {
    const gateFailure = runPreMergeGateLocal(
      recovery.worktree,
      descriptor.policy.pre_merge,
      context.cwd,
      STEP_TIMEOUT_MS[descriptor.id] ?? DEFAULT_TIMEOUT_MS,
    );
    if (gateFailure) localFailure = `pre_merge failed: ${JSON.stringify(gateFailure)}`;
  }
  let envelope = localFailure
    ? { failure: String(localFailure) }
    : contract.hasOutContract
      ? result != null
        ? { output: result }
        : { failure: `Step "${descriptor.id}" did not produce structured output` }
      : {};

  // V1: report the item's agent usage in the step_done envelope so the ENGINE
  // debits its own token/USD/ms ledger (it settles fanout attempts from
  // result.usage). The agent consumed the tokens whether or not the item
  // succeeded, so usage rides both the success and failure envelope. Compose's
  // cumulative ledger (context.onUsage) is separate, compose-side accounting.
  const engineUsage = toEngineUsage(mainResult?.usage);
  if (engineUsage && !context?.receiptsMode) envelope.usage = engineUsage;

  if (typeof artifacts.hooks.afterAgentMutationBeforePrepared === 'function') {
    await artifacts.hooks.afterAgentMutationBeforePrepared({
      descriptor,
      envelope,
      worktree: recovery.worktree,
    });
  }
  const preparedEntry = artifacts.prepareIssuance(descriptor, envelope, {
    finalStage, ...(bound ?? {}),
    ownership: context.pipelineProfiles?._consumer?.[descriptor.step]?.ownership,
  });
  // Legacy injected artifact adapters predate returned envelopes. Configured
  // admission/ownership requires the authoritative primitive result.
  if (configured || bound || preparedEntry?.envelope) envelope = preparedEntry.envelope;
  localFailure = envelope.failure ?? localFailure;
  if (preparedEntry?.findings?.length) await reportWaveEvidence(evidenceContext, 'ownership',
    descriptor.dispatchToken, { findings: preparedEntry.findings });
  if (bound && !admission?.routingOnly) await reportWaveEvidence(evidenceContext, 'item_model', descriptor.dispatchToken,
    { intended: bound.resolvedProfile, observed: { normalizedUsageModel: mainResult.usage?.model ?? null,
      connectorIdentityVerified: false } }, 'observed');
  // H3: record this item's timing + (final-stage) diff snapshot for the GSD
  // milestone report. `preparedEntry.diff` is the cumulative worktree diff the
  // artifacts journal already computed at final stage (null otherwise) — tapped
  // read-only, no re-derivation. The timing accumulator stamps startedAt (from
  // the pre-run capture) and completedAt+durationMs in a single sidecar write.
  if (gsdInstrument) {
    try {
      const timing = readTimingSidecar(context.cwd, context.featureCode);
      recordTaskStates(timing, { [gsdTaskId]: { state: 'running' } }, gsdStartIso);
      recordTaskStates(timing, { [gsdTaskId]: { state: localFailure ? 'failed' : 'complete' } }, new Date().toISOString());
      writeTimingSidecar(context.cwd, context.featureCode, timing);
      if (preparedEntry && typeof preparedEntry.diff === 'string' && preparedEntry.diff.length > 0) {
        writeGsdTaskDiff(context.cwd, context.featureCode, gsdTaskId, preparedEntry.diff);
      }
    } catch { /* best-effort report instrumentation — never fails the item */ }
  }
  if (typeof artifacts.hooks.afterPreparedBeforeReport === 'function') {
    await artifacts.hooks.afterPreparedBeforeReport({ descriptor, envelope, worktree: recovery.worktree });
  }

  const report = await reportConsumerStepDone({
    descriptor, flowId, envelope, stratum, artifacts, progress, streamWriter, buildCancel,
  });
  if (report.skipped) return report.response;
  const { response } = report;
  if (!context.gsd && typeof context?.settleDispatches === 'function') {
    const isEnsureRetry = responseReissuesStep(response, descriptor.id);
    context.settleDispatches({
      stepId: descriptor.id,
      dispatchIds: mainResult.dispatchIds,
      accepted: !localFailure && !isEnsureRetry,
      failureClass: mainResult.settlementFailureClass
        ?? (normalizationFailure ? 'normalization' : (localFailure ? 'agent' : null)),
      isEnsureRetry,
    });
  }
  if (typeof artifacts.hooks.afterStepDone === 'function') {
    await artifacts.hooks.afterStepDone({ descriptor, envelope, response });
  }
  artifacts.reconcileAudit(await stratum.audit(flowId), { fanoutStepId: descriptor.step, itemIndex: descriptor.itemIndex });
  progress.stepDone(descriptor.id);
  streamWriter.write({
    type: 'build_step_done',
    stepId: descriptor.id,
    summary: result?.summary ?? `consumer item ${descriptor.itemIndex} stage ${descriptor.stage} reported`,
    retries: Math.max(0, (descriptor.attempt ?? 1) - 1),
    violations: preparedEntry?.findings ?? [],
    flowId,
    consumer: true,
    // H6: matches the item's start stepId so the UI decrements the same task
    // (AgentStream keys the per-task done on parallel:true + a known stepId).
    parallel: true,
    // COMP-AGENT-LANES (C4): terminal status is explicit at source — the UI
    // must not infer "complete" from the done event's existence.
    status: localFailure ? 'failed' : 'succeeded',
    outcome: localFailure ? 'failed' : (result?.outcome ?? 'succeeded'),
    itemIndex: descriptor.itemIndex,
    stage: descriptor.stage,
    generation: descriptor.generation,
    lane,
  });
  return response;
}

function resolveConsumerConcurrency(descriptors = []) {
  // Surface 8 does not expose fanout.concurrency in descriptor.policy. Accept a
  // future engine policy field if one appears; until then use a default of 3
  // with an explicit Compose-side override.
  for (const descriptor of descriptors) {
    const policy = descriptor?.policy;
    const exposed = policy?.max_concurrent ?? policy?.maxConcurrent ?? policy?.concurrency;
    if (Number.isInteger(exposed) && exposed > 0) return exposed;
  }
  const override = Number(process.env.COMPOSE_FANOUT_CONCURRENCY);
  return Number.isInteger(override) && override > 0 ? override : 3;
}

// ---------------------------------------------------------------------------
// Debug discipline helpers (COMP-DEBUG-1)
// ---------------------------------------------------------------------------

/**
 * Extract a list of changed files from a step result/response object.
 * Handles multiple result shapes agents may return.
 */
function extractFilesChanged(response) {
  const result = response.result ?? {};
  if (Array.isArray(result.files_changed)) return result.files_changed;
  if (typeof result.files_changed === 'string') return result.files_changed.split(',').map(f => f.trim()).filter(Boolean);
  return [];
}

/**
 * D5: deterministic file-ownership enforcement at the decompose output seam.
 * A decompose result promises each task an EXCLUSIVE write set (files_owned).
 * The engine's `len(tasks) >= 1` ensure and the prompt's "reject conflicts"
 * text are not enforcement — two tasks claiming the same file would race in
 * their worktrees and collide at merge. Returns a clear reason string on the
 * FIRST pairwise overlap, or null when every files_owned set is disjoint.
 *
 * @param {Array<{id?:string, files_owned?:string[]}>} tasks
 * @returns {string|null}
 */
/**
 * A local copy of a bundled preset whose sidecar carries EXECUTION configuration
 * (object-form agent entries with tier_from, gate decide_from/validators,
 * `_consumer`, `_costCeiling`) must keep that sidecar: without it the output-driven
 * gate, per-item routing, ownership and the ceiling silently vanish and a blocking
 * repair decision ships (slice 4 review r1 #1). A string-only sidecar carries tool
 * restrictions and tiers, for which "missing → bare defaults" stays the documented
 * behaviour — and a custom spec that merely shares a bundled basename (every build
 * test fixture writes its own pipelines/build.stratum.yaml) is not a copy.
 */
export function sidecarCarriesExecutionConfig(profiles) {
  if (!profiles || typeof profiles !== 'object') return false;
  return Object.entries(profiles).some(([key, value]) =>
    key === '_consumer' || key === '_costCeiling'
    || (!key.startsWith('_') && value !== null && typeof value === 'object'));
}

export function requirePipelineSidecar(specPath) {
  const localPath = resolve(specPath);
  const name = basename(localPath).replace(/\.stratum\.ya?ml$/, '');
  if (name === basename(localPath)) return;
  const sidecarName = `${name}.profiles.json`;
  if (existsSync(join(dirname(localPath), sidecarName))) return;

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const bundledSpecs = ['presets', 'pipelines'].flatMap(directory =>
    ['yaml', 'yml'].map(ext => join(packageRoot, directory, `${name}.stratum.${ext}`)));
  if (bundledSpecs.includes(localPath)) return;
  for (const path of bundledSpecs) {
    const bundledSidecar = join(dirname(path), sidecarName);
    if (!existsSync(path) || !existsSync(bundledSidecar)) continue;
    let bundledProfiles;
    try { bundledProfiles = JSON.parse(readFileSync(bundledSidecar, 'utf-8')); } catch { continue; }
    if (sidecarCarriesExecutionConfig(bundledProfiles)) {
      throw Object.assign(new Error(
        `PROFILE_SIDECAR_REQUIRED: ${specPath} has no adjacent ${sidecarName} but the bundled ${name} ships one that configures gates/routing/ownership — copy both files (see docs/team-presets.md)`,
      ), { code: 'PROFILE_SIDECAR_REQUIRED' });
    }
  }
}

/**
 * D6: load the compose-owned profile sidecar next to a pipeline spec. The engine
 * accepts only the literal claude|codex agent, so the full profile strings that
 * carry tool restrictions + model tiers (claude:read-only-reviewer,
 * claude::critical, claude:orchestrator, ...) live in <spec>.profiles.json keyed
 * by step id and are applied compose-side at invocation. Absent → {} (bare
 * literals; no restrictions), after runBuild enforces required bundled sidecars.
 * Malformed or non-object sidecars fail closed.
 *
 * @param {string} specPath  path to the .stratum.yaml spec
 * @returns {Record<string,string>} step id → agent profile string
 */
export function loadPipelineProfiles(specPath) {
  const sidecar = String(specPath).replace(/\.stratum\.ya?ml$/, '.profiles.json');
  if (sidecar === String(specPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(sidecar, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected an object mapping step ids to profiles');
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Profile sidecar ${sidecar} is invalid: ${error.message}`);
  }
}

/**
 * Pure profile validation across all flows and fanout stages. Runtime references
 * use the supplied role inputs (build defaults for the initial static check).
 * No tier with modelID null means the documented connector default and is legal;
 * an explicit tier with modelID null is unavailable and must fail closed.
 * Metadata keys starting with '_' are ignored; stale step keys are errors.
 */
export function preflightPipelineProfiles(stepProfiles, specYaml, specName = '<spec>', inputs = {
  implementer_agent: 'claude', reviewer_agent: 'codex',
}, routingOptions = {}) {
  const rawProfiles = stepProfiles;
  stepProfiles = routingProfileProjection(stepProfiles, routingOptions).staticProfiles;
  if (Array.isArray(rawProfiles._costCeiling?.gates) && rawProfiles._costCeiling.gates.includes('review_gate')) {
    throw new PipelineProfileError('WAVE_COST_CEILING_RESERVED_GATE',
      `Profile preflight failed for ${specName}: _costCeiling.gates cannot target reserved review_gate`);
  }
  stepProfiles = Object.fromEntries(Object.entries(stepProfiles).filter(([, entry]) => !entry?.decide_from).map(([id, entry]) => [id, entry?.default ?? entry]));
  const rawSpec = typeof specYaml === 'string' ? YAML.parse(specYaml) : structuredClone(specYaml);
  const spec = resolvePlanSpecValues(structuredClone(rawSpec), inputs);
  const rawSteps = Object.values(rawSpec?.flows ?? {}).flatMap(flow => flow?.steps ?? []);
  const rawById = new Map(rawSteps.map(step => [step.id, step]));
  const steps = Object.values(spec?.flows ?? {}).flatMap(flow => flow?.steps ?? []);
  const stepIds = new Set(steps.map(step => step.id));
  const failures = [];
  const resolved = {};
  const check = (id, profile, { engineDispatch = false } = {}) => {
    try {
      if (typeof profile !== 'string' || !profile.trim()) {
        throw new Error('profile must be a non-empty agent string');
      }
      validateAgentString(profile);
      const { provider, template, tier, modelID } = resolveAgentConfig(profile);
      if (tier && modelID === null) throw new Error(`tier "${tier}" has no model for provider "${provider}"`);
      // Review r1 #3: an engine-dispatched fanout invokes its connector inside
      // Stratum, so compose-side tiers/templates never reach the call — certifying
      // a model here that the engine will not use is worse than not checking.
      if (engineDispatch && (tier || template)) {
        throw new Error(`profile "${profile}" carries a tier/template but the fanout is dispatch: engine, where compose profiles are not applied`);
      }
      resolved[id] = { profile, provider, tier, modelID };
    } catch (error) {
      failures.push(`step "${id}": ${error.message}`);
    }
  };
  for (const id of Object.keys(stepProfiles)) {
    if (!id.startsWith('_') && !stepIds.has(id)) failures.push(`step "${id}": not found in spec`);
  }
  for (const step of steps) {
    const hasProfile = !step.id.startsWith('_') && Object.hasOwn(stepProfiles, step.id);
    const stages = step.fanout?.steps ?? [];
    const engineDispatch = step.fanout?.dispatch === 'engine';
    if (Object.hasOwn(step, 'agent') || (hasProfile && stages.length === 0)) {
      check(step.id, hasProfile ? stepProfiles[step.id] : step.agent);
    }
    // Review r1 #1: profiles (sidecar and runtime) are keyed by the FANOUT id and
    // applied to every stage at invocation (resolvePlanSpecValues records the
    // last stage's runtime profile under step.id). A multi-stage fanout whose raw
    // stage agents differ therefore cannot be routed honestly — fail closed.
    if (stages.length > 1) {
      const rawStages = rawById.get(step.id)?.fanout?.steps ?? [];
      const rawAgents = new Set(rawStages.map(stage => JSON.stringify(stage?.agent ?? null)));
      const runtimeRef = rawStages.some(stage => typeof stage?.agent === 'string' && stage.agent.startsWith('$.input'));
      // Bare literals with no profile run as written — nothing collapses.
      if (rawAgents.size > 1 && (hasProfile || runtimeRef)) {
        failures.push(`step "${step.id}": multi-stage fanout stages declare different agents (${[...rawAgents].join(', ')}); profiles are keyed by the fanout id and apply to every stage`);
        continue;
      }
    }
    for (const [index, stage] of stages.entries()) {
      // Review r1 #2: a stage with no explicit agent inherits claude but still
      // consumes the enclosing sidecar profile at invocation — check it too.
      if (!Object.hasOwn(stage, 'agent') && !hasProfile) continue;
      // Single-stage fanouts use the enclosing id, as invocation profile lookup does.
      const id = stages.length === 1 ? step.id : `${step.id}/${index}`;
      check(id, hasProfile ? stepProfiles[step.id] : stage.agent, { engineDispatch });
    }
  }
  if (failures.length) throw new Error(`Profile preflight failed for ${specName}: ${failures.join('; ')}`);
  let checked;
  try { checked = preflightProfiles(rawProfiles, spec, routingOptions.runtimeOverrides ?? {}, routingOptions); }
  catch (error) { if (error.code?.startsWith('ROUTING_')) throw error; throw new Error(`Profile preflight failed for ${specName}: ${error.message}`, { cause: error }); }
  // Keep the public legacy projection; runner-only pins are additive.
  return Object.defineProperties({ ok: true, resolved }, {
    normalized: { value: checked.normalized }, profilesDigest: { value: checked.profilesDigest },
    routingPolicy: { value: checked.routingPolicy }, staticProvenance: { value: checked.staticProvenance },
  });
}

/**
 * V1: convert a compose usage record (runAndNormalize's normalized shape, or the
 * raw TS complete usage) into the engine Budget shape `{tokens?, usd?, ms?}` the
 * step_done envelope carries, so the engine debits its own ledger. Only positive,
 * finite values are included; `dispatches` is intentionally omitted (the engine
 * reserves one per attempt itself — a client count would double-charge). Returns
 * null when there is nothing to report.
 */
export function toEngineUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const tokens = usage.tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0));
  const usd = usage.cost_usd ?? usage.usd ?? 0;
  const ms = usage.duration_ms ?? usage.ms ?? 0;
  const out = {};
  if (Number.isFinite(tokens) && tokens > 0) out.tokens = tokens;
  if (Number.isFinite(usd) && usd > 0) out.usd = usd;
  if (Number.isFinite(ms) && ms > 0) out.ms = ms;
  return Object.keys(out).length > 0 ? out : null;
}

// A repair failure can carry two dispatch records. Keep those records for
// receipts and aggregate both for the legacy step_done budget envelope.
function failureUsageFields(error) {
  const usages = Array.isArray(error?.usages) ? error.usages : null;
  if (!usages?.length) return error?.usage ? { usage: error.usage } : {};
  if (usages.length === 1 && error?.usage) return { usage: error.usage, usages };
  const usage = {
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0, cost_usd: 0, duration_ms: 0, model: null,
  };
  for (const entry of usages) {
    if (!entry || typeof entry !== 'object') continue;
    usage.input_tokens += entry.input_tokens ?? 0;
    usage.output_tokens += entry.output_tokens ?? 0;
    usage.cache_creation_input_tokens += entry.cache_creation ?? entry.cache_creation_input_tokens ?? 0;
    usage.cache_read_input_tokens += entry.cache_read ?? entry.cache_read_input_tokens ?? 0;
    usage.cost_usd += entry.cost_usd ?? 0;
    usage.duration_ms += entry.duration_ms ?? 0;
    usage.model = entry.model ?? usage.model;
  }
  return { usage, usages };
}

/**
 * Provenance for a SUM of dispatches (COMP-COST-OWNER S2).
 *
 * Sticky, and unknown dominates: if any dispatch in the step could not be priced the
 * step's total is not a total at all, and if any was estimated the sum is an estimate.
 * A mixed sum can never honestly be called reported — the same rule result-normalizer
 * applies per run, applied here per step.
 *
 * Returns null for "cannot state it", which is what makes the writer omit the amount
 * instead of emitting a bare number nobody can vouch for.
 */
function aggregateUsdSource(usages) {
  if (!Array.isArray(usages) || usages.length === 0) return null;
  let source = 'reported';
  for (const entry of usages) {
    if (!entry || typeof entry !== 'object') return null;
    if (typeof entry.cost_usd !== 'number' || !Number.isFinite(entry.cost_usd)) return null;
    if (entry.usd_source === 'estimated') source = 'estimated';
    else if (entry.usd_source !== 'reported') return null;   // unlabelled dollar: refuse
  }
  return source;
}

function usagePayload(usage, usages) {
  if (!usage || typeof usage !== 'object') return usage;
  return Array.isArray(usages) ? { ...usage, usages } : usage;
}

/** Send one surface-15 receipt per underlying model dispatch. */
export async function reportUsageReceipts(context, usage, meta = {}) {
  const observed = await reportObservedUsage(context, usage, meta);
  if (observed !== null) return observed;
  if ((!context?.pipelineProfiles?._costCeiling && context?.buildCancel?.cancelled)
    || !context?.receiptsMode || !context.flowId || typeof context.stratum?.usageReport !== 'function') {
    return [];
  }
  const entries = Array.isArray(usage)
    ? usage
    : (Array.isArray(usage?.usages) ? usage.usages : (usage ? [usage] : []));
  const responses = [];
  for (const entry of entries) {
    if (context.buildCancel?.cancelled && !context.pipelineProfiles?._costCeiling) break;
    if (!entry || typeof entry !== 'object') continue;
    const engineUsage = toEngineUsage(entry) ?? (context.pipelineProfiles?._costCeiling ? {} : null);
    if (!engineUsage && !context.pipelineProfiles?._costCeiling) continue;
    // Surface 15 requires explicit USD provenance. Normalized UsageRecords carry
    // `usd_source`; raw engine usage ({tokens, usd, ms}) does not. Preserve raw
    // token/time usage, but fail closed on an unlabelled dollar value instead of
    // manufacturing "reported" provenance.
    const usdSource = ['reported', 'estimated'].includes(entry.usd_source)
      ? entry.usd_source
      : null;
    if (Object.hasOwn(engineUsage, 'usd') && !usdSource) delete engineUsage.usd;
    if (Object.keys(engineUsage).length === 0 && !context.pipelineProfiles?._costCeiling) continue;
    const input = entry.input_tokens;
    const output = entry.output_tokens;
    const receipt = {
      dispatchId: entry.dispatch_id ?? meta.dispatchId ?? randomUUID(),
      ...(meta.stepId ? { stepId: meta.stepId } : {}),
      source: meta.source ?? 'main',
      usage: engineUsage,
      telemetry: {
        model: typeof entry.model === 'string' && entry.model.length > 0 ? entry.model : 'unknown',
        ...(typeof entry.effort === 'string' && entry.effort.length > 0 ? { effort: entry.effort } : {}),
        durationMs: entry.duration_ms ?? entry.ms ?? 0,
      },
      ...(typeof input === 'number' || typeof output === 'number'
        ? { split: {
            input: input ?? 0,
            output: output ?? 0,
            ...(typeof (entry.cache_read ?? entry.cache_read_input_tokens) === 'number'
              ? { cacheRead: entry.cache_read ?? entry.cache_read_input_tokens }
              : {}),
            ...(typeof (entry.cache_creation ?? entry.cache_creation_input_tokens) === 'number'
              ? { cacheCreation: entry.cache_creation ?? entry.cache_creation_input_tokens }
              : {}),
          } }
        : {}),
      ...(Object.hasOwn(engineUsage, 'usd') ? { usdSource } : {}),
      ...(context.pipelineProfiles?._costCeiling && (!usdSource || !Number.isFinite(entry.cost_usd ?? entry.usd))
        ? { detail: { costUnknown: true } } : {}),
    };
    try {
      if (context.pipelineProfiles?._costCeiling) {
        context.artifacts.recordPendingUsageReceipt({ dispatchId: receipt.dispatchId, receipt });
        await flushWaveReceipts(context, [receipt.dispatchId]);
      } else responses.push(await context.stratum.usageReport(context.flowId, receipt));
    } catch (error) {
      if (await confirmCancellation(error, context)) break;
      console.warn(`[usage-receipt] failed for ${receipt.dispatchId}: ${error?.message ?? error}`);
    }
  }
  return responses;
}

/**
 * F5: deterministic v1 vocabulary enforcement, evaluated compose-side at the
 * review_merge step (the step the now-dropped judged ensure was attached to). The
 * TS `judged:` guard could never see the changed files or the vocabulary, so it
 * would fail every merge once a project had a real vocabulary. Here compose scans
 * the actual changed files with the ported deterministic checker and returns a
 * failure summary (violations listed) on any hit, so the ordinary step handler
 * sends a FAILURE step_done envelope and the engine's attempts/retry lifecycle
 * governs — never a throw past the step handler. Inert (null) when vocabulary is
 * off, the step is not review_merge, or the vocabulary is missing/empty.
 *
 * @returns {string|null} failure summary, or null when compliant/inapplicable
 */
export function computeVocabularyStepFailure({ vocabOn, stepId, cwd, filesChanged, base = 'HEAD' } = {}) {
  if (!vocabOn || stepId !== 'review_merge') return null;
  const vocabPath = join(cwd, VOCABULARY_FILE);
  const violations = vocabularyCompliance(vocabPath, filesChanged ?? [], {
    gitFallback: true,
    base,
    cwd,
  });
  if (violations.length === 0) return null;
  return `vocabulary compliance failed at review_merge:\n${violations.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Prior dirty lenses sidecar (STRAT-REV-5: selective re-review)
//
// When the review reducer (review_merge) produces a DIRTY result, its
// `lenses_run` array names the lenses that found problems. Compose persists
// those ids to `.compose/prior_dirty_lenses.json`; on a retry the review_triage
// step reads the sidecar and re-runs ONLY those lenses plus the baselines (the
// RETRY PATH in its prompt), rather than the full first-run lens set. The
// sidecar is cleared when the build completes cleanly. Restored on the flattened
// TS v1 review flow, where review_merge is a top-level reducer (its ensure miss
// reissues only the reducer, so compose — not the engine — writes the sidecar).
// ---------------------------------------------------------------------------

export function priorDirtyLensesPath(composeDir) {
  return join(composeDir, 'prior_dirty_lenses.json');
}

export function persistPriorDirtyLenses(composeDir, lensesRun) {
  mkdirSync(composeDir, { recursive: true });
  writeFileSync(
    priorDirtyLensesPath(composeDir),
    JSON.stringify(lensesRun ?? [], null, 2),
  );
}

export function clearPriorDirtyLenses(composeDir) {
  const p = priorDirtyLensesPath(composeDir);
  if (existsSync(p)) unlinkSync(p);
}

/**
 * J2: extract the TRUE dirty-lens identities from a review reducer's output
 * BEFORE ReviewResult normalization (which resets `lenses_run` to [] and stamps a
 * missing finding lens as 'general'). Accepts the raw agent text OR an
 * already-parsed output object; unions the raw `lenses_run` with the raw findings'
 * `lens`. Returns a de-duplicated list (possibly empty).
 */
export function extractDirtyLenses(rawOutput) {
  let parsed = rawOutput;
  if (typeof rawOutput === 'string') {
    const text = rawOutput.trim();
    if (!text) return [];
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return [];
      try { parsed = JSON.parse(m[0]); } catch { return []; }
    }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const fromLensesRun = Array.isArray(parsed.lenses_run) ? parsed.lenses_run.filter(Boolean) : [];
  const fromFindings = Array.isArray(parsed.findings)
    ? parsed.findings.map((f) => f?.lens).filter(Boolean)
    : [];
  return [...new Set([...fromLensesRun, ...fromFindings])];
}

export function filesOwnedConflict(tasks) {
  if (!Array.isArray(tasks)) return null;
  const owner = new Map(); // normalized file path → first claiming task id
  for (const task of tasks) {
    const id = task?.id ?? '(unnamed)';
    const owned = Array.isArray(task?.files_owned) ? task.files_owned : [];
    for (const raw of owned) {
      // V5: compare the FILE, not the spelling — normalize separators, strip a
      // leading ./, and resolve ./ and ../ segments so `src/x.js`,
      // `./src/x.js`, and `src/../src/x.js` collapse to one path.
      const file = normalizeOwnedPath(raw);
      if (file === null) continue;
      if (owner.has(file) && owner.get(file) !== id) {
        return `file-ownership conflict: "${file}" is claimed by both task ${owner.get(file)} and task ${id} — files_owned must be pairwise disjoint`;
      }
      owner.set(file, id);
    }
  }
  return null;
}

/**
 * V5: canonicalize an files_owned path for disjointness comparison. Posix
 * separators, a resolved segment path (./, ../), and no leading ./ — so
 * cosmetic spelling differences of the same file collapse to one key. Returns
 * null for a non-string / empty / whitespace-only entry.
 */
export function normalizeOwnedPath(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const posixSep = trimmed.replace(/\\/g, '/');
  const normalized = posix.normalize(posixSep);
  const stripped = normalized.replace(/^\.\//, '');
  return stripped.length === 0 ? null : stripped;
}

// ---------------------------------------------------------------------------
// Per-step timeouts
// ---------------------------------------------------------------------------

// Per-step timeout in ms. Steps not listed get the default.
// These are circuit breakers — generous enough for real work, tight enough to stop spiraling.
const STEP_TIMEOUT_MS = {
  explore_design: 20 * 60_000,  // 20 min
  scope:          5  * 60_000,  // 5 min
  prd:            15 * 60_000,  // 15 min
  architecture:   15 * 60_000,  // 15 min
  blueprint:      20 * 60_000,  // 20 min
  verification:   10 * 60_000,  // 10 min
  plan:           15 * 60_000,  // 15 min
  execute:        45 * 60_000,  // 45 min
  review:         15 * 60_000,  // 15 min (multi-lens parallel review)
  triage:         2  * 60_000,  // 2 min (parallel_review triage step)
  merge:          3  * 60_000,  // 3 min (parallel_review merge step)
  codex_review:   10 * 60_000,  // 10 min (codex cross-model review)
  run_tests:      10 * 60_000,  // 10 min (coverage sub-flow step)
  report:         10 * 60_000,  // 10 min
  docs:           10 * 60_000,  // 10 min
  ship:           5  * 60_000,  // 5 min (should be fast — just git ops)
};
const DEFAULT_TIMEOUT_MS = 30 * 60_000; // 30 min fallback

// STRAT-DEDUP-AGENTRUN-V3: connectors live behind the Stratum TS MCP server. The
// `runAndNormalize` helper resolves the agent tier internally and dispatches
// via `stratum.agentRun(...)`, so there is no JS connector factory.

// ---------------------------------------------------------------------------
// Active build state (resume/abort)
// ---------------------------------------------------------------------------

function activeBuildPath(dataDir) {
  return join(dataDir, 'active-build.json');
}

function readActiveBuild(dataDir) {
  const p = activeBuildPath(dataDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * COMP-BUILD-CANCEL §3.7 — re-read and CLAIM before ANY mutation of the active-build
 * record. Strict on purpose: a missing flow id must never match anything.
 *
 * Returns the claimed record, or a REASON. C48: the fallback validates PRESENCE before
 * equality, because `undefined === undefined` is true and two records that both lack a
 * pid would otherwise claim each other.
 */
function claimActiveBuild(dataDir, active) {
  const cur = readActiveBuild(dataDir);
  if (!cur) return { ok: false, reason: 'ownership_lost' };
  if (cur.featureCode !== active.featureCode) return { ok: false, reason: 'ownership_lost' };
  if (cur.flowId && active.flowId) {
    return cur.flowId === active.flowId
      ? { ok: true, record: cur }
      : { ok: false, reason: 'ownership_lost' };
  }
  // No flow id on one side: fall back to pid + startedAt, but ONLY when all four are present.
  const present = Boolean(cur.pid) && Boolean(active.pid)
    && Boolean(cur.startedAt) && Boolean(active.startedAt);
  if (!present) return { ok: false, reason: 'ownership_unverifiable' };
  return (cur.pid === active.pid && cur.startedAt === active.startedAt)
    ? { ok: true, record: cur }
    : { ok: false, reason: 'ownership_lost' };
}

export function writeActiveBuild(dataDir, state, { stampPid = true } = {}) {
  mkdirSync(dataDir, { recursive: true });
  // The aborter must preserve the driver's identity when it owns the terminal write.
  if (stampPid) state.pid = process.pid;
  const target = activeBuildPath(dataDir);
  const tmp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, target);
}

// COMP-COMPLETION-GATE slice 2: v2 adds the completion evidence the gate needs
// at terminalization — `tests_attested` (tri-state) and `evidence_root`.
//
// `test_count`/`pass_rate` were already here but are metrics, not attestation:
// they are only populated when the output PARSED, so their absence is ambiguous
// between "no tests" and "could not read the output". The gate cannot act on an
// ambiguous signal, hence an explicit tri-state.
//
// `evidence_root` is persisted because a cross-repo build runs git and tests in
// the agent's tree while feature metadata lives in the project tree — and
// `runBuild` reconstructs that root from the CURRENT invocation, so a resumed
// cross-repo build would otherwise fall back to the project root and verify the
// wrong repository's HEAD.
const BUILD_ACCUMULATOR_VERSION = 3;
const BUILD_ACCUMULATOR_FIELDS = new Set([
  'v',
  'build_id',
  'feature_code',
  'last_terminal',
  'review_iterations',
  'escalations',
  'files_changed',
  'ship_files_changed',
  'test_count',
  'pass_rate',
  'tests_attested',
  'evidence_root',
  'tokens_total',
  'usd',
  // COMP-COST-OWNER S1. The accumulator is the SOLE owner of what a build cost;
  // every other surface reads it. It previously carried only a combined
  // `tokens_total`, so the history record was written from a second in-memory tally
  // (`buildCostTotals`) that had the split -- and that tally was fed from ONE site
  // while this one is fed from nine. Measured on the 2026-09-12 live-fire run: the
  // ledger and this accumulator agreed to the cent at $1.4257732 while history
  // reported $1.38900475 and 589,373 tokens against 808,002.
  'input_tokens',
  'output_tokens',
  // Steps whose cost we could not price. COUNTED, never folded into `usd` as a zero:
  // a `?? 0` makes "we do not know" indistinguishable from "it was free", which is
  // the defect this feature exists to close.
  'usd_unknown_count',
]);
/** The only values `tests_attested` may hold. See deriveTestsAttested. */
const TESTS_ATTESTED_VALUES = new Set(['passed', 'failed', 'no-signal']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertFeatureCodeForAccumulator(featureCode) {
  if (typeof featureCode !== 'string' || featureCode.length === 0 || /[/\\]/.test(featureCode)) {
    throw new Error('Build accumulator feature code must be a non-empty path-safe string');
  }
}

export function buildAccumulatorPath(projectCwd, featureCode) {
  assertFeatureCodeForAccumulator(featureCode);
  return join(projectCwd, '.compose', 'data', 'build-accumulator', `${featureCode}.json`);
}

function validateBuildAccumulator(value, expectedFeatureCode = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Build accumulator is corrupt: expected an object');
  }
  for (const key of Object.keys(value)) {
    if (!BUILD_ACCUMULATOR_FIELDS.has(key)) {
      throw new Error(`Build accumulator is corrupt: unknown field "${key}"`);
    }
  }
  for (const key of BUILD_ACCUMULATOR_FIELDS) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`Build accumulator is corrupt: missing field "${key}"`);
    }
  }
  if (value.v !== BUILD_ACCUMULATOR_VERSION) {
    throw new Error(`Build accumulator is corrupt: unsupported version ${value.v}`);
  }
  if (typeof value.build_id !== 'string' || !UUID_RE.test(value.build_id)) {
    throw new Error('Build accumulator is corrupt: build_id must be a UUID');
  }
  if (typeof value.feature_code !== 'string' || value.feature_code.length === 0) {
    throw new Error('Build accumulator is corrupt: feature_code must be a non-empty string');
  }
  if (expectedFeatureCode !== null && value.feature_code !== expectedFeatureCode) {
    throw new Error(
      `Build accumulator feature identity mismatch: expected ${expectedFeatureCode}, found ${value.feature_code}`,
    );
  }
  if (![null, 'failed', 'complete', 'aborted'].includes(value.last_terminal)) {
    throw new Error('Build accumulator is corrupt: invalid last_terminal');
  }
  for (const key of ['review_iterations', 'escalations']) {
    if (!Number.isInteger(value[key]) || value[key] < 0) {
      throw new Error(`Build accumulator is corrupt: ${key} must be a non-negative integer`);
    }
  }
  if (!Array.isArray(value.files_changed) || !value.files_changed.every((file) => typeof file === 'string')) {
    throw new Error('Build accumulator is corrupt: files_changed must be a string array');
  }
  if (value.ship_files_changed !== null
    && (!Array.isArray(value.ship_files_changed)
      || !value.ship_files_changed.every((file) => typeof file === 'string'))) {
    throw new Error('Build accumulator is corrupt: ship_files_changed must be null or a string array');
  }
  for (const key of ['test_count', 'pass_rate']) {
    if (value[key] !== null && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
      throw new Error(`Build accumulator is corrupt: ${key} must be null or a finite number`);
    }
  }
  for (const key of ['tokens_total', 'usd']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) {
      throw new Error(`Build accumulator is corrupt: ${key} must be a non-negative finite number`);
    }
  }
  // Null is legal ONLY as the migrated-from-v2 "we cannot know" value; a live v3 build
  // writes integers from the first usage onward.
  for (const key of ['input_tokens', 'output_tokens', 'usd_unknown_count']) {
    if (value[key] !== null && (!Number.isInteger(value[key]) || value[key] < 0)) {
      throw new Error(`Build accumulator is corrupt: ${key} must be null or a non-negative integer`);
    }
  }
  if (!TESTS_ATTESTED_VALUES.has(value.tests_attested)) {
    throw new Error(
      `Build accumulator is corrupt: tests_attested must be one of ${[...TESTS_ATTESTED_VALUES].join('|')}`,
    );
  }
  if (value.evidence_root !== null && typeof value.evidence_root !== 'string') {
    throw new Error('Build accumulator is corrupt: evidence_root must be null or a string');
  }
  return value;
}

/**
 * Bring a v1 accumulator forward. A v1 record predates completion evidence, so
 * it cannot say anything about whether tests were attested — and the honest value
 * for "we do not know" is `no-signal`, which the completion gate REFUSES. A build
 * resumed across this upgrade therefore has to re-attest rather than inheriting a
 * pass it never recorded. That is the intended direction: absence of signal is
 * never attestation.
 */
function migrateBuildAccumulator(value) {
  if (!value || typeof value !== 'object') return value;
  let next = value;
  if (next.v === 1) {
    next = { ...next, v: 2, tests_attested: 'no-signal', evidence_root: null };
  }
  if (next.v === 2) {
    // COMP-COST-OWNER S1. A v2 record knows its combined `tokens_total` and its `usd`
    // and carries both forward untouched. It cannot know the input/output SPLIT, and
    // it cannot know whether any step went unpriced -- so both stay null rather than
    // being invented. Seeding `output_tokens` from `tokens_total` is precisely the
    // conflation this migration exists to avoid: build.js did that at the old :3748
    // and it made a resumed build's split wrong.
    next = { ...next, v: 3, input_tokens: null, output_tokens: null, usd_unknown_count: null };
  }
  return next;
}

export function readBuildAccumulator(projectCwd, featureCode) {
  const path = buildAccumulatorPath(projectCwd, featureCode);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Build accumulator is corrupt at ${path}: ${error.message}`);
  }
  return validateBuildAccumulator(migrateBuildAccumulator(parsed), featureCode);
}

export function writeBuildAccumulator(projectCwd, accumulator) {
  validateBuildAccumulator(accumulator, accumulator?.feature_code ?? null);
  const target = buildAccumulatorPath(projectCwd, accumulator.feature_code);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(accumulator, null, 2));
  renameSync(tmp, target);
  return accumulator;
}

export function clearBuildAccumulator(projectCwd, featureCode) {
  const path = buildAccumulatorPath(projectCwd, featureCode);
  if (existsSync(path)) unlinkSync(path);
}

export function newBuildAccumulatorRecord(featureCode) {
  return {
    v: BUILD_ACCUMULATOR_VERSION,
    build_id: randomUUID(),
    feature_code: featureCode,
    last_terminal: null,
    review_iterations: 0,
    escalations: 0,
    files_changed: [],
    ship_files_changed: null,
    test_count: null,
    pass_rate: null,
    tests_attested: 'no-signal',
    evidence_root: null,
    tokens_total: 0,
    usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    usd_unknown_count: 0,
  };
}

export function createBuildAccumulator(projectCwd, featureCode) {
  return writeBuildAccumulator(projectCwd, newBuildAccumulatorRecord(featureCode));
}

export function updateBuildAccumulator(projectCwd, featureCode, mutate) {
  const current = readBuildAccumulator(projectCwd, featureCode);
  if (!current) {
    throw new Error(`Build accumulator not found for ${featureCode}`);
  }
  const next = typeof mutate === 'function' ? mutate({ ...current }) : { ...current, ...mutate };
  validateBuildAccumulator(next, featureCode);
  return writeBuildAccumulator(projectCwd, next);
}

export function selectBuildAccumulator(projectCwd, featureCode, { fresh = false } = {}) {
  const existing = readBuildAccumulator(projectCwd, featureCode);
  if (fresh || !existing || ['complete', 'aborted'].includes(existing.last_terminal)) {
    // Candidate only — NOTHING persists until the caller owns the attempt. A
    // concurrent live build may refuse this invocation, and persisting here
    // (e.g. on --fresh) would clobber the live build's sidecar mid-run.
    return { accumulator: newBuildAccumulatorRecord(featureCode), isNew: true };
  }
  return { accumulator: existing, isNew: false };
}

function ledgerEstimateSource(source) {
  if (source === 'escalated') return 'escalated';
  if (source === 'cached') return 'cached';
  if (source === 'front' || source === 'refined' || source === 'fresh') return 'fresh';
  throw new Error(`Unsupported triage estimate source "${source}"`);
}

export function emitTriageEstimate(projectCwd, estimate) {
  return appendDispatchEvent(projectCwd, {
    kind: 'triage-estimate',
    build_id: estimate.build_id,
    feature_code: estimate.feature_code,
    tier: estimate.triageTier ?? estimate.tier,
    lane: estimate.lane,
    profile: estimate.profile,
    estimate_source: ledgerEstimateSource(estimate.estimateSource ?? estimate.estimate_source),
    confidence: estimate.triageConfidence ?? estimate.confidence ?? null,
  });
}

export function emitBuildActuals(projectCwd, accumulator, terminalStatus) {
  validateBuildAccumulator(accumulator, accumulator?.feature_code ?? null);
  const persisted = readBuildAccumulator(projectCwd, accumulator.feature_code);
  if (!persisted || persisted.build_id !== accumulator.build_id) {
    throw new Error(`Build accumulator identity mismatch while finalizing ${accumulator.feature_code}`);
  }
  // COMP-TRIAGE-6-4: the ledger row is the durable, ACRR-consumed artifact —
  // append it FIRST, then do the best-effort accumulator marker/clear. The row
  // fields are all read from `persisted` (none depends on last_terminal), so
  // this is byte-identical on the happy path. Row-first makes the two writes
  // effectively atomic for every terminalization path (fresh, --fresh, resume,
  // fresh-over-failed): a crash between them can leave a stale marker/sidecar
  // (harmless — rotated away on the next build) but can NEVER lose a row or
  // strand a `last_terminal='failed'` marker with no row behind it. Since
  // emitBuildActuals is the ONLY writer of `last_terminal='failed'`, no other
  // path can produce that orphan either.
  const authoritativeShip = Array.isArray(persisted.ship_files_changed);
  const files = authoritativeShip
    ? persisted.ship_files_changed
    : persisted.files_changed;
  const row = appendDispatchEvent(projectCwd, {
    kind: 'build-actuals',
    build_id: persisted.build_id,
    feature_code: persisted.feature_code,
    terminal_status: terminalStatus,
    files_changed_count: new Set(files).size,
    files_source: authoritativeShip ? 'ship' : 'accumulated',
    review_iterations: persisted.review_iterations,
    escalations: persisted.escalations,
    tokens_total: persisted.tokens_total,
    usd: persisted.usd,
    test_count: persisted.test_count,
    pass_rate: persisted.pass_rate,
  });
  if (terminalStatus === 'failed') {
    updateBuildAccumulator(projectCwd, persisted.feature_code, (current) => ({
      ...current,
      last_terminal: 'failed',
    }));
  } else if (terminalStatus === 'complete' || terminalStatus === 'aborted') {
    clearBuildAccumulator(projectCwd, persisted.feature_code);
  }
  return row;
}

export function settleDispatches(projectCwd, buildId, stepId, {
  dispatchIds,
  accepted,
  failureClass = null,
  isEnsureRetry = false,
  gsd = false,
} = {}) {
  if (gsd) return [];
  const primary = dispatchIds?.primary;
  const repair = dispatchIds?.repair;
  // COMP-POLICY-CHECK-4: a policy revision is a second dispatch whose output
  // replaced the primary's. It settles on the same verdict as the run it
  // replaced — same path, one more id, no parallel settlement loop.
  const revision = dispatchIds?.revision;
  if (!primary && !repair && !revision) return [];
  const rows = [];
  const appendSettlement = (dispatchId, isAccepted, rejectedClass) => {
    if (typeof dispatchId !== 'string' || dispatchId.length === 0) return;
    rows.push(appendDispatchEvent(projectCwd, {
      kind: 'settlement',
      dispatch_id: dispatchId,
      accepted: isAccepted,
      ...(typeof buildId === 'string' && buildId.length > 0 ? { build_id: buildId } : {}),
      ...(typeof stepId === 'string' && stepId.length > 0 ? { step_id: stepId } : {}),
      ...(!isAccepted ? { failure_class: rejectedClass ?? 'agent' } : {}),
    }));
  };

  if (repair) {
    appendSettlement(primary, false, 'normalization');
    appendSettlement(
      repair,
      isEnsureRetry ? false : accepted === true,
      isEnsureRetry ? 'ensure-retry' : failureClass,
    );
  } else {
    appendSettlement(
      primary,
      isEnsureRetry ? false : accepted === true,
      isEnsureRetry ? 'ensure-retry' : failureClass,
    );
  }

  if (revision) {
    appendSettlement(
      revision,
      isEnsureRetry ? false : accepted === true,
      isEnsureRetry ? 'ensure-retry' : failureClass,
    );
  }
  return rows;
}

/**
 * Decide how a compose build invocation should start.
 *
 * Pure decision table for COMP-BUILD-RESUME. The caller is responsible for all
 * I/O inputs: active-build state, pid liveness, flow terminality, and mode match.
 *
 * @param {object} params
 * @param {object|null} params.active
 * @param {object} params.opts
 * @param {boolean} params.pidAlive
 * @param {boolean} params.flowTerminal
 * @param {boolean} params.sameMode
 * @returns {{ action: 'resume'|'fresh'|'refuse'|'error', flowId?: string, reason: string }}
 */
export function decideBuildStart({ active, opts = {}, pidAlive = false, flowTerminal = false, sameMode = true } = {}) {
  const wantsResume = Boolean(opts.resume || opts.resumeFlowId);
  const wantsFresh = Boolean(opts.fresh);
  const flowId = opts.resumeFlowId ?? active?.flowId;

  if (wantsResume && wantsFresh) {
    return { action: 'error', reason: '--resume and --fresh are mutually exclusive' };
  }

  // COMP-BUILD-RESUME: a BARE programmatic flow id (resumeFlowId without the
  // `--resume` flag) is a self-sufficient resume target — the fix pipeline and
  // crash recovery pass it directly. It does NOT depend on active-build.json:
  // the caller resumes that exact flow and handles a terminal flow post-resume.
  // The `--resume` *flag* (opts.resume) is the guard-subject path below: it
  // discovers the flow from active-build state and errors if nothing is
  // resumable. When BOTH are set (flag + explicit id) the flag wins and the
  // guards apply, with resumeFlowId only supplying the id. So short-circuit
  // here (after the mutual-exclusion guard) ONLY for the bare-id case.
  if (opts.resumeFlowId && !opts.resume) {
    return { action: 'resume', flowId: opts.resumeFlowId, reason: 'Resuming specified flow' };
  }

  if (!active || !flowId || flowTerminal) {
    if (wantsResume) {
      return { action: 'error', reason: 'Nothing to resume (no in-progress or failed build found)' };
    }
    return { action: 'fresh', reason: 'No resumable build found' };
  }

  if (!sameMode) {
    if (wantsResume) {
      return { action: 'error', reason: 'Nothing to resume for this mode (active build mode differs)' };
    }
    return { action: 'fresh', reason: 'Previous build mode differs' };
  }

  if (active.status === 'running' && pidAlive) {
    return {
      action: 'refuse',
      reason: `Build already running${active.pid ? ` (pid ${active.pid})` : ''}. Use 'compose build --abort' to cancel it.`,
    };
  }

  if (wantsFresh) {
    return { action: 'fresh', reason: 'Fresh build requested' };
  }

  return { action: 'resume', flowId, reason: 'Resuming previous build' };
}

/**
 * COMP-MOBILE-1-1: persist a COMP-HEALTH gate downgrade back to
 * active-build.json. The terminal write happens BEFORE the health gate runs,
 * so when the gate downgrades the result the broadcast `buildState` (sourced
 * from this file by the server's watcher) would otherwise keep saying
 * 'complete' forever. Re-writing here triggers a fresh buildState broadcast
 * with the real outcome.
 *
 * No-ops (returns null) when there is no active-build file, it is already
 * 'failed', or it no longer belongs to this build — active-build.json is
 * last-writer-wins across concurrent builds, so without the flowId/featureCode
 * identity guard a downgrade could mark an unrelated live build as failed.
 * Returns the written state otherwise.
 */
export function persistHealthGateDowngrade(dataDir, { score, threshold, flowId, featureCode } = {}) {
  const state = readActiveBuild(dataDir);
  if (!state || state.status === 'failed') return null;
  // Identity guard: every provided key that exists on the on-disk state must
  // match. Checking both (not flowId-first) covers legacy state files that
  // lack flowId but carry a different featureCode.
  if (flowId && state.flowId && state.flowId !== flowId) return null;
  if (featureCode && state.featureCode && state.featureCode !== featureCode) return null;
  const next = {
    ...state,
    status: 'failed',
    failureReason: `Health score ${score} below threshold ${threshold}`,
    healthDowngrade: { score, threshold },
    completedAt: state.completedAt ?? new Date().toISOString(),
  };
  writeActiveBuild(dataDir, next);
  return next;
}

// COMP-TEST-BOOTSTRAP-4-1: repo-relative test files touched since HEAD
// (changed-vs-HEAD + untracked), filtered to test paths. Used to scope the
// post-coverage test-review pass to the tests this build produced.
function listChangedTestFiles(cwd) {
  try {
    const out = execSync('git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null', {
      cwd, encoding: 'utf-8', timeout: 5000,
    }).trim();
    if (!out) return [];
    return [...new Set(out.split('\n').map(s => s.trim()).filter(Boolean))].filter(isTestFile);
  } catch {
    return [];
  }
}

// COMP-TEST-BOOTSTRAP-4-1: the pre-coverage test-file snapshot is persisted to a
// sidecar (not just in-memory context) so a build that RESUMES after coverage and
// lands on test_review still has the correct baseline — otherwise scope would widen
// to every changed test file.
function preCoverageTestsPath(composeDir) {
  return join(composeDir, 'pre_coverage_tests.json');
}

function persistPreCoverageTests(composeDir, files) {
  mkdirSync(composeDir, { recursive: true });
  writeFileSync(preCoverageTestsPath(composeDir), JSON.stringify(files ?? [], null, 2));
}

function loadPreCoverageTests(composeDir) {
  try {
    return new Set(JSON.parse(readFileSync(preCoverageTestsPath(composeDir), 'utf-8')));
  } catch {
    return new Set();
  }
}

function clearPreCoverageTests(composeDir) {
  const p = preCoverageTestsPath(composeDir);
  if (existsSync(p)) unlinkSync(p);
}

/**
 * Check whether a process with the given PID is still alive.
 */
function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal
    return true;
  } catch (err) {
    // EPERM => the process exists but belongs to a different uid (e.g. a prior
    // run under sudo) — it is alive. Returning false here let the concurrent-
    // build guard treat a live process as dead and stomp active-build.json.
    // Matches the authoritative pidAlive() in gsd-state.js.
    return err.code === 'EPERM';
  }
}

/**
 * Build an askAgent helper that answers a single question using the claude connector.
 * Build an askAgent helper that answers gate questions with full workflow context.
 *
 * @param {object} stratum      - StratumMcpClient (provides runAgentText)
 * @param {object} context      - Execution context (cwd, featureCode, featureDir, stepHistory, filesChanged)
 * @param {object} gateDispatch - Stratum gate dispatch (step_id, on_approve, on_revise, on_kill)
 * @param {object} [gateExtras] - Optional enrichment (fromPhase, toPhase, summary)
 */
export function makeAskAgent(stratum, context, gateDispatch, gateExtras) {
  const preamble = buildGateContext(gateDispatch, context, gateExtras);
  let budgetExhausted = false;

  return async function askAgent(question, artifactPath) {
    if (budgetExhausted) return '(budget exhausted)';
    const fileRef = artifactPath && !artifactPath.endsWith('/')
      ? `Read the file "${artifactPath}" and answer`
      : `Look at the project files in the working directory and answer`;
    const qaPrompt =
      `${preamble}\n\n---\n\n` +
      `${fileRef} this question concisely:\n\n` +
      `${question}\n\n` +
      `Keep your answer brief — 2-3 sentences max.`;
    if (context.buildCancel?.cancelled) throw context.buildCancel.signal.reason;
    const taggedFlow = flowTag(context.flowId, gateDispatch.step_id ?? gateDispatch.id);
    const text = await stratum.runAgentText('claude', qaPrompt, routingCallOptions({
      ...(routingArtifactsFor(context) ? { routingCalls: callsForRouting(context, null, 'gate-qa', { id: gateDispatch.step_id ?? gateDispatch.id }) } : {}),
      cwd: context.cwd,
      // S03-4 (R1): a gate pause leaves the run `running`, so a gate-time agent IS
      // admitted and tags successfully (C1). Conditional on `context.flowId` because
      // `makeAskAgent` is exported and called with a bare, flow-less context in tests.
      ...(taggedFlow ? { flow: taggedFlow } : {}),
      signal: context.buildCancel?.signal,
      telemetry: {
        site: 'gate-qa',
        project_cwd: context.projectCwd ?? context.cwd,
        build_id: context.build_id,
        feature_code: context.featureCode,
        step_id: gateDispatch.step_id ?? gateDispatch.id,
        ...(typeof gateDispatch.attempt === 'number' ? { attempt: gateDispatch.attempt } : {}),
      },
      onUsage: async (usages) => {
        const results = await context.recordBuildUsage?.(usages, {
          stepId: gateDispatch.step_id ?? gateDispatch.id,
          source: 'gate_qa',
        });
        if (results?.some((result) => ['flow_exhausted', 'flow_exhausted_after_terminal'].includes(result?.budget))) {
          budgetExhausted = true;
        }
      },
    })).catch(async error => {
      await confirmCancellation(error, { stratum, flowId: context.flowId, buildCancel: context.buildCancel, tagged: Boolean(taggedFlow) });
      throw error;
    });
    return text || '(no answer)';
  };
}

export function deleteActiveBuild(dataDir) {
  const p = activeBuildPath(dataDir);
  if (existsSync(p)) unlinkSync(p);
}

// ---------------------------------------------------------------------------
// Flow-status helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when a Stratum flow has reached a terminal state and will
 * never produce more steps.  Used to detect stale lock files and decide
 * whether a resumed flow needs a fresh start.
 */
export function isTerminalFlow(status) {
  return ['completed', 'failed', 'budget_exhausted', 'cancelled'].includes(status);
}

function isRecoverableFlowProbeError(err) {
  return err?.code === -32603
    && /ENOENT: no such file or directory.*\.json/.test(err?.message ?? '');
}

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a template name to a file path. Checks two locations:
 * 1. Project-local: <cwd>/pipelines/<name>.stratum.yaml
 * 2. Bundled presets: <compose-package>/presets/<name>.stratum.yaml
 *
 * @param {string} [name='build'] - Template name
 * @param {string} cwd - Project root directory
 * @returns {string} Resolved file path
 */
export function resolveTemplatePath(name, cwd) {
  const templateName = name ?? 'build';
  const projectPath = join(cwd, 'pipelines', `${templateName}.stratum.yaml`);
  if (existsSync(projectPath)) return projectPath;

  const packageDir = dirname(fileURLToPath(import.meta.url));
  const presetsPath = join(packageDir, '..', 'presets', `${templateName}.stratum.yaml`);
  if (existsSync(presetsPath)) return presetsPath;

  // COMP-PIPELINE-QUARANTINE follow-up: fall back to the BUNDLED pipelines too,
  // not just presets. `compose init` seeds a curated few specs, so every other
  // shipped pipeline (content, coverage-sweep, refactor, research, review-fix)
  // was unreachable from a workspace no matter how it was invoked — the resolver
  // simply had no path to them. Project-local still wins, so a workspace that
  // customizes a spec keeps its own copy.
  //
  // NOT for the init-provisioned specs: if `build` is missing, the workspace was
  // never initialized, and answering with our bundled copy would silently run
  // Compose's own pipeline against an uninitialized project instead of raising
  // "Lifecycle spec not found".
  if (!INIT_PROVISIONED_SPECS.includes(templateName)) {
    const bundledPath = join(packageDir, '..', 'pipelines', `${templateName}.stratum.yaml`);
    if (existsSync(bundledPath)) return bundledPath;
  }

  return projectPath;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function buildFailureReason({ buildStatus = 'failed', stepHistory = [], healthDowngradeReason = null, fallback = null } = {}) {
  if (fallback) return fallback;
  if (buildStatus === 'complete') return null;
  const lastFailedStep = [...stepHistory].reverse().find(s => s.outcome === 'failed');
  return lastFailedStep?.summary ?? healthDowngradeReason ?? `Build ${buildStatus}`;
}

async function writeFailedBuildTerminalState({
  cwd,
  dataDir,
  cfg,
  visionWriter,
  itemId,
  featureCode,
  flowId = null,
  failureReason,
}) {
  const termState = readActiveBuild(dataDir);
  if (termState) {
    const sameFlow = !flowId || !termState.flowId || termState.flowId === flowId;
    const sameFeature = !termState.featureCode || termState.featureCode === featureCode;
    if (sameFlow && sameFeature) {
      writeActiveBuild(dataDir, {
        ...termState,
        status: 'failed',
        failureReason: termState.failureReason ?? failureReason,
        completedAt: termState.completedAt ?? new Date().toISOString(),
      });
    }
  }
  if (cfg.tracksFeatureJson) {
    const _bp = await getBuildProvider(cwd);
    const _feat = await _bp.getFeature(featureCode);
    if (_feat) {
      // Raw write back to PLANNED — no transition policy, no events, no renderRoadmap.
      // Matches original updateFeature semantics; keeps teardown side-effect-free.
      await _bp.persistFeatureRaw(featureCode, { ..._feat, status: 'PLANNED' });
    }
  }
  try {
    await visionWriter.updateItemStatus(itemId, 'blocked');
  } catch {
    // Best-effort UI projection only; durable build/feature state is already written.
  }
}

// COMP-FIX-HARD T2: the three bug-mode steps whose exhaustion is worth a
// resumable checkpoint. A feature-mode build never checkpoints (no docs/bugs dir).
export const BUG_CHECKPOINT_STEPS = new Set(['test', 'fix', 'diagnose']);

/**
 * Decide whether a terminally-failed build should emit a bug checkpoint, given the
 * EXHAUSTED step id — the step the engine ran out of attempts on, known directly at
 * the terminal-failure path. I4: history is NOT scanned for an outcome:'failed'
 * entry, because a test/diagnose step's contract carries no `outcome` field, so its
 * stepHistory entry defaults to outcome:'complete' even when its ensure exhausted.
 * Returns the (scoped-id-normalized) step id when the build is in bug mode AND the
 * exhausted step is one of {test,fix,diagnose}; otherwise null.
 */
export function bugCheckpointStepId(context, exhaustedStepId) {
  if (context?.mode !== 'bug' || !context?.bug_code) return null;
  const id = typeof exhaustedStepId === 'string'
    ? (exhaustedStepId.includes('/') ? exhaustedStepId.split('/').pop() : exhaustedStepId)
    : null;
  return id && BUG_CHECKPOINT_STEPS.has(id) ? id : null;
}

/**
 * On a terminal build FAILURE, emit docs/bugs/<code>/checkpoint.md (and regenerate
 * the bug index) when the EXHAUSTED step is a bug-mode {test,fix,diagnose} step.
 * The exhausted step id is passed in directly from the terminal-failure path (the
 * last step the engine issued as ready before it terminalized). Best-effort: a
 * checkpoint-write failure never masks the underlying build failure.
 */
export async function emitBugCheckpointOnTerminalFailure(context, exhaustedStepId, stepHistory) {
  const stepId = bugCheckpointStepId(context, exhaustedStepId);
  if (!stepId) return null;
  // Violations context is best-effort from history (may be absent for a
  // no-outcome-contract step); the checkpoint records the exhausted step regardless.
  const hist = [...(stepHistory ?? [])].reverse().find(s => s?.stepId === stepId || s?.outcome === 'failed');
  const violations = Array.isArray(hist?.violations) && hist.violations.length > 0
    ? hist.violations
    : (hist?.summary ? [hist.summary] : []);
  try {
    return await emitCheckpoint(
      { cwd: context.cwd, bug_code: context.bug_code },
      stepId,
      { violations },
    );
  } catch (err) {
    process.stderr.write(`[build] bug checkpoint emit failed: ${err?.message || err}\n`);
    return null;
  }
}

/** Guard the actual vision mutation, after updateItemStatus's async server probe.
 * Use a per-call receiver so a late best-effort update cannot outlive its claim. */
async function killOwnedBuildVision(visionWriter, itemId, claimOwnership) {
  const ownedWriter = Object.create(visionWriter);
  for (const method of ['_directUpdateItemStatus', '_restUpdateItemStatus']) {
    ownedWriter[method] = (...args) => {
      const claim = claimOwnership();
      if (!claim.ok) throw Object.assign(new Error(claim.reason), { reason: claim.reason });
      return visionWriter[method](...args);
    };
  }
  return ownedWriter.updateItemStatus(itemId, 'killed');
}

/** Claims protect the cancelled driver's record AND its vision projection. */
async function terminalizeCancelledBuild({ dataDir, buildIdentity, visionWriter, itemId, failureReason }) {
  if (!buildIdentity) return;
  const claim = claimActiveBuild(dataDir, buildIdentity);
  if (!claim.ok) return;
  writeActiveBuild(dataDir, {
    ...claim.record, status: 'aborted', failureReason,
    completedAt: claim.record.completedAt ?? new Date().toISOString(),
  });
  try { await killOwnedBuildVision(visionWriter, itemId, () => claimActiveBuild(dataDir, buildIdentity)); } catch { /* best-effort projection */ }
}

async function terminalizeThrownBuild({
  buildCancel, buildIdentity,
  cwd,
  dataDir,
  cfg,
  visionWriter,
  itemId,
  featureCode,
  mode,
  response,
  buildStartedAt,
  // COMP-COST-OWNER S1: a reader of the sole owner, not a second tally. This runs on
  // the crash path, where the owner on disk is the only cost record that survived.
  buildCostSnapshot,
  stepHistory,
  failureReason,
  historyWritten,
}) {
  const flowId = response?.runId ?? null;
  if (!flowId) return false;
  if (buildCancel?.cancelled) {
    await terminalizeCancelledBuild({ dataDir, buildIdentity, visionWriter, itemId, failureReason });
  } else await writeFailedBuildTerminalState({
    cwd,
    dataDir,
    cfg,
    visionWriter,
    itemId,
    featureCode,
    flowId,
    failureReason,
  });
  if (!historyWritten.value) {
    appendBuildHistory(dataDir, {
      featureCode,
      flowId,
      mode,
      status: buildCancel?.cancelled ? 'aborted' : 'failed',
      startedAt: buildStartedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(buildStartedAt).getTime(),
      ...buildCostSnapshot(),
      stepCount: stepHistory.length,
      failureReason,
      itemId,
      steps: projectHistorySteps(stepHistory),
    });
    historyWritten.value = true;
  }
  return true;
}

/**
 * Run a feature through the Stratum lifecycle.
 *
 * @param {string} featureCode - Feature code (e.g. 'FEAT-1')
 * @param {object} opts
 * @param {string}   [opts.cwd]              - Project root with .compose/ (default: process.cwd())
 * @param {string}   [opts.workingDirectory] - Agent working directory (default: opts.cwd). Use when
 *                                             agents need to operate in a different directory than
 *                                             the project root (e.g. parent dir for cross-repo features).
 * @param {boolean}  [opts.abort]            - Abort active build instead of running
 * @param {string}   [opts.description]      - Feature description override
 * @param {object}   [opts.gateOpts]         - Options for gate prompt (input/output streams)
 * @param {string}   [opts.template]         - Pipeline template name (default: 'build').
 *                                             Resolves to pipelines/${template}.stratum.yaml.
 *                                             When provided, skips triage entirely.
 * @param {boolean}  [opts.skipTriage]       - Skip pre-build triage (use spec as-is).
 */
export async function runBuild(featureCode, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const agentCwd = opts.workingDirectory ?? cwd;

  // COMP-FIX-HARD T4: bug-mode branch.
  //   mode === 'feature' (default): legacy behavior — docs/features/<code>/,
  //                                  feature-json updates, plan with {featureCode, description}.
  //   mode === 'bug':                docs/bugs/<code>/, no feature-json updates,
  //                                  plan with {task: description}.
  // COMP-ROADMAP-MODES: 3-valued runner mode. The runtime token stays
  // feature|bug|plan (byte-identical persistence in active-build.json and the
  // resume guard); `cfg` is the registry's per-mode behavioral switches
  // (getMode normalizes feature→build, bug→fix, plan→plan). isBugMode is kept as
  // a derived flag so the bug-SPECIFIC positive checks downstream are untouched.
  const mode = opts.mode === 'bug' ? 'bug' : (opts.mode === 'plan' ? 'plan' : 'feature');
  const isBugMode = mode === 'bug';
  const cfg = getMode(mode).runner;

  // Resolve project paths
  const composeDir = join(cwd, '.compose');
  const dataDir = join(composeDir, 'data');

  // Handle --abort early (featureCode may be null). C2: pass the project root so
  // the engine is resolved from this project's capabilities, not process.cwd().
  if (opts.abort) {
    return await abortBuild(dataDir, featureCode, cwd);
  }

  const {
    accumulator: selectedAccumulator,
    isNew: isNewAccumulator,
  } = selectBuildAccumulator(cwd, featureCode, { fresh: opts.fresh === true });
  let build_id = selectedAccumulator.build_id;
  // Tracks the record this attempt actually owns: the reused sidecar, the
  // in-memory candidate (persisted at the ownership point after the start
  // verdict), or the rotated record on a fresh-over-failed start.
  let activeAccumulator = selectedAccumulator;
  let accumulatorPersisted = !isNewAccumulator;
  const buildStartedAt = new Date().toISOString();
  let buildStatus = 'failed';
  // COMP-BUILD-CANCEL §3.4: one handle per runBuild. `signal` is the D-F chain into every
  // dispatch; `cancelled` is the merge guard's flag; `teardownStarted` is what a second
  // Ctrl-C keys on. Registered by flow id once the runId exists (S03-5b).
  const buildCancel = createBuildCancel();
  let buildIdentity = null;
  // The flow id this build registered its handle under, so the outermost finally can
  // unregister without reaching into the inner try's `response`.
  let registeredFlowId = null;
  const { cancelMs: cancelTimeoutMs, drainMs: drainTimeoutMs, joinMs: teardownJoinMs } = cancelBudgets();
  let attemptStarted = true;
  let attemptFinalized = false;
  // COMP-TRIAGE-6-4: function-scoped so finalizeBuildAttempt's ownership guard
  // can read them (they are assigned/read from inside the main try below).
  // accumulatorRotated flips true once a fresh-over-failed retry rotates to a
  // new identity; isFreshStart defaults true until a resume verdict flips it.
  let accumulatorRotated = false;
  let isFreshStart = true;
  let progress = null;
  let stratum = null;
  let streamWriter = null;
  let signalHandler = null;
  let runtimeResourcesFinalized = false;
  let suspended = false;
  let routingRuntimeContext = null;
  let routingFinalizationError = null;
  let routingPrimaryError = null;

  const _priorBuildIdEnv = process.env.COMPOSE_BUILD_ID;
  if (_priorBuildIdEnv !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(
      `[build] COMPOSE_BUILD_ID was already set ("${_priorBuildIdEnv}") when runBuild started. ` +
      `Overriding for this build; concurrent in-process builds will mis-stamp events.`
    );
  }
  process.env.COMPOSE_BUILD_ID = build_id;
  const _restoreBuildIdEnv = () => {
    if (_priorBuildIdEnv === undefined) delete process.env.COMPOSE_BUILD_ID;
    else process.env.COMPOSE_BUILD_ID = _priorBuildIdEnv;
  };
  const finalizeBuildAttempt = () => {
    if (!attemptStarted || attemptFinalized || (suspended && !buildCancel.cancelled)) return;
    if (buildCancel.teardown || buildCancel.cancelled) buildStatus = 'aborted';
    const terminalStatus = buildStatus === 'complete'
      ? 'complete'
      : (buildStatus === 'killed' || buildStatus === 'aborted')
        ? 'aborted'
        : 'failed';
    let accumulator = readBuildAccumulator(cwd, featureCode);
    // A pre-ownership failure (e.g. missing lifecycle spec) dies before the
    // candidate persists — write it now so the attempt still leaves a terminal
    // actuals row. The build_id guard keeps a stale on-disk record from another
    // identity from being finalized under this attempt's name.
    if ((!accumulator || accumulator.build_id !== build_id) && !accumulatorPersisted) {
      accumulator = writeBuildAccumulator(cwd, activeAccumulator);
      accumulatorPersisted = true;
    }
    // A terminal complete/abort may already have cleared the sidecar if a nested
    // terminalization path finalized first. The finalized flag is the primary
    // guard; the missing-file/identity guard keeps cleanup idempotent.
    //
    // COMP-TRIAGE-6-4 ownership guard: a fresh (non-resume), not-yet-rotated
    // attempt that reuses a prior record must not re-emit a terminal row that
    // ALREADY EXISTS for this build_id. Without it, an attempt that dies before
    // rotating to a fresh identity (rotateStaleAccumulatorForFreshStart) — e.g.
    // the flow-audit probe throws while resolving the fresh/resume verdict —
    // re-finalizes the reused failed record, double-counting in ACRR. The signal
    // is the LEDGER itself, not the reused record's last_terminal: emitBuildActuals
    // writes last_terminal and the row non-atomically, so a crash between them
    // must cause neither a wrongful suppression (marker set, no row) nor a
    // wrongful double-emit (row written, marker cleared). A genuine resume
    // (isFreshStart=false) owns and continues the build (its second row under the
    // same id is intended); a rotated/new identity owns a fresh, unemitted id.
    const mayReemitReused = !isNewAccumulator && !accumulatorRotated && isFreshStart;
    const alreadyEmitted = mayReemitReused
      && readDispatchEvents(cwd, { kind: 'build-actuals' }).some((r) => r.build_id === build_id);
    if (accumulator && accumulator.build_id === build_id && !alreadyEmitted) {
      emitBuildActuals(cwd, accumulator, terminalStatus);
    }
    attemptFinalized = true;
  };

  try {
  // Single resolver — used at every site that previously hardcoded
  // `docs/features/<featureCode>/`. Callers must use this (not inline
  // string concatenation) so the bug-mode path stays in sync.
  // COMP-MCP-MIGRATION-2: feature-mode honors paths.features override.
  // COMP-PATHS-EXTERNAL D7: two representations on purpose.
  //  - `featuresDir` stays RELATIVE (loadFeaturesDir): it flows into
  //    context.featuresDir → the MCP-enforcement guard, which matches against
  //    repo-relative `git status` output. External artifacts live in another
  //    repo and are out of that guard's scope by construction; making this
  //    absolute would break the relative match. triage consumers are
  //    absolute-safe (resolvePathValue) so the relative value is fine there too.
  //  - `resolveItemDir` resolves the actual FILESYSTEM dir via
  //    resolveFeaturesPath (absolute — handles absolute/../-escaping config).
  const featuresDir = loadFeaturesDir(cwd);
  // The artifact dir is driven by the mode's `artifactRoot` token: 'features'
  // resolves the (absolute, override-aware) features path; any other token is a
  // literal repo-relative dir (bug → docs/bugs, plan → docs/plans). Byte-identical
  // to the prior feature/bug ternary for those two modes.
  const resolveItemDir = (code) => cfg.artifactRoot === 'features'
    ? join(resolveFeaturesPath(cwd), code)
    : join(cwd, ...cfg.artifactRoot.split('/'), code);

  const featureDir = resolveItemDir(featureCode);

  // Debug discipline (COMP-DEBUG-1)
  const debugStatePath = join(composeDir, 'debug-state.json');
  let fixChainDetector, attemptCounter, debugLedger, crossLayerAudit;
  try {
    if (existsSync(debugStatePath)) {
      const saved = JSON.parse(readFileSync(debugStatePath, 'utf-8'));
      fixChainDetector = FixChainDetector.fromJSON(saved.fixChain ?? {});
      attemptCounter = AttemptCounter.fromJSON(saved.attempt ?? {});
    } else {
      fixChainDetector = new FixChainDetector();
      attemptCounter = new AttemptCounter();
    }
    debugLedger = new DebugLedger(composeDir);
    crossLayerAudit = new CrossLayerAudit(loadDebugConfig(cwd));
  } catch {
    fixChainDetector = new FixChainDetector();
    attemptCounter = new AttemptCounter();
    debugLedger = new DebugLedger(composeDir);
    crossLayerAudit = new CrossLayerAudit({ cross_layer_repos: [], cross_layer_extensions: [] });
  }

  // Read compose.json
  const configPath = join(composeDir, 'compose.json');
  if (!existsSync(configPath)) {
    throw new Error(`No .compose/compose.json found at ${cwd}. Run 'compose init' first.`);
  }
  let composeConfig = {};
  try { composeConfig = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* use defaults */ }
  const contextDirPath = resolveContextPath(cwd);

  // COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY (D5): per-task pre-merge gate is opt-in.
  // Resolve ONCE and thread into startFresh's planInputs only when the capability
  // is on. Left `undefined` ⇒ the `pre_merge_gate` key is omitted from the plan
  // envelope (not `[]`), so the default-OFF path is byte-identical to before.
  let preMergeGate;
  if (composeConfig?.capabilities?.preMergeGate) {
    preMergeGate = resolvePreMergeGate(agentCwd, opts.preMergeGate);
  }

  // ---------------------------------------------------------------------------
  // Pre-build triage — runs before spec loading so profile can toggle skip_if.
  // Skipped when:
  //   - opts.skipTriage is true (user flag --skip-triage)
  //   - opts.template is explicitly set (user chose a specific template)
  // ---------------------------------------------------------------------------
  let buildProfile = null;
  let _buildTierLabel = '?'; // for skip_reason label in spec YAML mutation below
  let triageEstimate = null;
  // Only modes that run feature triage do so — triage is feature-shaped (writes
  // feature.json, profile selection per complexity tiers). bug AND plan skip it.
  if (cfg.runsTriage && !opts.skipTriage && !opts.template) {
    const _buildProvider = await getBuildProvider(cwd);
    let cachedFeature = await _buildProvider.getFeature(featureCode);
    // COMP-TRIAGE-5: an escalated lane is a deliberate override, not a stale cache —
    // honor it regardless of feature-dir mtimes (a completed build writes audit.json
    // and other artifacts after the escalation stamp, which would otherwise make the
    // escalation look stale and get recomputed away on the next run).
    const _escalated = cachedFeature?.estimateSource === 'escalated';
    if (cachedFeature?.profile && (_escalated || !isTriageStale(cwd, featureCode, featuresDir))) {
      // Reuse cached profile
      buildProfile = cachedFeature.profile;
      _buildTierLabel = cachedFeature.complexity ?? '?';
      triageEstimate = {
        build_id,
        feature_code: featureCode,
        triageTier: cachedFeature.triageTier,
        lane: cachedFeature.lane,
        profile: cachedFeature.profile,
        estimateSource: _escalated ? 'escalated' : 'cached',
        triageConfidence: cachedFeature.triageConfidence ?? null,
      };
      console.log(`[triage] Using ${_escalated ? 'escalated' : 'cached'} profile (tier ${_buildTierLabel}, lane ${cachedFeature.lane ?? '?'}): ${JSON.stringify(buildProfile)}`);
    } else {
      // COMP-TRIAGE-5 (E3 Estimate): derive the lane from the RAW REQUEST before
      // any design/plan/blueprint doc is read, and persist validated fields
      // through the shared validator (closes the complexity: String(tier) bypass
      // that previously wrote "0".."4" straight past the {S,M,L,XL} guard).
      const front = await applyFrontTriage({
        featureCode,
        request: opts.description,
        provider: _buildProvider,
        cachedFeature,
        cwd,
        featuresDir,
      });
      buildProfile = front.buildProfile;
      _buildTierLabel = front.tierLabel;
      cachedFeature = front.cachedFeature;
      triageEstimate = {
        build_id,
        feature_code: featureCode,
        triageTier: front.tier,
        lane: front.lane,
        profile: front.buildProfile,
        estimateSource: 'fresh',
        triageConfidence: front.confidence ?? null,
      };
      console.log(`[triage] Front estimate lane=${front.lane} (tier ${front.tier}): ${front.rationale}`);
      console.log(`[triage] Profile: ${JSON.stringify(buildProfile)}`);
    }
  }
  // Estimate emission is DEFERRED to the post-verdict ownership point: a
  // refused/errored invocation must leave no orphan estimate (review r2).

  // Load lifecycle spec (template selection). The mode's defaultTemplate is the
  // fallback when no explicit --template is given (build → 'build', byte-identical
  // since resolveTemplatePath also defaults undefined→'build'; plan → 'new').
  const templateName = opts.template ?? cfg.defaultTemplate;
  const specPath = resolveTemplatePath(templateName, cwd);
  if (!existsSync(specPath)) {
    throw new Error(`Lifecycle spec not found: ${specPath}`);
  }
  requirePipelineSidecar(specPath);
  // D6: compose-owned per-step agent profiles (tool restrictions + model tiers)
  // for this pipeline. The engine ships only bare claude|codex; these restore
  // the stripped profiles at invocation. Optional absent sidecar → {} (bare literals).
  const stepProfiles = loadPipelineProfiles(specPath);
  let specYaml = readFileSync(specPath, 'utf-8');
  // Profile preflight runs below, after recorded resume roles are restored.
  if (opts.costCeilingUsd !== undefined && (!Number.isFinite(opts.costCeilingUsd) || opts.costCeilingUsd <= 0 || !stepProfiles._costCeiling)) {
    throw new Error('costCeilingUsd requires a finite positive value and a configured _costCeiling');
  }

  // COMP-PIPELINE-QUARANTINE: refuse a retired-dialect spec HERE, at the one
  // seam every template passes through (build, fix, plan, --quick, --template,
  // bundled presets), rather than letting the engine answer with a bare
  // `-32602: spec validation failed` that names neither the file nor the cause.
  const specCompat = tsCompatibilityOf(specYaml);
  if (!specCompat.compatible) {
    throw new Error(quarantineMessage(specPath, specCompat));
  }

  // STRAT-IMMUTABLE: hash the on-disk spec BEFORE triage mutation for tamper detection.
  // verifyPipelineIntegrity() re-reads from disk, so we must compare against the original file content.
  const specFileHash = _sha256(specYaml);

  // Apply spec mutations: triage profile (skip_if toggles) + STRAT-VOCAB-3
  // vocabulary-ensure injection. Parsed once, applied conditionally, stringified
  // once. The tamper hash above is taken from the on-disk file BEFORE mutation,
  // so in-memory edits here don't trip verifyPipelineIntegrity (same pattern the
  // triage profile already relied on).
  const vocabOn = vocabularyEnabled(cwd, composeConfig);
  // COMP-ROADMAP-PLAN S5: a plan-authored feature (feature.json.plannedBy) makes
  // explore_design ratify the existing design instead of rewriting it. Read it
  // independently of the triage block (whose provider is block-scoped) so the
  // ratify fires even on --skip-triage / explicit-template builds.
  let plannedBy = null;
  if (mode === 'feature') {
    try {
      const _ratifyProvider = await getBuildProvider(cwd);
      plannedBy = (await _ratifyProvider.getFeature(featureCode))?.plannedBy ?? null;
    } catch { /* best-effort — no ratify if unreadable */ }
  }
  if (buildProfile || vocabOn || plannedBy) {
    try {
      const specObj = YAML.parse(specYaml);
      if (buildProfile) {
        const v1 = specObj?.version === 1;
        const flows = specObj?.flows ?? {};
        // Find the build flow (or first flow)
        const flowKey = Object.keys(flows).includes('build') ? 'build' : Object.keys(flows)[0];
        const steps = flows[flowKey]?.steps ?? [];
        const skippableSteps = ['prd', 'architecture', 'verification', 'report'];
        for (const step of steps) {
          if (!skippableSteps.includes(step.id)) continue;
          const needsKey = `needs_${step.id}`;
          if (buildProfile[needsKey] === true) {
            // Enable step — v1 uses `when`; v0.3 uses skip_if/skip_reason.
            if (v1) {
              if (step.when === 'false') delete step.when;
            } else {
              delete step.skip_if;
              delete step.skip_reason;
            }
          } else if (buildProfile[needsKey] === false) {
            // Disable step — mark as unconditionally skipped in the active IR.
            if (v1) step.when = 'false';
            else {
              step.skip_if = 'true';
              step.skip_reason = `Skipped by triage (tier ${_buildTierLabel})`;
            }
          }
        }
      }
      if (plannedBy) applyPlannedByRatify(specObj, extractFlowName(specYaml, templateName), plannedBy);
      specYaml = YAML.stringify(specObj);
    } catch (err) {
      // Non-fatal — fall back to unmodified spec
      console.warn(`[triage] Failed to apply profile to spec: ${err.message} — using spec as-is`);
    }
  }

  const localSpec = YAML.parse(specYaml);
  const localFlowName = extractFlowName(specYaml, templateName);
  // Fingerprint of the FINALIZED local spec (post triage/vocab mutation) that
  // Compose derives consumer final-stage and merge-gate ownership from. Pinned
  // in the consumer journal at run start and re-checked on resume so an edit to
  // the pipeline file between crash and resume fails loudly instead of stranding
  // accepted diffs or approving a merge gate that no longer follows the fanout.
  let localSpecDigest = _sha256(JSON.stringify(localSpec));

  // Build description from the mode's folder. The bug loader reads docs/bugs;
  // every other mode uses the feature loader (byte-identical for feature/bug).
  const description = opts.description ?? (cfg.descriptionLoader === 'bug'
    ? loadBugDescription(featureDir, featureCode)
    : loadFeatureDescription(featureDir, featureCode));

  // Vision writer — thread mode so a UI-created bug item binds as type:bug
  // (and a brand-new fallback item is created with the right type) (#31).
  const visionWriter = opts.visionWriter ?? new VisionWriter(dataDir);
  const itemId = await visionWriter.ensureFeatureItem(featureCode, featureCode, mode);

  // Load policy settings (lazy from disk — works for all callers)
  const settingsPath = join(dataDir, 'settings.json');
  let policySettings = { policies: {} };
  try {
    if (existsSync(settingsPath)) {
      policySettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[build] Failed to load settings: ${err.message} — defaulting all gates to 'gate' mode`);
    }
  }

  // STRAT-IMMUTABLE: hash policy fields for tamper detection.
  const policyHash = _sha256(JSON.stringify(policySettings.policies ?? {}));

  if (agentCwd !== cwd) {
    console.log(`Agent working directory: ${agentCwd}`);
  }

  // CLI progress renderer
  progress = new CliProgress();

  // Stratum MCP client (test override permitted via opts.stratum)
  stratum = opts.stratum ?? new StratumMcpClient();
  if (!opts.stratum) await stratum.connect(resolveStratumMcpConnection(cwd));
  const receiptsMode = typeof stratum.hasTool === 'function'
    ? await stratum.hasTool('stratum_usage_report')
    : false;

  // Update feature.json status to IN_PROGRESS (only modes that track
  // feature.json lifecycle status; bug AND plan do not).
  if (cfg.tracksFeatureJson) {
    const _bp = await getBuildProvider(cwd);
    // Guard: feature.json may not exist if triage was skipped AND no prior
    // createFeature ran (e.g. test harnesses that only create the folder).
    // Original updateFeature silently no-oped when feature was missing.
    // Use persistFeatureRaw (not setStatus) — raw write with no transition policy,
    // no events, no renderRoadmap. Matches original updateFeature semantics exactly.
    const _feat = await _bp.getFeature(featureCode);
    if (_feat) {
      await _bp.persistFeatureRaw(featureCode, { ..._feat, status: 'IN_PROGRESS' });
    }
  }

  // Hoisted for finally-block visibility
  buildStatus = 'complete';
  let killedByGate = false;
  let terminalFailureReason = null;
  // I4: the last step the engine issued as `ready` (i.e. dispatched). When a flow
  // terminalizes as failed, this IS the step whose attempts the engine exhausted —
  // the terminal-failure path uses it directly for the bug checkpoint rather than
  // scanning stepHistory for an outcome:'failed' entry that a test/diagnose step
  // (whose contract has no `outcome` field) never produces.
  let lastReadyStepId = null;
  // I1: the review reducer's most recent normalized ReviewResult, stashed at its
  // stepDone so the following review_gate can decide clean (approve) vs dirty (run
  // the fixer, persist the dirty lens ids, revise → triage RETRY PATH).
  let lastReviewMergeResult = null;
  // J2: the dirty-lens identities captured from the reducer's RAW (pre-normalization)
  // output. ReviewResult normalization stamps a missing finding lens as 'general'
  // and resets lenses_run, so the TRUE dirty lens (e.g. security) can be erased —
  // the gate persists from this, and only falls back to post-normalization findings.
  let lastReviewMergeDirtyLenses = [];
  let response;
  let stepHistory = [];
  const terminalHistoryWritten = { value: false };
  // COMP-OBS-COST: Accumulate token/cost totals across all steps (hoisted for finally-block)
  // On resume, seed from active-build.json to preserve pre-resume cost totals
  // COMP-COST-OWNER S1. There is no second tally. The persisted accumulator is the
  // sole owner of what this build cost and every surface READS it.
  //
  // What was here before: an independent `buildCostTotals` incremented from exactly
  // ONE site (the main step, below) while `recordBuildUsage` fed the accumulator from
  // nine -- so every fix, revise, gate-fix and error-carried dispatch reached the
  // accumulator and the routing ledger but never the history record. Measured on the
  // 2026-09-12 live-fire run: ledger and accumulator agreed to the cent at $1.4257732
  // while history reported $1.38900475 (short $0.0367685) with 589,373 of 808,002
  // tokens. It also seeded `output_tokens` from `tokens_total` (input+output summed),
  // so a resumed build's split was wrong on top of the total.
  //
  // The snapshot MIRRORS the owner; it never tallies independently. That distinction
  // is the whole point: the old bug was a second tally over a DIFFERENT population,
  // whereas this only ever holds what the owner last said, so the two cannot diverge.
  // The mirror is load-bearing rather than an optimisation: finalizeBuildAttempt
  // DELETES the accumulator on a complete or aborted terminal (clearBuildAccumulator,
  // :2820), so a bare disk read here would return 0 for any write sequenced after
  // that -- silently reporting a completed build as free.
  let lastOwnerCost = {
    cost_usd: selectedAccumulator.usd,
    input_tokens: selectedAccumulator.input_tokens,
    output_tokens: selectedAccumulator.output_tokens,
    usd_unknown_count: selectedAccumulator.usd_unknown_count,
  };
  const buildCostSnapshot = () => {
    const owner = readBuildAccumulator(cwd, featureCode);
    if (owner) {
      lastOwnerCost = {
        cost_usd: owner.usd,
        // Null is the honest v2-migrated "split unknown" and is never coerced to 0,
        // because a 0 would read downstream as a measured zero.
        input_tokens: owner.input_tokens,
        output_tokens: owner.output_tokens,
        usd_unknown_count: owner.usd_unknown_count,
      };
    }
    return { ...lastOwnerCost };
  };
  // COMP-MODEL-AB: capture structured test counts from the ship step so they can
  // be persisted to build-history.jsonl for the metrics consumer (experiment-metrics.js).
  // Null when ship didn't run (failed/killed builds) or testSummary was unparsed.
  let shipStepTestData = selectedAccumulator.test_count === null
    ? null
    : {
        test_count: selectedAccumulator.test_count,
        pass_rate: selectedAccumulator.pass_rate ?? 0,
      };

  // COMP-OBS-GATES: accumulate tier pass/fail results for this build.
  // Keys are tier IDs (T0–T4), values are true (passed), false (failed), or null (not yet run).
  const tierResults = {};

  // COMP-HEALTH: accumulate build signals for composite health scoring.
  // Each key corresponds to a scoring dimension in lib/health-score.js.
  // Signals are populated as child flows and steps complete.
  const buildSignals = {};
  // Accumulate runtime violations across all steps (runtime_errors dimension)
  const allViolations = [];
  // Accumulate contract compliance signal: array of { passed: bool } per ensure check
  const contractCompliance = [];

  // COMP-TRIAGE-6-4: on a fresh-over-failed retry the reused accumulator still
  // carries the prior FAILED attempt's identity and counters. Rotate to a fresh
  // record BEFORE the fallible startFresh (its plan() call can throw): otherwise
  // a throw drops to finalizeBuildAttempt, which reads the OLD record still on
  // disk under the reused build_id and emits a DUPLICATE build-actuals failed
  // row with stale counters (double-count in ACRR). Rotating first means the
  // throw finalizes the NEW record (distinct build_id, zeroed counters) instead.
  // Idempotent: guarded so the post-startFresh ownership block cannot re-rotate.
  // accumulatorRotated / isFreshStart are declared at function scope above so
  // finalizeBuildAttempt's ownership guard can read them.
  const rotateStaleAccumulatorForFreshStart = () => {
    if (isNewAccumulator || accumulatorRotated) return;
    activeAccumulator = createBuildAccumulator(cwd, featureCode);
    accumulatorPersisted = true;
    build_id = activeAccumulator.build_id;
    process.env.COMPOSE_BUILD_ID = build_id;
    // createBuildAccumulator above replaced the owner with a fresh zeroed record, so
    // the mirror of it must be zeroed in the same breath.
    lastOwnerCost = { cost_usd: 0, input_tokens: 0, output_tokens: 0, usd_unknown_count: 0 };
    shipStepTestData = null;
    if (triageEstimate) {
      triageEstimate.build_id = build_id;
      emitTriageEstimate(cwd, triageEstimate);
    }
    accumulatorRotated = true;
  };

  try {
    // Check for active build (resume)
    const active = readActiveBuild(dataDir);
    isFreshStart = true;
    let routing = null;
    const recordedRunId = !opts.fresh && (opts.resumeFlowId ?? (active?.featureCode === featureCode && !['complete', 'aborted', 'killed'].includes(active.status) ? active.flowId : null));
    if (recordedRunId) routing = await resumeRouting({ runId: recordedRunId, cwd, targetCwd: agentCwd,
      artifactRoot: opts.consumerArtifactsRoot, localSpec, profiles: stepProfiles, stratum, featureCode });
    if (recordedRunId && !routing) localSpecDigest = legacyRoutingSpecPin({ runId: recordedRunId, cwd, targetCwd: agentCwd,
      artifactRoot: opts.consumerArtifactsRoot, localSpec, fallback: localSpecDigest });
    let routeOptions = recordedRunId ? { mode: routing ? 'shadow' : 'off' } : routingOptionsFor(stepProfiles, opts);

    // COMP-CODEX-IMPL: implementer/reviewer roles. A FRESH start derives them from
    // the flag (--codex flips Claude-implements/Codex-reviews → Codex/Claude); the
    // `roles` snapshot below carries those flag-derived values into startFresh.
    //
    // A RESUME instead restores roles from active-build state — the build context is
    // rebuilt locally each invocation, so a `--codex` build resumed WITHOUT the flag
    // must keep its Codex role (else fix-routing + cross-model suppression silently
    // revert). Restoration is gated on ACTUALLY resuming (done in the resume branches
    // below), never eagerly — otherwise a completed `--codex` build's persisted role
    // would bleed into a later plain `compose build <same-code>` that starts fresh
    // (Codex impl-review finding #1).
    let implementerAgent, reviewerAgent, roles;
    const resolveInvocationRoles = ({ fresh = false } = {}) => {
      implementerAgent = routing?.start.originalInput.implementer_agent ?? (opts.codex ? 'codex' : 'claude');
      reviewerAgent = routing?.start.originalInput.reviewer_agent ?? (opts.codex ? 'claude' : 'codex');
      // COMP-MODEL-AB: explicit --implementer/--reviewer override --codex-derived defaults.
      // Validated in bin/compose.js before reaching here; validate again for programmatic
      // callers that bypass the CLI (unknown provider = hard error).
      if (!routing && opts.implementer != null) {
        const { provider } = parseAgentString(opts.implementer);
        if (!['claude', 'codex'].includes(provider)) {
          throw new Error(`Invalid implementer agent string "${opts.implementer}": unknown provider "${provider}"`);
        }
        implementerAgent = opts.implementer;
      }
      if (!routing && opts.reviewer != null) {
        const { provider } = parseAgentString(opts.reviewer);
        if (!['claude', 'codex'].includes(provider)) {
          throw new Error(`Invalid reviewer agent string "${opts.reviewer}": unknown provider "${provider}"`);
        }
        reviewerAgent = opts.reviewer;
      }
      // COMP-PIPELINE-QUARANTINE round 3: keep the two roles on DIFFERENT providers
      // unless the caller asked for both explicitly. `--implementer codex` alone
      // leaves the reviewer at its codex default, so cross-model review silently
      // becomes Codex reviewing its own work — which is exactly the defect the
      // review-fix pipeline was corrected for, reintroduced one layer down. When
      // only one role is overridden, the other flips to the opposite provider.
      // Setting both to the same provider stays possible, but only deliberately.
      if (!routing && parseAgentString(implementerAgent).provider === parseAgentString(reviewerAgent).provider) {
        const bothExplicit = opts.implementer != null && opts.reviewer != null;
        if (!bothExplicit) {
          const flipped = parseAgentString(implementerAgent).provider === 'codex' ? 'claude' : 'codex';
          if (opts.reviewer == null) reviewerAgent = flipped;
          else implementerAgent = flipped;
        } else {
          console.warn(
            `⚠ implementer and reviewer are both ${parseAgentString(implementerAgent).provider}; ` +
            'cross-model review is disabled for this run.'
          );
        }
      }
      if (routing) {
        implementerAgent = routing.start.originalInput.implementer_agent ?? implementerAgent;
        reviewerAgent = routing.start.originalInput.reviewer_agent ?? reviewerAgent;
      }
      roles = { implementerAgent, reviewerAgent };
      if (!recordedRunId || fresh) {
        const runtimeOverrides = {}, runtimeOrigins = {};
        for (const flow of Object.values(localSpec.flows)) for (const step of flow?.steps ?? []) {
          for (const stage of step.fanout?.steps ?? [step]) {
            const role = stage.agent === '$.input.implementer_agent' ? 'implementer' : stage.agent === '$.input.reviewer_agent' ? 'reviewer' : null;
            if (!role) continue;
            const supplied = opts[role] != null || opts.codex === true;
            if (supplied) {
              const profile = role === 'implementer' ? implementerAgent : reviewerAgent;
              // Match resolvePlanSpecValues: a bare role selects the engine
              // provider but does not erase the sidecar's tier/template.
              if (profile !== parseAgentString(profile).provider) runtimeOverrides[step.id] = profile;
              runtimeOrigins[step.id] = { supplied: true, origin: 'explicit', recordedRole: profile };
            }
          }
        }
        Object.assign(routeOptions, { runtimeOverrides, runtimeOrigins });
      }
    };
    resolveInvocationRoles();
    // Resolve and validate runtime overrides BEFORE startFresh can create a flow.
    // Recompute on resume when persisted roles replace this invocation's flags.
    let pipelineProfiles;
    let effectiveProfiles;
    let profilePreflight;
    const refreshProfilePreflight = () => {
      const runtimeProfiles = {};
      const inputs = { implementer_agent: implementerAgent, reviewer_agent: reviewerAgent };
      resolvePlanSpecValues(structuredClone(localSpec), inputs, runtimeProfiles);
      Object.assign(runtimeProfiles, routeOptions.runtimeOverrides ?? {});
      pipelineProfiles = routingProfileProjection(stepProfiles, routeOptions).staticProfiles;
      for (const [id, override] of Object.entries(runtimeProfiles)) {
        try { pipelineProfiles = mergeRuntimeProfiles(pipelineProfiles, { [id]: override }); }
        catch (error) { throw new Error(`Profile preflight failed for ${specPath}: step "${id}": ${error.message}`, { cause: error }); }
      }
      // Pass the RAW local spec: the preflight resolves inputs itself and needs the
      // unresolved stage agents to detect a multi-stage runtime-profile collapse.
      profilePreflight = preflightPipelineProfiles(pipelineProfiles, localSpec, specPath, inputs, routeOptions);
      effectiveProfiles = Object.fromEntries(Object.entries(pipelineProfiles)
        .filter(([id, entry]) => !id.startsWith('_') && !entry?.decide_from)
        .map(([id, entry]) => [id, entry?.default ?? entry]));
    };
    refreshProfilePreflight();
    const configureFreshStart = () => {
      routing = null;
      routeOptions = routingOptionsFor(stepProfiles, opts);
      localSpecDigest = createHash('sha256').update(JSON.stringify(localSpec)).digest('hex');
      resolveInvocationRoles({ fresh: true });
      refreshProfilePreflight();
    };
    // Restore persisted roles when (and only when) a resume actually happens.
    const restoreRolesFromActive = (src) => {
      if (routing) return;
      if (mode !== 'feature' || !src || !src.implementerAgent) return;
      if (src.implementerAgent !== implementerAgent) {
        console.warn(
          `⚠ Resuming ${featureCode}: build started with implementer=${src.implementerAgent}; ` +
          `honoring the persisted role over the current invocation's flag.`
        );
      }
      implementerAgent = src.implementerAgent;
      reviewerAgent = src.reviewerAgent ?? reviewerAgent;
      refreshProfilePreflight();
    };

    const activeForDecision = active && active.featureCode === featureCode ? active : null;
    const pidAlive = Boolean(
      activeForDecision?.status === 'running'
      && activeForDecision.pid
      && activeForDecision.pid !== process.pid
      && isProcessAlive(activeForDecision.pid)
    );
    const sameMode = !activeForDecision?.mode || activeForDecision.mode === mode;
    let flowTerminal = !activeForDecision?.flowId
      || ['complete', 'aborted', 'killed'].includes(activeForDecision.status);
    const probeFlowId = opts.resumeFlowId ?? activeForDecision?.flowId;
    // Probe only when the engine can tell us something the local record cannot: an
    // explicit resume target, or a record that is not already terminal. A locally
    // terminal record needs no probe (pre-S05 semantics, kept).
    if (probeFlowId && !opts.fresh && (opts.resumeFlowId || !flowTerminal)) {
      try {
        const audit = await stratum.audit(probeFlowId);
        if (isTerminalFlow(audit?.status)) {
          const terminalJournal = verifyConsumerRunRevision({ runId: probeFlowId, targetCwd: agentCwd,
            artifactRoot: opts.consumerArtifactsRoot, specDigest: localSpecDigest,
            profilesDigest: waveProfilesEnabled(pipelineProfiles) ? profilePreflight.profilesDigest : undefined });
          recoverAdvancedConsumerArtifacts({ runId: probeFlowId, targetCwd: agentCwd,
            artifactRoot: opts.consumerArtifactsRoot, audit });
          if (terminalJournal?.wave) {
            const artifacts = new ConsumerFanoutArtifacts({ runId: probeFlowId, targetCwd: agentCwd, artifactRoot: opts.consumerArtifactsRoot });
            try { await replicateCheckpoints({ artifacts, stratum, flowId: probeFlowId, buildCancel }); }
            catch (error) {
              if (audit.status !== 'cancelled') throw error;
              console.warn(`[wave-checkpoint] ${error.message}; local checkpoint preserved, replication incomplete`);
            }
          }
        }
        if (audit?.status === 'cancelled') {
          // C42/C49: a resume probe is not necessarily the owning driver.
          const handle = lookupBuildCancel(probeFlowId);
          if (handle) {
            handle.cancel('flow_cancelled');
          } else if (activeForDecision?.flowId === probeFlowId) {
            const claim = claimActiveBuild(dataDir, activeForDecision);
            if (claim.ok) writeActiveBuild(dataDir, {
              ...claim.record, status: 'aborted', failureReason: 'flow_cancelled',
              completedAt: new Date().toISOString(),
            });
          }
          buildStatus = 'aborted';
          throw Object.assign(new Error(`Flow ${probeFlowId} was cancelled; it cannot be resumed. Run with --fresh to start a new build.`), {
            code: 'FLOW_CANCELLED', reason: 'flow_cancelled',
          });
        }
        flowTerminal = isTerminalFlow(audit?.status);

      } catch (err) {
        if (isRecoverableFlowProbeError(err)) {
          // An unknown flow is only evidence the build is over when its driver is
          // gone. With a live driver pid it is not evidence of anything, and the
          // same-feature conflict guard below must still hold (pre-S05 semantics).
          if (!pidAlive) flowTerminal = true;
        } else {
          throw err;
        }
      }
    }

    const verdict = decideBuildStart({
      active: activeForDecision,
      opts,
      pidAlive,
      flowTerminal,
      sameMode,
    });
    isFreshStart = verdict.action === 'fresh';
    if (isFreshStart && opts.fresh && activeForDecision?.flowId) {
      if (pidAlive) throw new Error('Cannot remove a wave ref owned by a live driver');
      // Inspection must not initialize storage, including ordinary-only old runs.
      const priorPath = routingJournalPath({ runId: activeForDecision.flowId,
        targetCwd: agentCwd, artifactRoot: opts.consumerArtifactsRoot });
      const recorded = pendingRoutingPlans({ cwd, featureCode }).find(p => p.binding?.runId === activeForDecision.flowId);
      const witness = recorded && join(cwd, '.compose/routing/starts', recorded.start.startId,
        'journals', `${activeForDecision.flowId}.json`);
      if (witness && existsSync(witness) && !existsSync(priorPath)) {
        routingRefuse('ROUTING_BINDING_MISSING', 'Initialized routing journal was lost');
      }
      const prior = existsSync(priorPath) ? JSON.parse(readFileSync(priorPath, 'utf8')) : null;
      if (prior?.wave) {
        const expected = prior.wave.checkpoints.at(-1)?.commit;
        if (expected) removeCheckpointRef({ cwd: agentCwd, ref: prior.wave.ref, expected });
      }
    }

    if (verdict.action === 'resume') {
      restoreRolesFromActive(activeForDecision);
      const resumeFlowId = verdict.flowId;
      console.log(`Resuming flow ${resumeFlowId} for ${featureCode}...`);
      if (routing) await reconcileRoutingIssuances({ context: { routing, stratum } });
      response = await stratum.resume(resumeFlowId);
      if (routing) {
        if (response.revisionDigest !== routing.binding.revisionDigest) routingRefuse('ROUTING_BINDING_DRIFT', 'Resume revision differs');
        checkedRouting({ routing });
      }
      // Before trusting the local spec for consumer final-stage / merge-gate
      // ownership, verify it still describes this run. A mismatch throws here,
      // BEFORE any gate can be resolved, leaving the engine's gate waiting and
      // the accepted diffs intact.
      verifyConsumerRunRevision({
        runId: resumeFlowId,
        targetCwd: agentCwd,
        artifactRoot: opts.consumerArtifactsRoot,
        specDigest: localSpecDigest,
        resumeRevisionDigest: response?.revisionDigest,
        profilesDigest: waveProfilesEnabled(pipelineProfiles) ? profilePreflight.profilesDigest : undefined,
      });
      try {
        recoverAdvancedConsumerArtifacts({
          runId: resumeFlowId,
          targetCwd: agentCwd,
          artifactRoot: opts.consumerArtifactsRoot,
          audit: await stratum.audit(resumeFlowId),
        });
      } catch (error) {
        if (error instanceof ConsumerArtifactError || error instanceof WaveCheckpointError) throw error;
        // Audit/cleanup projection is best-effort for ordinary non-consumer runs.
      }
      // A BARE programmatic resumeFlowId (no --resume flag) resumes the named
      // flow as-is and proceeds — exactly as pre-COMP-BUILD-RESUME, which had no
      // post-resume terminal check on this path. Only the --resume flag /
      // auto-resume path re-evaluates terminality: a terminal resume response
      // there means "nothing to resume" (flag → error, auto → start fresh).
      const bareFlowResume = Boolean(opts.resumeFlowId && !opts.resume);
      if (!bareFlowResume && isTerminalFlow(response.status)) {
        const explicitResume = Boolean(opts.resume || opts.resumeFlowId);
        if (explicitResume) {
          throw new Error(`Nothing to resume for ${featureCode} (no in-progress or failed build found)`);
        }
        // COMP-TRIAGE-6-4: claim fresh-ownership intent BEFORE rotating, so if
        // rotation itself throws the finalize guard still treats this as a fresh
        // start (isFreshStart=true) and suppresses re-finalizing the reused
        // failed row. Rotation then swaps to a fresh identity before startFresh.
        isFreshStart = true;
        configureFreshStart();
        rotateStaleAccumulatorForFreshStart();
        response = await startFresh(stratum, specYaml, featureCode, description, dataDir, templateName, mode, preMergeGate, roles, cwd, { ...routeOptions, profiles: stepProfiles, targetCwd: agentCwd, artifactRoot: opts.consumerArtifactsRoot });
        routing = response.routing ?? null;
      }
      if (!isFreshStart) {
        const stepId = response.ready?.[0]?.id;
        const flowId = response.runId ?? resumeFlowId;
        console.log(`Resuming from step: ${stepId}`);
        // COMP-CODEX-IMPL: this is a real resume — restore roles from persisted state
        // (the refresh-write below then persists the restored roles, not flag-derived).
        restoreRolesFromActive(activeForDecision);
        // Refresh active-build.json so streaming/UI sees this as the live build.
        const flowName = extractFlowName(specYaml, templateName);
        writeActiveBuild(dataDir, {
          featureCode,
          flowId,
          pipeline: flowName,
          mode,
          pid: process.pid,
          currentStepId: stepId,
          specPath: `pipelines/${templateName}.stratum.yaml`,
          stepNum: 1,
          totalSteps: null,
          retries: 0,
          violations: [],
          status: 'running',
          resumedAt: new Date().toISOString(),
          // COMP-CODEX-IMPL: carry the (restored or default) roles forward on resume-refresh.
          implementerAgent,
          reviewerAgent,
        });
      }
    } else if (verdict.action === 'fresh') {
      if (activeForDecision?.flowId) console.log(`${verdict.reason}. Starting fresh.`);
      // COMP-TRIAGE-6-4: rotate a reused failed identity before the fallible
      // startFresh so a plan() throw cannot re-finalize the prior attempt.
      configureFreshStart();
      rotateStaleAccumulatorForFreshStart();
      response = await startFresh(stratum, specYaml, featureCode, description, dataDir, templateName, mode, preMergeGate, roles, cwd, { ...routeOptions, profiles: stepProfiles, targetCwd: agentCwd, artifactRoot: opts.consumerArtifactsRoot });
        routing = response.routing ?? null;
    } else {
      // A refused invocation never owned the accumulator — the ALIVE build does.
      // Disown before throwing so the widened finally cannot finalize the other
      // build's attempt as failed (spurious terminal row).
      attemptStarted = false;
      const reason = verdict.reason.includes(featureCode)
        ? verdict.reason
        : verdict.reason.replace('Build already running', `Build already running for ${featureCode}`);
      throw new Error(reason);
    }

    // Ownership point — the verdict resolved to resume or fresh (refuse/error
    // threw above without persisting anything). The fresh-over-failed identity
    // rotation now happens BEFORE startFresh (COMP-TRIAGE-6-4,
    // rotateStaleAccumulatorForFreshStart), so only the brand-new candidate is
    // persisted here. A new candidate is unaffected by that bug: a startFresh
    // throw hits finalizeBuildAttempt's write-and-emit fallback under a distinct
    // candidate id, never a duplicate row.
    if (isNewAccumulator) {
      writeBuildAccumulator(cwd, activeAccumulator);
      accumulatorPersisted = true;
      if (triageEstimate) emitTriageEstimate(cwd, triageEstimate);
    }

    // COMP-BUILD-CANCEL S03-5b (C36): register the in-process handle the moment the run id
    // exists — BEFORE the Codex worktree preflight below, which can hold for up to
    // PROBE_AGENT_TIMEOUT_MS. `active-build.json` already advertises this flow id and pid,
    // so a same-process abort arriving in that window would otherwise find no handle, fall
    // through to the foreign-pid branch, and SIGTERM the compose server itself.
    registeredFlowId = response?.runId ?? null;
    registerBuildCancel(registeredFlowId, buildCancel);
    buildIdentity = { featureCode, flowId: registeredFlowId, pid: process.pid,
      startedAt: readActiveBuild(dataDir)?.startedAt };

    // SIGINT/SIGTERM: cancel the flow, tear down, exit (COMP-BUILD-CANCEL §9). A SECOND
    // signal during teardown exits immediately — a user pressing Ctrl-C twice is asking to
    // stop waiting, and the durable state a bounded teardown would have written is worth
    // less than obeying that.
    signalHandler = (signal) => {
      // No local `tearingDown` flag: the handle owns that state (C27), so a teardown
      // started by any other path is visible here too.
      if (buildCancel.teardownStarted) { process.exit(signal === 'SIGINT' ? 130 : 143); return; }
      buildStatus = 'aborted';
      // ASSIGN, do not fire and forget (C45). The promise is what the outer catch reads to
      // stand down and what the outermost finally and the CLI join on. `runCancelTeardown`
      // sets `teardownStarted` synchronously, so a second signal takes the branch above.
      buildCancel.teardown = runCancelTeardown({
        finalizeEvidence: () => recoverRoutingEvidence(routingRuntimeContext, { deliver: false }),
        buildCancel,
        signal,
        flowId: response?.runId,
        flowCancel: (id) => stratum.flowCancel(id),
        timeoutMs: cancelTimeoutMs,
        drainMs: drainTimeoutMs,
        claimOwnership: () => claimActiveBuild(dataDir, buildIdentity),
        killVision: () => killOwnedBuildVision(visionWriter, itemId, () => claimActiveBuild(dataDir, buildIdentity)),
        // The teardown re-claims after vision, immediately before this write (§3.7).
        writeTerminal: (record) => {
          writeActiveBuild(dataDir, { ...record, status: 'aborted', completedAt: new Date().toISOString() });
        },
        removeListeners: () => {
          process.removeListener('SIGINT', onSigint);
          process.removeListener('SIGTERM', onSigterm);
        },
        exit: (code) => process.exit(code),
        // eslint-disable-next-line no-console
        log: (message) => console.warn(`[build] ${message}`),
      });
    };
    // Named wrappers, because the two existing removeListener sites must remove the same
    // function references that were registered.
    const onSigint = () => signalHandler('SIGINT');
    const onSigterm = () => signalHandler('SIGTERM');
    signalHandler.listeners = { onSigint, onSigterm };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    // COMP-CODEX-IMPL: verify Codex can write inside a detached git worktree (the
    // execute step's isolation primitive) before any step dispatches. Runs on the
    // EFFECTIVE role — after resume restoration above — so a resumed Codex build is
    // probed too (cached per-repo, so resume is normally a no-op); gating on the
    // pre-restore flag would skip resumed Codex builds (Codex impl-review finding).
    // The plan/resume above only created the flow object; no agent/worktree work has
    // happened yet, so aborting here still means we never reach `execute` (Codex
    // review finding #2). Cached + skippable via COMPOSE_SKIP_CODEX_PROBE.
    // Compare the PROVIDER, not the raw string: `codex:orchestrator` and
    // `codex::critical` are Codex implementers too, and an exact-string check let
    // them skip the mandatory worktree probe entirely (round 4 review).
    routingRuntimeContext = routing ? { routing, stratum, flowId: response.runId, artifacts: routing.artifacts, buildCancel } : null;
    if (routingRuntimeContext) installRoutingCalls(routingRuntimeContext);
    if (parseAgentString(implementerAgent).provider === 'codex') {
      const probe = await preflightCodexWorktreeProbe({
        cwd: agentCwd,
        projectCwd: cwd,
        ...(routing ? { routingContext: routingRuntimeContext } : {}),
        buildId: build_id,
        featureCode,
        stratum,
        dataDir,
        ts: new Date().toISOString().replace(/[:.]/g, '-'),
        // C36/C51: an abort during the probe stops the probe too.
        signal: buildCancel.signal,
      });
      if (!probe.ok) {
        // The signal teardown owns terminal writes; let the catch/finally drain it.
        if (buildCancel.teardown) throw new Error(codexProbeAbortMessage(probe.reason));
        // The plan/resume above already persisted feature.json=IN_PROGRESS and
        // active-build.json='running'. A preflight abort throws before the normal
        // terminal handlers run, so roll BOTH back here (mirrors the killed/failed
        // teardown) — otherwise a build that never dispatched a step strands stale
        // state (Codex impl-review findings).
        if (cfg.tracksFeatureJson) {
          try {
            const _bp = await getBuildProvider(cwd);
            const _feat = await _bp.getFeature(featureCode);
            if (_feat) await _bp.persistFeatureRaw(featureCode, { ..._feat, status: 'PLANNED' });
          } catch { /* best-effort */ }
        }
        // Identity-guarded active-build downgrade: active-build.json is last-writer-wins
        // across concurrent feature builds and the probe can sit up to its timeout, so
        // only downgrade if the on-disk state is still THIS build (same pattern as
        // persistHealthGateDowngrade) — never clobber a concurrent build's state.
        try {
          const cur = readActiveBuild(dataDir);
          const sameFlow = !cur?.flowId || !response?.runId || cur.flowId === response.runId;
          const sameFeature = !cur?.featureCode || cur.featureCode === featureCode;
          if (cur && sameFlow && sameFeature) {
            writeActiveBuild(dataDir, { ...cur, status: 'aborted', completedAt: new Date().toISOString() });
          }
        } catch { /* best-effort cleanup */ }
        throw new Error(codexProbeAbortMessage(probe.reason));
      }
      if (!probe.cached && !probe.skipped) {
        console.log(`✓ Codex worktree probe passed — ${probe.reason}`);
      }
    }

    // Update vision state
    await visionWriter.updateItemStatus(itemId, 'in_progress');

    // Stream writer — instantiated after plan/resume succeeds to prevent
    // a rejected/duplicate invocation from truncating an active build's stream.
    // Only truncate on fresh starts; resumed builds append to existing stream.
    // COMP-TEST-BOOTSTRAP-4-1: clear any stale pre-coverage test snapshot on a fresh
    // start (it is per-build; a resume must keep the prior session's snapshot).
    if (isFreshStart) clearPreCoverageTests(composeDir);
    streamWriter = new BuildStreamWriter(composeDir, featureCode, { truncate: isFreshStart });
    streamWriter.write({
      type: isFreshStart ? 'build_start' : 'build_resume',
      featureCode,
      flowId: response.runId,
      specPath: `pipelines/${templateName}.stratum.yaml`,
    });

    streamWriter.write({ type: 'profile_preflight', steps: profilePreflight.resolved });
    // H1: reducer steps — ReviewResult-out steps that MERGE/deduplicate rather
    // than review (e.g. review_merge). They still get review normalization +
    // confidence handling, but must NOT get the reviewer scaffold. python's
    // reduce_mode input was stripped by the v0.3→v1 conversion; it now lives in
    // the profile sidecar's `_reduceSteps` array.
    const reduceSteps = new Set(Array.isArray(stepProfiles?._reduceSteps) ? stepProfiles._reduceSteps : []);

    // Dispatch loop — agents operate in agentCwd (which may differ from cwd for cross-repo builds)
    // stepHistory accumulates context across steps so downstream steps don't re-explore
    stepHistory = [];
    // COMP-MCP-MIGRATION: read enforcement.mcpForFeatureMgmt from settings.
    // When true, step-prompt.js injects a hard instruction telling the agent
    // to use typed MCP tools instead of free-text Edit/Write for ROADMAP /
    // CHANGELOG / feature.json.
    const enforceMcpForFeatureMgmt = (() => {
      try {
        if (existsSync(settingsPath)) {
          const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
          return Boolean(s?.enforcement?.mcpForFeatureMgmt);
        }
      } catch { /* default false */ }
      return false;
    })();

    const context = {
      stratum,
      flowId: response.runId,
      buildCancel,
      receiptsMode,
      cwd: agentCwd,
      projectCwd: cwd,
      featureCode,
      featureDir: resolveItemDir(featureCode),
      contextDir: contextDirPath,
      stepHistory,
      mode,
      // V4: merged runtime + static agent profiles let scoped consumer steps
      // recover their tier/capability profile via resolveStepProfile normalization.
      stepProfiles: effectiveProfiles,
      pipelineProfiles,
      routing,
      // COMP-BUILD-QUICK-1: the pipeline template (e.g. 'build-quick') so the ship
      // step can stamp built_via onto feature.json for the validator's exemption.
      templateName,
      enforceMcpForFeatureMgmt,
      build_id,
      buildStartedAt,
      featuresDir,
      // COMP-CODEX-IMPL: roles drive fix-routing (fixer = implementer) and Codex
      // self-review suppression. Restored from active-build state on resume (above).
      implementerAgent,
      reviewerAgent,
      filesChanged: [...activeAccumulator.files_changed],
      ...(isBugMode ? { bug_code: featureCode } : {}),
    };
    context.recordBuildUsage = async (usage, meta) => {
      if (!usage || typeof usage !== 'object') return;
      const accumulatorUsage = Array.isArray(usage)
        ? usage.reduce((sum, entry) => ({
            input_tokens: sum.input_tokens + (entry?.input_tokens ?? 0),
            output_tokens: sum.output_tokens + (entry?.output_tokens ?? entry?.tokens ?? 0),
            cost_usd: sum.cost_usd + (entry?.cost_usd ?? entry?.usd ?? 0),
          }), { input_tokens: 0, output_tokens: 0, cost_usd: 0 })
        : usage;
      const componentTokens = (typeof accumulatorUsage.input_tokens === 'number' ? accumulatorUsage.input_tokens : 0)
        + (typeof accumulatorUsage.output_tokens === 'number' ? accumulatorUsage.output_tokens : 0);
      const tokens = componentTokens > 0
        ? componentTokens
        : (typeof accumulatorUsage.tokens_total === 'number'
            ? accumulatorUsage.tokens_total
            : (typeof accumulatorUsage.tokens === 'number' ? accumulatorUsage.tokens : 0));
      const statedUsd = typeof accumulatorUsage.cost_usd === 'number'
        ? accumulatorUsage.cost_usd
        : (typeof accumulatorUsage.usd === 'number' ? accumulatorUsage.usd : null);
      const usd = statedUsd ?? 0;
      // COMP-COST-OWNER S1. Spend we cannot price is COUNTED, not added as a zero.
      // Counted per ENTRY, because the array branch above has already collapsed the
      // entries into one sum and a sum cannot say which of its terms were unknown.
      // Per-DISPATCH entries, selected exactly as reportUsageReceipts does (:2267-2269).
      // The aggregate `usage` object is the wrong place to look: result-normalizer seeds
      // its merged `cost_usd` at 0 and only ever adds to it, so an unpriced run arrives
      // here carrying a numeric `cost_usd: 0` that is indistinguishable from a measured
      // free call. The honest signal is the OMISSION of the key on `usages[i]`, which is
      // where result-normalizer:750 leaves it out. Same trap as `usd_source` riding
      // usages[0] rather than the aggregate.
      const unknownEntries = (Array.isArray(usage)
        ? usage
        : (Array.isArray(usage?.usages) ? usage.usages : (usage ? [usage] : []))
      ).filter((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        if (typeof entry.cost_usd === 'number' || typeof entry.usd === 'number') return false;
        const spent = (typeof entry.input_tokens === 'number' ? entry.input_tokens : 0)
          + (typeof entry.output_tokens === 'number' ? entry.output_tokens : 0)
          + (typeof entry.tokens === 'number' ? entry.tokens : 0);
        return spent > 0;   // tokens moved but nobody said what they cost
      }).length;
      const inTok = typeof accumulatorUsage.input_tokens === 'number' ? accumulatorUsage.input_tokens : 0;
      const outTok = typeof accumulatorUsage.output_tokens === 'number' ? accumulatorUsage.output_tokens : 0;
      if (tokens !== 0 || usd !== 0 || unknownEntries !== 0) {
        updateBuildAccumulator(cwd, featureCode, (accumulator) => ({
          ...accumulator,
          tokens_total: accumulator.tokens_total + tokens,
          usd: accumulator.usd + usd,
          // A null split came from a v2 record and cannot be recovered. It stays NULL
          // rather than becoming a partial count presented as a total -- the same
          // stickiness `usd_source: estimated` has, and for the same reason.
          input_tokens: accumulator.input_tokens === null ? null : accumulator.input_tokens + inTok,
          output_tokens: accumulator.output_tokens === null ? null : accumulator.output_tokens + outTok,
          usd_unknown_count: accumulator.usd_unknown_count === null
            ? null
            : accumulator.usd_unknown_count + unknownEntries,
        }));
      }
      return reportUsageReceipts(context, usage, meta);
    };
    context.recordFilesChanged = (paths, { authoritativeShip = false } = {}) => {
      const normalized = Array.isArray(paths)
        ? [...new Set(paths.filter((file) => typeof file === 'string' && file.length > 0))]
        : [];
      updateBuildAccumulator(cwd, featureCode, (accumulator) => ({
        ...accumulator,
        ...(authoritativeShip
          ? { ship_files_changed: normalized }
          : { files_changed: [...new Set([...accumulator.files_changed, ...normalized])] }),
      }));
    };
    // COMP-COMPLETION-GATE slice 2: the ship step's completion evidence, carried
    // to terminalization (where completion now happens, after the health gate).
    //
    // `tests_attested` and `evidence_root` are PERSISTED because they cannot be
    // re-derived later: re-running the suite at terminalization would be a second
    // run with a different result, and `runBuild` rebuilds the agent cwd from the
    // current invocation — so a resumed cross-repo build would otherwise verify
    // the wrong repository. The commit SHA is deliberately NOT persisted; it is
    // resolved from HEAD at terminalization, where it is verifiable.
    context.completionEvidence = null;
    context.recordCompletionEvidence = (evidence = {}) => {
      context.completionEvidence = { ...(context.completionEvidence || {}), ...evidence };
      const attested = evidence.testsAttested;
      if (attested !== undefined) {
        updateBuildAccumulator(cwd, featureCode, (accumulator) => ({
          ...accumulator,
          tests_attested: attested,
          evidence_root: agentCwd,
        }));
      }
    };
    context.recordShipTestMetrics = (metrics) => {
      if (!metrics || typeof metrics.test_count !== 'number') return;
      updateBuildAccumulator(cwd, featureCode, (accumulator) => ({
        ...accumulator,
        test_count: metrics.test_count,
        pass_rate: typeof metrics.pass_rate === 'number' ? metrics.pass_rate : 0,
      }));
    };
    context.recordEscalation = () => {
      updateBuildAccumulator(cwd, featureCode, (accumulator) => ({
        ...accumulator,
        escalations: accumulator.escalations + 1,
      }));
    };
    context.recordReviewIteration = () => {
      updateBuildAccumulator(cwd, featureCode, (accumulator) => ({
        ...accumulator,
        review_iterations: accumulator.review_iterations + 1,
      }));
    };
    context.settleDispatches = ({ stepId, ...args } = {}) => settleDispatches(
      cwd,
      build_id,
      stepId,
      args,
    );
    context.onUsage = context.recordBuildUsage;
    if (routing) { routingRuntimeContext = context; installRoutingCalls(context); }

    let consumerArtifacts = routing?.artifacts ?? null;
    const artifactsForRun = (runId, pins) => {
      if (!consumerArtifacts) {
        consumerArtifacts = new ConsumerFanoutArtifacts({
          runId,
          targetCwd: agentCwd,
          artifactRoot: opts.consumerArtifactsRoot,
          // Crash hooks receive the live target path and transaction; they are a
          // TEST-ONLY seam (same convention as the _testClient gate in
          // stratum-mcp-client.js) and are ignored outside NODE_ENV=test.
          hooks: process.env.NODE_ENV === 'test' ? opts.consumerCrashHooks : undefined,
          // Pin the run revision + spec fingerprint into the journal's FIRST
          // durable write, so a crash before the first bind cannot leave an
          // unpinned journal a drifted spec could re-pin (R1).
          revisionDigest: pins?.revisionDigest,
          specDigest: pins?.specDigest,
          profilesDigest: waveProfilesEnabled(pipelineProfiles) ? profilePreflight.profilesDigest : undefined,
        });
      } else if (consumerArtifacts.runId !== runId) {
        throw new Error(`consumer artifact manager is bound to ${consumerArtifacts.runId}, not ${runId}`);
      }
      context.artifacts = consumerArtifacts;
      return consumerArtifacts;
    };
    if (routing) context.artifacts = routing.artifacts;
    if (waveProfilesEnabled(pipelineProfiles)) {
      artifactsForRun(context.flowId, { revisionDigest: response.revisionDigest, specDigest: localSpecDigest });
      context.streamWriter = streamWriter;
      // A ceiling gate turns delivery failures into a durable human hold below.
      try { await flushWaveReceipts(context); } catch (error) {
        if (!pipelineProfiles._costCeiling || buildCancel.cancelled) throw error;
      }
      await replicateCheckpoints(context);
    }


    // COMP-PLAN-GATE-LOOP: per-step gate re-entry counter. A `revise` that
    // routes back through earlier steps re-enters the same gate; the round-aware
    // gate id (below) keeps each re-entry a fresh pending gate, but this counter
    // is the backstop — if the round can't be threaded for any reason, it trips
    // instead of letting the gate spin unbounded (the 52-round loop).
    const gateReentries = new Map();
    // Last consumer-merge preparation/apply failure per merge gate. A failure
    // that repeats byte-identically means the fan-out re-produced the same
    // conflict; revising again only re-dispatches every lane for the same result
    // (observed 2026-08-30: 4 paid rounds on one MERGE_WITNESS_PRECOMPUTE_FAILED).
    const consumerMergeFailures = new Map();

    // The run's effective-spec digest, carried on plan/resume responses only
    // (step_done responses omit it). Captured so the merge-gate path can pin the
    // journal even for an EMPTY-input fanout, which issues no descriptor to pin
    // from (T2). Refreshed whenever a response carries it.
    let runRevisionDigest = response?.revisionDigest ?? null;

    // Consumer descriptors are the only ready entries that leave the serial
    // pump. Tokens are issuance identities: a token is queued/launched once,
    // and ready snapshots returned by concurrent step_done calls may safely
    // repeat it without causing a second dispatch.
    const consumerSeenTokens = new Set();
    const consumerPending = [];
    const consumerInFlight = new Map();
    const consumerCompleted = [];
    let consumerConcurrency = resolveConsumerConcurrency();
    let consumerFatalError = null;
    let consumerWake = null;

    const wakeConsumerPump = () => {
      if (consumerWake) {
        const wake = consumerWake;
        consumerWake = null;
        wake();
      }
    };

    const runConsumerDescriptor = async (descriptor, sourceResponse, admission) => {
      const flowId = sourceResponse.runId ?? sourceResponse.flow_id;
      const artifacts = artifactsForRun(flowId);
      const audit = await stratum.audit(flowId);
      await visionWriter.updateItemPhase(itemId, descriptor.id);
      updateActiveBuildStep(dataDir, descriptor.id, {
        stepNum: sourceResponse.step_number,
        totalSteps: sourceResponse.total_steps,
      });
      return runConsumerIssuance({
        descriptor,
        admission,
        flowId,
        buildCancel,
        stratum,
        artifacts,
        audit,
        localSpec,
        context,
        progress,
        streamWriter,
        // D6/V4: apply the fanout step's compose-side profile (e.g. review_lenses →
        // claude:read-only-reviewer, or a runtime --implementer=claude::critical)
        // so an isolation:none review item runs read-only instead of with
        // Edit/Write/Bash in the target workspace.
        profile: resolveStepProfile(context.stepProfiles, descriptor.step)
          ?? resolveStepProfile(context.stepProfiles, descriptor.id),
      });
    };

    const launchPendingConsumers = () => {
      while (!consumerFatalError && !buildCancel.cancelled
        && consumerInFlight.size < consumerConcurrency
        && consumerPending.length > 0) {
        const work = consumerPending.shift();
        const token = work.descriptor.dispatchToken;
        const task = runConsumerDescriptor(work.descriptor, work.sourceResponse, work.admission)
          .then((nextResponse) => {
            consumerCompleted.push(nextResponse);
          }, (error) => {
            consumerFatalError ??= error;
          })
          .finally(() => {
            consumerInFlight.delete(token);
            launchPendingConsumers();
            wakeConsumerPump();
          });
        consumerInFlight.set(token, task);
      }
    };

    const enqueueConsumerReady = async (engineResponse) => {
      const ready = engineResponse?.status === 'ready' && Array.isArray(engineResponse.ready)
        ? engineResponse.ready
        : [];
      const descriptors = ready.filter(isConsumerDescriptor);
      const ordinary = ready.filter((entry) => !isConsumerDescriptor(entry));
      if (descriptors.length > 0) {
        consumerConcurrency = resolveConsumerConcurrency(descriptors);
        for (const descriptor of descriptors) {
          if (consumerSeenTokens.has(descriptor.dispatchToken)) continue;
          const flowId = engineResponse.runId ?? engineResponse.flow_id;
          const runPins = { revisionDigest: descriptor.revisionDigest, specDigest: localSpecDigest,
            profilesDigest: waveProfilesEnabled(pipelineProfiles) ? profilePreflight.profilesDigest : undefined };
          // Preflight a whole ready batch before launching it. This preserves the
          // shipped crash-before-first-bind boundary (zero issuances may execute)
          // while allowing the work after revision fencing to overlap.
          const artifacts = artifactsForRun(flowId, runPins);
          if (typeof artifacts.hooks.beforeRevisionBind === 'function') {
            await artifacts.hooks.beforeRevisionBind({ descriptor, journal: artifacts.journal });
          }
          artifacts.bindRunRevision(runPins);
          // Concurrent stepDone snapshots can repeat siblings that have since
          // settled. Fence only unseen tokens; already queued tokens retain
          // their original admission and issuance link. Legacy/deferred waves
          // still validate the full batch, including any failed admissions.
          const routingWave = context.routing && routingScope(localSpec, descriptor).step.fanout.steps.length === 1;
          const admission = await admitConsumerWave({ descriptor,
            descriptors: routingWave ? descriptors.filter(d => !consumerSeenTokens.has(d.dispatchToken)) : descriptors,
            localSpec, profiles: pipelineProfiles,
            artifacts, stratum, flowId, routing: context.routing });
          consumerSeenTokens.add(descriptor.dispatchToken);
          consumerPending.push({ descriptor, sourceResponse: engineResponse, admission });
        }
        launchPendingConsumers();
      }
      return ordinary;
    };

    const drainConsumerFatal = async () => {
      // No queued issuance starts after a run-fatal signal. Already-started work
      // is allowed to finish its journal/report path before the signal escapes.
      consumerPending.length = 0;
      while (consumerInFlight.size > 0) {
        await Promise.all([...consumerInFlight.values()]);
      }
      throw consumerFatalError;
    };

    const mergeConsumerReady = async (engineResponse) => {
      let current = engineResponse;
      let latestNonReady = current?.status !== 'ready' ? current : null;
      while (true) {
        if (buildCancel.cancelled) {
          consumerFatalError ??= buildCancel.signal.reason;
          await drainConsumerFatal();
        }
        let ordinary;
        try {
          ordinary = await enqueueConsumerReady(current);
        } catch (error) {
          consumerFatalError ??= error;
          await drainConsumerFatal();
        }
        if (ordinary.length > 0) {
          // Mixed readiness: consumer work has been launched first; the existing
          // ordinary serial path below receives the same response metadata and
          // processes ready[0] exactly as before.
          return { ...current, ready: ordinary };
        }
        if (current?.status !== 'ready') latestNonReady = current;

        if (consumerFatalError) await drainConsumerFatal();
        if (consumerCompleted.length > 0) {
          current = consumerCompleted.shift();
          continue;
        }
        if (consumerPending.length > 0 || consumerInFlight.size > 0) {
          await new Promise((resolve) => { consumerWake = resolve; });
          continue;
        }
        // Concurrent response delivery can leave an older ready snapshot after
        // the response that settled the fanout. Prefer the observed non-ready
        // settlement once every token in that snapshot is already deduplicated.
        return current?.status === 'ready' && latestNonReady ? latestNonReady : current;
      }
    };

    // C2: pump-level fatal boundary. ANY error out of the TS pump — ordinary
    // step, gate, interrupt, OR consumer origin — must not orphan in-flight
    // consumer issuances. Stop queued launches and await every started issuance's
    // journal/report path before the error escapes to the outer catch + shutdown,
    // so no orphaned task mutates a worktree/journal after the run terminalizes.
    const drainConsumersThenRethrow = async (error) => {
      consumerFatalError ??= error;
      consumerPending.length = 0;
      while (consumerInFlight.size > 0) {
        await Promise.allSettled([...consumerInFlight.values()]);
      }
      throw error;
    };
    try {
    while (!isTerminalFlow(response.status) && !buildCancel.cancelled) {
      if (response?.revisionDigest) runRevisionDigest = response.revisionDigest;
      response = await mergeConsumerReady(response);
      const readyStep = response.status === 'ready' ? response.ready?.[0] : null;
      if (response.status === 'ready' && !readyStep) {
        throw new Error('Stratum returned ready without a ready step');
      }
      const outputContract = readyStep
        ? resolveStepOutputContract(localSpec, localFlowName, readyStep.id)
        : null;
      const stepDispatch = readyStep
        ? {
            ...readyStep,
            step_id: readyStep.id,
            agent: readyStep.agent,
            flow_id: response.runId,
            intent: readyStep.do,
            output_fields: outputContract.outputFields,
            has_out_contract: outputContract.hasOutContract,
          }
        : response;
      const stepId = readyStep?.id;
      const flowId = response.runId;
      const stepNum = '?';
      const totalSteps = '?';
      // I4: record the dispatched step so the terminal-failure path knows exactly
      // which step exhausted (scoped ids normalized to the bare step id).
      if (stepId) lastReadyStepId = stepId.includes('/') ? stepId.split('/').pop() : stepId;

      if (response.status === 'ready') {
        progress.stepStart(stepNum, totalSteps, stepId);

        // Stream: step start
        streamWriter.write({
          type: 'build_step_start',
          stepId, stepNum, totalSteps,
          agent: readyStep.agent ?? 'claude',
          intent: readyStep?.do ?? response.intent ?? null,
          flowId,
        });

        // Update tracking
        await visionWriter.updateItemPhase(itemId, stepId);
        updateActiveBuildStep(dataDir, stepId, { stepNum: response.step_number, totalSteps: response.total_steps });

        // Ship step: run git commit in-process instead of delegating to a sandboxed agent.
        // The agent can't git commit (sandbox blocks it), so we do it here where we have
        // full shell access. This turns a 10+ minute spiral into a <5 second operation.
        // COMP-ROADMAP-PLAN S8: build/fix only — plan's `ship` falls through to the
        // normal agent step (handoff/verify), never executeShipStep.
        if (shouldInterceptShip(stepId, mode)) {
          const shipResult = await executeShipStep(featureCode, agentCwd, cwd, context, description, progress);
          // COMP-MODEL-AB fix B: capture test counts here, in the interception branch that
          // `continue`s before the generic step-completion path at ~1703. Without this
          // capture, shipStepTestData stays null for all real builds and appendBuildHistory
          // never persists test_count/pass_rate. Must mirror the generic path exactly.
          const _interceptedTestMetrics = _extractShipTestMetrics(shipResult);
          if (Array.isArray(shipResult.filesChanged)) {
            context.recordFilesChanged(shipResult.filesChanged, { authoritativeShip: true });
          }
          if (_interceptedTestMetrics !== null) {
            shipStepTestData = _interceptedTestMetrics;
            context.recordShipTestMetrics(_interceptedTestMetrics);
          }
          stepHistory.push({
            stepId: 'ship',
            artifact: shipResult.artifact,
            summary: shipResult.summary,
            outcome: shipResult.outcome,
          });
          if (shipResult.outcome === 'failed') {
            console.error(`\nShip failed: ${shipResult.summary}`);
            buildStatus = 'failed';
            streamWriter.write({
              type: 'build_step_done',
              stepId: 'ship', summary: shipResult.summary, retries: 0,
              violations: [shipResult.summary], flowId,
            });
            break;
          }
          progress.stepDone(stepId);
          // COMP-PLAN-SECTIONS T7: append "What Was Built" trailers to all
          // section files after a successful ship. No-op if sections/ doesn't
          // exist. Wrapped so trailer-append failure never fails the ship.
          let postShipAnalysis = null;
          try {
            if (shipResult.commit) {
              const trailerResult = appendSectionTrailers({
                featureDir,
                commit: shipResult.commit,
                filesChanged: shipResult.filesChanged ?? [],
                cwd: agentCwd,
              });
              // COMP-PLAN-SECTIONS-REPORT T4: read-only analyzer feeds the
              // trailer event with `unattributed` and primes writeRollup.
              const sectionsDir = join(featureDir, SECTIONS_DIR);
              postShipAnalysis = analyzeRollup({
                sectionsDir,
                filesChanged: shipResult.filesChanged ?? [],
              });
              if (trailerResult.trailed?.length > 0) {
                const payload = {
                  type: 'build_sections_trailed',
                  featureCode,
                  count: trailerResult.trailed.length,
                  sections: trailerResult.trailed,
                };
                if (postShipAnalysis && Array.isArray(postShipAnalysis.unattributed)) {
                  payload.unattributed = postShipAnalysis.unattributed;
                }
                streamWriter.write(payload);
              }
            }
          } catch (err) {
            if (context.routing && routingIntegrityError(err)) throw err;
            try { streamWriter.write({ type: 'build_error', message: `sections trailer append failed: ${err.message}`, stepId: 'ship' }); } catch { /* ignore */ }
          }
          // COMP-PLAN-SECTIONS-REPORT T4: roll-up write isolated in its own
          // try/catch — failure must not suppress the trailer-success event.
          try {
            if (shipResult.commit && postShipAnalysis) {
              const today = new Date().toISOString().slice(0, 10);
              writeRollup({
                featureDir,
                analysis: postShipAnalysis,
                commit: shipResult.commit,
                date: today,
              });
            }
          } catch (err) {
            if (context.routing && routingIntegrityError(err)) throw err;
            try { streamWriter.write({ type: 'build_error', message: `sections rollup write failed: ${err.message}`, stepId: 'ship' }); } catch { /* ignore */ }
          }
          // COMP-HEALTH: collect plan_completion signal from ship result (if present)
          if (shipResult.planCompletionPct != null || shipResult.plan_completion_pct != null) {
            buildSignals.plan_completion = {
              planCompletionPct: shipResult.planCompletionPct ?? shipResult.plan_completion_pct,
            };
          }
          verifyPipelineIntegrity(specPath, specFileHash);
          // `plan_items` is declared by build.stratum.yaml's PhaseResult but NOT
          // by gsd's, so it stays at this call site rather than in the shared
          // narrowing helper.
          const tsShipOutput = {
            ...toPhaseResultOutput(shipResult),
            ...(Array.isArray(shipResult.plan_items) ? { plan_items: shipResult.plan_items } : {}),
          };
          const shipStepResult = response.status === 'ready'
            ? { output: tsShipOutput }
            : shipResult;
          response = await callFlowWithCancellation(stratum, 'stepDone', flowId, buildCancel,
            stepId, shipStepResult, readyStep?.dispatchToken,
          );
          streamWriter.write({
            type: 'build_step_done',
            stepId, summary: shipResult.summary, retries: 0, violations: [], flowId,
          });
          continue;
        }

        const ordinaryAdmission = readyStep ? admitOrdinaryRoute({ descriptor: readyStep, localSpec, context }) : null;
        const ordinaryIssuance = prepareRoutingIssuance({ descriptor: readyStep, admission: ordinaryAdmission, context });
        await launchRoutingIssuance(context, ordinaryIssuance);
        const ordinaryCalls = callsForRouting(context, ordinaryIssuance, ordinaryIssuance ? null : 'engine-judged', readyStep);

        // Surface 9 returns a fresh ready issuance with previousFailure after a
        // contract/ensure miss. Preserve Compose's recovery behavior: let the
        // implementer fix the failed work before the declared agent re-runs it.
        // I1: this is scoped-id only again. review_merge's dirty-review convergence
        // is NOT a reissue loop (it can't converge — see review_gate below); it is
        // the engine-native review_gate that runs the fixer and revises to triage.
        if (stepId.includes('/') && readyStep?.previousFailure) {
          const fixAgent = context.implementerAgent || 'claude';
          const failureReason = readyStep.previousFailure.reason ?? 'postcondition failed';
          progress.fix('build', fixAgent, stepId);
          const fixPrompt =
            `Fix step "${stepId}" — the previous attempt failed:\n` +
            `- ${failureReason}\n\nFix every issue, then return the step's expected result.`;
          try {
            // The fixer's work is adjudicated by the retried step's own stepDone —
            // no settlement here (its dispatch event still records the cost).
            const fixResult = await runAndNormalize(undefined, fixPrompt, { ...stepDispatch, agent: fixAgent }, routingCallOptions({
              ...(context.routing ? { routingCalls: callsForRouting(context, ordinaryIssuance, 'scoped-fixer', readyStep) } : {}),
              progress,
              streamWriter,
              maxDurationMs: STEP_TIMEOUT_MS[stepId] ?? DEFAULT_TIMEOUT_MS,
              stratum,
              cwd: agentCwd,
              // C9: the sidecar's `fix` profile carries the fixer's tool
              // restrictions and model tier. Passing the bare agent literal
              // here handed the fixer an unrestricted profile; the sibling
              // review-repair site keys off `fix` the same way. Identity still
              // comes from the dispatch (`agent: fixAgent`).
              profile: resolveStepProfile(effectiveProfiles, 'fix')
                ?? resolveStepProfile(context.stepProfiles, stepId),
              sandboxMode: 'workspace-write',
              ...(flowTag(flowId, stepId) ? { flow: flowTag(flowId, stepId) } : {}),
              flowId, buildCancel,
              buildSignal: buildCancel.signal,
              telemetry: {
                site: 'review-repair',
                project_cwd: cwd,
                build_id,
                feature_code: featureCode,
                step_id: stepId,
                ...(typeof readyStep.attempt === 'number' ? { attempt: readyStep.attempt } : {}),
              },
            }));
            if (fixResult?.usage && typeof context.recordBuildUsage === 'function') {
              try {
                await context.recordBuildUsage(usagePayload(fixResult.usage, fixResult.usages), {
                  stepId,
                  source: 'fixer',
                  dispatchId: fixResult.dispatchIds?.primary,
                });
              } catch (usageError) { if (context.routing && routingIntegrityError(usageError)) throw usageError; }
            }
          } catch (err) {
            if (context.routing && routingIntegrityError(err)) throw err;
            if (buildCancel.cancelled) throw err;
            if (err?.usage && typeof context.recordBuildUsage === 'function') {
              try {
                await context.recordBuildUsage(usagePayload(err.usage, err.usages), {
                  stepId,
                  source: 'fixer',
                  dispatchId: err.dispatchId,
                });
              } catch (usageError) { if (context.routing && routingIntegrityError(usageError)) throw usageError; }
            }
            if (err instanceof AgentTimeoutError) {
              console.warn(`\n⚠ Fix agent timed out on "${stepId}"`);
            } else {
              throw err;
            }
          }
          progress.retry('build', stepId, readyStep.agent ?? response.agent ?? 'claude');
        }

        // Build prompt and dispatch to agent
        const stepStartMs = Date.now();
        const agentType = readyStep?.agent ?? response.agent ?? 'claude';
        const basePrompt = buildStepPrompt(stepDispatch, context);
        const maxDurationMs = process.env.NODE_ENV === 'test' && Number.isFinite(opts.stepTimeoutMs)
          ? opts.stepTimeoutMs
          : (STEP_TIMEOUT_MS[stepId] ?? DEFAULT_TIMEOUT_MS);

        // MF-1/SF-4: Prepend shared review scaffold when this is a review step.
        // Also covers a ReviewResult merge step so its output is normalized via
        // normalizeReviewResult. Reducer steps get normalization but not reviewer
        // scaffold framing. Review-ness comes from the resolved contract identity (e.g.
        // the scoped codex_review/review subflow step, out: ReviewResult); reducer-
        // ness (review_merge merges/deduplicates → normalization but NO reviewer
        // scaffold) comes from the profile sidecar's _reduceSteps.
        const { isReviewMain, isReviewScaffoldMain } = deriveOrdinaryReviewScaffold({
          contractName: outputContract?.contractName ?? null,
          stepId,
          reduceSteps,
        });
        const confGateMain = Number(response.inputs?.confidence_gate ?? response.confidence_gate ?? 7);
        let prompt = basePrompt;
        if (isReviewScaffoldMain) {
          prompt = buildReviewPrompt({
            agentType,
            lens: 'general',
            lensFocus: '',
            exclusions: '',
            confidenceGate: confGateMain,
            taskDescription: response.inputs?.task ?? '',
            blueprint: response.inputs?.blueprint ?? '',
          }) + '\n\n' + basePrompt;
        }

        // Collect tool_use events for post-step capability audit (Item 193/195)
        const observedTools = [];
        const onToolUse = ({ tool, input, timestamp }) => {
          observedTools.push({ tool, input, timestamp });
        };

        let mainResult;
        try {
          mainResult = await runAndNormalize(null, prompt, stepDispatch, routingCallOptions({
            ...(ordinaryCalls ? { routingCalls: ordinaryCalls } : {}),
            progress, streamWriter, maxDurationMs, onToolUse, stratum, cwd: agentCwd,
            reviewMode: isReviewMain,
            confidenceGate: confGateMain,
            lens: response.inputs?.lens_name ?? response.lens_name ?? 'general',
            ...(flowTag(flowId, stepId) ? { flow: flowTag(flowId, stepId) } : {}),
            flowId, buildCancel,
            buildSignal: buildCancel.signal,
            telemetry: {
              site: isReviewMain ? 'review' : 'build-step',
              project_cwd: cwd,
              build_id,
              feature_code: featureCode,
              step_id: stepId,
              ...(typeof readyStep?.attempt === 'number' ? { attempt: readyStep.attempt } : {}),
            },
            // D6/V4: apply this ordinary step's compose-side profile (e.g.
            // blueprint → claude::critical, review_merge → claude:orchestrator),
            // normalizing scoped subflow ready ids to the bare step id.
            profile: ordinaryAdmission ? admittedRoute(context.routing, ordinaryAdmission, ordinaryAdmission.baseline).profile
              : resolveStepProfile(context.stepProfiles, stepId),
          }));
        } catch (err) {
          if (ordinaryIssuance) routingEvent(context, ordinaryIssuance, 'uncertain', { reason: err.message });
          if (context.routing && routingIntegrityError(err)) throw err;
          if (buildCancel.cancelled) throw err;
          const failedUsage = failureUsageFields(err);
          if (err instanceof UserInterruptError) {
            if (err.action === 'skip') {
              if (progress) progress.info(`  ⏭ Skipped step "${stepId}"`);
              mainResult = {
                text: '',
                // `phase` is carried because every pipeline's result contract
                // declares it and engine contracts are strict — without it a
                // user-initiated skip fails the step it was meant to bypass.
                result: { phase: stepId, outcome: 'skipped', summary: 'Skipped by user' },
                dispatchIds: { primary: err.dispatchId ?? null, repair: null },
                settlementFailureClass: 'agent',
                ...failedUsage,
              };
            } else {
              if (progress) progress.info(`  ↻ Retrying step "${stepId}"`);
              mainResult = {
                text: '',
                result: { outcome: 'failed', summary: 'Retry requested by user' },
                dispatchIds: { primary: err.dispatchId ?? null, repair: null },
                settlementFailureClass: 'agent',
                ...failedUsage,
              };
            }
          } else if (err instanceof AgentTimeoutError) {
            console.warn(`\n⚠ Agent timed out on step "${stepId}" after ${Math.round(err.durationMs / 1000)}s`);
            streamWriter.write({ type: 'build_error', message: err.message, stepId });
            mainResult = {
              text: '',
              result: { outcome: 'failed', summary: `Timed out after ${Math.round(err.durationMs / 1000)}s` },
              dispatchIds: { primary: err.dispatchId ?? null, repair: null },
              settlementFailureClass: 'agent',
              ...failedUsage,
            };
          } else {
            // Fatal rethrow bypasses the post-stepDone usage fold — bill the
            // attempt's real cost to the accumulator before crashing.
            if (failedUsage.usage && typeof context.recordBuildUsage === 'function') {
              try {
                await context.recordBuildUsage(usagePayload(failedUsage.usage, failedUsage.usages), {
                  stepId,
                  source: 'main',
                  dispatchId: err.dispatchId,
                });
              } catch (usageError) { if (context.routing && routingIntegrityError(usageError)) throw usageError; }
            }
            if (ordinaryIssuance && routingCallsTerminated(context, ordinaryIssuance)) {
              await reportRoutingStep(context, readyStep, ordinaryIssuance, { failure: err.message });
            }
            streamWriter.write({ type: 'build_error', message: err.message, stepId });
            throw err;
          }
        }
        // COMP-POLICY-CHECK-3/4: scan the candidate response against the local
        // adherence catalog before it is accepted, then allow the agent exactly
        // one revision pass. Never hard-blocks (design: "surfaces violations for
        // revision; it does not refuse to emit") and never rewrites the draft.
        let policyViolationStrings = [];
        let policyUnsuppressedCount = 0;
        {
          const skillGated = isGateStep(localSpec, localFlowName, stepId);
          const traceArgs = { cwd, streamWriter, stepId, featureCode, buildId: build_id };

          let scan = policyScanForStep({ cwd, text: mainResult?.text, skillGated });
          recordPolicyScan({ ...traceArgs, records: scan.records, userMode: scan.userMode, pass: 'initial' });

          if (scan.violations.length > 0) {
            if (progress) progress.warn(`Policy check: ${scan.violations.length} unsuppressed violation(s) — requesting one revision`);
            try {
              const revised = await runAndNormalize(
                null,
                `${prompt}\n\n${buildRevisionNotice(scan.records)}`,
                stepDispatch,
                routingCallOptions({
                  ...(context.routing ? { routingCalls: callsForRouting(context, ordinaryIssuance, 'policy-revision', readyStep) } : {}),
                  progress, streamWriter, maxDurationMs, stratum, cwd: agentCwd,
                  reviewMode: isReviewMain,
                  confidenceGate: confGateMain,
                  profile: resolveStepProfile(context.stepProfiles, stepId),
                  ...(flowTag(flowId, stepId) ? { flow: flowTag(flowId, stepId) } : {}),
                  flowId, buildCancel,
                  buildSignal: buildCancel.signal,
                  telemetry: {
                    site: 'policy-revision',
                    project_cwd: cwd,
                    build_id,
                    feature_code: featureCode,
                    step_id: stepId,
                    ...(typeof readyStep?.attempt === 'number' ? { attempt: readyStep.attempt } : {}),
                  },
                }),
              );
              const replaces = revised && !revised.normalizationFailure && revised.result?.outcome !== 'failed';
              if (!replaces && revised?.usage && typeof context.recordBuildUsage === 'function') {
                // Rejected revision: its cost still happened, and no merged
                // usage will carry it, so bill it like the review fixer's.
                try {
                  await context.recordBuildUsage(usagePayload(revised.usage, revised.usages), {
                    stepId,
                    source: 'policy_revision',
                    dispatchId: revised.dispatchIds?.primary,
                  });
                } catch (usageError) { if (context.routing && routingIntegrityError(usageError)) throw usageError; }
              }
              if (replaces) {
                await reportUsageReceipts(
                  context,
                  usagePayload(revised.usage, revised.usages),
                  { stepId, source: 'policy_revision', dispatchId: revised.dispatchIds?.primary },
                );
                // The replacement carries BOTH dispatch ids (so settlement
                // settles both) and the summed usage (so step_usage, build
                // totals, and build-history include the revision's cost — the
                // step_usage block below is the single accumulator call).
                mainResult = {
                  ...mainResult,
                  text: revised.text ?? mainResult.text,
                  result: revised.result ?? mainResult.result,
                  usage: mergeUsage(mainResult.usage, revised.usage),
                  dispatchIds: {
                    ...(mainResult.dispatchIds ?? {}),
                    revision: revised.dispatchIds?.primary ?? null,
                  },
                };
                scan = policyScanForStep({ cwd, text: mainResult.text, skillGated });
                recordPolicyScan({ ...traceArgs, records: scan.records, userMode: scan.userMode, pass: 'policy_revision' });
              }
              // The second result stands either way — no further passes.
            } catch (err) {
              if (context.routing && routingIntegrityError(err)) throw err;
              if (buildCancel.cancelled) throw err;
              if (err?.usage && typeof context.recordBuildUsage === 'function') {
                try {
                  await context.recordBuildUsage(usagePayload(err.usage, err.usages), {
                    stepId,
                    source: 'policy_revision',
                    dispatchId: err.dispatchId,
                  });
                } catch (usageError) { if (context.routing && routingIntegrityError(usageError)) throw usageError; }
              }
              if (policyRevisionMustStop(err) || ordinaryIssuance && !routingCallsTerminated(context, ordinaryIssuance)) throw err;
              // eslint-disable-next-line no-console
              console.warn(`[policy-check] revision pass failed on "${stepId}" — keeping the original draft: ${err.message}`);
            }
          }

          policyViolationStrings = scan.violations;
          policyUnsuppressedCount = scan.violations.length;
        }

        const { result, text: stepText, usage: stepUsage, normalizationFailure } = mainResult;

        // Scan agent output for "we should X" / "we could X" patterns that don't map
        // to existing roadmap features — emit idea_suggestion hint events (Item 184).
        // This is a passive hint; nothing is auto-filed.
        if (stepText) {
          const ideaSuggestionRe = /\b(?:we should|we could|we might want to|consider adding|it would be worth)\s+([^.!?\n]{10,120})/gi;
          let m;
          while ((m = ideaSuggestionRe.exec(stepText)) !== null) {
            const suggestion = m[1].trim();
            streamWriter.write({ type: 'idea_suggestion', stepId, text: suggestion });
          }
        }

        // Emit capability_profile event for audit (informational, never blocking)
        {
          const { template: stepTemplate, allowedTools: stepAllowed, disallowedTools: stepDisallowed, tier: stepTier, modelID: stepModelID } = resolveAgentConfig(agentType);
          if (stepTemplate) {
            streamWriter.writeCapabilityProfile(stepId, agentType, stepTemplate, stepAllowed, stepDisallowed);
          }
          // Emit step_model event so the audit trail records which model actually ran each step
          streamWriter.write({ type: 'step_model', stepId, agent: agentType, modelID: stepModelID, tier: stepTier });
        }

        // Post-step capability violation audit (Items 195/196)
        // Read enforcement mode from settings.json (capabilities.enforcement: 'log'|'block')
        {
          const enforcement = (() => {
            try {
              if (existsSync(settingsPath)) {
                const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
                return s?.capabilities?.enforcement ?? 'log';
              }
            } catch { /* degraded — default to log */ }
            return 'log';
          })();

          const capViolations = [];
          for (const { tool } of observedTools) {
            const check = checkCapabilityViolation(tool, agentType);
            if (check.violation) {
              capViolations.push({ tool, severity: check.severity, reason: check.reason });
              // Emit capability_violation event to build stream
              const { template: tpl } = resolveAgentConfig(agentType);
              streamWriter.writeViolation(stepId, agentType, tpl ?? 'unknown', check.reason, check.severity);
              // Console log (always, even in block mode — for visibility)
              console.log(`  [caps] ${tool} used by ${agentType} — violates ${tpl ?? 'unknown'} profile`);
            }
          }

          if (enforcement === 'block' && capViolations.length > 0) {
            const tools = capViolations.map(v => v.tool).join(', ');
            throw new StratumError('CAPABILITY_VIOLATION',
              `Step "${stepId}" used disallowed tools: ${tools}`, stepId);
          }
        }

        // Accumulate step context for downstream steps
        const entry = {
          stepId,
          artifact: result?.artifact ?? null,
          summary: result?.summary ?? 'Step complete',
          outcome: result?.outcome ?? 'complete',
          agent: readyStep?.agent ?? response.agent ?? 'claude',
          durationMs: Date.now() - stepStartMs,
          // COMP-OBS-COST: per-step token/cost data
          input_tokens: stepUsage?.input_tokens ?? 0,
          output_tokens: stepUsage?.output_tokens ?? 0,
          cost_usd: stepUsage?.cost_usd ?? 0,
        };

        // COMP-HEALTH: record contract compliance — ensure passed on first try
        contractCompliance.push({ passed: true, stepId });
        buildSignals.contract_compliance = contractCompliance;

        // After code-producing steps, snapshot changed files so downstream
        // steps (review, coverage, docs, ship) know exactly what was touched.
        // Maintained as context.filesChanged (pre-deduplicated) for step-prompt.js.
        if (stepId === 'execute' || stepId === 'docs') {
          try {
            const diff = execSync('git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null', {
              cwd: agentCwd, encoding: 'utf-8', timeout: 5000,
            }).trim();
            if (diff) {
              const files = diff.split('\n').filter(Boolean);
              entry.filesChanged = files;
              // Merge into context-level deduplicated list
              const existing = new Set(context.filesChanged ?? []);
              for (const f of files) existing.add(f);
              context.filesChanged = [...existing];
              context.recordFilesChanged(context.filesChanged);
            }
          } catch { /* git not available or no repo — skip */ }
        }

        stepHistory.push(entry);
        progress.stepDone(stepId);

        // COMP-MODEL-AB: capture test counts from ship step for build-history persistence.
        // Generic path (non-intercepted ship / plan mode ship-as-agent). Mirrors the
        // ship-interception capture above; uses the same _extractShipTestMetrics helper
        // so both paths produce identical shipStepTestData shapes.
        if (stepId === 'ship') {
          const _genericTestMetrics = _extractShipTestMetrics(result);
          const genericShipFiles = result?.filesChanged ?? result?.files_changed;
          if (Array.isArray(genericShipFiles)) {
            context.recordFilesChanged(genericShipFiles, { authoritativeShip: true });
          }
          if (_genericTestMetrics !== null) {
            shipStepTestData = _genericTestMetrics;
            context.recordShipTestMetrics(_genericTestMetrics);
          }
        }

        // Note: scope-step BuildProfile persistence has been replaced by pre-build triage.
        // runTriage() runs before stratum_plan() and populates feature.json directly.

        // Keep a flat deduplicated file manifest on context so buildStepPrompt
        // doesn't need to recompute it from history on every prompt build.
        if (entry.filesChanged?.length > 0) {
          const set = new Set(context.filesChanged ?? []);
          for (const f of entry.filesChanged) set.add(f);
          context.filesChanged = [...set];
        }

        verifyPipelineIntegrity(specPath, specFileHash);
        // D5: reject a decompose result whose tasks' files_owned overlap, before
        // reporting the step done. A failure envelope routes the step through the
        // engine's attempts loop so the agent can re-decompose disjointly.
        const ownershipFailure = (result && Array.isArray(result.tasks))
          ? filesOwnedConflict(result.tasks)
          : null;
        // F5: v1 vocabulary enforcement is deterministic + compose-side (the
        // judged ensure it replaced was unevaluable). At review_merge, scan the
        // changed files; a violation becomes a failure envelope so the engine's
        // attempts loop governs — never a throw past this handler.
        const vocabularyFailure = ownershipFailure
          ? null
          : computeVocabularyStepFailure({ vocabOn, stepId, cwd: agentCwd, filesChanged: context.filesChanged });
        const blockingFailure = ownershipFailure ?? vocabularyFailure;
        // I1: stash the review reducer's (review_merge) normalized result so the
        // following review_gate can decide clean vs dirty and, on dirty, persist the
        // dirty lens ids + run the fixer + revise. The reducer no longer carries an
        // ensure/attempts loop (it could never converge on frozen lens outputs).
        // Keyed on the profile sidecar's _reduceSteps AND the canonical id, so a
        // missing sidecar can never strand review_gate on a permanent "dirty".
        if (reduceSteps.has(stepId) || stepId === 'review_merge') {
          lastReviewMergeResult = result ?? null;
          // J2: capture the RAW dirty-lens identities from the reducer's
          // pre-normalization text (falling back to the normalized result if the
          // raw text is unavailable), so the corrective round reruns the TRUE dirty
          // lens rather than a normalization-stamped 'general'.
          lastReviewMergeDirtyLenses = extractDirtyLenses(stepText ?? result);
        }
        // COMP-POLICY-CHECK-6: expose the unsuppressed count on the step result
        // so a spec can declare `ensure: ['result.unsuppressed_violations == 0']`.
        // Engine contracts are strict, so the field is attached only where it is
        // declared (or where the step has no out contract).
        const policyResult = attachPolicyCount(result, policyUnsuppressedCount, stepDispatch);
        const stepDoneResult = readyStep
          ? blockingFailure
            ? { failure: blockingFailure }
            : normalizationFailure || result?.outcome === 'failed'
              ? { failure: String(normalizationFailure ?? result?.summary ?? `Step "${stepId}" did not produce structured output`) }
              : stepDispatch.has_out_contract
                ? policyResult != null
                  ? { output: policyResult }
                  : { failure: `Step "${stepId}" did not produce structured output` }
                : {}
          : policyResult ?? { summary: 'Step complete' };
        // Report each model dispatch before the outcome it funded. The merged
        // step usage remains the accumulator/build-stream shape used by existing
        // callers; receipts use mainResult.usages to preserve per-dispatch data.
        if (context.pipelineProfiles?._costCeiling && !toEngineUsage(stepUsage)) {
          await context.recordBuildUsage({ dispatch_id: mainResult.dispatchIds?.primary ?? readyStep?.dispatchToken }, { stepId, source: 'main' });
        }
        if (toEngineUsage(stepUsage)) {
          // recordBuildUsage below is the ONLY writer of build cost; it feeds the owner.
          await context.recordBuildUsage(usagePayload(stepUsage, mainResult.usages), {
            stepId,
            source: 'main',
            dispatchId: mainResult.dispatchIds?.primary,
          });
          streamWriter.writeUsage(stepId, stepUsage, { usdSource: aggregateUsdSource(mainResult.usages) });
        }
        if (ordinaryIssuance) routingEvent(context, ordinaryIssuance, 'result-prepared', { envelope: stepDoneResult });
        response = await callFlowWithCancellation(stratum, 'stepDone', flowId, buildCancel,
          stepId, stepDoneResult, readyStep?.dispatchToken,
        );
        if (ordinaryIssuance) {
          acknowledgeRoutingFailure(context, ordinaryIssuance, stepDoneResult, response);
          await reconcileRoutingIssuances({ context, only: ordinaryIssuance.id });
        }
        {
          const isEnsureRetry = responseReissuesStep(response, stepId);
          const failureClass = ownershipFailure
            ? 'ownership'
            : vocabularyFailure
              ? 'vocabulary'
              : normalizationFailure || (stepDispatch.has_out_contract && result == null)
                ? 'normalization'
                : mainResult.settlementFailureClass
                  ?? (result?.outcome === 'failed' ? 'agent' : null);
          context.settleDispatches({
            stepId,
            dispatchIds: mainResult.dispatchIds,
            accepted: !isEnsureRetry && !blockingFailure && !normalizationFailure
              && result?.outcome !== 'failed'
              && (!stepDispatch.has_out_contract || result != null),
            failureClass,
            isEnsureRetry,
          });
        }
        syncStepHistory(dataDir, stepHistory);

        // COMP-FIX-HARD T6: record accepted hypothesis on diagnose success (bug mode only).
        recordDiagnoseSuccessIfBugMode(context, stepId, result);

        // Debug discipline enforcement (COMP-DEBUG-1)
        if (stepId === 'fix' || stepId === 'diagnose') {
          const filesChanged = extractFilesChanged({ result });
          // COMP-FIX-HARD T9: per-bug keying when running in bug mode.
          if (context.mode === 'bug' && context.bug_code) {
            fixChainDetector.recordIterationForBug(context.bug_code, filesChanged);
            attemptCounter.recordForBug(context.bug_code, { filesChanged });
          } else {
            fixChainDetector.recordIteration(filesChanged);
            attemptCounter.record({ filesChanged });
          }

          // Validate trace evidence on diagnose results
          if (stepId === 'diagnose' && result) {
            const traceResult = TraceValidator.validate(result);
            if (!traceResult.valid) {
              debugLedger.record({ type: 'trace_validation_failed', reason: traceResult.reason });
              if (progress) progress.warn(`Debug discipline: trace evidence insufficient — ${traceResult.reason}`);
            }

            // Cross-layer scope detection after diagnose
            const scopeCheck = crossLayerAudit.shouldExpand(result);
            if (scopeCheck.expand) {
              debugLedger.record({ type: 'scope_expansion_triggered', trigger: scopeCheck.trigger });
              if (progress) progress.warn(`Debug discipline: cross-layer change detected (${scopeCheck.trigger}) — scope_check step should audit all configured repos`);
            }
          }

          const isBugMode = context.mode === 'bug' && !!context.bug_code;
          const chains = isBugMode
            ? fixChainDetector.detectForBug(context.bug_code)
            : fixChainDetector.detect();
          const intervention = isBugMode
            ? attemptCounter.getInterventionForBug(context.bug_code)
            : attemptCounter.getIntervention();
          // COMP-FIX-HARD T10: read attempt counters via the per-bug API in bug mode.
          const attemptCount = isBugMode
            ? attemptCounter.getCountForBug(context.bug_code)
            : attemptCounter.count;
          const attemptIsVisual = isBugMode
            ? (attemptCounter.byBug.get(context.bug_code)?.isVisual ?? false)
            : attemptCounter.isVisual;

          if (chains.length > 0) {
            debugLedger.record({ type: 'fix_chain_detected', chains });
          }

          if (intervention === 'escalate') {
            debugLedger.record({ type: 'escalation', attempt: attemptCount, isVisual: attemptIsVisual });
            if (streamWriter) streamWriter.write({ type: 'build_error', message: `Debug discipline: escalating after ${attemptCount} attempts. Dispatching to cross-agent review.` });
          } else if (intervention === 'trace_refresh') {
            debugLedger.record({ type: 'trace_refresh_required', attempt: attemptCount });
            if (progress) progress.warn(`Debug discipline: ${attemptCount} attempts — fresh trace evidence required before next fix`);
          } else if (intervention === 'trace_reminder') {
            if (progress) progress.warn(`Debug discipline: ${attemptCount} attempts on same target — verify trace evidence is current`);
          }

          // Persist debug state
          try {
            writeFileSync(debugStatePath, JSON.stringify({
              fixChain: fixChainDetector.toJSON(),
              attempt: attemptCounter.toJSON(),
            }), 'utf-8');
          } catch { /* best-effort */ }
        }

        // COMP-FIX-HARD T10: post-retro_check escalation gate (bug mode only).
        if (stepId === 'retro_check' && context.mode === 'bug' && context.bug_code) {
          await maybeRunEscalation(
            stratum,
            {
              ...context,
              projectCwd: cwd,
              step_id: stepId,
              ...(ordinaryIssuance ? { routingParent: ordinaryIssuance } : {}),
              ...(typeof readyStep?.attempt === 'number' ? { attempt: readyStep.attempt } : {}),
            },
            progress,
            streamWriter,
            attemptCounter,
            dataDir,
          );
        }

        // Stream: step done — read retries/violations from active-build state
        // (syncStepHistory has already written them above)
        {
          const buildState = readActiveBuild(dataDir);
          const stepState = buildState?.steps?.find(s => s.id === stepId) ?? {};
          // COMP-HEALTH: collect runtime violations for health score signal.
          // COMP-POLICY-CHECK-3: unsuppressed policy violations join the same
          // stream — ViolationDetail renders them with zero UI changes.
          const stepViolations = [...(stepState.violations ?? []), ...policyViolationStrings];
          if (stepViolations.length > 0) {
            allViolations.push(...stepViolations);
          }

          streamWriter.write({
            type: 'build_step_done',
            stepId,
            summary: (result ?? {}).summary ?? 'Step complete',
            retries: stepState.retries ?? 0,
            violations: stepViolations,
            flowId,
            // COMP-OBS-COST: per-step and cumulative cost
            input_tokens: stepUsage?.input_tokens ?? 0,
            output_tokens: stepUsage?.output_tokens ?? 0,
            cost_usd: stepUsage?.cost_usd ?? 0,
            cumulative_cost_usd: buildCostSnapshot().cost_usd,
          });

          // COMP-UX-3c: 1-sentence console narration instead of full event dump
          const stepSummary = (result ?? {}).summary ?? 'Step complete';
          const retryNote = (stepState.retries ?? 0) > 0 ? ` (${stepState.retries} retr${stepState.retries === 1 ? 'y' : 'ies'})` : '';
          console.log(`  ${stepId}: ${stepSummary}${retryNote}`);

          // COMP-OBS-GATES: classify this step as a tier and record result
          {
            const tierId = classifyStepAsTier(stepId);
            if (tierId) {
              const stepPassed = (result?.outcome ?? 'complete') !== 'failed';
              tierResults[tierId] = stepPassed;
              streamWriter.writeGateTier(stepId, tierId, stepPassed, result?.summary ?? null);

              // If this tier failed, emit gate_tier_failed for early visibility
              if (!stepPassed) {
                streamWriter.write({
                  type: 'gate_tier_failed',
                  stepId,
                  tierId,
                  summary: result?.summary ?? 'Tier failed',
                  flowId,
                });
              }
            }
          }
        }

      } else if (response.status === 'running') {
        // STRAT-PY-RETIRE: the TS engine surfaces a foreground gate as a bare
        // `running` response (no gate id, no step_id). Discover the waiting gate
        // from the audit; if `running` for another reason (in-flight
        // subflow/fanout, or a scoped child gate), break as the legacy path did.
        const gateAudit = await stratum.audit(response.runId);
        const localGateSteps = localSpec?.flows?.[localFlowName]?.steps ?? [];
        const waitingGates = Object.entries(gateAudit?.steps ?? {})
          .filter(([id, s]) => s?.status === 'waiting_gate'
            && !id.includes(':')
            && localGateSteps.some((st) => st.id === id && st.gate))
          .map(([id, step]) => ({ id, gateToken: step.gateToken }));
        if (waitingGates.length === 0) {
          // Known non-dispatch running state (subflow/fanout in flight).
          break;
        }
        if (waitingGates.length > 1) {
          throw new Error(`build.js gate seam: expected a single waiting gate, found ${waitingGates.length}: ${waitingGates.map((gate) => gate.id).join(', ')}`);
        }
        const { id: gateStepId, gateToken } = waitingGates[0];
        // Shadow the loop-level stepId (undefined for a bare `running` response)
        // so the existing gate policy body below operates on the gate step.
        const stepId = gateStepId;
        // Producer-derived gate metadata: the TS gate node carries only
        // on_approve/on_revise/on_kill/max_rounds, so compose synthesizes the
        // rest from its own local spec + stepHistory (cf. resolveStepOutputContract).
        const gateStep = localGateSteps.find((st) => st.id === gateStepId);
        const gateAfter = gateStep?.after;
        const synthFromPhase = Array.isArray(gateAfter)
          ? (gateAfter[gateAfter.length - 1] ?? null)
          : (gateAfter ?? null);
        const synthToPhase = gateStep?.gate?.on_approve ?? null;
        const gatePredHist = (synthFromPhase
          ? [...stepHistory].reverse().find((h) => h.stepId === synthFromPhase)
          : null)
          ?? (stepHistory.length > 0 ? stepHistory[stepHistory.length - 1] : null);
        const synthArtifact = gatePredHist?.artifact ?? null;
        const synthSummary = gatePredHist?.summary ?? null;
        const gateDispatch = {
          step_id: gateStepId,
          on_approve: gateStep?.gate?.on_approve ?? null,
          on_revise: gateStep?.gate?.on_revise ?? null,
          on_kill: gateStep?.gate?.on_kill ?? null,
        };

        // Any consumer fanout the gate directly follows owns this merge — worktree
        // OR none. A pure isolation:none fanout reaches prepareMerge with zero
        // worktree diffs and approves as a trivially clean merge (isolation-aware).
        const consumerFanoutStep = localGateSteps.find((candidate) =>
          candidate?.fanout?.dispatch === 'consumer'
          && (Array.isArray(gateAfter) ? gateAfter.includes(candidate.id) : gateAfter === candidate.id));
        let consumerMergeArtifacts = null;
        let consumerMergeTransaction = null;
        let consumerMergePreparationError = null;
        if (consumerFanoutStep) {
          // Pin from the response's run revision + local spec digest: an
          // empty-input fanout issues no descriptor, so the gate path is where its
          // journal is first created and must still be pinned (T2). For a non-empty
          // fanout the journal already exists (pinned from the first issuance) and
          // these pins are ignored.
          consumerMergeArtifacts = artifactsForRun(flowId, {
            revisionDigest: runRevisionDigest,
            specDigest: localSpecDigest,
          });
          // The fanout→gate binding derived from the (resume-verified) local spec
          // must agree with the one journaled when this gate was first reached;
          // on a resumed run the journal is the authoritative owner record.
          const journaledFanoutId = consumerMergeArtifacts.journal.gateBinding?.[gateStepId] ?? null;
          if (journaledFanoutId && journaledFanoutId !== consumerFanoutStep.id) {
            throw new ConsumerArtifactError(
              'CONSUMER_GATE_BINDING_MISMATCH',
              `merge gate ${gateStepId} follows ${consumerFanoutStep.id} in the local spec but was `
                + `journaled against ${journaledFanoutId}`,
              { gateStepId, localFanoutStepId: consumerFanoutStep.id, journaledFanoutStepId: journaledFanoutId },
            );
          }
          if (pipelineProfiles._consumer?.[consumerFanoutStep.id]?.checkpoint_gate === gateStepId) {
            consumerMergeArtifacts.initializeWave({ ref: `refs/heads/compose/wave/${flowId}`, profilesDigest: profilePreflight.profilesDigest });
          }
          consumerMergeArtifacts.recordGateBinding({ gateStepId, fanoutStepId: consumerFanoutStep.id });
        }

        const resolveGateWithConsumerMerge = async (requestedOutcome, requestedRationale, resolvedBy) => {
          const captured = await captureRoutingGate(context, { gateStepId, gateToken, localSpec });
          let mergeApplied = false;
          const reverseCancelledMerge = () => {
            buildCancel.cancel('flow_cancelled');
            try {
              consumerMergeArtifacts.restoreMergeBaseline(consumerMergeTransaction, gateAudit, { reason: 'cancelled' });
            } catch (revertError) {
              // #mutate cannot persist anything when the restore callback throws.
              // This separate mutation is the durable indeterminate-tree finding.
              let journalFailure = '';
              try { consumerMergeArtifacts.markRollbackFailed(consumerMergeTransaction, revertError); }
              catch (error) { journalFailure = `; rollback failure journal also failed: ${error.message}`; }
              throw new MergeAfterCancelError(`merge reversal FAILED after cancel; working tree is indeterminate: ${revertError.message}${journalFailure}`);
            }
            throw new MergeAfterCancelError('merge reversed: the run was cancelled while the merge was applying');
          };
          let outcome = requestedOutcome;
          let rationale = requestedRationale;
          const repairOutcome = gateStep?.gate?.on_revise ? 'revise' : 'kill';

          if (consumerMergeArtifacts && !consumerMergeTransaction) {
            try {
              consumerMergeTransaction = consumerMergeArtifacts.prepareMerge({
                gateStepId,
                gateToken,
                fanoutStepId: consumerFanoutStep.id,
                audit: gateAudit,
              });
            } catch (error) {
              if (!(error instanceof ConsumerMergeDecisionError)) throw error;
              consumerMergePreparationError = error;
              consumerMergeTransaction = consumerMergeArtifacts.journal.mergeTransactions.find(
                (entry) => entry.gateToken === gateToken,
              ) ?? null;
            }
          }
          const repairFor = (error) => {
            const failure = `${error.code}: ${error.message}`;
            const decision = decideMergeRepairOutcome(
              consumerMergeFailures.get(stepId), failure, repairOutcome,
            );
            consumerMergeFailures.set(stepId, failure);
            outcome = decision.outcome;
            rationale = decision.rationale;
          };
          if (consumerMergeArtifacts && outcome === 'approve') {
            if (consumerMergePreparationError) {
              repairFor(consumerMergePreparationError);
            } else {
              // Both fences are outside the repairFor catch: cancellation cannot revise.
              if (buildCancel.cancelled) {
                streamWriter.write({ type: 'build_note', note: `merge skipped: build cancelled (${buildCancel.reason})`, flowId });
                throw new MergeAfterCancelError(`merge refused: build was cancelled at ${buildCancel.at}`);
              }
              try {
                await consumerMergeArtifacts.applyMerge(consumerMergeTransaction);
                mergeApplied = true;
                try {
                  if (!consumerMergeArtifacts.journal.wave) {
                  const changed = execSync(
                    'git diff --name-only HEAD; git ls-files --others --exclude-standard',
                    { cwd: agentCwd, encoding: 'utf8', timeout: 5000, stdio: 'pipe' },
                  ).trim();
                  if (changed) {
                    const files = new Set(context.filesChanged ?? []);
                    for (const file of changed.split('\n').filter(Boolean)) files.add(file);
                    context.filesChanged = [...files];
                    context.recordFilesChanged(context.filesChanged);
                  }
                  }
                } catch { /* best-effort build context projection */ }
              } catch (error) {
                if (!(error instanceof ConsumerMergeDecisionError)) throw error;
                repairFor(error);
              }
              const runCancelled = mergeApplied && !buildCancel.cancelled && await isRunCancelled(stratum, flowId);
              if (mergeApplied && (buildCancel.cancelled || runCancelled)) {
                reverseCancelledMerge();
              }
            }
          }
          // Seam between a completed applyMerge (issuances now journaled `merged`)
          // and the durable gate decision. A crash here is the R2 window: the
          // rollback on the next revise must restore merge eligibility.
          if (consumerMergeArtifacts
            && outcome === 'approve'
            && !consumerMergePreparationError
            && typeof consumerMergeArtifacts.hooks.afterMergeApplyBeforeGateResolve === 'function') {
            await consumerMergeArtifacts.hooks.afterMergeApplyBeforeGateResolve({
              gateStepId: stepId,
              gateToken,
              transaction: consumerMergeTransaction,
            });
          }
          if (consumerMergeArtifacts && outcome !== 'approve' && consumerMergeTransaction) {
            consumerMergeArtifacts.restoreMergeBaseline(consumerMergeTransaction, gateAudit);
          }

          const disposition = prepareRoutingGate(context, captured, { audit: gateAudit, mergeGate: Boolean(consumerMergeArtifacts), mergeEvidence: consumerMergeTransaction ? structuredClone(consumerMergeTransaction) : null,
            requestedDecision: { decision: requestedOutcome, rationale: requestedRationale ?? '', resolver: resolvedBy },
            finalProposedDecision: { decision: outcome, rationale: rationale ?? '', resolver: resolvedBy } });
          let next;
          try {
            next = await callFlowWithCancellation(stratum, 'gateResolve', flowId, buildCancel,
              stepId, outcome, rationale, resolvedBy, gateToken,
            );
            acknowledgeRoutingGate(context, disposition, next);
            if (consumerMergeArtifacts?.journal?.wave && outcome === 'approve') {
              consumerMergeArtifacts.markGateResolved(consumerMergeTransaction, outcome);
              // Acknowledged approval creates an obligation even if cancellation follows.
              consumerMergeArtifacts.recoverCheckpoint(consumerMergeTransaction);
              mergeApplied = false; // confirmed checkpoint must never be rolled back on cancel
              await replicateCheckpoints(context);
            }
            if (next.status === 'cancelled') buildCancel.cancel('flow_cancelled');
            if (buildCancel.cancelled) throw buildCancel.signal.reason;
          } catch (error) {
            if (context.routing && routingIntegrityError(error)) throw error;
            if (disposition) acknowledgeRoutingGate(context, disposition, null, await stratum.audit(flowId));
            if (waveProfilesEnabled(pipelineProfiles)) {
              const current = await stratum.audit(flowId);
              const ordinal = (gateAudit.events ?? []).filter(e => e.type === 'gate_resolved' && e.stepId === stepId).length;
              const decision = (current.events ?? []).filter(e => e.type === 'gate_resolved' && e.stepId === stepId)[ordinal]?.detail?.decision;
              if (decision) {
                outcome = decision;
                if (consumerMergeArtifacts && decision === 'approve') {
                  consumerMergeArtifacts.markGateResolved(consumerMergeTransaction, decision);
                  consumerMergeArtifacts.recoverCheckpoint(consumerMergeTransaction);
                  mergeApplied = false;
                  await replicateCheckpoints(context);
                }
                if (current.status === 'cancelled') throw error;
                next = await stratum.resume(flowId);
              } else {
                if (mergeApplied && buildCancel.cancelled) reverseCancelledMerge();
                throw error;
              }
            } else {
              if (mergeApplied && buildCancel.cancelled) reverseCancelledMerge();
              throw error;
            }
          }
          if (consumerMergeArtifacts) {
            if (typeof consumerMergeArtifacts.hooks.afterGateResolve === 'function') {
              await consumerMergeArtifacts.hooks.afterGateResolve({
                gateStepId: stepId,
                gateToken,
                outcome,
                rationale,
                response: next,
              });
            }
            if (mergeApplied && buildCancel.cancelled) reverseCancelledMerge();
            consumerMergeArtifacts.markGateResolved(consumerMergeTransaction, outcome);
            if (outcome === 'approve' || outcome === 'kill' || isTerminalFlow(next.status)) {
              consumerMergeArtifacts.cleanupWorktrees(
                outcome === 'approve' ? 'merge gate approved and advanced' : 'run terminalized',
                consumerMergeArtifacts.journal.wave && consumerMergeTransaction
                  ? { dispatchTokens: consumerMergeTransaction.acceptedDispatchTokens } : {},
              );
            }
          }
          if (outcome === 'kill') killedByGate = true;
          await recoverRoutingEvidence(context);
          return { response: next, outcome, rationale };
        };

        updateActiveBuildStep(dataDir, stepId);

        // COMP-PLAN-GATE-LOOP: trip the backstop before doing any gate work if
        // this step has re-entered its gate too many times without converging.
        const gateReentryCount = (gateReentries.get(stepId) ?? 0) + 1;
        gateReentries.set(stepId, gateReentryCount);
        assertGateReentryWithinCap(gateReentryCount, stepId);

        // Gate enrichment extras for STRAT-COMP-6 (producer-synthesized)
        const gateExtras = {
          fromPhase: synthFromPhase,
          toPhase: synthToPhase,
          artifact: synthArtifact,
          summary: synthSummary,
        };

        // STRAT-IMMUTABLE: verify policy has not changed since build start.
        verifyPolicyIntegrity(settingsPath, policyHash);

        // I1: review_gate is resolved PROGRAMMATICALLY from the review reducer's
        // result — a clean merge approves; a dirty merge runs the corrective fixer,
        // persists the dirty lens ids, and REVISES so the engine reroutes to
        // review_triage, whose RETRY PATH reads the sidecar and re-runs only the
        // dirty lenses (+ the two always-on) on the fixed code. This is the
        // engine-native convergence review_merge's own ensure/attempts loop could
        // never achieve (it re-merged the SAME frozen lens outputs every attempt).
        if (gateStepId === 'review_gate') {
          // Test seam (NODE_ENV=test only): interrupt AT the waiting review_gate —
          // after review_merge's stepDone is journaled but before this gate resolves
          // — so a golden can prove the resume re-derive path (J1).
          if (process.env.NODE_ENV === 'test' && typeof opts.reviewGateInterrupt === 'function') {
            opts.reviewGateInterrupt();
          }
          // J1: `lastReviewMergeResult` is process-local — a build RESUMED at the
          // waiting review_gate has a null stash, which would wrongly treat a clean
          // review as dirty (empty fixer + wasted revise, and at max_rounds a clean
          // review terminalizes as exhaustion). Re-derive from the engine audit,
          // which retains steps.review_merge.output, when the stash is empty.
          let reviewResult = lastReviewMergeResult;
          let rawDirtyLenses = lastReviewMergeDirtyLenses;
          if (!reviewResult) {
            // COMP-PIPELINE-QUARANTINE follow-up: the re-derive used to read
            // `steps.review_merge.output` by that literal name, so any pipeline
            // whose reducer is called something else (team-review's `merge`,
            // review-fix's `review`) silently got a null stash on resume and had
            // its clean review treated as dirty. The stash above is already keyed
            // on the sidecar's _reduceSteps; this now matches it, with the
            // canonical id kept as the fallback.
            const reducerIds = [...reduceSteps, 'review_merge'];
            const auditedOutput = reducerIds
              .map((id) => gateAudit?.steps?.[id]?.output ?? null)
              .find((out) => out && typeof out === 'object') ?? null;
            if (auditedOutput) {
              reviewResult = auditedOutput;
              rawDirtyLenses = extractDirtyLenses(auditedOutput);
            }
          }
          reviewResult = reviewResult ?? {};
          const clean = reviewResult.clean === true;
          if (clean) {
            const resolved = await resolveGateWithConsumerMerge('approve', 'review clean', 'system');
            response = resolved.response;
            streamWriter.write({ type: 'build_gate_resolved', stepId: gateStepId, outcome: resolved.outcome, rationale: resolved.rationale, flowId, policyMode: 'review' });
            stepHistory.push({ stepId: gateStepId, artifact: null, summary: 'Review gate: clean', outcome: resolved.outcome });
            syncStepHistory(dataDir, stepHistory);
          } else {
            context.recordReviewIteration();
            // Persist the dirty lens ids so the revised triage re-runs only those.
            // J2: prefer the PRE-normalization dirty lenses (normalization resets
            // lenses_run and stamps a missing finding lens as 'general', which would
            // hide the true dirty lens). Fall back to the post-normalization findings
            // only when the raw capture is empty.
            let lensesRun = Array.isArray(rawDirtyLenses) ? rawDirtyLenses.filter(Boolean) : [];
            if (lensesRun.length === 0) {
              lensesRun = [...new Set(
                (Array.isArray(reviewResult.findings) ? reviewResult.findings : [])
                  .map((f) => f?.lens).filter(Boolean),
              )];
            }
            if (lensesRun.length > 0) persistPriorDirtyLenses(composeDir, lensesRun);
            // Run the corrective fixer against the review findings before revising —
            // this is what makes the NEXT lens rerun able to come back clean.
            const fixAgent = context.implementerAgent || 'claude';
            progress.fix('build', fixAgent, gateStepId);
            const findings = Array.isArray(reviewResult.findings) ? reviewResult.findings : [];
            const fixPrompt =
              'The code review is not clean. Fix EVERY finding below, then stop.\n'
              + (reviewResult.summary ? `\nSummary: ${reviewResult.summary}\n` : '')
              + findings.map((f) => `- ${f.file ?? '?'}:${f.line ?? '?'} [${f.lens ?? f.severity ?? ''}] ${f.finding ?? f.summary ?? ''}`).join('\n');
            try {
              const gateFixResult = await runAndNormalize(undefined, fixPrompt, { step_id: 'review_fix', agent: fixAgent, flow_id: flowId }, routingCallOptions({
                ...(context.routing ? { routingCalls: callsForRouting(context, routingParentForToken(context, gateAudit.steps?.review_merge?.acceptedDispatchToken), 'review-fixer', { id: gateStepId }) } : {}),
                progress, streamWriter, maxDurationMs: STEP_TIMEOUT_MS.review_merge ?? DEFAULT_TIMEOUT_MS,
                stratum, cwd: agentCwd, sandboxMode: 'workspace-write', profile: resolveStepProfile(effectiveProfiles, 'fix'),
                // S03-4: tag with `gateStepId`, not the literal `review_fix` this dispatch
                // carries as its step_id — the run's real step is the gate, and flow.stepId
                // is audit decoration (the server validates it against nothing).
                ...(flowTag(flowId, gateStepId) ? { flow: flowTag(flowId, gateStepId) } : {}),
                flowId, buildCancel,
                buildSignal: buildCancel.signal,
                telemetry: {
                  site: 'review-repair',
                  project_cwd: cwd,
                  build_id,
                  feature_code: featureCode,
                  step_id: 'review_fix',
                  ...(typeof gateDispatch.attempt === 'number' ? { attempt: gateDispatch.attempt } : {}),
                },
              }));
              if (gateFixResult?.usage && typeof context.recordBuildUsage === 'function') {
                try {
                  await context.recordBuildUsage(usagePayload(gateFixResult.usage, gateFixResult.usages), {
                    stepId: gateStepId,
                    source: 'gate_fixer',
                    dispatchId: gateFixResult.dispatchIds?.primary,
                  });
                } catch (usageError) { if (context.routing && routingIntegrityError(usageError)) throw usageError; }
              }
            } catch (err) {
              if (context.routing && routingIntegrityError(err)) throw err;
              if (buildCancel.cancelled) throw err;
              if (err?.usage && typeof context.recordBuildUsage === 'function') {
                try {
                  await context.recordBuildUsage(usagePayload(err.usage, err.usages), {
                    stepId: gateStepId,
                    source: 'gate_fixer',
                    dispatchId: err.dispatchId,
                  });
                } catch (usageError) { if (context.routing && routingIntegrityError(usageError)) throw usageError; }
              }
              if (!(err instanceof AgentTimeoutError)) throw err;
              console.warn('\n⚠ Review fixer timed out');
            }
            const resolved = await resolveGateWithConsumerMerge('revise', 'review dirty — fixer ran, re-review the dirty lenses', 'system');
            response = resolved.response;
            progress.retry('build', 'review_triage', 'claude');
            streamWriter.write({ type: 'build_gate_resolved', stepId: gateStepId, outcome: resolved.outcome, rationale: resolved.rationale, flowId, policyMode: 'review' });
            stepHistory.push({ stepId: gateStepId, artifact: null, summary: 'Review gate: dirty — fix + revise', outcome: resolved.outcome });
            syncStepHistory(dataDir, stepHistory);
          }
          continue;
        }

        const outputDecision = await evaluateConfiguredGate(context, {
          localSpec, gateStepId: stepId, gateToken, costCeilingUsd: opts.costCeilingUsd,
        });
        if (outputDecision && !outputDecision.outcome && (opts.gateOpts?.nonInteractive ?? !process.stdin.isTTY)) {
          suspended = true;
          const reason = outputDecision.reason;
          writeActiveBuild(dataDir, { ...readActiveBuild(dataDir), status: 'waiting_gate', gateToken, reason });
          streamWriter.pause({ flowId, gateToken, reason });
          console.log(`Build paused at ${stepId}: ${reason}. Resume with a human gate decision.`);
          return { status: 'waiting_gate', flowId, gateToken, reason };
        }

        // ── Policy evaluation (ITEM-23) ────────────────────────────────────
        const policy = outputDecision
          ? { mode: outputDecision.outcome ? 'skip' : 'gate', reason: outputDecision.rationale ?? outputDecision.reason }
          : evaluatePolicy(policySettings, stepId, {
          fromPhase: synthFromPhase,
          // Gate policy is keyed by the gate step id (evaluatePolicy falls back
          // to stepId when toPhase is absent); the synthesized approval target
          // must not hijack the lookup.
        });

        if (policy.mode === 'skip') {
          // Silent pass-through — no gate record, no UI
          const resolved = await resolveGateWithConsumerMerge(outputDecision?.outcome ?? 'approve', policy.reason, 'system');
          response = resolved.response;
          streamWriter.write({
            type: 'build_gate_resolved',
            stepId, outcome: resolved.outcome, rationale: resolved.rationale, flowId, policyMode: outputDecision ? 'output' : 'skip',
          });
          // COMP-PLAN-SECTIONS T6: emit sections after plan_gate auto-approve
          if (resolved.outcome === 'approve') {
            maybeEmitSectionsAfterPlanGate(stepId, featureDir, { streamWriter, featureCode });
          }
          if (outputDecision?.outcome) await reportWaveEvidence(context, 'gate_decision', gateToken,
            { ...outputDecision, outcome: resolved.outcome, rationale: resolved.rationale }, 'accepted');
          stepHistory.push({ stepId, artifact: null, summary: `Gate ${outputDecision ? 'output' : 'skip'}: ${resolved.rationale}`, outcome: resolved.outcome });
          syncStepHistory(dataDir, stepHistory);

        } else if (policy.mode === 'flag') {
          // Auto-approve — no gate record, stream event for audit
          console.log(`  Gate auto-approved (policy: flag) — ${policy.reason}`);
          const resolved = await resolveGateWithConsumerMerge('approve', policy.reason, 'system');
          response = resolved.response;
          streamWriter.write({
            type: 'build_gate_resolved',
            stepId, outcome: resolved.outcome, rationale: resolved.rationale, flowId, policyMode: 'flag',
          });
          // COMP-PLAN-SECTIONS T6: emit sections after plan_gate auto-approve
          if (resolved.outcome === 'approve') {
            maybeEmitSectionsAfterPlanGate(stepId, featureDir, { streamWriter, featureCode });
          }
          stepHistory.push({ stepId, artifact: null, summary: `Gate flag: ${resolved.rationale}`, outcome: resolved.outcome });
          syncStepHistory(dataDir, stepHistory);

        } else {
          // mode === 'gate' — human approval required (existing behavior)
          streamWriter.write({
            type: 'build_gate',
            stepId, flowId,
            gateType: 'approval',
            policyMode: 'gate',
          });

          progress.pause();
          console.log(`\nGate: ${stepId}`);

          const askAgent = makeAskAgent(stratum, context, gateDispatch, gateExtras);
          const serverUp = await probeServer();
          let outcome, rationale;
          let gateId = null;

          // COMP-PLAN-GATE-LOOP: thread Stratum's current round into the gate id
          // so a `revise` re-entry mints a fresh `<flowId>:<stepId>:<round>` gate
          // (pending) instead of colliding with the prior resolved gate and
          // replaying its stale outcome. Stratum tracks the round in the flow
          // state but omits it from the running response, so read it from the
          // persisted TS flow state.
          const round = readFlowRound(flowId);

          if (serverUp) {
            gateId = await visionWriter.createGate(flowId, stepId, itemId, { ...gateExtras, policyMode: 'gate', round });
            console.log('Gate delegated to web UI. Waiting for resolution...');
            let resolved;
            try {
              resolved = await pollGateResolution(visionWriter, gateId, 2000, buildCancel.signal);
            } catch (error) {
              await confirmCancellation(error, { stratum, flowId, buildCancel });
              throw error;
            }
            if (resolved) {
              outcome = resolved.outcome;
              rationale = resolved.comment ?? '';
            } else {
              const result = await promptGate(gateDispatch, {
                ...(opts.gateOpts ?? {}),
                signal: buildCancel.signal,
                artifact: context.cwd,
                askAgent,
                gateExtras,
              });
              outcome = result.outcome;
              rationale = result.rationale;
            }
          } else {
            gateId = await visionWriter.createGate(flowId, stepId, itemId, { ...gateExtras, policyMode: 'gate', round });
            const result = await promptGate(gateDispatch, {
              ...(opts.gateOpts ?? {}),
              signal: buildCancel.signal,
              artifact: context.cwd,
              askAgent,
              gateExtras,
            });
            outcome = result.outcome;
            rationale = result.rationale;
          }

          if (outputDecision) await reportWaveEvidence(context, 'gate_human', gateToken, { outcome, rationale, hold: outputDecision }, 'proposed');
          const resolved = await resolveGateWithConsumerMerge(outcome, rationale, 'human');
          if (outputDecision) await reportWaveEvidence(context, 'gate_human', gateToken,
            { outcome: resolved.outcome, rationale: resolved.rationale, hold: outputDecision }, 'accepted');
          response = resolved.response;
          outcome = resolved.outcome;
          rationale = resolved.rationale;
          if (gateId) {
            try { await visionWriter.resolveGate(gateId, outcome); } catch { /* web outcome may already be recorded */ }
            try { await visionWriter._restResolveGate(gateId, outcome); } catch { /* ignore */ }
          }
          // COMP-CTX item 102: persist the FINAL engine decision. Consumer merge
          // failures may downgrade a requested approve to revise/kill.
          appendDecisionEntry(contextDirPath, featureCode, stepId, outcome, rationale);
          clearAmbientContextCache(contextDirPath);
          stepHistory.push({
            stepId,
            artifact: null,
            summary: `Gate ${outcome}${rationale ? ': ' + rationale : ''}`,
            outcome,
          });
          syncStepHistory(dataDir, stepHistory);
          // COMP-PLAN-SECTIONS T6: emit sections after plan_gate human approve
          if (outcome === 'approve') {
            maybeEmitSectionsAfterPlanGate(stepId, featureDir, { streamWriter, featureCode });
          }
          progress.resume();

          // COMP-UX-3c: concise gate resolution narration
          if (outcome === 'approve') {
            const nextPhase = response.ready?.[0]?.id ?? 'next phase';
            console.log(`  Approved -> moving to ${nextPhase}`);
          } else if (outcome === 'revise') {
            console.log(`  Revising ${stepId}${rationale ? ': ' + rationale : ''}`);
          } else if (outcome === 'kill') {
            console.log(`  Killed ${stepId}`);
          }

          streamWriter.write({
            type: 'build_gate_resolved',
            stepId, outcome, rationale: rationale ?? '', flowId, policyMode: 'gate',
          });
        }

      } else {
        // TS running is a known non-dispatch state; terminal TS statuses exit
        // through the loop condition above.
        if (!['running', 'completed', 'failed', 'budget_exhausted'].includes(response.status)) {
          console.warn(`Unknown dispatch status: ${response.status}`);
        }
        break;
      }
    }
    } catch (error) {
      await drainConsumersThenRethrow(error);
    }

    if (consumerArtifacts && isTerminalFlow(response.status)) {
      consumerArtifacts.cleanupWorktrees('run terminalized');
    }

    if (response.status === 'cancelled') buildCancel.cancel('flow_cancelled');

    // Flow complete — write terminal state (file retained per STRAT-COMP-4 contract).
    // COMP-COMPLETION-GATE slice 2: set when the flow completed and the feature is
    // eligible to be completed — the actual completion runs after the health gate.
    let pendingCompletion = null;
    if (!buildCancel.cancelled && response.status === 'completed') buildStatus = 'complete';
    if (!buildCancel.cancelled && (response.status === 'failed' || response.status === 'budget_exhausted') && !killedByGate) {
      buildStatus = 'failed';
      terminalFailureReason = response.failure?.reason ?? null;
    }
    if (buildCancel.teardown) {
      // A successful final stepDone can race SIGINT. The teardown still owns
      // terminal state; retain aborted for history, stream closure and actuals.
      buildStatus = 'aborted';
    } else if (buildCancel.cancelled) {
      buildStatus = 'aborted';
      terminalFailureReason = buildCancel.reason;
      await terminalizeCancelledBuild({ dataDir, buildIdentity, visionWriter, itemId, failureReason: buildCancel.reason });
    } else if (response.status === 'completed' && buildStatus === 'complete') {
      console.log('\nBuild complete.');
      // COMP-COMPLETION-GATE slice 2: the COMPLETION does not happen here.
      //
      // This block used to flip the vision item and feature.json to COMPLETE
      // immediately — but the health gate below can still downgrade the build to
      // `failed`, and the guard ledger is append-only. Completing here meant a
      // health-rejected build was left marked COMPLETE, and (once gated) the very
      // first thing the ledger would ever durably attest would be a build the
      // system itself then judged a failure.
      //
      // The health verdict is a PRECONDITION of completion, not its successor, so
      // the completion is deferred to the gated block below, which runs after the
      // health gate. See COMP-COMPLETION-GATE design §2.3c.
      pendingCompletion = { itemId, featureCode };
      const termState = readActiveBuild(dataDir);
      if (termState) {
        writeActiveBuild(dataDir, { ...termState, status: 'complete', completedAt: new Date().toISOString() });
      }
      clearPriorDirtyLenses(composeDir); // STRAT-REV-5: clear the dirty-lenses sidecar on a clean build
    } else if (killedByGate) {
      buildStatus = 'killed';
      console.log('\nBuild killed.');
      await visionWriter.updateItemStatus(itemId, 'killed');
      if (cfg.tracksFeatureJson) {
        const _bp = await getBuildProvider(cwd);
        const _feat = await _bp.getFeature(featureCode);
        if (_feat) {
          // Raw write back to PLANNED — no transition policy, no events, no renderRoadmap.
          // Matches original updateFeature semantics; keeps teardown side-effect-free.
          await _bp.persistFeatureRaw(featureCode, { ..._feat, status: 'PLANNED' });
        }
      }
      const termState = readActiveBuild(dataDir);
      if (termState) {
        writeActiveBuild(dataDir, { ...termState, status: 'aborted', completedAt: new Date().toISOString() });
      }
    } else if (buildStatus === 'failed') {
      // Ship failure or other explicit failure — write terminal state
      console.log('\nBuild failed.');
      await writeFailedBuildTerminalState({
        cwd,
        dataDir,
        cfg,
        visionWriter,
        itemId,
        featureCode,
        flowId: response?.runId ?? null,
        failureReason: buildFailureReason({ buildStatus, stepHistory, fallback: terminalFailureReason }),
      });
      // COMP-FIX-HARD T2: a bug-mode {test,fix,diagnose} step that exhausted its
      // attempts writes a resumable docs/bugs/<code>/checkpoint.md + refreshes the
      // bug index. The exhausted step is the last step the engine issued as ready
      // (I4 — passed directly, not inferred from a history outcome the step's
      // contract never sets). No-op in feature mode / for non-checkpoint steps.
      await emitBugCheckpointOnTerminalFailure(context, lastReadyStepId, stepHistory);
    } else {
      buildStatus = 'failed';
    }

    // COMP-HEALTH: finalize signals and compute composite health score
    // COMP-MOBILE-1-1: when the gate downgrades the build, the reason is kept
    // for the history record — health-gate failures have no failed step, so
    // the lastFailedStep-derived failureReason would otherwise be generic.
    let healthDowngradeReason = null;
    if (streamWriter && !buildCancel.teardown && !buildCancel.cancelled) {
      const checkHealthOwnership = () => {
        if (buildCancel.teardown || buildCancel.cancelled) throw buildCancel.signal.reason;
      };
      try {
        // Runtime errors signal — accumulated across all steps
        checkHealthOwnership();
        if (allViolations.length > 0) {
          buildSignals.runtime_errors = allViolations;
        } else if (!buildSignals.runtime_errors) {
          buildSignals.runtime_errors = [];
        }

        // Doc freshness — derivation-based staleness (COMP-PROV-LINEAGE). An
        // artifact is stale when an upstream it wasDerivedFrom is newer than it.
        // This replaced the old phase-marker staleness reader (now removed),
        // which read a `<!-- phase: -->` marker that no production writer ever
        // emitted (a dead signal). findStaleArtifacts works off the canonical
        // chain + mtimes, so it needs no marker to be written first.
        try {
          const { findStaleArtifacts } = await import('./lineage.js');
          checkHealthOwnership();
          buildSignals.doc_freshness = findStaleArtifacts(resolveItemDir(featureCode));
        } catch { /* staleness check is optional — skip on error */ }

        // COMP-PROV-LINEAGE — populate PROV-O lineage markers on the canonical
        // artifacts that now exist. This runs once per build, in the finalization
        // pass after the dispatch loop, when the artifact set is complete. Build
        // is the single writer here, so the read/write/utimes in stampFeatureLineage
        // is uncontended. Idempotent and mtime-preserving, so it never resets the
        // derivation clock that staleness reachability depends on. This is the
        // lifecycle-writer surface that materialises wasGeneratedBy/wasDerivedFrom.
        try {
          const { stampFeatureLineage } = await import('./lineage.js');
          checkHealthOwnership();
          stampFeatureLineage(resolveItemDir(featureCode));
        } catch { /* lineage stamping is optional — skip on error */ }

        const healthSettings = (() => {
          try {
            if (existsSync(settingsPath)) {
              const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
              return s?.health ?? {};
            }
          } catch { /* degraded */ }
          return {};
        })();

        const { score, breakdown, missing } = computeCompositeScore(
          buildSignals,
          healthSettings.weights ?? {}
        );

        // Emit to build stream
        checkHealthOwnership();
        streamWriter.writeHealthScore(score, breakdown, missing);

        // Persist to history
        try {
          checkHealthOwnership();
          recordScore(cwd, { featureCode, phase: buildStatus, score, breakdown });
        } catch (err) {
          console.warn(`[health] Failed to persist score: ${err.message}`);
        }

        // COMP-HEALTH item 119: gate threshold check (policy integration)
        // If health score is below the configured threshold, mark the build as failed
        // so downstream consumers (vision item status, exit code) reflect the rejection.
        const threshold = healthSettings.gate_threshold;
        checkHealthOwnership();
        if (typeof threshold === 'number' && score < threshold) {
          streamWriter.write({
            type: 'gate_health_rejection',
            featureCode,
            score,
            threshold,
            reason: `Health score ${score} below threshold ${threshold}`,
          });
          console.warn(`  [health] Build health score ${score} is below gate threshold ${threshold} — marking build as failed`);
          // Enforce: downgrade build status so the build is reported as failed
          checkHealthOwnership();
          buildStatus = 'failed';
          // COMP-MOBILE-1-1: re-persist the downgrade to active-build.json so the
          // file watcher re-broadcasts buildState over /ws/vision. Without this,
          // the terminal write above already said 'complete' and clients never
          // learn the build actually failed (mobile compensated via history).
          // Identity-guarded: no-ops if a concurrent build replaced the file.
          checkHealthOwnership();
          const downgraded = persistHealthGateDowngrade(dataDir, {
            score,
            threshold,
            flowId: response?.runId ?? null,
            featureCode,
          });
          healthDowngradeReason = downgraded?.failureReason
            ?? `Health score ${score} below threshold ${threshold}`;
        }

        console.log(`  Health score: ${score}/100 (${Object.keys(breakdown).length} dimensions scored)`);
      } catch (err) {
        // Non-fatal — health scoring never blocks the build
        if (!buildCancel.teardown && !buildCancel.cancelled) console.warn(`[health] Score computation failed: ${err.message}`);
      }
    }

    // ---------------------------------------------------------------------
    // COMP-COMPLETION-GATE slice 2 — THE completion, and the only one.
    //
    // Runs here, after the health gate above may have downgraded buildStatus, so
    // a health-rejected build completes nothing: no completion record, no
    // COMPLETE status, no vision completion, no guard transition.
    // ---------------------------------------------------------------------
    if (pendingCompletion && !buildCancel.teardown && !buildCancel.cancelled && buildStatus === 'complete') {
      const ev = context.completionEvidence || {};
      const acc = readBuildAccumulator(cwd, featureCode);
      // Persisted, because it survives a resume; the in-memory value wins when
      // this process ran the ship step itself.
      const testsAttested = ev.testsAttested ?? acc?.tests_attested ?? 'no-signal';
      const evidenceRoot = acc?.evidence_root || agentCwd;

      // The SHA is resolved here rather than carried: at terminalization HEAD is
      // the commit the build produced (or, on the already-committed path, found),
      // and resolving it at the point of use keeps it verifiable instead of a
      // stale claim threaded across a resume boundary.
      let commitSha = ev.commitSha ?? null;
      if (!commitSha) {
        try {
          commitSha = execSync('git rev-parse HEAD', {
            cwd: evidenceRoot, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
          }).trim() || null;
        } catch { /* no repo — the no-repo exemption applies below */ }
      }

      if (cfg.tracksFeatureJson) {
        const { completionGate, guardEnabled } = await import('./completion-gate.js');
        // `capabilities.guard: false` is a deliberate opt-OUT, and the gate itself
        // honors it (completion-gate.js §"Evidence, BEFORE the lock" / AC-5). This
        // refusal has to sit INSIDE the same regime: enforcing attestation on an
        // opted-out project would break every one of them — including non-git
        // workspaces, where the evidence can never pass at all — which is exactly
        // the reversal already made once during slice 1. An opted-out project keeps
        // `deriveTestsPass`'s degrade contract: 'no-signal' reads as true there.
        const guarded = guardEnabled(cwd);

        // `no-signal` is not an attestation. Refusing here is the whole point of
        // the tri-state: an unreadable test run must not become a passing claim
        // on a permanent record.
        if (guarded && testsAttested === 'no-signal') {
          console.warn(
            `[completion-gate] ${featureCode}: tests could not be attested (test output was ` +
            `unreadable). Configure guard.testCommand in .compose/compose.json so the test run ` +
            `itself attests, or record the completion explicitly. Build is complete; the feature ` +
            `is NOT marked COMPLETE.`,
          );
        } else {
          const gated = await completionGate({
            featureCode,
            commitSha,
            testsPass: guarded ? testsAttested === 'passed' : testsAttested !== 'failed',
            filesChanged: ev.filesChanged ?? context.filesChanged ?? [],
            notes: ev.notes,
            builtVia: ev.builtVia,
            workspaceRoot: cwd,
            evidenceRoot,
            mode: resolveMode(mode),
            // Slice 3: the gate owns the vision projection (§2.3a step 4) through
            // the self-verifying seam; `updateItemStatus(…, 'complete')` refuses
            // managed build items now (AC-16).
            visionItemId: pendingCompletion.itemId,
            visionProjector: ({ featureCode: fc, commitSha: sha, ledgerRef }) =>
              visionWriter.completeItem(pendingCompletion.itemId, { featureCode: fc, cwd, commitSha: sha, ledgerRef }),
          });
          if (gated.ok) {
            if (gated.partial) {
              console.warn(
                `[completion-gate] ${featureCode}: completed, but a projection failed — ` +
                gated.failures.map(f => `${f.step}: ${f.message} (recover: ${f.recover})`).join('; '),
              );
            }
          } else {
            // Do NOT fail the build: the work is committed and the flow finished.
            // But do not claim completion either — say plainly what was refused.
            console.warn(
              `[completion-gate] ${featureCode}: completion refused at ${gated.refusedAt} — ` +
              `${(gated.reasons || []).join('; ')}. The build finished and the commit stands; ` +
              `the feature is NOT marked COMPLETE.`,
            );
          }
        }
      } else {
        // Bug/plan modes have no feature.json to gate on (COMP-FIX-HARD T4), and
        // slice 1/2 are scoped to build mode — their completion path is unchanged.
        await visionWriter.updateItemStatus(pendingCompletion.itemId, 'complete');
      }
    }

    // COMP-COCKPIT-3: archive the run to build-history.jsonl ONCE, here — after
    // the COMP-HEALTH gate above may have downgraded buildStatus to 'failed'.
    // Assembled from the in-memory build context for THIS run (never re-read
    // active-build.json, which is last-writer-wins across concurrent builds).
    if (buildCancel.teardown || buildCancel.cancelled) {
      buildStatus = 'aborted';
      terminalFailureReason = buildCancel.reason;
    }
    if (['complete', 'aborted', 'failed', 'killed'].includes(buildStatus)) {
      const failureReason = buildFailureReason({
        buildStatus,
        stepHistory,
        healthDowngradeReason,
        fallback: terminalFailureReason,
      });
      appendBuildHistory(dataDir, {
        featureCode,
        flowId: response?.runId ?? null,
        mode,
        status: buildStatus,
        startedAt: buildStartedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(buildStartedAt).getTime(),
        ...buildCostSnapshot(),
        stepCount: stepHistory.length,
        failureReason,
        itemId,
        // COMP-MOBILE-1-1: compact per-step results so history consumers can
        // render which-step-failed without the live active-build state.
        steps: projectHistorySteps(stepHistory),
        // COMP-MODEL-AB: structured test counts from ship step — present only when
        // the build ran tests and the framework output was parseable.
        ...(shipStepTestData !== null ? shipStepTestData : {}),
      });
      terminalHistoryWritten.value = true;
    }

    // COMP-OBS-GATES: emit gate_tier_summary and persist savings on build completion
    if (streamWriter && Object.keys(tierResults).length > 0) {
      const tierSummary = evaluateTiers(tierResults);
      streamWriter.write({
        type: 'gate_tier_summary',
        featureCode,
        passed: tierSummary.passed,
        tierThatFailed: tierSummary.tierThatFailed,
        tiersRun: tierSummary.tiersRun,
        tiersSkipped: tierSummary.tiersSkipped,
        costSaved: tierSummary.costSaved,
      });

      // Persist savings entry to .compose/data/gate-savings.json
      if (tierSummary.tiersSkipped.length > 0 && tierSummary.costSaved > 0) {
        try {
          const savingsPath = join(dataDir, 'gate-savings.json');
          let savingsData = { entries: [] };
          if (existsSync(savingsPath)) {
            try { savingsData = JSON.parse(readFileSync(savingsPath, 'utf-8')); } catch { /* corrupt — start fresh */ }
          }
          if (!Array.isArray(savingsData.entries)) savingsData.entries = [];
          savingsData.entries.push({
            featureCode,
            date: new Date().toISOString(),
            cost_saved: Math.round(tierSummary.costSaved * 10000) / 10000,
            tiers_skipped: tierSummary.tiersSkipped,
          });
          mkdirSync(dataDir, { recursive: true });
          writeFileSync(savingsPath, JSON.stringify(savingsData, null, 2));
        } catch (err) {
          console.warn(`[gate-tiers] Failed to persist savings: ${err.message}`);
        }
      }
    }

    // Write audit trace from the completion/killed envelope.
    // Stratum deletes persisted flows on completion, so stratum_audit()
    // would return flow_not_found. The completion envelope already includes
    // { trace, total_duration_ms, output, flow_id }.
    if (response.trace) {
      try {
        mkdirSync(featureDir, { recursive: true });
        writeFileSync(
          join(featureDir, 'audit.json'),
          JSON.stringify(response, null, 2)
        );
        console.log(`Audit trace written to ${cfg.artifactRoot === 'features' ? 'docs/features' : cfg.artifactRoot}/${featureCode}/audit.json`);
      } catch (err) {
        console.warn(`Warning: could not write audit trace: ${err.message}`);
      }
    } else {
      // Fallback: try stratum_audit (works for killed flows that may still be persisted)
      try {
        const audit = await stratum.audit(response.runId);
        mkdirSync(featureDir, { recursive: true });
        writeFileSync(
          join(featureDir, 'audit.json'),
          JSON.stringify(audit, null, 2)
        );
        console.log(`Audit trace written to ${cfg.artifactRoot === 'features' ? 'docs/features' : cfg.artifactRoot}/${featureCode}/audit.json`);
      } catch (err) {
        console.warn(`Warning: could not write audit trace: ${err.message}`);
      }
    }

    // File retained on disk per STRAT-COMP-4 — overwritten on next build start

  } catch (err) {
    routingPrimaryError = err;
    // COMP-BUILD-CANCEL §3.6: a pending teardown is the single terminal owner. Stand down —
    // do NOT terminalize (two writers, one record) and do NOT await it (the teardown is
    // waiting on `drained`, which this rethrow is what releases).
    if (buildCancel.teardown) {
      buildStatus = 'aborted';
      throw err;
    }
    buildStatus = buildCancel.cancelled ? 'aborted' : 'failed';
    const failureReason = buildCancel.cancelled ? buildCancel.reason : (err?.message ?? 'Build failed');
    try {
      await terminalizeThrownBuild({
        buildCancel, buildIdentity,
        cwd,
        dataDir,
        cfg,
        visionWriter,
        itemId,
        featureCode,
        mode,
        response,
        buildStartedAt,
        buildCostSnapshot,
        stepHistory,
        failureReason,
        historyWritten: terminalHistoryWritten,
      });
    } catch (terminalErr) {
      console.warn(`[build] Failed to terminalize crashed build: ${terminalErr.message}`);
    }
    throw err;
  } finally {
    let actualsError = null;
    try { await recoverRoutingEvidence(routingRuntimeContext, { deliver: !buildCancel.cancelled }); } catch (error) { actualsError = error; }
    try {
      finalizeBuildAttempt();
    } catch (error) {
      actualsError ??= error;
      attemptFinalized = true;
    }
    // Close stream writer with appropriate status (idempotent — signal handler may have already closed)
    if (streamWriter) {
      if (suspended && !buildCancel.cancelled) streamWriter.pause();
      else streamWriter.close(buildStatus, buildCostSnapshot());
    }
    // §3.6: the teardown removes the listeners itself, AFTER its writes. Removing them here
    // while it is pending would send a second Ctrl-C to the default handler, killing the
    // process mid-write.
    if (signalHandler && !buildCancel.teardown) {
      process.removeListener('SIGINT', signalHandler.listeners.onSigint);
      process.removeListener('SIGTERM', signalHandler.listeners.onSigterm);
    }
    progress.finish();
    // A pending teardown may still have a `flowCancel` in flight over this client; closing it
    // underneath would abandon the cancel. The teardown exits the process, so the deferred
    // close is a courtesy, not a leak.
    if (buildCancel.teardown) {
      void buildCancel.teardown.then(() => stratum.close()).catch(() => undefined);
    } else {
      await stratum.close();
    }
    runtimeResourcesFinalized = true;
    // §3.6: release the teardown's bounded wait — this build's resources are now closed and
    // finalizeBuildAttempt has emitted its actuals, so the teardown's writes cannot race it.
    buildCancel.resolveDrained();
    if (actualsError && !routingIntegrityError(routingPrimaryError)) throw actualsError;
  }
  } catch (error) {
    routingPrimaryError = error;
    throw error;
  } finally {
    try {
      try { await recoverRoutingEvidence(routingRuntimeContext, { deliver: !buildCancel.cancelled }); } catch (error) { routingFinalizationError = error; }
      finalizeBuildAttempt();
    } finally {
      try {
        if (!runtimeResourcesFinalized) {
          if (streamWriter) {
            if (suspended && !buildCancel.cancelled) streamWriter.pause();
            else streamWriter.close(buildStatus);
          }
          if (signalHandler && !buildCancel.teardown) {
            process.removeListener('SIGINT', signalHandler.listeners.onSigint);
            process.removeListener('SIGTERM', signalHandler.listeners.onSigterm);
          }
          progress?.finish();
          if (stratum && !buildCancel.teardown) await stratum.close();
          runtimeResourcesFinalized = true;
          buildCancel.resolveDrained();
        }
        // §3.6: join the teardown so the CLI cannot exit out from under it. The bound is
        // DERIVED from the teardown's own two deadlines (C46), never chosen.
        if (buildCancel.teardown) {
          await withDeadline(buildCancel.teardown, teardownJoinMs).catch(error => {
            if (routingIntegrityError(error)) routingFinalizationError ??= error;
          });
        }
      } finally {
        // S03-5b: a crashed build must leave no stale handle behind.
        // A join deadline is not settlement. Keep the handle visible to the CLI
        // until teardown finishes, even when this outer finally stops waiting.
        if (buildCancel.teardown) {
          const unregister = () => unregisterBuildCancel(registeredFlowId);
          void buildCancel.teardown.then(unregister, unregister);
        } else {
          unregisterBuildCancel(registeredFlowId);
        }
        // COMP-MCP-MIGRATION-1: restore COMPOSE_BUILD_ID env to its prior value
        // (or unset) so subsequent processes / tests don't inherit a stale UUID.
        _restoreBuildIdEnv();
        attemptStarted = false;
        if (routingFinalizationError && !routingIntegrityError(routingPrimaryError)) throw routingFinalizationError;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * COMP-PLAN-SECTIONS T6 — emit per-task section files after a plan_gate approve.
 *
 * Called from each of the three plan_gate approve branches (skip / flag / human).
 * No-op for any other gate. No-op if the plan is below the threshold (the
 * underlying emitSections handles that). On success, emits a build_sections_emitted
 * stream event with the created/skipped lists.
 *
 * @param {string} stepId — the gate stepId (must be 'plan_gate' to fire)
 * @param {string} featureDir — absolute feature directory
 * @param {object} opts
 * @param {object} [opts.streamWriter] — build stream writer
 * @param {string} [opts.featureCode] — feature code, included in event
 * @returns {{ created: string[], skipped: string[] }}
 */
export function maybeEmitSectionsAfterPlanGate(stepId, featureDir, opts = {}) {
  const empty = { created: [], skipped: [] };
  if (stepId !== 'plan_gate' || !featureDir) return empty;
  let result = empty;
  try {
    result = emitPlanSections(featureDir);
  } catch (err) {
    // Section emission must never break the build.
    if (opts.streamWriter) {
      try { opts.streamWriter.write({ type: 'build_error', message: `sections emit failed: ${err.message}`, stepId }); } catch { /* ignore */ }
    }
    return empty;
  }
  if (result.created.length > 0 && opts.streamWriter) {
    try {
      opts.streamWriter.write({
        type: 'build_sections_emitted',
        featureCode: opts.featureCode ?? null,
        created: result.created,
        skipped: result.skipped,
      });
    } catch { /* ignore */ }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Ship step — runs git commit in-process (not via agent)
// ---------------------------------------------------------------------------

/**
 * The git repository toplevel that contains `dir`, or null if `dir` is not
 * inside any git work tree. Used so ship decides commit ownership per-file by
 * containing repo, not by assuming the workspace root == the repo
 * (COMP-PATHS-EXTERNAL D6a).
 */
function gitToplevel(dir) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: dir, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}

/**
 * For each owned artifact (ROADMAP, the feature folder) that resolves into a
 * git repo OTHER than the build's repo, log a one-line "commit it there"
 * notice. v1 does not auto-commit other repos (that is COMP-PATHS-EXTERNAL-1).
 * Artifacts in the build's own repo, or in no repo at all, produce no notice.
 */
function noticeExternalArtifacts(cwd, featureCode, buildToplevel) {
  try {
    const candidates = [
      ['ROADMAP.md', resolveRoadmapPath(cwd)],
      ['feature folder', join(resolveFeaturesPath(cwd), featureCode)],
    ];
    for (const [label, abs] of candidates) {
      if (!existsSync(abs)) continue;
      const top = gitToplevel(dirname(abs));
      if (top && top !== buildToplevel) {
        // eslint-disable-next-line no-console
        console.warn(`[build/ship] 📝 wrote ${label} in ${top} — commit it there (Compose does not auto-commit other repos in v1)`);
      }
    }
  } catch { /* notice is best-effort */ }
}

/**
 * Extract structured test counts from a ship step result for build-history persistence.
 * Exported so tests can assert the capture logic without running a full build loop.
 *
 * Called in BOTH the ship-interception branch (shouldInterceptShip path) and the
 * generic step-completion path so both code paths produce the same history record.
 *
 * Returns null when testSummary was unparsed (test_count absent or not a number).
 * The `?? 0` on pass_rate is defensive — parseTestSummary always sets it when
 * parsed=true, but this prevents a null from silently reaching the history record.
 *
 * @param {object|null} shipResult  Return value from executeShipStep
 * @returns {{ test_count: number, pass_rate: number }|null}
 */
export function _extractShipTestMetrics(shipResult) {
  if (typeof shipResult?.test_count !== 'number') return null;
  return { test_count: shipResult.test_count, pass_rate: shipResult.pass_rate ?? 0 };
}

/** The guarded namespace — must equal the verifier's and the hook's (R2). */
const JUDGMENT_TREE = 'docs/judgment';

/**
 * Run a git command and return its non-empty output lines.
 *
 * Deliberately does NOT swallow failures: this feeds the pre-commit judgment
 * gate, where an unreadable git state must fail CLOSED. The caller's catch turns
 * a throw into "verification errored; refusing to commit".
 */
function gitLines(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 5000 })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function judgmentCanonDriftError({ treeDrift, projectionDrift, recordDrift }) {
  const tiers = [
    ['Tree drift', treeDrift],
    ['Projection drift', projectionDrift],
    // R1: records are covered by drift detection, not claimed as enforced.
    ['Record drift detection', recordDrift],
  ];
  const sections = tiers
    .filter(([, drift]) => drift.length > 0)
    .map(([label, drift]) => {
      const paths = drift.map((item) => {
        if (typeof item === 'string') return `  - ${item}`;
        return `  - ${item.path} [${item.kind}]`;
      });
      return `${label}:\n${paths.join('\n')}`;
    });
  const err = new Error(
    `Judgment canon drift detected; refusing to commit.\n${sections.join('\n')}`,
  );
  err.code = 'JUDGMENT_CANON_DRIFT';
  err.treeDrift = treeDrift;
  err.projectionDrift = projectionDrift;
  err.recordDrift = recordDrift;
  return err;
}

/**
 * Narrow an executeShipStep return value to the fields the TS engine's
 * PhaseResult contract declares.
 *
 * COMP-SHIP-CONTRACT: engine contracts are STRICT Zod objects — any key the
 * contract does not declare fails the step. executeShipStep's return carries
 * caller-facing extras (`commit`, `filesChanged`, `testsAttested`,
 * `test_count`/`pass_rate`, `error_code`) that Compose's own code consumes but
 * PhaseResult never declared, so the raw object must NEVER be handed to
 * stepDone as an `output`. Both sites that do so (runBuild, runGsd) go through
 * here. Note runBuild's non-`ready` branch passes shipResult as the whole
 * envelope rather than as `{output}` — a legacy shape that never reaches
 * contract validation, deliberately left untouched.
 *
 * @param {object} shipResult  Return value from executeShipStep
 * @returns {object}           `{phase, artifact, outcome, summary}` plus
 *                             `files_changed`/`commit_hash` when present
 */
export function toPhaseResultOutput(shipResult) {
  return {
    phase: shipResult.phase,
    artifact: shipResult.artifact,
    outcome: shipResult.outcome,
    summary: shipResult.summary,
    ...(Array.isArray(shipResult.filesChanged) ? { files_changed: shipResult.filesChanged } : {}),
    ...(typeof shipResult.commit === 'string' ? { commit_hash: shipResult.commit } : {}),
  };
}

/**
 * Execute the ship step: run tests, stage feature files, commit.
 * Returns a PhaseResult-shaped object.
 */
export async function executeShipStep(featureCode, agentCwd, cwd, context, description, progress) {
  const waveShipTree = prepareWaveShip(context);
  if (waveShipTree?.replay) {
    const { dispatchId, receipt } = waveShipTree.replay;
    const { result, completionEvidence } = receipt.detail;
    if (!result || result.outcome !== 'complete' || result.commit !== receipt.detail.commit) {
      throw new WaveCheckpointError('WAVE_CHECKPOINT_EVIDENCE_MISSING', 'Recorded ship result is unavailable');
    }
    await flushWaveReceipts(context, [dispatchId]);
    context.recordFilesChanged?.(result.filesChanged, { authoritativeShip: true });
    context.recordCompletionEvidence?.(completionEvidence);
    return structuredClone(result);
  }
  // COMP-FIX-HARD T4: bug mode stages docs/bugs/<code>/ instead of <featuresDir>/<code>/
  // COMP-MCP-MIGRATION-2: feature mode honors paths.features override.
  const featuresDir = loadFeaturesDir(cwd);
  // RELATIVE staging dir, driven by the mode's artifactRoot (the relative form is
  // load-bearing for the MCP-enforcement git-status guard). Byte-identical to the
  // prior feature/bug branch: 'features' → <featuresDir>, else the literal token.
  const shipCfg = getMode(context?.mode).runner;
  const featureDir = shipCfg.artifactRoot === 'features'
    ? `${featuresDir}/${featureCode}`
    : `${shipCfg.artifactRoot}/${featureCode}`;

  // COMP-BUILD-QUICK-1: when a feature was built via the trimmed quick lifecycle
  // (which omits the report phase by design), stamp built_via onto feature.json so
  // the validator exempts it from MISSING_COMPLETION_REPORT. Null for normal builds.
  const builtVia = context?.templateName === 'build-quick' ? 'build-quick' : null;

  try {
    // 0. Run tests FIRST — before the git-availability branch.
    //
    // COMP-COMPLETION-GATE slice 2: this used to live below, after the non-git
    // branch had already returned. That meant a non-git build never ran tests at
    // all and hard-coded `tests_pass: true` on its completion record. With the
    // gate refusing an unattested completion, every non-git build would have been
    // refused — and "no repo" is a reason to skip the COMMIT, never a reason to
    // skip the tests. Both paths now attest identically.
    if (progress) progress.toolUse('ship', 'Running tests...');
    let testSummary = { test_count: 0, pass_rate: 0, parsed: false };
    try {
      // COMP-TEST-BOOTSTRAP item 128: use the detected test command, not a hard-coded `npm test`.
      const testFramework = detectTestFramework(agentCwd);
      const testCommand = testFramework?.command ?? 'npm test';
      const testOutput = execSync(`${testCommand} 2>&1 || true`, { cwd: agentCwd, encoding: 'utf-8', timeout: 120_000 });
      testSummary = parseTestSummary(testFramework?.framework, testOutput);
    } catch { /* test runner unavailable or timed out — testSummary stays unparsed */ }
    const testsPass = deriveTestsPass(testSummary);
    // The gate's input: 'passed' | 'failed' | 'no-signal'. Unlike testsPass, an
    // unreadable run does NOT become an attestation here.
    const testsAttested = deriveTestsAttested(testSummary);
    if (progress && testSummary.parsed) {
      progress.toolUse('ship', `Tests: ${testSummary.test_count} run, ${testSummary.pass_rate}% passing`);
    }
    // Hand the evidence to terminalization, which is where completion now happens
    // (after the health gate). The ship step no longer completes anything itself.
    context.recordCompletionEvidence?.({ testsAttested, testSummary });

    // 1. Check if we're in a git repository — if not, skip git operations
    let isGitRepo = false;
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd: agentCwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
      isGitRepo = true;
    } catch { /* not a git repo */ }

    if (!isGitRepo) {
      // COMP-PATHS-EXTERNAL D6b: there is no repo to commit into (e.g. a
      // forge-top-shaped workspace). The lifecycle still advances, but the
      // completion is now written at terminalization by the completion gate,
      // AFTER the health verdict — not here. See COMP-COMPLETION-GATE §2.3c.
      return {
        phase: 'ship',
        artifact: 'no-git',
        outcome: 'complete',
        summary: 'No git repository — wrote artifacts (commit skipped)',
        commit: null,
        noRepo: true,
        testsAttested,
      };
    }


    // COMP-TRIAGE-5 (E3 Expand): if a lane-triaged feature fails its ship-time
    // test gate, escalate the lane so the NEXT build runs wider. Best-effort —
    // never blocks ship. Re-entry happens on re-invocation (which reads the
    // escalated lane from the cache-read path), not via inline runBuild surgery.
    if (!testsPass && testSummary.parsed) {
      try {
        const _escProvider = await getBuildProvider(cwd);
        // featureDir is intentionally RELATIVE for the git-status staging guard;
        // resolve it against the build's configured root so the checkpoint lands in
        // the real feature dir even when opts.cwd differs from process.cwd().
        const _esc = await maybeEscalateLane({ featureCode, provider: _escProvider, featureDir: resolve(cwd, featureDir) });
        if (_esc.action === 'escalate') {
          context.recordEscalation?.();
          console.warn(`[triage] Test gate failed on lane '${_esc.from}' — escalated to '${_esc.to}'. Re-run to execute the heavier phases.`);
        } else if (_esc.action === 'stop') {
          console.warn(`[triage] Test gate failed and escalation bound reached (lane '${_esc.lane}') — see escalation-checkpoint.md; human review needed.`);
        }
      } catch (err) {
        console.warn(`[triage] escalation observer failed (non-fatal): ${err.message}`);
      }
    }

    // 2. Collect files to stage
    const filesToStage = new Set();

    // Feature docs
    filesToStage.add(featureDir);

    // Files changed during this build (tracked by context)
    if (context.filesChanged?.length > 0) {
      for (const f of context.filesChanged) filesToStage.add(f);
    }

    // Also catch any unstaged changes via git, plus already-staged files
    // (so MCP enforcement can scan files that an agent staged via `git add`
    // before reaching ship — COMP-MCP-MIGRATION-1).
    try {
      const dirty = execSync(
        'git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; git diff --cached --name-only 2>/dev/null',
        { cwd: agentCwd, encoding: 'utf-8', timeout: 5000 }
      ).trim();
      if (dirty) {
        for (const f of dirty.split('\n').filter(Boolean)) filesToStage.add(f);
      }
    } catch { /* no git or no changes */ }

    // Filter to only files that belong to this feature (feature docs, CHANGELOG, ROADMAP, README)
    const ownedPrefixes = [featureDir, 'CHANGELOG.md', 'ROADMAP.md', 'README.md', 'CLAUDE.md'];
    const featureFiles = [...filesToStage].filter(f => {
      // Feature docs always included
      if (f.startsWith(featureDir)) return true;
      // Doc updates
      if (ownedPrefixes.some(p => f === p || f.endsWith('/' + p))) return true;
      // Source files from context.filesChanged (the build created/modified these)
      if (context.filesChanged?.includes(f)) return true;
      return false;
    });

    if (featureFiles.length === 0) {
      return {
        phase: 'ship',
        artifact: 'no-changes',
        outcome: 'complete',
        summary: 'No files to commit — nothing to ship',
      };
    }

    // COMP-MCP-MIGRATION-1: pre-stage MCP enforcement scan. When
    // enforcement.mcpForFeatureMgmt is 'block' or 'log', verify every
    // dirty guarded path (ROADMAP.md, CHANGELOG.md, feature.json) has at
    // least one matching typed-tool audit row stamped with this build's
    // build_id. Block mode rejects unauthorized edits; log mode emits
    // decision events but proceeds.
    if (context?.build_id) {
      try {
        const { readEnforcementMode, scanGuarded, enforcementError } =
          await import('./mcp-enforcement.js');
        const { readEvents } = await import('./feature-events.js');
        const dataDir = join(cwd, '.compose', 'data');
        const mode = readEnforcementMode(dataDir);
        if (mode !== 'off') {
          // COMP-PATHS-EXTERNAL: the pre-stage guard matches repo-relative
          // `git status`, so relocated canon (an external paths.roadmap /
          // paths.features) is OUT of its scope — unauthorized edits there are
          // NOT enforced. Surface that visibly instead of failing silently.
          // Full external-canon enforcement needs cross-repo dirty detection
          // (tracked with COMP-PATHS-EXTERNAL-1).
          for (const [label, abs] of [['paths.roadmap', resolveRoadmapPath(cwd)], ['paths.features', resolveFeaturesPath(cwd)]]) {
            if (relative(cwd, abs).startsWith('..')) {
              // eslint-disable-next-line no-console
              console.warn(`[ship] MCP enforcement (${mode}) does NOT cover external ${label} (${abs}) — edits there are unguarded in v1.`);
            }
          }
          const events = readEvents(cwd, { since: context.buildStartedAt });
          const { violations } = scanGuarded({
            dirtyFiles: featureFiles,
            featuresDir: context.featuresDir ?? loadFeaturesDir(cwd),
            buildId: context.build_id,
            events,
          });
          if (violations.length > 0) {
            // Emit a decision event for visibility in either mode
            try {
              const { emitDecisionEvent } = await import('../server/decision-event-emit.js');
              emitDecisionEvent(() => {}, {
                type: 'mcp_enforcement_violation',
                featureCode: context.featureCode,
                build_id: context.build_id,
                mode,
                violations,
                timestamp: new Date().toISOString(),
              });
            } catch { /* decision event emit best-effort */ }
            // eslint-disable-next-line no-console
            console.warn(
              `[ship] MCP enforcement (${mode}): ${violations.length} guarded path(s) without typed-tool events:` +
              violations.map(v => `\n  - ${v.path}`).join('')
            );
            if (mode === 'block') {
              throw enforcementError(violations);
            }
          }
        }
      } catch (err) {
        if (err && err.code === 'MCP_ENFORCEMENT_VIOLATION') throw err;
        // Other failures inside the scan are best-effort — log and proceed
        // eslint-disable-next-line no-console
        console.warn(`[ship] MCP enforcement scan errored (proceeding): ${err.message}`);
      }
    }

    // 3. Stage files
    if (progress) progress.toolUse('ship', `Staging ${featureFiles.length} files...`);
    for (const f of featureFiles) {
      try {
        execFileSync('git', ['add', '--', f], { cwd: agentCwd, encoding: 'utf-8', timeout: 5000 });
      } catch { /* file might not exist or already staged */ }
    }

    // COMP-CANON-GUARD S5 T5: this verifier is deliberately build-independent
    // and runs after staging so pre-staged judgment edits cannot slip through.
    // This is a hard pre-commit gate: unlike best-effort metadata collection,
    // unexpected verifier failures are rethrown and block the commit because
    // silently passing would allow an unverified canon to ship.
    //
    // Scope boundary (whole-branch review): the canon verified is the WORKSPACE's
    // (`cwd`). For a cross-repo build (`agentCwd !== cwd`) the commit lands in
    // another repo, and that repo's own judgment canon — if it has one — is not
    // verified here. The staged-divergence check below does run in `agentCwd`,
    // against the tree actually being committed.
    try {
      // The verifier reads the WORKING TREE; `git commit` ships the INDEX. A canon
      // file staged and then restored in the worktree therefore verifies GREEN while
      // forged bytes go into the commit — a false GREEN, which is the one failure
      // mode this whole slice exists to prevent. So before trusting the verdict,
      // require that every STAGED guarded path matches the bytes about to be
      // verified. A guarded path modified but NOT staged is not this case: it is not
      // being committed, and worktree drift is what the verifier already covers.
      const stagedGuarded = new Set(gitLines(['diff', '--cached', '--name-only', '--', JUDGMENT_TREE], agentCwd));
      const worktreeGuarded = gitLines(['diff', '--name-only', '--', JUDGMENT_TREE], agentCwd);
      const divergent = worktreeGuarded.filter((p) => stagedGuarded.has(p));
      if (divergent.length > 0) {
        throw judgmentCanonDriftError({
          treeDrift: divergent.map((path) => ({ path, kind: 'staged-differs-from-worktree' })),
          projectionDrift: [],
          recordDrift: [],
        });
      }

      const { verifyJudgmentCanon } = await import('./judgment-verify.js');
      const verification = await verifyJudgmentCanon(cwd);
      if (!verification.ok) throw judgmentCanonDriftError(verification);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        err?.code === 'JUDGMENT_CANON_DRIFT'
          ? `[ship] ${err.message}`
          : `[ship] Judgment canon verification errored; refusing to commit: ${err.message}`,
      );
      throw err;
    }

    // 4. Check if there's anything to commit
    const staged = execSync('git diff --cached --name-only', {
      cwd: agentCwd, encoding: 'utf-8', timeout: 5000,
    }).trim();

    if (!staged) {
      return {
        phase: 'ship',
        artifact: 'no-changes',
        outcome: 'complete',
        summary: 'All changes already committed',
      };
    }

    // 5. Build commit message
    const shortDesc = description.split('\n')[0].slice(0, 72);
    const commitMsg = `feat(${featureCode}): ${shortDesc}`;

    // 6. Commit
    if (progress) progress.toolUse('ship', 'Committing...');
    execFileSync('git', ['commit', '-m', commitMsg], {
      cwd: agentCwd, encoding: 'utf-8', timeout: 30_000,
    });

    // 7. Best-effort post-commit metadata collection.
    // Each call is wrapped in its own try/catch — metadata failures must NEVER
    // downgrade the ship outcome from 'complete' to 'failed'. Empty fields
    // (commit:null, filesChanged:[]) are acceptable.
    const stagedFiles = staged.split('\n').filter(Boolean);

    let sha = null;
    try {
      sha = execSync('git rev-parse HEAD', {
        cwd: agentCwd, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() || null;
    } catch { /* metadata best-effort */ }

    if (progress) {
      progress.toolUse('ship', sha
        ? `Committed ${sha.slice(0, 8)} (${stagedFiles.length} files)`
        : `Committed (${stagedFiles.length} files)`);
    }

    // COMP-PLAN-SECTIONS T5: filesChanged from `git show --name-only`. Best-effort.
    let filesChanged = [];
    try {
      const namesOnly = execSync('git show --name-only --pretty=format: HEAD', {
        cwd: agentCwd, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      filesChanged = namesOnly.split('\n').map(s => s.trim()).filter(Boolean);
    } catch { /* metadata best-effort — leave [] */ }
    // If we got nothing from show, fall back to the staged list (still best-effort).
    if (filesChanged.length === 0 && sha) filesChanged = stagedFiles;
    context.recordFilesChanged?.(filesChanged, { authoritativeShip: true });

    const result = {
      phase: 'ship',
      artifact: sha ?? '',
      outcome: 'complete',
      summary: sha
        ? `Committed ${sha.slice(0, 8)}: ${commitMsg} (${stagedFiles.length} files)`
        : `Committed: ${commitMsg} (${stagedFiles.length} files)`,
      commit: sha,
      filesChanged,
      testsAttested,
      // Preserve structured test metrics on a replay as well as the first result.
      ...(testSummary.parsed ? { test_count: testSummary.test_count, pass_rate: testSummary.pass_rate } : {}),
    };
    const completionEvidence = { commitSha: sha, filesChanged, notes: shortDesc, builtVia, testsAttested, testSummary };
    if (waveShipTree && sha) await reportWaveEvidence(context, 'wave_ship',
      context.artifacts.journal.wave.checkpoints.at(-1).gateToken,
      { commit: sha, baseCommit: context.artifacts.journal.wave.baseCommit, checkpointTree: waveShipTree,
        filesChanged, result, completionEvidence });

    // COMP-COMPLETION-GATE slice 2: the ship step no longer completes the feature.
    //
    // It used to call recordCompletion here, catch ANY failure, and still return
    // a successful ship outcome — so a completion could fail silently and the
    // build marched on regardless. Worse, the terminal block then wrote COMPLETE
    // again independently, and the health gate that can fail the build runs AFTER
    // both. A health-rejected build was left marked COMPLETE.
    //
    // Ship now collects evidence and stops. Exactly one completion happens, at
    // terminalization, through the gate, after health. See §2.3, §2.3c.
    context.recordCompletionEvidence?.(completionEvidence);

    // COMP-PATHS-EXTERNAL D6a: if ROADMAP / the feature folder resolved into a
    // DIFFERENT git repo, they were written but not committed here — tell the
    // user to commit them there (v1 does not auto-commit other repos).
    noticeExternalArtifacts(cwd, featureCode, gitToplevel(agentCwd));

    return result;

  } catch (err) {
    return {
      phase: 'ship',
      artifact: '',
      outcome: 'failed',
      summary: `Ship failed: ${err.message}`,
      ...(typeof err?.code === 'string' ? { error_code: err.code } : {}),
    };
  }
}

export async function startFresh(stratum, specYaml, featureCode, description, dataDir, templateName, mode = 'feature', preMergeGate, roles, workspaceRoot, routingOptions = {}) {
  const flowName = extractFlowName(specYaml, templateName);
  console.log(`Starting ${flowName} for ${featureCode}...`);
  // I2: a FRESH build must not inherit a prior run's dirty-lenses sidecar. It is
  // cleared only on clean completion, so a killed/aborted dirty build would leave
  // it behind and make this unrelated fresh build's review_triage take the RETRY
  // PATH (selective re-review) on its very first round. Clearing here (the single
  // fresh-start entry — resume paths never reach it) means a mid-run sidecar
  // always denotes "this run's prior round".
  if (workspaceRoot) clearPriorDirtyLenses(join(workspaceRoot, '.compose'));
  // COMP-FIX-HARD T4: bug-mode flows take input as { task: <description> }
  // because pipelines/bug-fix.stratum.yaml's flow input contract uses `task`,
  // not the feature flow's `{ featureCode, description }`.
  // COMP-PAR-MERGE-QUEUE-CONSUMER-RETRY (D5): fold pre_merge_gate into the
  // feature plan envelope ONLY when resolved (undefined ⇒ key omitted, not [])
  // so the default-OFF path is byte-identical to pre-feature behavior.
  // COMP-CODEX-IMPL: feature flows always carry implementer_agent/reviewer_agent so
  // the interpolated execute/review agents (STRAT-AGENT-INTERP) always resolve.
  // Defaults reproduce today's behavior (claude implements, codex reviews) byte-identically.
  const implementerAgent = roles?.implementerAgent ?? 'claude';
  const reviewerAgent = roles?.reviewerAgent ?? 'codex';
  // The plan-input envelope is the mode's flow input contract. bug → { task };
  // plan → { projectName, intent } (the new.stratum.yaml shape); feature → the
  // full feature envelope. Byte-identical to the prior bug/feature ternary.
  const planCfg = getMode(mode).runner;
  const planInputs = planCfg.planInputs === 'bug'
    ? { task: description }
    : planCfg.planInputs === 'plan'
      ? { projectName: featureCode, intent: description }
      : { featureCode, description, implementer_agent: implementerAgent, reviewer_agent: reviewerAgent, ...(preMergeGate !== undefined ? { pre_merge_gate: preMergeGate } : {}) };
  const { response, routing } = await planWithRouting({ stratum, specYaml, flowName, input: planInputs, cwd: workspaceRoot,
    featureCode, profiles: routingOptions.profiles ?? {}, options: routingOptions,
    targetCwd: routingOptions.targetCwd ?? workspaceRoot, artifactRoot: routingOptions.artifactRoot });
  if (routing) Object.defineProperty(response, 'routing', { value: routing, configurable: true });

  writeActiveBuild(dataDir, {
    featureCode,
    flowId: response.runId,
    pipeline: flowName,
    mode,
    pid: process.pid,
    currentStepId: response.ready?.[0]?.id,
    specPath: `pipelines/${templateName}.stratum.yaml`,
    stepNum: 1,
    totalSteps: null,
    retries: 0,
    violations: [],
    status: 'running',
    startedAt: new Date().toISOString(),
    // COMP-CODEX-IMPL: roles are durable across resume (the build context is rebuilt
    // locally each invocation, so a resume without --codex must restore them).
    implementerAgent,
    reviewerAgent,
  });

  return response;
}

function updateActiveBuildStep(dataDir, stepId, extra = {}) {
  const state = readActiveBuild(dataDir);
  if (state) {
    // Reset retries/violations when switching to a new step
    if (state.currentStepId !== stepId) {
      state.retries = 0;
      state.violations = [];
    }
    state.currentStepId = stepId;
    Object.assign(state, extra);
    writeActiveBuild(dataDir, state);
  }
}

/**
 * Sync stepHistory into active-build.json so the UI can read per-step results.
 * Called after each step completes (execute or gate).
 */
function syncStepHistory(dataDir, stepHistory) {
  const state = readActiveBuild(dataDir);
  if (state) {
    // Top-level retries/violations on active-build apply to the current step
    const currentStepId = state.currentStepId;
    const topRetries = state.retries || 0;
    const topViolations = state.violations || [];

    let cumulativeCostUsd = 0;
    let cumulativeInputTokens = 0;
    let cumulativeOutputTokens = 0;
    state.steps = stepHistory.map(h => {
      const isCurrent = h.stepId === currentStepId;
      cumulativeCostUsd += h.cost_usd ?? 0;
      cumulativeInputTokens += h.input_tokens ?? 0;
      cumulativeOutputTokens += h.output_tokens ?? 0;
      return {
        id: h.stepId,
        status: stepOutcomeToStatus(h.outcome),
        summary: h.summary ?? null,
        artifact: h.artifact ?? null,
        agent: h.agent ?? null,
        durationMs: h.durationMs ?? null,
        filesChanged: h.filesChanged ?? null,
        retries: isCurrent ? topRetries : (h.retries ?? 0),
        violations: isCurrent ? topViolations : (h.violations ?? []),
        // COMP-OBS-COST: per-step token/cost data
        input_tokens: h.input_tokens ?? 0,
        output_tokens: h.output_tokens ?? 0,
        cost_usd: h.cost_usd ?? 0,
      };
    });
    // COMP-OBS-COST: persist cumulative build cost/tokens to active-build.json
    // so resumed builds can seed their accumulators correctly
    state.cumulative_cost_usd = cumulativeCostUsd;
    state.total_input_tokens = cumulativeInputTokens;
    state.total_output_tokens = cumulativeOutputTokens;
    writeActiveBuild(dataDir, state);
  }
}

/**
 * Poll gate resolution via REST. Returns resolved gate or null on server loss.
 * @param {VisionWriter} visionWriter
 * @param {string} gateId
 * @param {number} [intervalMs=2000]
 * @param {AbortSignal} [signal]
 * @returns {Promise<object|null>} resolved gate or null (server lost mid-poll)
 */
export async function pollGateResolution(visionWriter, gateId, intervalMs = 2000, signal) {
  let consecutiveFailures = 0;
  while (true) {
    signal?.throwIfAborted();
    try {
      const gate = await visionWriter.getGate(gateId, { requireServer: true });
      signal?.throwIfAborted();
      consecutiveFailures = 0;
      if (!gate) throw new Error(`Gate ${gateId} not found (404)`);
      if (gate.status === 'expired') throw new Error(`Gate ${gateId} expired`);
      if (gate.status !== 'pending') return gate;
    } catch (err) {
      signal?.throwIfAborted();
      if (err instanceof ServerUnreachableError) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          console.log('Server lost during gate poll — falling back to readline.');
          return null;
        }
      } else {
        throw err;
      }
    }
    await sleep(intervalMs, undefined, { signal });
  }
}

/**
 * COMP-PLAN-GATE-LOOP: backstop cap on how many times a single step may
 * re-enter its gate within one build. With the round-aware gate id this should
 * never trip (each re-entry blocks for a real decision), but if the round can't
 * be threaded the gate would otherwise spin forever (the observed 52-round
 * loop). Trip loudly instead — the Stratum flow state is preserved, so the
 * gate can be resolved and the build resumed.
 *
 * @param {number} count - re-entry count for this step (1 on first entry)
 * @param {string} stepId
 * @param {number} [cap=MAX_GATE_REENTRIES]
 */
export const MAX_GATE_REENTRIES = 20;

/**
 * Decide how a merge gate answers a consumer-merge failure.
 *
 * The first failure routes to the gate's repair path (`on_revise`, else kill).
 * A failure that repeats BYTE-IDENTICALLY for the same gate is not going to be
 * fixed by re-running the fan-out — the lanes reproduced the same conflict —
 * so the gate kills instead of paying for another round. Anything different
 * (a new code, a different file) is genuine progress and revises as before.
 *
 * @param {string|undefined} previousFailure - `${code}: ${message}` of the last failure at this gate
 * @param {string} failure - this round's `${code}: ${message}`
 * @param {'revise'|'kill'} repairOutcome - the gate's configured repair route
 * @returns {{ outcome: 'revise'|'kill', rationale: string, repeated: boolean }}
 */
export function decideMergeRepairOutcome(previousFailure, failure, repairOutcome) {
  const repeated = previousFailure !== undefined && previousFailure === failure;
  if (repairOutcome === 'revise' && repeated) {
    return {
      outcome: 'kill',
      repeated,
      rationale: `${failure} — identical to the previous round's failure at this gate; `
        + 'the fan-out reproduces the same conflict, so revising would only re-dispatch every '
        + 'lane for the same result. Killed to stop spending. A killed build is not resumable: '
        + 'fix the conflict (usually lanes editing the same file), then re-run with --fresh.',
    };
  }
  return { outcome: repairOutcome, repeated, rationale: failure };
}

export function assertGateReentryWithinCap(count, stepId, cap = MAX_GATE_REENTRIES) {
  if (count > cap) {
    throw new Error(
      `Gate "${stepId}" re-entered ${count} times without converging (cap ${cap}). ` +
      `Aborting to avoid an infinite gate loop. The Stratum flow state is preserved — ` +
      `resolve the gate (e.g. approve it) and re-run with --resume to continue.`
    );
  }
}

/**
 * Append a decision log entry to docs/context/decisions.md.
 * Only writes if the file already exists (created by `compose init`).
 *
 * @param {string} contextDir  - Absolute path to docs/context/
 * @param {string} featureCode
 * @param {string} stepId
 * @param {string} outcome     - 'approve' | 'revise' | 'kill'
 * @param {string} [rationale]
 */
function appendDecisionEntry(contextDir, featureCode, stepId, outcome, rationale) {
  const decisionsPath = join(contextDir, 'decisions.md');
  if (!existsSync(decisionsPath)) return;

  const today = new Date().toISOString().slice(0, 10);
  const entry = [
    '',
    `## [${today}] ${featureCode} — ${stepId}`,
    `**Outcome:** ${outcome}`,
    rationale ? `**Rationale:** ${rationale}` : null,
  ].filter(l => l !== null).join('\n');

  try {
    const current = readFileSync(decisionsPath, 'utf-8');
    writeFileSync(decisionsPath, current.trimEnd() + '\n' + entry + '\n');
  } catch {
    // If we can't write, don't crash the build
  }
}

/**
 * Load bug description from docs/bugs/<bugCode>/description.md (bug mode).
 *
 * Bug mode has no JSON file (feature.json equivalent); description.md is
 * the sole source. If absent, fall back to the bug code so callers don't
 * crash — `bin/compose.js` is responsible for prompting the user to write
 * description.md before invoking runBuild.
 */
function loadBugDescription(bugDir, bugCode) {
  const p = join(bugDir, 'description.md');
  if (existsSync(p)) {
    const content = readFileSync(p, 'utf-8');
    // First non-blank, non-heading line; fall back to whole file if none.
    const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#'));
    return (firstLine?.trim()) || content.trim() || bugCode;
  }
  return bugCode;
}

function loadFeatureDescription(featureDir, featureCode) {
  // Try design.md, then spec.md, then fall back to feature code
  for (const name of ['design.md', 'spec.md']) {
    const p = join(featureDir, name);
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8');
      // Extract first paragraph or heading as description
      const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#'));
      return firstLine?.trim() ?? featureCode;
    }
  }
  return featureCode;
}

const ABORT_TERMINAL_STATUSES = new Set(['complete', 'aborted', 'killed', 'failed']);

function abortSetting(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function abortRefusal(error) {
  if (['CANCELLATION_UNCONFIRMED', 'CANCELLATION_TEARDOWN_TIMEOUT', 'FLOW_NOT_FOUND'].includes(error?.code)) return error;
  if (isUnknownFlowError(error)) {
    return { code: 'FLOW_NOT_FOUND', reason: 'flow_not_found', status: null, flowSettled: false, agents: null };
  }
  return asTransportRefusal(error);
}

function reportAbort(result) {
  console.log(`Flow status: ${result.status ?? 'unknown'} (settled: ${result.flowSettled}).`);
  if (result.reason) console.log(`Reason: ${result.reason}${result.holderPid == null ? '' : `; holderPid: ${result.holderPid}`}.`);
  for (const [counter, count] of Object.entries(result.agents ?? {})) {
    if (count > 0) console.log(`Agents ${counter}: ${count}.`);
  }
  console.log(`Driver: ${result.driverMode}; signalled: ${result.driverSignalled}; exited: ${result.driverExited}; terminal writer: ${result.terminalWriter}.`);
  console.log(result.ok ? 'Build aborted.' : `Build NOT aborted — ${result.reason}.`);
  return result;
}

/** Retry only pre-settle lock refusals; a settled timeout gets one idempotent sweep. */
async function cancelAbortFlow(stratum, flowId, result) {
  const retries = abortSetting('COMPOSE_ABORT_RETRIES', 2);
  let lockRetries = 0;
  let reswept = false;
  let settled = null;
  for (;;) {
    result.attempts++;
    let outcome;
    try {
      outcome = await stratum.flowCancel(flowId);
    } catch (error) {
      outcome = abortRefusal(error);
    }
    // Once durable settlement is known, a later broken pipe cannot undo it. Keep
    // the last settled counters/status and report the failed re-sweep separately.
    if (settled && outcome.flowSettled !== true) {
      console.log(`Re-sweep failed: ${outcome.reason ?? outcome.code ?? 'transport'}.`);
      return settled;
    }
    if (outcome.flowSettled === true) {
      settled = outcome;
      if (outcome.code === 'CANCELLATION_TEARDOWN_TIMEOUT' && !reswept) {
        reswept = true;
        console.log('Flow settled; re-sweeping agent teardown once.');
        continue;
      }
      return outcome;
    }
    if (outcome.code === 'CANCELLATION_UNCONFIRMED' && outcome.reason === 'run_lock_held'
      && Object.values(outcome.agents ?? {}).every(count => count === 0) && lockRetries < retries) {
      lockRetries++;
      console.log(`Cancel lock held${outcome.holderPid == null ? '' : ` by ${outcome.holderPid}`}; retry ${lockRetries}/${retries}.`);
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    return outcome;
  }
}

/** The driver owns all terminal writes while it can still finish them itself. */
async function waitForAbortDriver(dataDir, active, handle) {
  const deadline = Date.now() + abortSetting('COMPOSE_ABORT_DRIVER_WAIT_MS', 20000);
  for (;;) {
    const claim = claimActiveBuild(dataDir, active);
    if (!claim.ok) return claim;
    if (ABORT_TERMINAL_STATUSES.has(claim.record.status)
      && (!handle || !lookupBuildCancel(active.flowId))) {
      return { ...claim, exited: true };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ...claim, exited: false };
    await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
  }
}

export async function abortBuild(dataDir, featureCode, cwd, opts = {}) {
  const active = readActiveBuild(dataDir);
  const result = {
    ok: false, flowId: active?.flowId ?? null, status: null, flowSettled: false,
    acknowledged: false, code: null, reason: null, holderPid: null, agents: null,
    attempts: 0, driverMode: 'none', driverSignalled: false, driverExited: false,
    terminalWriter: 'none', localCleanup: false,
  };
  const refuse = reason => reportAbort({ ...result, ok: false, reason, terminalWriter: 'none', localCleanup: false });
  if (!active) {
    console.log('No active build to abort.');
    return refuse('no_active_build');
  }
  if (featureCode && active.featureCode !== featureCode) {
    console.log(`Active build is for ${active.featureCode}, not ${featureCode}.`);
    return refuse('feature_mismatch');
  }
  if (ABORT_TERMINAL_STATUSES.has(active.status)) return refuse(`already_${active.status}`);

  const handle = lookupBuildCancel(active.flowId);
  const foreignPid = !handle && active.pid && active.pid !== process.pid
    && active.status === 'running' && isProcessAlive(active.pid) ? active.pid : null;
  result.driverMode = handle ? 'in-process' : foreignPid ? 'foreign-pid' : 'none';
  console.log(`Aborting build for ${active.featureCode}...`);

  // Configuration errors (notably the retired Python pin) still reject BEFORE
  // connecting. Only a connection/transport failure belongs in the outcome table.
  const connection = active.flowId ? resolveStratumMcpConnection(cwd) : null;
  const stratum = connection ? (opts.stratum ?? new StratumMcpClient()) : null;
  try {
    let outcome = { flowSettled: true };
    if (stratum) {
      try {
        await stratum.connect({ ...connection,
          env: { ...process.env, STRATUM_CANCEL_LOCK_WAIT_MS: String(abortSetting('COMPOSE_ABORT_LOCK_WAIT_MS', 10000)) },
        });
      } catch (error) {
        outcome = asTransportRefusal(error);
      }
      if (!outcome.code) outcome = await cancelAbortFlow(stratum, active.flowId, result);
    }
    for (const key of ['status', 'code', 'reason', 'holderPid', 'agents']) result[key] = outcome[key] ?? null;
    result.flowSettled = outcome.flowSettled === true;
    result.acknowledged = outcome.acknowledged === true;
    const alreadyTerminal = !outcome.code && ['completed', 'failed', 'budget_exhausted'].includes(outcome.status)
      && outcome.reason === `already_${outcome.status}`;
    if (!result.flowSettled && !alreadyTerminal) return refuse(result.reason ?? 'transport');

    // C41/C48: the awaits above may have handed ownership to a different build.
    // Claim BEFORE even cancelling the local controller or signalling a driver.
    let claim = claimActiveBuild(dataDir, active);
    if (!claim.ok) return refuse(claim.reason);
    if (result.flowSettled) {
      if (handle) handle.cancel('abort');
      else if (foreignPid && isProcessAlive(foreignPid)) {
        try { process.kill(foreignPid, 'SIGTERM'); result.driverSignalled = true; }
        catch (error) {
          if (error.code !== 'ESRCH') console.log(`Driver SIGTERM failed: ${error.code ?? error.message}.`);
        }
      }
    }
    if (result.driverMode !== 'none') {
      const driver = await waitForAbortDriver(dataDir, active, handle);
      if (!driver.ok) return refuse(driver.reason);
      if (driver.exited) {
        result.driverExited = true;
        result.terminalWriter = 'driver';
        result.ok = ['aborted', 'killed'].includes(driver.record.status);
        result.localCleanup = result.ok;
        if (!result.ok) result.reason = `already_${driver.record.status}`;
        return reportAbort(result);
      }
    }

    // Re-claim after the bounded wait, covering vision + state + actuals as one
    // cleanup. The aborter never restamps the driver's pid.
    claim = claimActiveBuild(dataDir, active);
    if (!claim.ok) return refuse(claim.reason);
    if (ABORT_TERMINAL_STATUSES.has(claim.record.status)) return refuse(`already_${claim.record.status}`);
    const visionWriter = new VisionWriter(dataDir);
    const item = await visionWriter.findFeatureItem(active.featureCode);
    claim = claimActiveBuild(dataDir, active);
    if (!claim.ok) return refuse(claim.reason);
    if (ABORT_TERMINAL_STATUSES.has(claim.record.status)) return refuse(`already_${claim.record.status}`);
    if (item?.id) {
      try { await killOwnedBuildVision(visionWriter, item.id, () => claimActiveBuild(dataDir, active)); }
      catch (error) {
        if (['ownership_lost', 'ownership_unverifiable'].includes(error.reason)) return refuse(error.reason);
        throw error;
      }
    }
    claim = claimActiveBuild(dataDir, active);
    if (!claim.ok) return refuse(claim.reason);
    if (ABORT_TERMINAL_STATUSES.has(claim.record.status)) return refuse(`already_${claim.record.status}`);
    writeActiveBuild(dataDir, { ...claim.record, status: 'aborted', completedAt: new Date().toISOString() }, { stampPid: false });
    const accumulator = readBuildAccumulator(cwd, active.featureCode);
    if (accumulator) emitBuildActuals(cwd, accumulator, 'aborted');
    result.ok = true;
    result.localCleanup = true;
    result.terminalWriter = 'abort';
    return reportAbort(result);
  } finally {
    if (stratum) {
      try { await stratum.close(); }
      catch (error) { console.warn(`Abort client close failed: ${error.message}`); }
    }
  }
}

/** Optional revision failures keep the draft; only user control or uncertain teardown stops the build. */
export function policyRevisionMustStop(error) {
  return error instanceof UserInterruptError
    || ['CANCELLATION_UNCONFIRMED', 'CANCELLATION_TEARDOWN_TIMEOUT'].includes(error?.code);
}
