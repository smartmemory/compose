/**
 * policy-catalog.test.js — COMP-POLICY-CHECK-1 (catalog loader + cache + config).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import {
  loadCatalog,
  getCatalog,
  getPolicyCheckConfig,
  isPolicyCheckEnabled,
  resolveMemoryDir,
  encodeProjectDir,
  _clearCatalogCache,
} from '../lib/policy-catalog.js';
import {
  freshMemoryDir,
  writeRuleFile,
  seedCanonicalCatalog,
  NEVER_SUGGEST_STOPPING,
  EXTERNAL_PROSE,
  MALFORMED_YAML,
  NO_PATTERNS_KEY,
  NO_BLOCK,
} from './helpers/policy-catalog-stub.js';

function freshCwd(policyCheck) {
  const cwd = mkdtempSync(join(tmpdir(), 'policy-cwd-'));
  if (policyCheck !== undefined) {
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ version: 2, policyCheck }), 'utf-8');
  }
  return cwd;
}

/** Silence + capture console.warn for degradation assertions. */
function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

describe('loadCatalog', () => {
  test('parses the canonical fixtures into records', () => {
    const dir = seedCanonicalCatalog();
    const catalog = loadCatalog(dir);

    assert.equal(catalog.length, 2);
    const byName = Object.fromEntries(catalog.map(r => [r.name, r]));

    const stopping = byName['Never suggest stopping points'];
    assert.ok(stopping, 'expected the stopping rule keyed by frontmatter name');
    assert.equal(stopping.patterns.length, 3);
    assert.equal(stopping.suppressionSignals.length, 3);
    assert.equal(stopping.ruleType, 'feedback');
    assert.equal(stopping.scanTarget, 'response');
    assert.equal(stopping.recentTurnWindow, 1);
    assert.ok(stopping.sourceFile.endsWith('feedback_never_suggest_stopping.md'));

    // The external-prose block carries a leading YAML comment and an
    // exclude_regex entry — both must survive the parse.
    const prose = byName['feedback-external-prose'];
    assert.ok(prose, 'expected the external-prose rule');
    assert.equal(prose.patterns.length, 4);
    assert.ok(prose.patterns.some(p => typeof p.exclude_regex === 'string'));
  });

  test('missing memory dir yields an empty catalog, no throw', () => {
    const { result, warnings } = captureWarnings(() => loadCatalog(join(tmpdir(), 'policy-does-not-exist-xyz')));
    assert.deepEqual(result, []);
    assert.equal(warnings.length, 0, 'an absent opt-in dir is not a degradation');
  });

  test('malformed YAML warns and skips only that file', () => {
    const dir = freshMemoryDir();
    writeRuleFile(dir, 'feedback_good.md', NEVER_SUGGEST_STOPPING);
    writeRuleFile(dir, 'feedback_broken.md', MALFORMED_YAML);

    const { result, warnings } = captureWarnings(() => loadCatalog(dir));
    assert.equal(result.length, 1, 'the good file still loads');
    assert.equal(result[0].name, 'Never suggest stopping points');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /invalid YAML/);
    assert.match(warnings[0], /feedback_broken\.md/);
  });

  test('block without a usable patterns key warns and skips', () => {
    const dir = freshMemoryDir();
    writeRuleFile(dir, 'feedback_nopatterns.md', NO_PATTERNS_KEY);

    const { result, warnings } = captureWarnings(() => loadCatalog(dir));
    assert.deepEqual(result, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no valid 'patterns'/);
  });

  test('file with no detection block is skipped silently', () => {
    const dir = freshMemoryDir();
    writeRuleFile(dir, 'feedback_plain.md', NO_BLOCK);

    const { result, warnings } = captureWarnings(() => loadCatalog(dir));
    assert.deepEqual(result, []);
    assert.deepEqual(warnings, [], 'the section is opt-in — absence is not an error');
  });

  test('non-feedback files and non-markdown files are ignored', () => {
    const dir = freshMemoryDir();
    writeRuleFile(dir, 'feedback_ok.md', NEVER_SUGGEST_STOPPING);
    writeRuleFile(dir, 'reference_other.md', EXTERNAL_PROSE);
    writeRuleFile(dir, 'feedback_notes.txt', EXTERNAL_PROSE);

    assert.equal(loadCatalog(dir).length, 1);
    assert.equal(loadCatalog(dir, { ruleType: 'reference' }).length, 1);
  });

  test('garbage pattern entries are dropped, not coerced', () => {
    const dir = freshMemoryDir();
    writeRuleFile(dir, 'feedback_mixed.md', [
      '---', 'name: mixed', 'type: feedback', '---', '',
      '## Detection patterns', '',
      '```yaml',
      'patterns:',
      '  - regex: 123',
      '  - unknown_key: nope',
      "  - phrase: 'real'",
      '  - notadict',
      '```', '',
    ].join('\n'));

    const [rule] = loadCatalog(dir);
    assert.deepEqual(rule.patterns, [{ phrase: 'real' }]);
  });
});

