/**
 * capability-enforcement-block.test.js — Integration tests for COMP-AGENT-CAPS-5.
 *
 * Covers the end-to-end enforcement path:
 *   tool_use observed → checkCapabilityViolation → enforcement mode read → block throws / log emits
 *
 * Uses an inline reimplementation of the post-step enforcement block from build.js
 * (lines 763-794) so we can drive it with synthetic inputs without importing the
 * full build module (which has heavy side-effect imports).
 *
 * Pattern mirrors test/cross-model-review.test.js: makeStreamWriter + inline logic.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkCapabilityViolation } from '../lib/capability-checker.js';
import { StratumError } from '../lib/stratum-mcp-client.js';
import { BuildStreamWriter } from '../lib/build-stream-writer.js';

// ---------------------------------------------------------------------------
// Helpers — mirror patterns from cross-model-review.test.js
// ---------------------------------------------------------------------------

function makeStreamWriter() {
  const events = [];
  return {
    events,
    write(event) { events.push(event); },
    writeCapabilityProfile() {},
    writeViolation(stepId, agent, template, detail, severity) {
      events.push({ type: 'capability_violation', stepId, agent, template, detail, severity });
    },
    getEventsOfType(type) { return events.filter(e => e.type === type); },
  };
}

/**
 * Inline reimplementation of the capability enforcement block from build.js:763-794.
 *
 * Takes:
 *   observedTools  — array of { tool: string } (what the agent used)
 *   agentType      — agent string, e.g. 'claude:read-only-reviewer'
 *   stepId         — build step ID
 *   settingsPath   — path to settings.json (enforcement mode is read from here)
 *   streamWriter   — mock stream writer
 *
 * Returns { capViolations } on success; throws StratumError('CAPABILITY_VIOLATION') in block mode.
 */
async function runEnforcementBlock({ observedTools, agentType, stepId, settingsPath, streamWriter }) {
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
      // Mirror build.js: resolve template name for the event
      const templateName = agentType?.split(':')[1] ?? 'unknown';
      streamWriter.writeViolation(stepId, agentType, templateName, check.reason, check.severity);
    }
  }

  if (enforcement === 'block' && capViolations.length > 0) {
    const tools = capViolations.map(v => v.tool).join(', ');
    throw new StratumError('CAPABILITY_VIOLATION',
      `Step "${stepId}" used disallowed tools: ${tools}`, stepId);
  }

  return { capViolations, enforcement };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir;
let settingsPath;

