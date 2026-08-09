/**
 * ambient-context.test.js — Tests for COMP-CTX (Ambient Context Layer)
 *
 * Covers:
 *   - Item 100: docs/context/ scaffolding in compose init + prompt injection
 *   - Item 101: Staleness warnings in gate context (now derivation-based,
 *     lib/lineage.js findStaleArtifacts; the phase-marker lib/staleness.js was removed)
 *   - Item 102: Decision log append (appendDecisionEntry via build.js integration)
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  buildStepPrompt, buildGateContext, loadAmbientContext, clearAmbientContextCache,
} from '../lib/step-prompt.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_BIN = join(REPO_ROOT, 'bin', 'compose.js');

const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'compose-ctx-'));
  temps.push(d);
  return d;
}
function makeEnv(cwd, home) {
  return { ...process.env, HOME: home };
}
function runCmd(cmd, cwd, env, extraArgs = []) {
  return execFileSync(process.execPath, [COMPOSE_BIN, cmd, ...extraArgs], {
    cwd, env, encoding: 'utf-8',
  });
}

// ---------------------------------------------------------------------------
// Item 100 — compose init scaffolds docs/context/
// ---------------------------------------------------------------------------

describe('compose init — ambient context scaffold', () => {
  test('creates docs/context/ directory', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    assert.ok(existsSync(join(cwd, 'docs', 'context')), 'docs/context/ should exist');
  });

  test('creates tech-stack.md with template content', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    const p = join(cwd, 'docs', 'context', 'tech-stack.md');
    assert.ok(existsSync(p), 'tech-stack.md should exist');
    const content = readFileSync(p, 'utf-8');
    assert.ok(content.includes('# Tech Stack'), 'should have heading');
  });

  test('creates conventions.md with template content', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    const p = join(cwd, 'docs', 'context', 'conventions.md');
    assert.ok(existsSync(p), 'conventions.md should exist');
    const content = readFileSync(p, 'utf-8');
    assert.ok(content.includes('# Conventions'), 'should have heading');
  });

  test('creates decisions.md with template content', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    const p = join(cwd, 'docs', 'context', 'decisions.md');
    assert.ok(existsSync(p), 'decisions.md should exist');
    const content = readFileSync(p, 'utf-8');
    assert.ok(content.includes('# Decision Log'), 'should have heading');
  });

  test('does not overwrite existing context files on re-init', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    const env = makeEnv(cwd, home);
    runCmd('init', cwd, env);

    // Customize tech-stack.md
    const tsPath = join(cwd, 'docs', 'context', 'tech-stack.md');
    writeFileSync(tsPath, '# Tech Stack\n\nNode 22, Postgres 16\n');

    // Re-init
    runCmd('init', cwd, env);

    const content = readFileSync(tsPath, 'utf-8');
    assert.ok(content.includes('Node 22'), 'custom content should be preserved on re-init');
  });

  test('compose.json has paths.context = "docs/context"', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    const config = JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf-8'));
    assert.equal(config.paths.context, 'docs/context');
  });
});

// ---------------------------------------------------------------------------
// Item 100 — loadAmbientContext + buildStepPrompt injection
// ---------------------------------------------------------------------------

describe('loadAmbientContext', () => {
  test('returns null when contextDir does not exist', () => {
    const result = loadAmbientContext('/nonexistent/path/xyz123');
    assert.equal(result, null);
  });

  test('returns null when contextDir has no .md files', () => {
    const dir = tmpDir();
    const result = loadAmbientContext(dir);
    assert.equal(result, null);
  });

  test('returns concatenated contents of .md files', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'tech-stack.md'), '# Tech Stack\n\nNode 22');
    writeFileSync(join(dir, 'conventions.md'), '# Conventions\n\nUse ESM');
    // Clear cache so fresh read happens
    clearAmbientContextCache(dir);
    const result = loadAmbientContext(dir);
    assert.ok(result.includes('# Tech Stack'), 'should include tech-stack');
    assert.ok(result.includes('# Conventions'), 'should include conventions');
  });

  test('sorts files alphabetically', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'z-last.md'), 'Z content');
    writeFileSync(join(dir, 'a-first.md'), 'A content');
    clearAmbientContextCache(dir);
    const result = loadAmbientContext(dir);
    assert.ok(result.indexOf('A content') < result.indexOf('Z content'), 'files should be sorted');
  });

  test('caches result so second call returns same value without re-reading', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'info.md'), '# Info\n\nOriginal');
    clearAmbientContextCache(dir);
    const first = loadAmbientContext(dir);
    // Overwrite file — cache should still return original
    writeFileSync(join(dir, 'info.md'), '# Info\n\nModified');
    const second = loadAmbientContext(dir);
    assert.equal(first, second, 'should return cached value');
  });

  test('clearAmbientContextCache invalidates cache', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'info.md'), '# Info\n\nVersion1');
    clearAmbientContextCache(dir);
    loadAmbientContext(dir);
    writeFileSync(join(dir, 'info.md'), '# Info\n\nVersion2');
    clearAmbientContextCache(dir);
    const result = loadAmbientContext(dir);
    assert.ok(result.includes('Version2'), 'should re-read after cache clear');
  });
});

describe('buildStepPrompt — ambient context injection', () => {
  const dispatch = {
    step_id: 'test-step',
    intent: 'Do a thing',
    inputs: {},
    output_fields: [],
    ensure: [],
  };

  test('includes ## Project Context section when contextDir has files', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'tech-stack.md'), '# Tech Stack\n\nNode 22');
    clearAmbientContextCache(dir);
    const prompt = buildStepPrompt(dispatch, {
      cwd: '/some/dir',
      featureCode: 'FEAT-1',
      contextDir: dir,
    });
    assert.ok(prompt.includes('## Project Context'), 'should have Project Context section');
    assert.ok(prompt.includes('Node 22'), 'should contain context file content');
  });

  test('omits ## Project Context section when contextDir is absent', () => {
    const prompt = buildStepPrompt(dispatch, {
      cwd: '/some/dir',
      featureCode: 'FEAT-1',
    });
    assert.ok(!prompt.includes('## Project Context'), 'should not have Project Context section');
  });

  test('Project Context appears before ## Context section', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'info.md'), '# Info\n\nSome context');
    clearAmbientContextCache(dir);
    const prompt = buildStepPrompt(dispatch, {
      cwd: '/some/dir',
      featureCode: 'FEAT-1',
      contextDir: dir,
    });
    const projIdx = prompt.indexOf('## Project Context');
    const ctxIdx = prompt.indexOf('## Context');
    assert.ok(projIdx < ctxIdx, '## Project Context should appear before ## Context');
  });
});

// ---------------------------------------------------------------------------
// Staleness warnings in gate context — now derivation-based (COMP-PROV-LINEAGE).
// The phase-marker reader (lib/staleness.js) was removed; the model-level
// staleness tests live in test/lineage.test.js. These cover only the gate-
// context surface, which now uses findStaleArtifacts.
// ---------------------------------------------------------------------------

describe('buildGateContext — staleness warnings', () => {
  const gateDispatch = {
    step_id: 'gate-review',
    on_approve: 'build',
    on_revise: 'explore_design',
    on_kill: 'kill',
  };
  const BASE = new Date('2026-01-01T00:00:00Z');
  const writeAt = (dir, file, content, offsetSec) => {
    const p = join(dir, file);
    writeFileSync(p, content);
    const t = new Date(BASE.getTime() + offsetSec * 1000);
    utimesSync(p, t, t);
  };

  test('includes Stale Artifacts when a descendant is older than its upstream', () => {
    const featureDir = tmpDir();
    writeAt(featureDir, 'blueprint.md', '# Blueprint\n', 10);
    writeAt(featureDir, 'design.md', '# Design (edited)\n', 100);

    const context = { cwd: '/some/dir', featureCode: 'FEAT-1', featureDir, stepHistory: [] };
    const result = buildGateContext(gateDispatch, context, { toPhase: 'build' });

    assert.ok(result.includes('## Stale Artifacts'), 'should include stale artifacts section');
    assert.ok(result.includes('blueprint.md'), 'should mention the stale file');
    assert.ok(result.includes('design.md'), 'should name the newer upstream');
  });

  test('omits Stale Artifacts when all artifacts are fresh', () => {
    const featureDir = tmpDir();
    writeAt(featureDir, 'design.md', '# Design\n', 10);
    writeAt(featureDir, 'blueprint.md', '# Blueprint\n', 100);

    const context = { cwd: '/some/dir', featureCode: 'FEAT-1', featureDir, stepHistory: [] };
    const result = buildGateContext(gateDispatch, context, { toPhase: 'build' });

    assert.ok(!result.includes('## Stale Artifacts'), 'should not include stale artifacts section');
  });

  test('omits Stale Artifacts when context has no featureDir', () => {
    const context = { cwd: '/some/dir', featureCode: 'FEAT-1', stepHistory: [] };
    const result = buildGateContext(gateDispatch, context, { toPhase: 'build' });
    assert.ok(!result.includes('## Stale Artifacts'), 'no featureDir → no staleness section');
  });

  test('is phase-independent — shows staleness even with no toPhase', () => {
    const featureDir = tmpDir();
    writeAt(featureDir, 'blueprint.md', '# Blueprint\n', 10);
    writeAt(featureDir, 'design.md', '# Design (edited)\n', 100);

    const context = { cwd: '/some/dir', featureCode: 'FEAT-1', featureDir, stepHistory: [] };
    const result = buildGateContext(gateDispatch, context, {});
    assert.ok(result.includes('## Stale Artifacts'), 'derivation staleness does not need toPhase');
  });
});

// ---------------------------------------------------------------------------
// Item 102 — Decision log (verified via decisions.md file content)
// ---------------------------------------------------------------------------

describe('decision log — decisions.md append', () => {
  test('decisions.md is created by compose init', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    assert.ok(existsSync(join(cwd, 'docs', 'context', 'decisions.md')));
  });

  test('decisions.md starts with # Decision Log heading', () => {
    const cwd = tmpDir();
    const home = tmpDir();
    runCmd('init', cwd, makeEnv(cwd, home));
    const content = readFileSync(join(cwd, 'docs', 'context', 'decisions.md'), 'utf-8');
    assert.ok(content.startsWith('# Decision Log'), 'should start with # Decision Log');
  });
});
