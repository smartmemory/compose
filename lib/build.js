/**
 * build.js — Headless lifecycle runner for `compose build`.
 *
 * Orchestrates feature execution through a Stratum workflow:
 * load spec → stratum_plan → dispatch steps to agents → enforce gates → audit.
 *
 * No server required. Vision state written directly to disk.
 * Gates resolved via CLI readline prompt.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync, symlinkSync } from 'node:fs';
import { join, resolve, dirname, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

import { StratumMcpClient, StratumError, resolvePlanSpecValues, resolveStepProfile } from './stratum-mcp-client.js';
import { resolveStratumMcpConnection } from './stratum-engine.js';
import { runAndNormalize, AgentTimeoutError, AgentAbortedError, UserInterruptError, AgentError } from './result-normalizer.js';
import { checkCapabilityViolation } from './capability-checker.js';
import { preflightCodexWorktreeProbe, codexProbeAbortMessage } from './codex-preflight.js';
import { buildStepPrompt, buildGateContext, clearAmbientContextCache } from './step-prompt.js';
import { promptGate } from './gate-prompt.js';
import { VisionWriter, ServerUnreachableError } from './vision-writer.js';
import { readFlowRound } from './flow-state.js';
import { resolvePort } from './resolve-port.js';
import { probeServer } from './server-probe.js';
import { CliProgress } from './cli-progress.js';
import { BuildStreamWriter } from './build-stream-writer.js';
import { appendBuildHistory, projectHistorySteps, stepOutcomeToStatus } from './build-history.js';
import { KNOWN_VERSIONS } from './build-stream-schema.js';
import { resolveAgentConfig, parseAgentString } from './agent-string.js';
import { emitSections as emitPlanSections, appendTrailers as appendSectionTrailers, analyzeRollup, writeRollup } from './sections.js';
import { SECTIONS_DIR } from './constants.js';
import { rtkPrefix } from './rtk.js';

import YAML from 'yaml';
// feature-json direct imports removed — mutations now go through TrackerProvider (T9)
import { loadFeaturesDir, resolveContextPath, resolveRoadmapPath, resolveFeaturesPath } from './project-paths.js';
import { getMode } from './lifecycle-modes.js';
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
import { runTriage, isTriageStale } from './triage.js';
import { LENS_DEFINITIONS } from './review-lenses.js';
import { injectCertInstructions } from './cert-inject.js';
import { buildReviewPrompt } from './review-prompt.js';
import { detectTestFramework, scaffoldTestFramework, parseTestSummary, deriveTestsPass, isTestFile } from './test-bootstrap.js';
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
  isConsumerDescriptor,
  recoverAdvancedConsumerArtifacts,
  verifyConsumerRunRevision,
} from './consumer-fanout.js';

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
  // D6: the full agent profile string for this fanout step (from the compose
  // sidecar), applied at invocation so e.g. an isolation:none review fanout runs
  // read-only. Absent → the descriptor's bare provider literal (no restrictions).
  profile = null,
}) {
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
    const response = await stratum.stepDone(
      flowId, descriptor.id, envelope, descriptor.dispatchToken,
    );
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
    const response = await stratum.stepDone(
      flowId,
      descriptor.id,
      recovery.envelope,
      descriptor.dispatchToken,
    );
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

  // D3: stable per-item key for the stuck detector's per-task bookkeeping.
  const stuckTaskId = descriptor.item?.id ?? `${descriptor.step ?? descriptor.id}:${descriptor.itemIndex}`;
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
  });

  let mainResult;
  try {
    mainResult = await runAndNormalize(null, prompt, dispatch, {
      progress,
      streamWriter,
      maxDurationMs,
      stratum,
      cwd: recovery.worktree,
      onAgentEvent,
      profile,
      reviewMode: reviewOpts.reviewMode,
      confidenceGate: reviewOpts.confidenceGate,
      lens: reviewOpts.lens,
      // V2/V3: the isolation:none review fanout is the safety-critical controlled
      // execution — a claude review item runs via the compose-local connector so
      // its read-only tool restrictions actually BIND (the engine's sync
      // agent_run can't carry claude allowlists and its sandboxMode binds only
      // codex) and its per-item timeout / stuck abort truly INTERRUPTS it. Write
      // (worktree) items keep the engine seam: their per-item timeout still fails
      // the item, but interrupting an in-flight workspace-write run needs a
      // stratum follow-up (background mode is codex+read-only-only). Codex review
      // items also fall back to the sync seam (compose has no codex SDK).
      localExecution: descriptor.policy?.isolation === 'none',
    });
  } catch (error) {
    // User interrupts and injected crashes are control-flow signals, not item
    // failures — they must propagate and abort the pump.
    if (error instanceof UserInterruptError || error?.code === 'INJECTED_CONSUMER_CRASH') {
      throw error;
    }
    // D3: a stuck verdict halts the whole GSD run (not a per-item retry) — the
    // GSD driver catches this, writes the diagnostic, and returns status:stuck.
    if (error instanceof AgentAbortedError) {
      // G3: no step_done envelope is sent on the stuck/abort path (the run halts),
      // so the billable usage the aborted run consumed would be lost. Record it
      // into compose's cumulative ledger before converting to the stuck signal.
      if (error.usage && typeof context?.onUsage === 'function') {
        context.onUsage(error.usage, descriptor);
      }
      throw new ConsumerStuckError(stuckTaskId, error.reason);
    }
    if (error instanceof AgentTimeoutError) {
      mainResult = {
        result: { outcome: 'failed', summary: `Timed out after ${Math.round(error.durationMs / 1000)}s` },
        normalizationFailure: error.message,
        // G3: a timed-out run still consumed billable usage — forward it so the
        // failure envelope debits the engine ledger (same mechanism as F3).
        ...(error && typeof error === 'object' && error.usage ? { usage: error.usage } : {}),
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
        // F3: a failed run still consumed billable usage — the connector attaches
        // it to the error. Forward it so the failure envelope (and compose's
        // cumulative ledger) debit the attempt instead of letting failures evade
        // budget exhaustion.
        ...(error && typeof error === 'object' && error.usage ? { usage: error.usage } : {}),
      };
    }
  }

  const { result, normalizationFailure } = mainResult;
  // D2(b): forward the item's agent usage so GSD can debit the cumulative
  // budget ledger. Build mode passes no onUsage sink → byte-identical no-op.
  if (typeof context?.onUsage === 'function' && mainResult?.usage) {
    context.onUsage(mainResult.usage, descriptor);
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
  const envelope = localFailure
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
  if (engineUsage) envelope.usage = engineUsage;

  if (typeof artifacts.hooks.afterAgentMutationBeforePrepared === 'function') {
    await artifacts.hooks.afterAgentMutationBeforePrepared({
      descriptor,
      envelope,
      worktree: recovery.worktree,
    });
  }
  const preparedEntry = artifacts.prepareIssuance(descriptor, envelope, {
    finalStage,
  });
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

  const response = await stratum.stepDone(
    flowId, descriptor.id, envelope, descriptor.dispatchToken,
  );
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
    violations: [],
    flowId,
    consumer: true,
    // H6: matches the item's start stepId so the UI decrements the same task
    // (AgentStream keys the per-task done on parallel:true + a known stepId).
    parallel: true,
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
 * D6: load the compose-owned profile sidecar next to a pipeline spec. The engine
 * accepts only the literal claude|codex agent, so the full profile strings that
 * carry tool restrictions + model tiers (claude:read-only-reviewer,
 * claude::critical, claude:orchestrator, ...) live in <spec>.profiles.json keyed
 * by step id and are applied compose-side at invocation. Absent → {} (bare
 * literals; no restrictions).
 *
 * @param {string} specPath  path to the .stratum.yaml spec
 * @returns {Record<string,string>} step id → agent profile string
 */