before(() => {
  tmpDir = join(tmpdir(), `caps-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  settingsPath = join(tmpDir, 'settings.json');
});

after(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 1: enforcement: 'block' — disallowed tool throws StratumError
// ---------------------------------------------------------------------------

describe('capability enforcement: block mode', () => {
  it('throws StratumError(CAPABILITY_VIOLATION) when enforcement=block and disallowed tool used', async () => {
    // Write settings.json with block enforcement
    writeFileSync(settingsPath, JSON.stringify({ capabilities: { enforcement: 'block' } }), 'utf-8');

    const sw = makeStreamWriter();

    await assert.rejects(
      () => runEnforcementBlock({
        observedTools: [{ tool: 'Edit' }],   // Edit is in disallowedTools for read-only-reviewer
        agentType: 'claude:read-only-reviewer',
        stepId: 'review',
        settingsPath,
        streamWriter: sw,
      }),
      (err) => {
        assert.ok(err instanceof StratumError, 'error must be StratumError');
        assert.equal(err.code, 'CAPABILITY_VIOLATION', 'error code must be CAPABILITY_VIOLATION');
        assert.match(err.message, /disallowed tools/, 'message must mention disallowed tools');
        assert.match(err.message, /Edit/, 'message must include the offending tool name');
        return true;
      }
    );
  });

  it('still emits capability_violation event to stream before throwing in block mode', async () => {
    writeFileSync(settingsPath, JSON.stringify({ capabilities: { enforcement: 'block' } }), 'utf-8');

    const sw = makeStreamWriter();

    await assert.rejects(
      () => runEnforcementBlock({
        observedTools: [{ tool: 'Write' }],  // Write is disallowed for read-only-reviewer
        agentType: 'claude:read-only-reviewer',
        stepId: 'review',
        settingsPath,
        streamWriter: sw,
      })
    );

    const violations = sw.getEventsOfType('capability_violation');
    assert.equal(violations.length, 1, 'exactly one violation event emitted');
    assert.equal(violations[0].stepId, 'review');
    assert.equal(violations[0].severity, 'violation', 'severity field on stream event');
  });

  it('does not throw when block mode but no violations', async () => {
    writeFileSync(settingsPath, JSON.stringify({ capabilities: { enforcement: 'block' } }), 'utf-8');

    const sw = makeStreamWriter();

    // Read is in allowedTools for read-only-reviewer — no violation
    const result = await runEnforcementBlock({
      observedTools: [{ tool: 'Read' }],
      agentType: 'claude:read-only-reviewer',
      stepId: 'review',
      settingsPath,
      streamWriter: sw,
    });

    assert.equal(result.capViolations.length, 0, 'no violations for allowed tool');
    assert.equal(sw.getEventsOfType('capability_violation').length, 0, 'no violation events');
  });
});

// ---------------------------------------------------------------------------
// Test 2: enforcement: 'log' (default) — no throw, violation event emitted
// ---------------------------------------------------------------------------

describe('capability enforcement: log mode (default)', () => {
  it('does not throw when enforcement=log and disallowed tool used', async () => {
    writeFileSync(settingsPath, JSON.stringify({ capabilities: { enforcement: 'log' } }), 'utf-8');

    const sw = makeStreamWriter();

    // Must not throw
    const result = await runEnforcementBlock({
      observedTools: [{ tool: 'Edit' }],   // disallowed for read-only-reviewer
      agentType: 'claude:read-only-reviewer',
      stepId: 'review',
      settingsPath,
      streamWriter: sw,
    });

    assert.equal(result.enforcement, 'log', 'enforcement mode must be log');
    assert.equal(result.capViolations.length, 1, 'violation detected and recorded');
  });

  it('emits capability_violation event to stream in log mode', async () => {
    writeFileSync(settingsPath, JSON.stringify({ capabilities: { enforcement: 'log' } }), 'utf-8');

    const sw = makeStreamWriter();

    await runEnforcementBlock({
      observedTools: [{ tool: 'Edit' }],
      agentType: 'claude:read-only-reviewer',
      stepId: 'review',
      settingsPath,
      streamWriter: sw,
    });

    const violations = sw.getEventsOfType('capability_violation');
    assert.equal(violations.length, 1, 'exactly one capability_violation event emitted');
    assert.equal(violations[0].type, 'capability_violation');
    assert.equal(violations[0].stepId, 'review');
    assert.equal(violations[0].severity, 'violation', 'severity is violation for disallowedTools hit');
  });

  it('emits warning-severity event for tool not in allowedTools (not explicitly denied)', async () => {
    writeFileSync(settingsPath, JSON.stringify({ capabilities: { enforcement: 'log' } }), 'utf-8');

    const sw = makeStreamWriter();

    // TodoWrite is not in allowedTools and not in disallowedTools for read-only-reviewer
    await runEnforcementBlock({
      observedTools: [{ tool: 'TodoWrite' }],
      agentType: 'claude:read-only-reviewer',
      stepId: 'review',
      settingsPath,
      streamWriter: sw,
    });

    const violations = sw.getEventsOfType('capability_violation');
    assert.equal(violations.length, 1);
    assert.equal(violations[0].severity, 'warning', 'severity is warning for tools not in allowedTools');
  });

  it('defaults to log when settings.json is absent (no throw)', async () => {
    const absentPath = join(tmpDir, 'nonexistent-settings.json');

    const sw = makeStreamWriter();

    // Must not throw — falls back to log
    const result = await runEnforcementBlock({
      observedTools: [{ tool: 'Edit' }],
      agentType: 'claude:read-only-reviewer',
      stepId: 'review',
      settingsPath: absentPath,
      streamWriter: sw,
    });

    assert.equal(result.enforcement, 'log', 'should default to log when no settings file');
    assert.equal(result.capViolations.length, 1, 'violation still recorded');
  });
});

// ---------------------------------------------------------------------------
// Test 3: multiple violations in block mode — all tools reported in error
// ---------------------------------------------------------------------------

describe('capability enforcement: multiple violations', () => {
  it('reports all disallowed tools in block mode error message', async () => {
    writeFileSync(settingsPath, JSON.stringify({ capabilities: { enforcement: 'block' } }), 'utf-8');

    const sw = makeStreamWriter();

    await assert.rejects(
      () => runEnforcementBlock({
        observedTools: [{ tool: 'Edit' }, { tool: 'Write' }],
        agentType: 'claude:read-only-reviewer',
        stepId: 'review',
        settingsPath,
        streamWriter: sw,
      }),
      (err) => {
        assert.match(err.message, /Edit/, 'first tool in error');
        assert.match(err.message, /Write/, 'second tool in error');
        return true;
      }
    );

    // Both events emitted before throw
    assert.equal(sw.getEventsOfType('capability_violation').length, 2, 'both violations emitted to stream');
  });

  it('emits separate events for violation vs warning in log mode', async () => {
    writeFileSync(settingsPath, JSON.stringify({ capabilities: { enforcement: 'log' } }), 'utf-8');

    const sw = makeStreamWriter();

    // Edit = explicit disallowedTools → 'violation'; TodoWrite = not in allowedTools → 'warning'
    await runEnforcementBlock({
      observedTools: [{ tool: 'Edit' }, { tool: 'TodoWrite' }],
      agentType: 'claude:read-only-reviewer',
      stepId: 'review',
      settingsPath,
      streamWriter: sw,
    });

    const events = sw.getEventsOfType('capability_violation');
    assert.equal(events.length, 2, 'two events for two findings');

    const severities = events.map(e => e.severity).sort();
    assert.deepEqual(severities, ['violation', 'warning'], 'one violation + one warning');
  });
});

// ---------------------------------------------------------------------------
// Test 4: child-flow severity propagation — regression coverage for build.js:1973
// (Codex review finding: child-flow writeViolation must pass check.severity)
// ---------------------------------------------------------------------------

describe('child-flow writeViolation severity propagation', () => {
  it('BuildStreamWriter.writeViolation emits the provided severity field verbatim', () => {
    // Simulate what the child-flow path in build.js does after the CAPS-5 fix:
    //   streamWriter.writeViolation(stepId, agent, template, detail, check.severity)
    // before the fix, severity defaulted to 'violation' for warning-class findings.
    const writer = new BuildStreamWriter(tmpDir, 'TEST-FC', { truncate: true });

    writer.writeViolation('review', 'claude:read-only-reviewer', 'read-only-reviewer', 'TodoWrite: not in allowedTools', 'warning');
    writer.writeViolation('review', 'claude:read-only-reviewer', 'read-only-reviewer', 'Edit disallowed', 'violation');

    const lines = readFileSync(writer.filePath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));

    assert.equal(lines[0].type, 'capability_violation');
    assert.equal(lines[0].severity, 'warning', 'warning-class event must carry severity=warning');

    assert.equal(lines[1].type, 'capability_violation');
    assert.equal(lines[1].severity, 'violation', 'hard violation must carry severity=violation');
  });

  it('BuildStreamWriter.writeViolation defaults to violation when severity omitted (back-compat)', () => {
    const writer = new BuildStreamWriter(tmpDir, 'TEST-FC', { truncate: true });

    // Calling without 5th arg — legacy callers before CAPS-5
    writer.writeViolation('review', 'claude', 'unknown', 'some reason');

    const lines = readFileSync(writer.filePath, 'utf-8').trim().split('\n').map(l => JSON.parse(l));

    assert.equal(lines[0].severity, 'violation', 'default severity is violation when omitted');
  });
});

// ---------------------------------------------------------------------------
// Test 5: COMP-AGENT-CAPS-6 — child-flow block mode enforcement
// Mirrors the inline runEnforcementBlock pattern to test the child-flow path.
// The actual fix is in build.js:executeChildFlow; this test drives the same
// logic pattern to confirm child-flow block throws and log-mode does not.
// ---------------------------------------------------------------------------

/**
 * Child-flow enforcement block — extracted from build.js:executeChildFlow
 * (post-CAPS-6 fix). Same logic as runEnforcementBlock above but named
 * distinctly to document the child-flow code path.
 */
async function runChildFlowEnforcementBlock({ observedTools, agentType, stepId, settingsPath, streamWriter }) {
  const childTemplate = agentType?.split(':')[1] ?? 'unknown';

  const childCapViolations = [];
  for (const { tool } of observedTools) {
    const check = checkCapabilityViolation(tool, agentType);
    if (check.violation) {
      childCapViolations.push({ tool, severity: check.severity, reason: check.reason });
      if (streamWriter) {
        streamWriter.writeViolation(stepId, agentType, childTemplate, `${tool}: ${check.reason}`, check.severity);
      }
    }
  }

  const childEnforcement = (() => {
    try {
      if (existsSync(settingsPath)) {
        const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        return s?.capabilities?.enforcement ?? 'log';
      }
    } catch { /* degraded — default to log */ }
    return 'log';
  })();

  if (childEnforcement === 'block' && childCapViolations.length > 0) {
    const tools = childCapViolations.map(v => v.tool).join(', ');
    throw new StratumError('CAPABILITY_VIOLATION',
      `Child step "${stepId}" used disallowed tools: ${tools}`, stepId);
  }

  return { childCapViolations, childEnforcement };
}

describe('COMP-AGENT-CAPS-6: child-flow block mode enforcement', () => {
  it('throws StratumError(CAPABILITY_VIOLATION) in block mode for child-flow disallowed tool', async () => {
    writeFileSync(settingsPath, JSON.stringify({ capabilities: { enforcement: 'block' } }), 'utf-8');

    const sw = makeStreamWriter();

    await assert.rejects(
      () => runChildFlowEnforcementBlock({
        observedTools: [{ tool: 'Edit' }],
        agentType: 'claude:read-only-reviewer',
        stepId: 'review',
        settingsPath,
        streamWriter: sw,
      }),
      (err) => {
        assert.ok(err instanceof StratumError, 'must be StratumError');
        assert.equal(err.code, 'CAPABILITY_VIOLATION');
        assert.match(err.message, /Child step/, 'error must identify child-flow path');
        assert.match(err.message, /Edit/);
        return true;
      }
    );
  });

  it('does NOT throw in log mode for child-flow disallowed tool (pre-CAPS-6 behavior preserved)', async () => {
    writeFileSync(settingsPath, JSON.stringify({ capabilities: { enforcement: 'log' } }), 'utf-8');

    const sw = makeStreamWriter();

    const result = await runChildFlowEnforcementBlock({
      observedTools: [{ tool: 'Edit' }],
      agentType: 'claude:read-only-reviewer',
      stepId: 'review',
      settingsPath,
      streamWriter: sw,
    });

    assert.equal(result.childEnforcement, 'log');
    assert.equal(result.childCapViolations.length, 1, 'violation still recorded');
    assert.equal(sw.getEventsOfType('capability_violation').length, 1, 'violation event emitted');
  });

  it('emits violation event to stream before throwing in child-flow block mode', async () => {
    writeFileSync(settingsPath, JSON.stringify({ capabilities: { enforcement: 'block' } }), 'utf-8');

    const sw = makeStreamWriter();

    await assert.rejects(
      () => runChildFlowEnforcementBlock({
        observedTools: [{ tool: 'Write' }],
        agentType: 'claude:read-only-reviewer',
        stepId: 'review',
        settingsPath,
        streamWriter: sw,
      })
    );

    const violations = sw.getEventsOfType('capability_violation');
    assert.equal(violations.length, 1, 'stream event emitted before throw');
    assert.equal(violations[0].stepId, 'review');
  });

  it('does not throw in child-flow block mode when no violations', async () => {
    writeFileSync(settingsPath, JSON.stringify({ capabilities: { enforcement: 'block' } }), 'utf-8');

    const sw = makeStreamWriter();

    const result = await runChildFlowEnforcementBlock({
      observedTools: [{ tool: 'Read' }],   // Read is allowed for read-only-reviewer
      agentType: 'claude:read-only-reviewer',
      stepId: 'review',
      settingsPath,
      streamWriter: sw,
    });

    assert.equal(result.childCapViolations.length, 0, 'no violations for allowed tool');
  });
});
