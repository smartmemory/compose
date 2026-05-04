/**
 * mcp-enforcement.test.js — coverage for lib/mcp-enforcement.js
 * (COMP-MCP-MIGRATION-1).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readEnforcementMode,
  filterGuarded,
  isGuardedPath,
  expectedToolsForPath,
  scanGuarded,
  enforcementError,
} from '../lib/mcp-enforcement.js';

function freshDataDir() {
  const d = mkdtempSync(join(tmpdir(), 'mcp-enf-'));
  return d;
}

function writeSettings(dataDir, settings) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings), 'utf-8');
}

describe('readEnforcementMode', () => {
  test('off when no settings.json', () => {
    assert.equal(readEnforcementMode(freshDataDir()), 'off');
  });
  test('off when flag absent', () => {
    const d = freshDataDir(); writeSettings(d, { capabilities: { stratum: true } });
    assert.equal(readEnforcementMode(d), 'off');
  });
  test('block when flag is true', () => {
    const d = freshDataDir(); writeSettings(d, { enforcement: { mcpForFeatureMgmt: true } });
    assert.equal(readEnforcementMode(d), 'block');
  });
  test('log when flag is "log"', () => {
    const d = freshDataDir(); writeSettings(d, { enforcement: { mcpForFeatureMgmt: 'log' } });
    assert.equal(readEnforcementMode(d), 'log');
  });
  test('off on malformed JSON', () => {
    const d = freshDataDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'settings.json'), '{not valid', 'utf-8');
    assert.equal(readEnforcementMode(d), 'off');
  });
  test('off when flag is unknown string', () => {
    const d = freshDataDir(); writeSettings(d, { enforcement: { mcpForFeatureMgmt: 'random' } });
    assert.equal(readEnforcementMode(d), 'off');
  });
});

describe('isGuardedPath / filterGuarded', () => {
  test('matches ROADMAP.md and CHANGELOG.md', () => {
    assert.equal(isGuardedPath('ROADMAP.md', 'docs/features'), true);
    assert.equal(isGuardedPath('CHANGELOG.md', 'docs/features'), true);
  });
  test('matches feature.json under default features dir', () => {
    assert.equal(isGuardedPath('docs/features/X-1/feature.json', 'docs/features'), true);
  });
  test('matches feature.json under override', () => {
    assert.equal(isGuardedPath('specs/features/X-1/feature.json', 'specs/features'), true);
    assert.equal(isGuardedPath('docs/features/X-1/feature.json', 'specs/features'), false);
  });
  test('does not match unrelated paths', () => {
    assert.equal(isGuardedPath('README.md', 'docs/features'), false);
    assert.equal(isGuardedPath('src/index.js', 'docs/features'), false);
    assert.equal(isGuardedPath('docs/features/X-1/design.md', 'docs/features'), false);
  });
  test('filterGuarded picks only guarded paths', () => {
    const out = filterGuarded(
      ['README.md', 'ROADMAP.md', 'docs/features/A/feature.json', 'src/x.js'],
      'docs/features',
    );
    assert.deepEqual(out, ['ROADMAP.md', 'docs/features/A/feature.json']);
  });
});

describe('expectedToolsForPath', () => {
  test('ROADMAP.md', () => {
    assert.deepEqual(
      expectedToolsForPath('ROADMAP.md', 'docs/features'),
      ['add_roadmap_entry', 'set_feature_status', 'propose_followup'],
    );
  });
  test('CHANGELOG.md', () => {
    assert.deepEqual(
      expectedToolsForPath('CHANGELOG.md', 'docs/features'),
      ['add_changelog_entry'],
    );
  });
  test('feature.json — full set', () => {
    const tools = expectedToolsForPath('docs/features/X-1/feature.json', 'docs/features');
    assert.ok(tools.includes('add_roadmap_entry'));
    assert.ok(tools.includes('set_feature_status'));
    assert.ok(tools.includes('record_completion'));
    assert.ok(tools.includes('link_features'));
    assert.ok(tools.includes('link_artifact'));
    assert.ok(tools.includes('propose_followup'));
  });
  test('non-guarded → empty', () => {
    assert.deepEqual(expectedToolsForPath('README.md', 'docs/features'), []);
  });
});

describe('scanGuarded', () => {
  const featuresDir = 'docs/features';

  test('no guarded paths → no violations', () => {
    const r = scanGuarded({
      dirtyFiles: ['README.md', 'src/x.js'],
      featuresDir,
      buildId: 'B',
      events: [],
    });
    assert.deepEqual(r.violations, []);
  });

  test('guarded path with matching event → no violation', () => {
    const r = scanGuarded({
      dirtyFiles: ['ROADMAP.md'],
      featuresDir,
      buildId: 'B',
      events: [{ tool: 'add_roadmap_entry', build_id: 'B' }],
    });
    assert.deepEqual(r.violations, []);
  });

  test('guarded path with no matching event → violation', () => {
    const r = scanGuarded({
      dirtyFiles: ['ROADMAP.md'],
      featuresDir,
      buildId: 'B',
      events: [],
    });
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].path, 'ROADMAP.md');
  });

  test('event with different build_id does NOT satisfy', () => {
    const r = scanGuarded({
      dirtyFiles: ['ROADMAP.md'],
      featuresDir,
      buildId: 'B',
      events: [{ tool: 'add_roadmap_entry', build_id: 'OTHER' }],
    });
    assert.equal(r.violations.length, 1);
  });

  test('event with null build_id does NOT satisfy', () => {
    const r = scanGuarded({
      dirtyFiles: ['ROADMAP.md'],
      featuresDir,
      buildId: 'B',
      events: [{ tool: 'add_roadmap_entry', build_id: null }],
    });
    assert.equal(r.violations.length, 1);
  });

  test('mixed: one violation, one satisfied', () => {
    const r = scanGuarded({
      dirtyFiles: ['ROADMAP.md', 'CHANGELOG.md'],
      featuresDir,
      buildId: 'B',
      events: [{ tool: 'add_changelog_entry', build_id: 'B' }],
    });
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].path, 'ROADMAP.md');
  });
});

describe('scanGuarded — code correlation for feature.json paths', () => {
  const featuresDir = 'docs/features';

  test('feature.json edit blessed only by an event with matching code', () => {
    const r = scanGuarded({
      dirtyFiles: ['docs/features/B/feature.json'],
      featuresDir,
      buildId: 'B',
      events: [{ tool: 'set_feature_status', code: 'A', build_id: 'B' }],  // wrong code
    });
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].path, 'docs/features/B/feature.json');
  });

  test('feature.json edit passes when code matches', () => {
    const r = scanGuarded({
      dirtyFiles: ['docs/features/B/feature.json'],
      featuresDir,
      buildId: 'B',
      events: [{ tool: 'set_feature_status', code: 'B', build_id: 'B' }],
    });
    assert.deepEqual(r.violations, []);
  });

  test('ROADMAP.md does not require code correlation (project-scoped)', () => {
    const r = scanGuarded({
      dirtyFiles: ['ROADMAP.md'],
      featuresDir,
      buildId: 'B',
      events: [{ tool: 'add_roadmap_entry', code: 'ANY', build_id: 'B' }],
    });
    assert.deepEqual(r.violations, []);
  });
});

describe('enforcementError', () => {
  test('attaches code and violations', () => {
    const err = enforcementError([{ path: 'ROADMAP.md', expected: ['add_roadmap_entry'] }]);
    assert.equal(err.code, 'MCP_ENFORCEMENT_VIOLATION');
    assert.equal(err.violations.length, 1);
    assert.match(err.message, /ROADMAP\.md/);
  });
});