export function loadPipelineProfiles(specPath) {
  try {
    const sidecar = String(specPath).replace(/\.stratum\.ya?ml$/, '.profiles.json');
    if (sidecar === String(specPath) || !existsSync(sidecar)) return {};
    const parsed = JSON.parse(readFileSync(sidecar, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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

function writeActiveBuild(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  // Always stamp PID so concurrent processes can detect each other
  state.pid = process.pid;
  const target = activeBuildPath(dataDir);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, target);
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
function makeAskAgent(stratum, context, gateDispatch, gateExtras) {
  const preamble = buildGateContext(gateDispatch, context, gateExtras);

  return async function askAgent(question, artifactPath) {
    const fileRef = artifactPath && !artifactPath.endsWith('/')
      ? `Read the file "${artifactPath}" and answer`
      : `Look at the project files in the working directory and answer`;
    const qaPrompt =
      `${preamble}\n\n---\n\n` +
      `${fileRef} this question concisely:\n\n` +
      `${question}\n\n` +
      `Keep your answer brief — 2-3 sentences max.`;
    const text = await stratum.runAgentText('claude', qaPrompt, { cwd: context.cwd });
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
function isTerminalFlow(status) {
  return ['completed', 'failed', 'budget_exhausted'].includes(status);
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

async function terminalizeThrownBuild({
  cwd,
  dataDir,
  cfg,
  visionWriter,
  itemId,
  featureCode,
  mode,
  response,
  buildStartedAt,
  buildCostTotals,
  stepHistory,
  failureReason,
  historyWritten,
}) {
  const flowId = response?.runId ?? null;
  if (!flowId) return false;
  await writeFailedBuildTerminalState({
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
      status: 'failed',
      startedAt: buildStartedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(buildStartedAt).getTime(),
      cost_usd: buildCostTotals.cost_usd,
      input_tokens: buildCostTotals.input_tokens,
      output_tokens: buildCostTotals.output_tokens,
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
    await abortBuild(dataDir, featureCode, cwd);
    return;
  }

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

  // COMP-MCP-MIGRATION-1: per-build correlation ID stamped onto every audit
  // row written during this run, so `executeShipStep`'s pre-stage scan can
  // tell agent-emitted typed-tool events apart from anything else.
  const build_id = randomUUID();
  const buildStartedAt = new Date().toISOString();
  const _priorBuildIdEnv = process.env.COMPOSE_BUILD_ID;
  if (_priorBuildIdEnv !== undefined) {
    // Concurrent in-process builds are not currently supported — env-based
    // stamping cannot tell them apart. Warn loudly so the surrounding
    // process tree picks it up; do not throw, since the prior env value
    // may simply be inherited from the parent (CI, harness) and harmless.
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
  // Only modes that run feature triage do so — triage is feature-shaped (writes
  // feature.json, profile selection per complexity tiers). bug AND plan skip it.
  if (cfg.runsTriage && !opts.skipTriage && !opts.template) {
    const _buildProvider = await getBuildProvider(cwd);
    let cachedFeature = await _buildProvider.getFeature(featureCode);
    if (cachedFeature?.profile && !isTriageStale(cwd, featureCode, featuresDir)) {
      // Reuse cached profile
      buildProfile = cachedFeature.profile;
      _buildTierLabel = cachedFeature.complexity ?? '?';
      console.log(`[triage] Using cached profile (tier ${_buildTierLabel}): ${JSON.stringify(buildProfile)}`);
    } else {
      // Run fresh triage
      const triageResult = await runTriage(featureCode, { cwd, featuresDir });
      buildProfile = triageResult.profile;
      _buildTierLabel = String(triageResult.tier);
      console.log(`[triage] Tier ${triageResult.tier}: ${triageResult.rationale}`);
      console.log(`[triage] Profile: ${JSON.stringify(buildProfile)}`);

      const triageTimestamp = new Date().toISOString();
      if (!cachedFeature) {
        // Create feature.json — feature folder exists but json was missing
        const featureDesc = opts.description ?? featureCode;
        cachedFeature = await _buildProvider.createFeature(featureCode, {
          code: featureCode,
          description: featureDesc,
          status: 'PLANNED',
          complexity: String(triageResult.tier),
          profile: buildProfile,
          triageTimestamp,
        });
      } else {
        // Profile/complexity cache update — no status change. Spread current
        // feature so putFeature receives the full object (it overwrites, not merges).
        cachedFeature = await _buildProvider.putFeature(featureCode, {
          ...cachedFeature,
          complexity: String(triageResult.tier),
          profile: buildProfile,
          triageTimestamp,
        });
      }
    }
  }

  // Load lifecycle spec (template selection). The mode's defaultTemplate is the
  // fallback when no explicit --template is given (build → 'build', byte-identical
  // since resolveTemplatePath also defaults undefined→'build'; plan → 'new').
  const templateName = opts.template ?? cfg.defaultTemplate;
  const specPath = resolveTemplatePath(templateName, cwd);
  if (!existsSync(specPath)) {
    throw new Error(`Lifecycle spec not found: ${specPath}`);
  }
  // D6: compose-owned per-step agent profiles (tool restrictions + model tiers)
  // for this pipeline. The engine ships only bare claude|codex; these restore
  // the stripped profiles at invocation. Absent sidecar → {} (bare literals).
  const stepProfiles = loadPipelineProfiles(specPath);
  let specYaml = readFileSync(specPath, 'utf-8');

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
  const localSpecDigest = _sha256(JSON.stringify(localSpec));

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
  const progress = new CliProgress();

  // Stratum MCP client (test override permitted via opts.stratum)
  const stratum = opts.stratum ?? new StratumMcpClient();
  if (!opts.stratum) await stratum.connect(resolveStratumMcpConnection(cwd));

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
  let streamWriter = null;
  let buildStatus = 'complete';
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
  let signalHandler = null;
  let response;
  let stepHistory = [];
  const terminalHistoryWritten = { value: false };
  // COMP-OBS-COST: Accumulate token/cost totals across all steps (hoisted for finally-block)
  // On resume, seed from active-build.json to preserve pre-resume cost totals
  const buildCostTotals = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  // COMP-MODEL-AB: capture structured test counts from the ship step so they can
  // be persisted to build-history.jsonl for the metrics consumer (experiment-metrics.js).
  // Null when ship didn't run (failed/killed builds) or testSummary was unparsed.
  let shipStepTestData = null;

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

  const priorActive = readActiveBuild(dataDir);
  if (priorActive && priorActive.featureCode === featureCode && priorActive.status === 'running') {
    if (typeof priorActive.total_input_tokens === 'number') buildCostTotals.input_tokens = priorActive.total_input_tokens;
    if (typeof priorActive.total_output_tokens === 'number') buildCostTotals.output_tokens = priorActive.total_output_tokens;
    if (typeof priorActive.cumulative_cost_usd === 'number') buildCostTotals.cost_usd = priorActive.cumulative_cost_usd;
  }

  try {
    // Check for active build (resume)
    const active = readActiveBuild(dataDir);
    let isFreshStart = true;

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
    let implementerAgent = opts.codex ? 'codex' : 'claude';
    let reviewerAgent = opts.codex ? 'claude' : 'codex';
    // COMP-MODEL-AB: explicit --implementer/--reviewer override --codex-derived defaults.
    // Validated in bin/compose.js before reaching here; validate again for programmatic
    // callers that bypass the CLI (unknown provider = hard error).
    if (opts.implementer != null) {
      const { provider } = parseAgentString(opts.implementer);
      if (!['claude', 'codex'].includes(provider)) {
        throw new Error(`Invalid implementer agent string "${opts.implementer}": unknown provider "${provider}"`);
      }
      implementerAgent = opts.implementer;
    }
    if (opts.reviewer != null) {
      const { provider } = parseAgentString(opts.reviewer);
      if (!['claude', 'codex'].includes(provider)) {
        throw new Error(`Invalid reviewer agent string "${opts.reviewer}": unknown provider "${provider}"`);
      }
      reviewerAgent = opts.reviewer;
    }
    const roles = { implementerAgent, reviewerAgent };
    // Restore persisted roles when (and only when) a resume actually happens.
    const restoreRolesFromActive = (src) => {
      if (mode !== 'feature' || !src || !src.implementerAgent) return;
      if (src.implementerAgent !== implementerAgent) {
        console.warn(
          `⚠ Resuming ${featureCode}: build started with implementer=${src.implementerAgent}; ` +
          `honoring the persisted role over the current invocation's flag.`
        );
      }
      implementerAgent = src.implementerAgent;
      reviewerAgent = src.reviewerAgent ?? reviewerAgent;
    };

    const activeForDecision = active && active.featureCode === featureCode ? active : null;
    const pidAlive = Boolean(
      activeForDecision?.status === 'running'
      && activeForDecision.pid
      && activeForDecision.pid !== process.pid
      && isProcessAlive(activeForDecision.pid)
    );
    const sameMode = !activeForDecision?.mode || activeForDecision.mode === mode;
    let flowTerminal = !activeForDecision?.flowId;
    if (activeForDecision?.flowId && ['complete', 'aborted', 'killed'].includes(activeForDecision.status)) {
      flowTerminal = true;
    } else if (activeForDecision?.flowId && !pidAlive) {
      try {
        const audit = await stratum.audit(activeForDecision.flowId);
        flowTerminal = isTerminalFlow(audit?.status);
        if (flowTerminal) {
          recoverAdvancedConsumerArtifacts({
            runId: activeForDecision.flowId,
            targetCwd: agentCwd,
            artifactRoot: opts.consumerArtifactsRoot,
            audit,
          });
        }
      } catch (err) {
        if (isRecoverableFlowProbeError(err)) {
          flowTerminal = true;
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

    if (verdict.action === 'resume') {
      const resumeFlowId = verdict.flowId;
      console.log(`Resuming flow ${resumeFlowId} for ${featureCode}...`);
      response = await stratum.resume(resumeFlowId);
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
      });
      try {
        recoverAdvancedConsumerArtifacts({
          runId: resumeFlowId,
          targetCwd: agentCwd,
          artifactRoot: opts.consumerArtifactsRoot,
          audit: await stratum.audit(resumeFlowId),
        });
      } catch (error) {
        if (error instanceof ConsumerArtifactError) throw error;
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
        response = await startFresh(stratum, specYaml, featureCode, description, dataDir, templateName, mode, preMergeGate, roles, cwd);
        isFreshStart = true;
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
      response = await startFresh(stratum, specYaml, featureCode, description, dataDir, templateName, mode, preMergeGate, roles, cwd);
    } else {
      const reason = verdict.reason.includes(featureCode)
        ? verdict.reason
        : verdict.reason.replace('Build already running', `Build already running for ${featureCode}`);
      throw new Error(reason);
    }

    // COMP-CODEX-IMPL: verify Codex can write inside a detached git worktree (the
    // execute step's isolation primitive) before any step dispatches. Runs on the
    // EFFECTIVE role — after resume restoration above — so a resumed Codex build is
    // probed too (cached per-repo, so resume is normally a no-op); gating on the
    // pre-restore flag would skip resumed Codex builds (Codex impl-review finding).
    // The plan/resume above only created the flow object; no agent/worktree work has
    // happened yet, so aborting here still means we never reach `execute` (Codex
    // review finding #2). Cached + skippable via COMPOSE_SKIP_CODEX_PROBE.
    if (implementerAgent === 'codex') {
      const probe = await preflightCodexWorktreeProbe({
        cwd: agentCwd,
        stratum,
        dataDir,
        ts: new Date().toISOString().replace(/[:.]/g, '-'),
      });
      if (!probe.ok) {
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

    // SIGINT/SIGTERM: mark build as killed
    signalHandler = () => {
      buildStatus = 'killed';
      streamWriter.close('killed');
    };
    process.on('SIGINT', signalHandler);
    process.on('SIGTERM', signalHandler);

    // V4: merge the runtime profile map over the static sidecar (runtime wins).
    // Tiers/templates carried by $.input.* agents (e.g. --implementer=claude::critical)
    // are stripped to the bare provider at resolution for the engine; recover the
    // full string here so the tier/capability profile still binds at invocation.
    const runtimeProfiles = {};
    try {
      resolvePlanSpecValues(
        YAML.parse(readFileSync(specPath, 'utf-8')),
        { implementer_agent: implementerAgent, reviewer_agent: reviewerAgent },
        runtimeProfiles,
      );
    } catch { /* best-effort — a malformed spec fails later at plan() */ }
    const effectiveProfiles = { ...stepProfiles, ...runtimeProfiles };
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
      cwd: agentCwd,
      featureCode,
      featureDir: resolveItemDir(featureCode),
      contextDir: contextDirPath,
      stepHistory,
      mode,
      // V4: merged runtime + static agent profiles let scoped consumer steps
      // recover their tier/capability profile via resolveStepProfile normalization.
      stepProfiles: effectiveProfiles,
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
      ...(isBugMode ? { bug_code: featureCode } : {}),
    };

    let consumerArtifacts = null;
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
        });
      } else if (consumerArtifacts.runId !== runId) {
        throw new Error(`consumer artifact manager is bound to ${consumerArtifacts.runId}, not ${runId}`);
      }
      return consumerArtifacts;
    };


    // COMP-PLAN-GATE-LOOP: per-step gate re-entry counter. A `revise` that
    // routes back through earlier steps re-enters the same gate; the round-aware
    // gate id (below) keeps each re-entry a fresh pending gate, but this counter
    // is the backstop — if the round can't be threaded for any reason, it trips
    // instead of letting the gate spin unbounded (the 52-round loop).
    const gateReentries = new Map();

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

    const runConsumerDescriptor = async (descriptor, sourceResponse) => {
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
        flowId,
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
        profile: resolveStepProfile(effectiveProfiles, descriptor.step)
          ?? resolveStepProfile(effectiveProfiles, descriptor.id),
      });
    };

    const launchPendingConsumers = () => {
      while (!consumerFatalError
        && consumerInFlight.size < consumerConcurrency
        && consumerPending.length > 0) {
        const work = consumerPending.shift();
        const token = work.descriptor.dispatchToken;
        const task = runConsumerDescriptor(work.descriptor, work.sourceResponse)
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
          const runPins = { revisionDigest: descriptor.revisionDigest, specDigest: localSpecDigest };
          // Preflight a whole ready batch before launching it. This preserves the
          // shipped crash-before-first-bind boundary (zero issuances may execute)
          // while allowing the work after revision fencing to overlap.
          const artifacts = artifactsForRun(flowId, runPins);
          if (typeof artifacts.hooks.beforeRevisionBind === 'function') {
            await artifacts.hooks.beforeRevisionBind({ descriptor, journal: artifacts.journal });
          }
          artifacts.bindRunRevision(runPins);
          consumerSeenTokens.add(descriptor.dispatchToken);
          consumerPending.push({ descriptor, sourceResponse: engineResponse });
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
    while (!isTerminalFlow(response.status)) {
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
          if (_interceptedTestMetrics !== null) shipStepTestData = _interceptedTestMetrics;
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
            try { streamWriter.write({ type: 'build_error', message: `sections rollup write failed: ${err.message}`, stepId: 'ship' }); } catch { /* ignore */ }
          }
          // COMP-HEALTH: collect plan_completion signal from ship result (if present)
          if (shipResult.planCompletionPct != null || shipResult.plan_completion_pct != null) {
            buildSignals.plan_completion = {
              planCompletionPct: shipResult.planCompletionPct ?? shipResult.plan_completion_pct,
            };
          }
          verifyPipelineIntegrity(specPath, specFileHash);
          const tsShipOutput = {
            phase: shipResult.phase,
            artifact: shipResult.artifact,
            outcome: shipResult.outcome,
            summary: shipResult.summary,
            ...(Array.isArray(shipResult.plan_items) ? { plan_items: shipResult.plan_items } : {}),
            ...(Array.isArray(shipResult.filesChanged) ? { files_changed: shipResult.filesChanged } : {}),
            ...(typeof shipResult.commit === 'string' ? { commit_hash: shipResult.commit } : {}),
          };
          const shipStepResult = response.status === 'ready'
            ? { output: tsShipOutput }
            : shipResult;
          response = await stratum.stepDone(
            flowId, stepId, shipStepResult, readyStep?.dispatchToken,
          );
          streamWriter.write({
            type: 'build_step_done',
            stepId, summary: shipResult.summary, retries: 0, violations: [], flowId,
          });
          continue;
        }

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
            await runAndNormalize(undefined, fixPrompt, { ...stepDispatch, agent: fixAgent }, {
              progress,
              streamWriter,
              maxDurationMs: STEP_TIMEOUT_MS[stepId] ?? DEFAULT_TIMEOUT_MS,
              stratum,
              cwd: agentCwd,
              profile: resolveStepProfile(context.stepProfiles, stepId),
            });
          } catch (err) {
            if (!(err instanceof AgentTimeoutError)) throw err;
            console.warn(`\n⚠ Fix agent timed out on "${stepId}"`);
          }
          progress.retry('build', stepId, readyStep.agent ?? response.agent ?? 'claude');
        }

        // Build prompt and dispatch to agent
        const stepStartMs = Date.now();
        const agentType = readyStep?.agent ?? response.agent ?? 'claude';
        const basePrompt = buildStepPrompt(stepDispatch, context);
        const maxDurationMs = STEP_TIMEOUT_MS[stepId] ?? DEFAULT_TIMEOUT_MS;

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
          mainResult = await runAndNormalize(null, prompt, stepDispatch, {
            progress, streamWriter, maxDurationMs, onToolUse, stratum, cwd: agentCwd,
            reviewMode: isReviewMain,
            confidenceGate: confGateMain,
            lens: response.inputs?.lens_name ?? response.lens_name ?? 'general',
            // D6/V4: apply this ordinary step's compose-side profile (e.g.
            // blueprint → claude::critical, review_merge → claude:orchestrator),
            // normalizing scoped subflow ready ids to the bare step id.
            profile: resolveStepProfile(effectiveProfiles, stepId),
          });
        } catch (err) {
          if (err instanceof UserInterruptError) {
            if (err.action === 'skip') {
              if (progress) progress.info(`  ⏭ Skipped step "${stepId}"`);
              mainResult = { text: '', result: { outcome: 'skipped', summary: `Skipped by user` } };
            } else {
              if (progress) progress.info(`  ↻ Retrying step "${stepId}"`);
              mainResult = { text: '', result: { outcome: 'failed', summary: `Retry requested by user` } };
            }
          } else if (err instanceof AgentTimeoutError) {
            console.warn(`\n⚠ Agent timed out on step "${stepId}" after ${Math.round(err.durationMs / 1000)}s`);
            streamWriter.write({ type: 'build_error', message: err.message, stepId });
            mainResult = { text: '', result: { outcome: 'failed', summary: `Timed out after ${Math.round(err.durationMs / 1000)}s` } };
          } else {
            streamWriter.write({ type: 'build_error', message: err.message, stepId });
            throw err;
          }
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
          if (_genericTestMetrics !== null) shipStepTestData = _genericTestMetrics;
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
        const stepDoneResult = readyStep
          ? blockingFailure
            ? { failure: blockingFailure }
            : normalizationFailure || result?.outcome === 'failed'
              ? { failure: String(normalizationFailure ?? result?.summary ?? `Step "${stepId}" did not produce structured output`) }
              : stepDispatch.has_out_contract
                ? result != null
                  ? { output: result }
                  : { failure: `Step "${stepId}" did not produce structured output` }
                : {}
          : result ?? { summary: 'Step complete' };
        response = await stratum.stepDone(
          flowId, stepId, stepDoneResult, readyStep?.dispatchToken,
        );
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
          await maybeRunEscalation(stratum, context, progress, streamWriter, attemptCounter, dataDir);
        }

        // Stream: step done — read retries/violations from active-build state
        // (syncStepHistory has already written them above)
        {
          const buildState = readActiveBuild(dataDir);
          const stepState = buildState?.steps?.find(s => s.id === stepId) ?? {};
          // COMP-OBS-COST: accumulate step usage and emit step_usage event
          if (stepUsage && (stepUsage.input_tokens > 0 || stepUsage.output_tokens > 0 || stepUsage.cost_usd > 0)) {
            buildCostTotals.input_tokens += stepUsage.input_tokens ?? 0;
            buildCostTotals.output_tokens += stepUsage.output_tokens ?? 0;
            buildCostTotals.cost_usd += stepUsage.cost_usd ?? 0;
            streamWriter.writeUsage(stepId, stepUsage);
          }

          // COMP-HEALTH: collect runtime violations for health score signal
          const stepViolations = stepState.violations ?? [];
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
            cumulative_cost_usd: buildCostTotals.cost_usd,
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
          consumerMergeArtifacts.recordGateBinding({ gateStepId, fanoutStepId: consumerFanoutStep.id });
        }

        const resolveGateWithConsumerMerge = async (requestedOutcome, requestedRationale, resolvedBy) => {
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
          if (consumerMergeArtifacts && outcome === 'approve') {
            if (consumerMergePreparationError) {
              outcome = repairOutcome;
              rationale = `${consumerMergePreparationError.code}: ${consumerMergePreparationError.message}`;
            } else {
              try {
                await consumerMergeArtifacts.applyMerge(consumerMergeTransaction);
                try {
                  const changed = execSync(
                    'git diff --name-only HEAD; git ls-files --others --exclude-standard',
                    { cwd: agentCwd, encoding: 'utf8', timeout: 5000, stdio: 'pipe' },
                  ).trim();
                  if (changed) {
                    const files = new Set(context.filesChanged ?? []);
                    for (const file of changed.split('\n').filter(Boolean)) files.add(file);
                    context.filesChanged = [...files];
                  }
                } catch { /* best-effort build context projection */ }
              } catch (error) {
                if (!(error instanceof ConsumerMergeDecisionError)) throw error;
                outcome = repairOutcome;
                rationale = `${error.code}: ${error.message}`;
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

          let next = await stratum.gateResolve(
            flowId, stepId, outcome, rationale, resolvedBy, gateToken,
          );
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
            consumerMergeArtifacts.markGateResolved(consumerMergeTransaction, outcome);
            if (outcome === 'approve' || outcome === 'kill' || isTerminalFlow(next.status)) {
              consumerMergeArtifacts.cleanupWorktrees(
                outcome === 'approve' ? 'merge gate approved and advanced' : 'run terminalized',
              );
            }
          }
          if (outcome === 'kill') killedByGate = true;
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
            const auditedOutput = gateAudit?.steps?.review_merge?.output ?? null;
            if (auditedOutput && typeof auditedOutput === 'object') {
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
              await runAndNormalize(undefined, fixPrompt, { step_id: 'review_fix', agent: fixAgent, flow_id: flowId }, {
                progress, streamWriter, maxDurationMs: STEP_TIMEOUT_MS.review_merge ?? DEFAULT_TIMEOUT_MS,
                stratum, cwd: agentCwd, profile: resolveStepProfile(effectiveProfiles, 'fix'),
              });
            } catch (err) {
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

        // ── Policy evaluation (ITEM-23) ────────────────────────────────────
        const policy = evaluatePolicy(policySettings, stepId, {
          fromPhase: synthFromPhase,
          // Gate policy is keyed by the gate step id (evaluatePolicy falls back
          // to stepId when toPhase is absent); the synthesized approval target
          // must not hijack the lookup.
        });

        if (policy.mode === 'skip') {
          // Silent pass-through — no gate record, no UI
          const resolved = await resolveGateWithConsumerMerge('approve', policy.reason, 'system');
          response = resolved.response;
          streamWriter.write({
            type: 'build_gate_resolved',
            stepId, outcome: resolved.outcome, rationale: resolved.rationale, flowId, policyMode: 'skip',
          });
          // COMP-PLAN-SECTIONS T6: emit sections after plan_gate auto-approve
          if (resolved.outcome === 'approve') {
            maybeEmitSectionsAfterPlanGate(stepId, featureDir, { streamWriter, featureCode });
          }
          stepHistory.push({ stepId, artifact: null, summary: `Gate skip: ${resolved.rationale}`, outcome: resolved.outcome });
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
            const resolved = await pollGateResolution(visionWriter, gateId);
            if (resolved) {
              outcome = resolved.outcome;
              rationale = resolved.comment ?? '';
            } else {
              const result = await promptGate(gateDispatch, {
                ...(opts.gateOpts ?? {}),
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
              artifact: context.cwd,
              askAgent,
              gateExtras,
            });
            outcome = result.outcome;
            rationale = result.rationale;
          }

          const resolved = await resolveGateWithConsumerMerge(outcome, rationale, 'human');
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

    // Flow complete — write terminal state (file retained per STRAT-COMP-4 contract).
    if (response.status === 'completed') buildStatus = 'complete';
    if ((response.status === 'failed' || response.status === 'budget_exhausted') && !killedByGate) {
      buildStatus = 'failed';
      terminalFailureReason = response.failure?.reason ?? null;
    }
    if (response.status === 'completed' && buildStatus === 'complete') {
      console.log('\nBuild complete.');
      await visionWriter.updateItemStatus(itemId, 'complete');
      // COMP-QA: persist filesChanged so `compose qa-scope` can read them post-build.
      // Bug mode skips feature-json — bugs don't have feature.json (COMP-FIX-HARD T4).
      if (cfg.tracksFeatureJson) {
        const _bp = await getBuildProvider(cwd);
        // Guard: feature.json may not exist when triage was skipped (test harnesses).
        // Original updateFeature silently no-oped when feature was missing.
        // Single atomic raw write (status + filesChanged together) — restores original
        // updateFeature atomicity. persistFeatureRaw: no policy, no events, no roadmap.
        const _feat = await _bp.getFeature(featureCode);
        if (_feat) {
          await _bp.persistFeatureRaw(featureCode, { ..._feat, status: 'COMPLETE', filesChanged: context.filesChanged ?? [] });
        }
      }
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
    if (streamWriter) {
      try {
        // Runtime errors signal — accumulated across all steps
        if (allViolations.length > 0) {
          buildSignals.runtime_errors = allViolations;
        } else if (!buildSignals.runtime_errors) {
          buildSignals.runtime_errors = [];
        }

        // Doc freshness — check staleness of feature artifacts
        try {
          const { checkStaleness } = await import('./staleness.js');
          const currentPhase = stepHistory.length > 0
            ? stepHistory[stepHistory.length - 1].stepId
            : 'build';
          const stalenessResults = checkStaleness(resolveItemDir(featureCode), currentPhase);
          buildSignals.doc_freshness = stalenessResults;
        } catch { /* staleness check is optional — skip on error */ }

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
        streamWriter.writeHealthScore(score, breakdown, missing);

        // Persist to history
        try {
          recordScore(cwd, { featureCode, phase: buildStatus, score, breakdown });
        } catch (err) {
          console.warn(`[health] Failed to persist score: ${err.message}`);
        }

        // COMP-HEALTH item 119: gate threshold check (policy integration)
        // If health score is below the configured threshold, mark the build as failed
        // so downstream consumers (vision item status, exit code) reflect the rejection.
        const threshold = healthSettings.gate_threshold;
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
          buildStatus = 'failed';
          // COMP-MOBILE-1-1: re-persist the downgrade to active-build.json so the
          // file watcher re-broadcasts buildState over /ws/vision. Without this,
          // the terminal write above already said 'complete' and clients never
          // learn the build actually failed (mobile compensated via history).
          // Identity-guarded: no-ops if a concurrent build replaced the file.
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
        console.warn(`[health] Score computation failed: ${err.message}`);
      }
    }

    // COMP-COCKPIT-3: archive the run to build-history.jsonl ONCE, here — after
    // the COMP-HEALTH gate above may have downgraded buildStatus to 'failed'.
    // Assembled from the in-memory build context for THIS run (never re-read
    // active-build.json, which is last-writer-wins across concurrent builds).
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
        cost_usd: buildCostTotals.cost_usd,
        input_tokens: buildCostTotals.input_tokens,
        output_tokens: buildCostTotals.output_tokens,
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
    buildStatus = 'failed';
    const failureReason = err?.message ?? 'Build failed';
    try {
      await terminalizeThrownBuild({
        cwd,
        dataDir,
        cfg,
        visionWriter,
        itemId,
        featureCode,
        mode,
        response,
        buildStartedAt,
        buildCostTotals,
        stepHistory,
        failureReason,
        historyWritten: terminalHistoryWritten,
      });
    } catch (terminalErr) {
      console.warn(`[build] Failed to terminalize crashed build: ${terminalErr.message}`);
    }
    throw err;
  } finally {
    // Close stream writer with appropriate status (idempotent — signal handler may have already closed)
    if (streamWriter) {
      streamWriter.close(buildStatus, buildCostTotals);
    }
    if (signalHandler) {
      process.removeListener('SIGINT', signalHandler);
      process.removeListener('SIGTERM', signalHandler);
    }
    progress.finish();
    await stratum.close();
    // COMP-MCP-MIGRATION-1: restore COMPOSE_BUILD_ID env to its prior value
    // (or unset) so subsequent processes / tests don't inherit a stale UUID.
    _restoreBuildIdEnv();
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

/**
 * Execute the ship step: run tests, stage feature files, commit.
 * Returns a PhaseResult-shaped object.
 */
export async function executeShipStep(featureCode, agentCwd, cwd, context, description, progress) {
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
    // 0. Check if we're in a git repository — if not, skip git operations
    let isGitRepo = false;
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd: agentCwd, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
      isGitRepo = true;
    } catch { /* not a git repo */ }

    if (!isGitRepo) {
      // COMP-PATHS-EXTERNAL D6b: there is no repo to commit into (e.g. a
      // forge-top-shaped workspace), but the lifecycle must still advance —
      // record a commit-less completion (null-SHA) so status flips to COMPLETE.
      // Best-effort: a completion failure must not fail ship.
      let completionWarning = null;
      if (featureCode) {
        try {
          const { recordCompletion } = await import('./completion-writer.js');
          await recordCompletion(cwd, {
            feature_code: featureCode,
            // commit_sha omitted — non-git workspace, stamped with the null-SHA
            // COMP-TEST-BOOTSTRAP-4: this path returns before the test run, so
            // there is no parsed signal — degrade to true (no block).
            tests_pass: true,
            files_changed: [],
            notes: description.split('\n')[0].slice(0, 72),
            ...(builtVia ? { built_via: builtVia } : {}),
          });
        } catch (err) {
          completionWarning = `completion record failed (${err.code || 'UNKNOWN'}): ${err.message}`;
          // eslint-disable-next-line no-console
          console.warn(`[build/ship] ${featureCode}: ${completionWarning}`);
        }
      }
      return {
        phase: 'ship',
        artifact: 'no-git',
        outcome: 'complete',
        summary: 'No git repository — wrote artifacts, recorded completion (commit skipped)',
        commit: null,
        ...(completionWarning ? { completionWarning } : {}),
      };
    }

    // 1. Run feature-relevant tests (best-effort — don't block ship on test infra issues)
    if (progress) progress.toolUse('ship', 'Running tests...');
    // COMP-TEST-BOOTSTRAP-4: parse the run output into a structured signal and
    // derive a real tests_pass for the completion attestation. Degrades to
    // `true` (no block) whenever the output can't be parsed — see deriveTestsPass.
    let testSummary = { test_count: 0, pass_rate: 0, parsed: false };
    try {
      // COMP-TEST-BOOTSTRAP item 128: use detected test command instead of hard-coded npm test
      const testFramework = detectTestFramework(agentCwd);
      const testCommand = testFramework?.command ?? 'npm test';
      const testOutput = execSync(`${testCommand} 2>&1 || true`, { cwd: agentCwd, encoding: 'utf-8', timeout: 120_000 });
      testSummary = parseTestSummary(testFramework?.framework, testOutput);
    } catch { /* test runner not available or timed out — proceed (testSummary stays unparsed) */ }
    const testsPass = deriveTestsPass(testSummary);
    if (progress && testSummary.parsed) {
      progress.toolUse('ship', `Tests: ${testSummary.test_count} run, ${testSummary.pass_rate}% passing`);
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

    // COMP-MCP-MIGRATION: write a commit-bound completion record via the
    // typed writer. The writer flips feature.status to COMPLETE atomically
    // and regenerates ROADMAP.md. Best-effort: completion failures must not
    // downgrade the ship outcome since the commit itself succeeded.
    let completionWarning = null;
    if (sha && featureCode) {
      try {
        const { recordCompletion } = await import('./completion-writer.js');
        await recordCompletion(cwd, {
          feature_code: featureCode,
          commit_sha: sha,
          // COMP-TEST-BOOTSTRAP-4: derived from the parsed test run above
          // (true when unparseable — never a false block).
          tests_pass: testsPass,
          files_changed: filesChanged,
          notes: shortDesc,
          ...(builtVia ? { built_via: builtVia } : {}),
        });
        if (progress) progress.toolUse('ship', `Recorded completion for ${featureCode}`);
      } catch (err) {
        completionWarning = err.code === 'STATUS_FLIP_AFTER_COMPLETION_RECORDED'
          ? `completion recorded but status flip failed: ${err.message}`
          : `completion record failed (${err.code || 'UNKNOWN'}): ${err.message}`;
        // eslint-disable-next-line no-console
        console.warn(`[build/ship] ${featureCode}: ${completionWarning}`);
      }
    }

    // COMP-PATHS-EXTERNAL D6a: if ROADMAP / the feature folder resolved into a
    // DIFFERENT git repo, they were written but not committed here — tell the
    // user to commit them there (v1 does not auto-commit other repos).
    noticeExternalArtifacts(cwd, featureCode, gitToplevel(agentCwd));

    return {
      phase: 'ship',
      artifact: sha ?? '',
      outcome: 'complete',
      summary: sha
        ? `Committed ${sha.slice(0, 8)}: ${commitMsg} (${stagedFiles.length} files)`
        : `Committed: ${commitMsg} (${stagedFiles.length} files)`,
      commit: sha,
      filesChanged,
      // COMP-MODEL-AB: thread structured test counts into the step result so the
      // main loop can persist them to build-history.jsonl for metrics consumers.
      // Only present when testSummary.parsed=true (framework detected + output parsed).
      ...(testSummary.parsed ? { test_count: testSummary.test_count, pass_rate: testSummary.pass_rate } : {}),
      ...(completionWarning ? { completionWarning } : {}),
    };

  } catch (err) {
    return {
      phase: 'ship',
      artifact: '',
      outcome: 'failed',
      summary: `Ship failed: ${err.message}`,
    };
  }
}

export async function startFresh(stratum, specYaml, featureCode, description, dataDir, templateName, mode = 'feature', preMergeGate, roles, workspaceRoot) {
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
  const response = await stratum.plan(specYaml, flowName, planInputs, { workspaceRoot });

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
 * @returns {Promise<object|null>} resolved gate or null (server lost mid-poll)
 */
async function pollGateResolution(visionWriter, gateId, intervalMs = 2000) {
  let consecutiveFailures = 0;
  while (true) {
    try {
      const gate = await visionWriter.getGate(gateId, { requireServer: true });
      consecutiveFailures = 0;
      if (!gate) throw new Error(`Gate ${gateId} not found (404)`);
      if (gate.status === 'expired') throw new Error(`Gate ${gateId} expired`);
      if (gate.status !== 'pending') return gate;
    } catch (err) {
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
    await new Promise(r => setTimeout(r, intervalMs));
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

export async function abortBuild(dataDir, featureCode, cwd, opts = {}) {
  const active = readActiveBuild(dataDir);
  if (!active) {
    console.log('No active build to abort.');
    return;
  }

  if (featureCode && active.featureCode !== featureCode) {
    console.log(`Active build is for ${active.featureCode}, not ${featureCode}.`);
    return;
  }

  console.log(`Aborting build for ${active.featureCode}...`);

  // Probe the persisted TS run before abandoning the local build. Foreground TS
  // runs advance only through this client, so closing it prevents more dispatch.
  const stratum = opts.stratum ?? new StratumMcpClient();
  const connection = resolveStratumMcpConnection(cwd);
  try {
    await stratum.connect(connection);
    const audit = await stratum.audit(active.flowId);
    if (isTerminalFlow(audit.status)) {
      console.log(`Flow already ${audit.status}.`);
    }
  } catch {
    // A missing/unreadable run does not prevent local cleanup.
  } finally {
    await stratum.close();
  }

  // Update vision state
  const visionWriter = new VisionWriter(dataDir);
  const item = await visionWriter.findFeatureItem(active.featureCode);
  const itemId = item?.id;
  if (itemId) {
    await visionWriter.updateItemStatus(itemId, 'killed');
  }

  // Write terminal state (file retained per STRAT-COMP-4 contract)
  writeActiveBuild(dataDir, { ...active, status: 'aborted', completedAt: new Date().toISOString() });
  console.log('Build aborted.');
}
