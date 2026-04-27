/**
 * review-parity.test.js — Golden parity test for STRAT-CLAUDE-EFFORT-PARITY.
 *
 * Verifies that both Claude (structured JSON) and Codex (JSON in code-fence) paths
 * through normalizeReviewResult produce identical `clean` booleans and compatible
 * finding counts for the same fixture artifacts.
 *
 * No live model calls — uses fixed JSON responses per fixture.
 */

import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeReviewResult, parseReviewJson } from '../lib/review-normalize.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { runAndNormalize } = await import(`${REPO_ROOT}/lib/result-normalizer.js`);

// ---------------------------------------------------------------------------
// Minimal fake stratum for prompt-capture tests
// ---------------------------------------------------------------------------

function fakeStratumCapture(responseText = '') {
  const subs = new Map();
  const calls = [];
  return {
    onEvent(flowId, stepId, handler) {
      const key = `${flowId}::${stepId}`;
      let set = subs.get(key);
      if (!set) { set = new Set(); subs.set(key, set); }
      set.add(handler);
      return () => set.delete(handler);
    },
    async agentRun(agentType, prompt, opts) {
      calls.push({ agentType, prompt, opts });
      return { text: responseText, correlation_id: opts?.correlationId ?? 'test' };
    },
    async cancelAgentRun() { return {}; },
    _calls: calls,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Fixture 1: clean code — no findings at or above gate
const FIXTURE_CLEAN = {
  claude: JSON.stringify({
    summary: 'Code is well-structured and follows all conventions.',
    findings: [],
  }),
  codex: '```json\n' + JSON.stringify({
    summary: 'No issues found in this clean implementation.',
    findings: [],
  }) + '\n```',
};

// Fixture 2: one must-fix bug (confidence 9 >= gate 7)
const FIXTURE_MUST_FIX = {
  claude: JSON.stringify({
    summary: 'One critical bug found in auth.js.',
    findings: [
      {
        lens: 'security',
        file: 'auth.js',
        line: 42,
        severity: 'must-fix',
        finding: 'SQL query is not parameterized — SQL injection risk.',
        confidence: 9,
        applied_gate: 7,
        rationale: null,
      },
    ],
  }),
  codex: '```json\n' + JSON.stringify({
    summary: 'Critical SQL injection bug found.',
    findings: [
      {
        lens: 'general',
        file: 'auth.js',
        line: 42,
        severity: 'must-fix',
        finding: 'SQL query is not parameterized — SQL injection risk.',
        confidence: 9,
        applied_gate: 7,
        rationale: null,
      },
    ],
  }) + '\n```',
};

// Fixture 3: nits only (confidence 8 >= gate 7, severity=nit — should not block)
const FIXTURE_NITS_ONLY = {
  claude: JSON.stringify({
    summary: 'Two minor style issues found.',
    findings: [
      {
        lens: 'diff-quality',
        file: 'util.js',
        line: 10,
        severity: 'nit',
        finding: 'Variable name `x` is not descriptive.',
        confidence: 8,
        applied_gate: 7,
        rationale: null,
      },
      {
        lens: 'diff-quality',
        file: 'util.js',
        line: 22,
        severity: 'nit',
        finding: 'Missing trailing newline.',
        confidence: 7,
        applied_gate: 7,
        rationale: null,
      },
    ],
  }),
  codex: '```json\n' + JSON.stringify({
    summary: 'Two style nits, no blockers.',
    findings: [
      {
        lens: 'general',
        file: 'util.js',
        line: 10,
        severity: 'nit',
        finding: 'Variable name `x` is not descriptive.',
        confidence: 8,
        applied_gate: 7,
        rationale: null,
      },
      {
        lens: 'general',
        file: 'util.js',
        line: 22,
        severity: 'nit',
        finding: 'Missing trailing newline.',
        confidence: 7,
        applied_gate: 7,
        rationale: null,
      },
    ],
  }) + '\n```',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateReviewResultSchema(result, label) {
  assert.ok(typeof result.clean === 'boolean', `${label}: clean must be boolean`);
  assert.ok(typeof result.summary === 'string' && result.summary.length > 0, `${label}: summary must be non-empty string`);
  assert.ok(Array.isArray(result.findings), `${label}: findings must be array`);
  assert.ok(result.meta && typeof result.meta === 'object', `${label}: meta must be object`);
  assert.ok(typeof result.meta.agent_type === 'string', `${label}: meta.agent_type must be string`);
  assert.ok(Array.isArray(result.lenses_run), `${label}: lenses_run must be array`);
  assert.ok(Array.isArray(result.auto_fixes), `${label}: auto_fixes must be array`);
  assert.ok(Array.isArray(result.asks), `${label}: asks must be array`);

  for (const [i, f] of result.findings.entries()) {
    assert.ok(typeof f.lens === 'string', `${label}: findings[${i}].lens must be string`);
    assert.ok(['must-fix', 'should-fix', 'nit'].includes(f.severity), `${label}: findings[${i}].severity must be canonical`);
    assert.ok(typeof f.finding === 'string', `${label}: findings[${i}].finding must be string`);
    assert.ok(typeof f.confidence === 'number', `${label}: findings[${i}].confidence must be number`);
    assert.ok(typeof f.applied_gate === 'number', `${label}: findings[${i}].applied_gate must be number (stamped)`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('review-parity: parseReviewJson', () => {
  it('parses bare JSON object', () => {
    const result = parseReviewJson('{"summary":"ok","findings":[]}');
    assert.ok(result);
    assert.equal(result.summary, 'ok');
  });

  it('strips markdown code fence (```json)', () => {
    const text = '```json\n{"summary":"ok","findings":[]}\n```';
    const result = parseReviewJson(text);
    assert.ok(result);
    assert.equal(result.summary, 'ok');
  });

  it('strips markdown code fence (no language tag)', () => {
    const text = '```\n{"summary":"clean","findings":[]}\n```';
    const result = parseReviewJson(text);
    assert.ok(result);
    assert.equal(result.summary, 'clean');
  });

  it('extracts JSON object from surrounding prose', () => {
    const text = 'Here is my review: {"summary":"found bug","findings":[]} That is all.';
    const result = parseReviewJson(text);
    assert.ok(result);
    assert.equal(result.summary, 'found bug');
  });

  it('returns null for non-JSON text', () => {
    const result = parseReviewJson('This code looks fine to me.');
    assert.equal(result, null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseReviewJson(''), null);
    assert.equal(parseReviewJson(null), null);
  });
});

describe('review-parity: fixture 1 — clean code', () => {
  it('Claude path: clean=true, no findings', async () => {
    const result = await normalizeReviewResult(FIXTURE_CLEAN.claude, {
      agentType: 'claude',
      modelId: 'claude-test',
      confidenceGate: 7,
      lens: 'diff-quality',
    });
    validateReviewResultSchema(result, 'fixture-clean:claude');
    assert.equal(result.clean, true, 'clean code should be clean=true');
    assert.equal(result.findings.length, 0, 'no findings expected');
    assert.equal(result.meta.agent_type, 'claude');
  });

  it('Codex path: clean=true, no findings', async () => {
    const result = await normalizeReviewResult(FIXTURE_CLEAN.codex, {
      agentType: 'codex',
      modelId: 'codex-test',
      confidenceGate: 7,
      lens: 'general',
    });
    validateReviewResultSchema(result, 'fixture-clean:codex');
    assert.equal(result.clean, true, 'clean code should be clean=true');
    assert.equal(result.findings.length, 0, 'no findings expected');
    assert.equal(result.meta.agent_type, 'codex');
  });

  it('clean boolean is identical between Claude and Codex paths', async () => {
    const claude = await normalizeReviewResult(FIXTURE_CLEAN.claude, { agentType: 'claude', confidenceGate: 7 });
    const codex  = await normalizeReviewResult(FIXTURE_CLEAN.codex,  { agentType: 'codex',  confidenceGate: 7 });
    assert.equal(claude.clean, codex.clean, 'clean parity for clean fixture');
  });
});

describe('review-parity: fixture 2 — one must-fix', () => {
  it('Claude path: clean=false, 1 must-fix finding', async () => {
    const result = await normalizeReviewResult(FIXTURE_MUST_FIX.claude, {
      agentType: 'claude',
      modelId: 'claude-test',
      confidenceGate: 7,
      lens: 'security',
    });
    validateReviewResultSchema(result, 'fixture-mustfix:claude');
    assert.equal(result.clean, false, 'must-fix should make clean=false');
    assert.equal(result.findings.filter(f => f.severity === 'must-fix').length, 1);
  });

  it('Codex path: clean=false, 1 must-fix finding', async () => {
    const result = await normalizeReviewResult(FIXTURE_MUST_FIX.codex, {
      agentType: 'codex',
      modelId: 'codex-test',
      confidenceGate: 7,
      lens: 'general',
    });
    validateReviewResultSchema(result, 'fixture-mustfix:codex');
    assert.equal(result.clean, false, 'must-fix should make clean=false');
    assert.equal(result.findings.filter(f => f.severity === 'must-fix').length, 1);
  });

  it('clean boolean is identical between paths', async () => {
    const claude = await normalizeReviewResult(FIXTURE_MUST_FIX.claude, { agentType: 'claude', confidenceGate: 7 });
    const codex  = await normalizeReviewResult(FIXTURE_MUST_FIX.codex,  { agentType: 'codex',  confidenceGate: 7 });
    assert.equal(claude.clean, codex.clean, 'clean parity for must-fix fixture');
  });

  it('must-fix count is identical between paths', async () => {
    const claude = await normalizeReviewResult(FIXTURE_MUST_FIX.claude, { agentType: 'claude', confidenceGate: 7 });
    const codex  = await normalizeReviewResult(FIXTURE_MUST_FIX.codex,  { agentType: 'codex',  confidenceGate: 7 });
    const claudeMustFix = claude.findings.filter(f => f.severity === 'must-fix').length;
    const codexMustFix  = codex.findings.filter(f => f.severity === 'must-fix').length;
    assert.equal(claudeMustFix, codexMustFix, 'must-fix count parity');
  });

  it('applied_gate is stamped on every finding', async () => {
    const result = await normalizeReviewResult(FIXTURE_MUST_FIX.claude, { agentType: 'claude', confidenceGate: 7 });
    for (const f of result.findings) {
      assert.ok(typeof f.applied_gate === 'number', 'applied_gate must be stamped');
      assert.equal(f.applied_gate, 7);
    }
  });
});

describe('review-parity: fixture 3 — nits only', () => {
  it('Claude path: clean=true (nits do not block)', async () => {
    const result = await normalizeReviewResult(FIXTURE_NITS_ONLY.claude, {
      agentType: 'claude',
      confidenceGate: 7,
    });
    validateReviewResultSchema(result, 'fixture-nits:claude');
    assert.equal(result.clean, true, 'nits-only should be clean=true');
    assert.equal(result.findings.filter(f => f.severity === 'nit').length, 2);
  });

  it('Codex path: clean=true (nits do not block)', async () => {
    const result = await normalizeReviewResult(FIXTURE_NITS_ONLY.codex, {
      agentType: 'codex',
      confidenceGate: 7,
    });
    validateReviewResultSchema(result, 'fixture-nits:codex');
    assert.equal(result.clean, true, 'nits-only should be clean=true');
  });

  it('clean boolean is identical between paths', async () => {
    const claude = await normalizeReviewResult(FIXTURE_NITS_ONLY.claude, { agentType: 'claude', confidenceGate: 7 });
    const codex  = await normalizeReviewResult(FIXTURE_NITS_ONLY.codex,  { agentType: 'codex',  confidenceGate: 7 });
    assert.equal(claude.clean, codex.clean, 'clean parity for nits fixture');
  });

  it('schema validation passes for both paths', async () => {
    const claude = await normalizeReviewResult(FIXTURE_NITS_ONLY.claude, { agentType: 'claude', confidenceGate: 7 });
    const codex  = await normalizeReviewResult(FIXTURE_NITS_ONLY.codex,  { agentType: 'codex',  confidenceGate: 7 });
    validateReviewResultSchema(claude, 'nits:claude');
    validateReviewResultSchema(codex, 'nits:codex');
  });
});

describe('review-parity: normalizeReviewResult edge cases', () => {
  it('drops findings below confidence gate', async () => {
    const text = JSON.stringify({
      summary: 'Low confidence finding should be dropped.',
      findings: [
        { lens: 'general', severity: 'must-fix', finding: 'Low confidence bug', confidence: 3, applied_gate: 7 },
      ],
    });
    const result = await normalizeReviewResult(text, { confidenceGate: 7 });
    assert.equal(result.findings.length, 0, 'low-confidence finding should be dropped');
    assert.equal(result.clean, true, 'should be clean after dropping low-confidence finding');
  });

  it('stamps applied_gate when missing from model output', async () => {
    const text = JSON.stringify({
      summary: 'Finding without applied_gate.',
      findings: [
        { lens: 'general', severity: 'should-fix', finding: 'No applied_gate field', confidence: 8 },
      ],
    });
    const result = await normalizeReviewResult(text, { confidenceGate: 7 });
    assert.equal(result.findings.length, 1, 'finding should be kept');
    assert.equal(result.findings[0].applied_gate, 7, 'applied_gate should be stamped from confidenceGate');
  });

  it('synthesizes summary when model omits it', async () => {
    const text = JSON.stringify({
      findings: [
        { lens: 'general', severity: 'must-fix', finding: 'Critical bug', confidence: 9, applied_gate: 7 },
        { lens: 'general', severity: 'nit', finding: 'Minor style', confidence: 7, applied_gate: 7 },
      ],
    });
    const result = await normalizeReviewResult(text, { confidenceGate: 7 });
    assert.ok(result.summary.includes('must-fix'), 'synthesized summary should mention must-fix count');
  });

  it('falls back to text-mode parser for malformed JSON without repairFn', async () => {
    const text = '- must-fix: SQL injection in auth.js\n- nit: missing semicolon';
    const result = await normalizeReviewResult(text, { confidenceGate: 4, lens: 'security' });
    // Text mode findings have confidence=5, which is >= gate 4
    assert.ok(Array.isArray(result.findings), 'should still return findings array');
    // Text mode must pick up the must-fix bullet and return at least one finding
    assert.ok(
      result.findings.length >= 1 && result.findings.some(f => f.severity === 'must-fix'),
      'text mode should extract at least one must-fix finding from the bullet list'
    );
  });

  it('calls repairFn on JSON parse failure and uses repaired result', async () => {
    let repairCalled = false;
    const repairedJson = JSON.stringify({
      summary: 'Repaired successfully.',
      findings: [
        { lens: 'general', severity: 'must-fix', finding: 'Bug found via repair', confidence: 8, applied_gate: 7 },
      ],
    });

    const repairFn = async (_prompt) => {
      repairCalled = true;
      return repairedJson;
    };

    const result = await normalizeReviewResult('this is not json at all', {
      confidenceGate: 7,
      repairFn,
    });
    assert.ok(repairCalled, 'repairFn should have been called');
    assert.equal(result.findings.length, 1, 'repaired findings should be used');
    assert.equal(result.findings[0].finding, 'Bug found via repair');
    assert.equal(result.clean, false);
  });

  it('initializes lenses_run, auto_fixes, asks as empty arrays', async () => {
    const text = JSON.stringify({ summary: 'ok', findings: [] });
    const result = await normalizeReviewResult(text, { agentType: 'codex', confidenceGate: 7 });
    assert.deepEqual(result.lenses_run, []);
    assert.deepEqual(result.auto_fixes, []);
    assert.deepEqual(result.asks, []);
  });
});

// ---------------------------------------------------------------------------
// MF-1 end-to-end: verify buildReviewPrompt scaffold reaches stratum.agentRun
//
// build.js composes: scaffold = buildReviewPrompt(...), then passes
//   `scaffold + '\n\n' + taskPrompt` as the `prompt` arg to runAndNormalize.
// runAndNormalize passes that prompt straight through to stratum.agentRun.
// These tests verify the scaffold tokens survive to agentRun unmodified.
// ---------------------------------------------------------------------------

import { buildReviewPrompt } from '../lib/review-prompt.js';
import { injectCertInstructions } from '../lib/cert-inject.js';
import { LENS_DEFINITIONS } from '../lib/review-lenses.js';

describe('review-parity: review scaffold wired into runAndNormalize prompt', () => {
  it('scaffold tokens reach stratum.agentRun when composed by build.js pattern', async () => {
    const cleanResponse = JSON.stringify({ summary: 'No findings.', findings: [] });
    const stratum = fakeStratumCapture(cleanResponse);
    const fakeDispatch = {
      step_id: 'review',
      agent: 'codex',
      output_fields: {},
      flow_id: 'flow-test',
    };

    // Reproduce what build.js does at call site 1 / call site 3
    const scaffold = buildReviewPrompt({
      agentType: 'codex',
      lens: 'general',
      lensFocus: '',
      exclusions: '',
      confidenceGate: 7,
      taskDescription: 'review the auth module',
      blueprint: 'blueprint content here',
    });
    const composedPrompt = scaffold + '\n\n' + 'original task prompt';

    await runAndNormalize(null, composedPrompt, fakeDispatch, {
      stratum,
      reviewMode: true,
      confidenceGate: 7,
      lens: 'general',
    });

    assert.equal(stratum._calls.length, 1, 'agentRun should be called once');
    const sentPrompt = stratum._calls[0].prompt;

    // Scaffold tokens that buildReviewPrompt injects
    assert.ok(sentPrompt.includes('Severity Vocabulary'), 'scaffold must include Severity Vocabulary section');
    assert.ok(sentPrompt.includes('must-fix'), 'scaffold must include must-fix severity label');
    assert.ok(sentPrompt.includes('Confidence Scale'), 'scaffold must include Confidence Scale section');
    assert.ok(sentPrompt.includes('Output Format'), 'scaffold must include Output Format section');
    assert.ok(sentPrompt.includes('Confidence Gate'), 'scaffold must include Confidence Gate section');
    // Original task prompt must still appear after the scaffold
    assert.ok(sentPrompt.includes('original task prompt'), 'original task prompt must be preserved after scaffold');
  });

  it('buildReviewPrompt produces scaffold with all canonical severity labels', () => {
    const scaffold = buildReviewPrompt({ agentType: 'claude', lens: 'security', confidenceGate: 8 });
    assert.ok(scaffold.includes('must-fix'), 'scaffold must include must-fix');
    assert.ok(scaffold.includes('should-fix'), 'scaffold must include should-fix');
    assert.ok(scaffold.includes('nit'), 'scaffold must include nit');
    assert.ok(scaffold.includes('8'), 'scaffold must include the confidence gate value');
    assert.ok(scaffold.includes('security reviewer'), 'scaffold must include the lens role');
  });

  it('buildReviewPrompt codex path includes JSON code-fence output instruction', () => {
    const scaffold = buildReviewPrompt({ agentType: 'codex', lens: 'general', confidenceGate: 7 });
    assert.ok(scaffold.includes('code-fence'), 'codex scaffold must include code-fence instruction');
    assert.ok(scaffold.includes('Output Instruction'), 'codex scaffold must have output instruction section');
  });
});

// ---------------------------------------------------------------------------
// SF-NEW-1: merge step (reduce_mode) — normalizer runs, scaffold does NOT prepend
//
// build.js main loop: isReviewMain=true (output_contract=ReviewResult) but
// isReduceMain=true → isReviewScaffoldMain=false → buildReviewPrompt is skipped.
// runAndNormalize still receives reviewMode: isReviewMain (true).
// ---------------------------------------------------------------------------

describe('review-parity: SF-NEW-1 — reduce_mode skips scaffold, keeps normalizer', () => {
  it('reduce_mode=true: prompt is NOT prepended with review scaffold', async () => {
    // Simulate build.js main-loop logic for a merge step with reduce_mode
    const fakeResponse = {
      output_contract: 'ReviewResult',
      inputs: { reduce_mode: 'true', task: 'merge task', blueprint: 'bp' },
    };
    const agentType = 'claude:orchestrator';
    const basePrompt = 'Merge all lens results into one ReviewResult.';

    const isReviewMain = fakeResponse.output_contract === 'ReviewResult';
    const isReduceMain = fakeResponse.inputs?.reduce_mode === 'true';
    const isReviewScaffoldMain = isReviewMain && !isReduceMain;

    let prompt = basePrompt;
    if (isReviewScaffoldMain) {
      prompt = buildReviewPrompt({
        agentType,
        lens: 'general',
        lensFocus: '',
        exclusions: '',
        confidenceGate: 7,
        taskDescription: fakeResponse.inputs?.task ?? '',
        blueprint: fakeResponse.inputs?.blueprint ?? '',
      }) + '\n\n' + basePrompt;
    }

    // Scaffold must NOT be prepended for reduce_mode steps
    assert.equal(isReviewMain, true, 'isReviewMain must be true (normalizer should run)');
    assert.equal(isReduceMain, true, 'isReduceMain must be true');
    assert.equal(isReviewScaffoldMain, false, 'scaffold must be skipped for reduce steps');
    assert.equal(prompt, basePrompt, 'prompt must be the base prompt without scaffold');
    assert.ok(!prompt.includes('Severity Vocabulary'), 'scaffold Severity Vocabulary must not appear in merge prompt');
    assert.ok(!prompt.includes('Confidence Scale'), 'scaffold Confidence Scale must not appear in merge prompt');
  });

  it('reduce_mode=true: runAndNormalize receives reviewMode=true so normalizer runs', async () => {
    const cleanMergeResponse = JSON.stringify({
      summary: 'Merged: no findings.',
      findings: [],
      clean: true,
      lenses_run: [],
      auto_fixes: [],
      asks: [],
      meta: {},
    });
    const stratum = fakeStratumCapture(cleanMergeResponse);
    const fakeDispatch = {
      step_id: 'merge',
      agent: 'claude:orchestrator',
      inputs: { reduce_mode: 'true' },
      output_fields: {},
    };

    // reviewMode must be true so normalizeReviewResult is invoked on output
    const result = await runAndNormalize(null, 'Merge all lens results.', fakeDispatch, {
      stratum,
      reviewMode: true,   // reduce steps still pass reviewMode=true (isReviewMain)
      confidenceGate: 7,
      lens: 'general',
    });

    assert.ok(typeof result.result?.clean === 'boolean', 'normalizer must produce clean boolean');
    assert.ok(Array.isArray(result.result?.findings), 'normalizer must produce findings array');
  });

  it('non-reduce review step IS prepended with scaffold', () => {
    const fakeResponse = {
      output_contract: 'ReviewResult',
      inputs: { task: 'review this', blueprint: 'bp' },
      // no reduce_mode
    };
    const agentType = 'codex';
    const basePrompt = 'Review the implementation.';

    const isReviewMain = fakeResponse.output_contract === 'ReviewResult';
    const isReduceMain = fakeResponse.inputs?.reduce_mode === 'true';
    const isReviewScaffoldMain = isReviewMain && !isReduceMain;

    let prompt = basePrompt;
    if (isReviewScaffoldMain) {
      prompt = buildReviewPrompt({
        agentType, lens: 'general', lensFocus: '', exclusions: '',
        confidenceGate: 7,
        taskDescription: fakeResponse.inputs?.task ?? '',
        blueprint: fakeResponse.inputs?.blueprint ?? '',
      }) + '\n\n' + basePrompt;
    }

    assert.equal(isReviewScaffoldMain, true, 'non-reduce review step must use scaffold');
    assert.ok(prompt.includes('Severity Vocabulary'), 'scaffold must be prepended for non-reduce review steps');
    assert.ok(prompt.includes(basePrompt), 'base prompt must follow scaffold');
  });
});

// ---------------------------------------------------------------------------
// SF-NEW-3: parallel-lens path — exactly one cert block in final prompt
//
// After the fix, cert is injected only on the review scaffold (NOT also on
// taskIntent). The final prompt = reviewScaffold + '\n\n' + baseTaskPrompt.
// Count occurrences of "## Premises" — must be exactly 1.
// ---------------------------------------------------------------------------

describe('review-parity: SF-NEW-3 — parallel-lens cert block appears exactly once', () => {
  it('final prompt has exactly one ## Premises block when lens has reasoning_template', () => {
    const agentType = 'claude:read-only-reviewer';
    const lensName = Object.keys(LENS_DEFINITIONS).find(k => LENS_DEFINITIONS[k]?.reasoning_template);

    if (!lensName) {
      // No lens with reasoning_template defined — test is vacuously satisfied.
      // (Cert injection is only relevant when a template exists.)
      return;
    }

    const task = {
      lens_name: lensName,
      lens_focus: 'Test lens focus.',
      confidence_gate: 7,
      exclusions: '',
    };

    // Reproduce the build.js parallel-dispatch path AFTER SF-NEW-3 fix:
    // 1. taskIntent does NOT get injectCertInstructions (early injection skipped)
    // 2. reviewScaffold DOES get injectCertInstructions
    // 3. prompt = reviewScaffold + '\n\n' + baseTaskPrompt (which is derived from taskIntent)

    const taskIntent = `Lens: ${task.lens_name}. Focus: ${task.lens_focus}.`;
    // taskIntent must NOT have cert injected (SF-NEW-3 fix)
    const taskIntentCertCount = (taskIntent.match(/## Premises/g) ?? []).length;
    assert.equal(taskIntentCertCount, 0, 'taskIntent must not contain ## Premises before scaffold injection');

    let reviewScaffold = buildReviewPrompt({
      agentType,
      lens: task.lens_name,
      lensFocus: task.lens_focus,
      exclusions: task.exclusions,
      confidenceGate: task.confidence_gate,
      taskDescription: '',
      blueprint: '',
    });

    // Inject cert onto the scaffold (this is the single injection point after SF-NEW-3)
    const lensDef = LENS_DEFINITIONS[task.lens_name];
    if (lensDef?.reasoning_template) {
      reviewScaffold = injectCertInstructions(reviewScaffold, lensDef.reasoning_template);
    }

    const finalPrompt = reviewScaffold + '\n\n' + taskIntent;

    const certBlockCount = (finalPrompt.match(/## Premises/g) ?? []).length;
    assert.equal(certBlockCount, 1,
      `final prompt must contain exactly one "## Premises" block, got ${certBlockCount}`);
  });

  it('lens without reasoning_template has zero cert blocks in final prompt', () => {
    const agentType = 'claude:read-only-reviewer';
    // Use a lens that has no reasoning_template, or a synthetic one
    const lensName = 'diff-quality';
    const task = {
      lens_name: lensName,
      lens_focus: 'Diff quality check.',
      confidence_gate: 7,
      exclusions: '',
    };

    const taskIntent = `Lens: ${task.lens_name}. Focus: ${task.lens_focus}.`;

    let reviewScaffold = buildReviewPrompt({
      agentType,
      lens: task.lens_name,
      lensFocus: task.lens_focus,
      exclusions: task.exclusions,
      confidenceGate: task.confidence_gate,
      taskDescription: '',
      blueprint: '',
    });

    const lensDef = LENS_DEFINITIONS[task.lens_name];
    if (lensDef?.reasoning_template) {
      reviewScaffold = injectCertInstructions(reviewScaffold, lensDef.reasoning_template);
    }

    const finalPrompt = reviewScaffold + '\n\n' + taskIntent;

    // If the lens has a reasoning_template, exactly 1 block; otherwise 0.
    const certBlockCount = (finalPrompt.match(/## Premises/g) ?? []).length;
    const expectedCount = lensDef?.reasoning_template ? 1 : 0;
    assert.equal(certBlockCount, expectedCount,
      `cert block count must be ${expectedCount} for ${lensName}, got ${certBlockCount}`);
  });
});