describe('config + memory dir resolution', () => {
  test('absent policyCheck block means enabled', () => {
    const cwd = freshCwd();
    assert.deepEqual(getPolicyCheckConfig(cwd), {});
    assert.equal(isPolicyCheckEnabled(cwd), true);
  });

  test('enabled:false is the kill switch and empties getCatalog', () => {
    const dir = seedCanonicalCatalog();
    const cwd = freshCwd({ enabled: false, memoryDir: dir });
    assert.equal(isPolicyCheckEnabled(cwd), false);
    _clearCatalogCache();
    assert.deepEqual(getCatalog(cwd), []);
  });

  test('default memory dir is the encoded Claude Code project path', () => {
    const cwd = freshCwd();
    const expected = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd), 'memory');
    assert.equal(resolveMemoryDir(cwd), expected);
    assert.equal(encodeProjectDir('/Users/x/reg/my/App.v2'), '-Users-x-reg-my-App-v2');
  });

  test('memoryDir override accepts absolute, ~, and cwd-relative paths', () => {
    const abs = freshMemoryDir();
    assert.equal(resolveMemoryDir(freshCwd(), { memoryDir: abs }), abs);

    const cwd = freshCwd();
    assert.equal(resolveMemoryDir(cwd, { memoryDir: 'mem' }), join(cwd, 'mem'));
    assert.equal(resolveMemoryDir(cwd, { memoryDir: '~/mem' }), join(homedir(), 'mem'));
  });
});

describe('getCatalog caching', () => {
  test('caches per dir and invalidates when a rule file changes', () => {
    _clearCatalogCache();
    const dir = freshMemoryDir();
    writeRuleFile(dir, 'feedback_a.md', NEVER_SUGGEST_STOPPING);
    const cwd = freshCwd({ memoryDir: dir });

    const first = getCatalog(cwd);
    assert.equal(first.length, 1);
    assert.equal(getCatalog(cwd), first, 'unchanged dir returns the cached array identity');

    // Adding a file changes the cache key (count) → reload.
    writeRuleFile(dir, 'feedback_b.md', EXTERNAL_PROSE);
    const second = getCatalog(cwd);
    assert.equal(second.length, 2);
    assert.notEqual(second, first);

    // Editing a file changes the cache key (max mtime) → reload.
    const edited = join(dir, 'feedback_b.md');
    writeFileSync(edited, EXTERNAL_PROSE.replace('no em dashes', 'no dashes'), 'utf-8');
    const future = new Date(Date.now() + 5000);
    utimesSync(edited, future, future);
    assert.notEqual(getCatalog(cwd), second);

    // Removing every rule file empties the catalog.
    rmSync(join(dir, 'feedback_a.md'));
    rmSync(edited);
    assert.deepEqual(getCatalog(cwd), []);
  });

  test('editing an OLDER file invalidates even when a newer file is untouched', () => {
    _clearCatalogCache();
    const dir = freshMemoryDir();
    const older = writeRuleFile(dir, 'feedback_older.md', NEVER_SUGGEST_STOPPING);
    const newer = writeRuleFile(dir, 'feedback_newer.md', EXTERNAL_PROSE);

    // `newer` is the max-mtime holder and stays untouched for the whole test.
    const far = new Date(Date.now() + 60_000);
    utimesSync(newer, far, far);
    const cwd = freshCwd({ memoryDir: dir });

    const first = getCatalog(cwd);
    assert.equal(first.length, 2);

    // Edit the OLDER file, keeping its mtime BELOW the newer file's. A
    // count + max-mtime key cannot see this; a per-file digest can.
    writeFileSync(older, NEVER_SUGGEST_STOPPING.replace('shall i continue', 'shall we continue'), 'utf-8');
    const stillOlder = new Date(Date.now() - 30_000);
    utimesSync(older, stillOlder, stillOlder);

    const second = getCatalog(cwd);
    assert.notEqual(second, first, 'an older-file edit must invalidate the cache');
    const stopping = second.find(r => r.name === 'Never suggest stopping points');
    assert.ok(stopping.patterns.some(p => p.phrase === 'shall we continue'), 'the edit is visible');
  });
});
