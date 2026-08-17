/**
 * policy-check.test.js — COMP-POLICY-CHECK-2/3/6
 * (user-mode classification, response scanning, violation strings, result field).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadCatalog } from '../lib/policy-catalog.js';
import {
  classifyUserMode,
  resolveBuildUserMode,
  scanResponse,
  toViolationStrings,
  buildRevisionNotice,
  applyExclusions,
  compilePattern,
  attachPolicyCount,
  MAX_PATTERN_LENGTH,
  MAX_SCAN_CHARS,
  _clearRegexCache,
} from '../lib/policy-check.js';
import { seedCanonicalCatalog, freshMemoryDir, writeRuleFile } from './helpers/policy-catalog-stub.js';

const CATALOG = loadCatalog(seedCanonicalCatalog());
const rule = name => CATALOG.filter(r => r.name === name);

const STOPPING = 'Never suggest stopping points';
const PROSE = 'feedback-external-prose';

/** Run `fn` with console.warn captured. */
function quietly(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

describe('compilePattern', () => {
  test('translates Python inline (?i) flags into JS RegExp flags', () => {
    const re = compilePattern('(?i)\\bwant me to continue\\b');
    assert.ok(re, 'a (?i) pattern must compile — JS throws on inline groups');
    assert.equal(re.flags.includes('i'), true);
    assert.equal(re.test('Want Me To Continue?'), true);
  });

  test('invalid regex warns once and returns null instead of throwing', () => {
    _clearRegexCache();
    const { result, warnings } = quietly(() => compilePattern('([unclosed'));
    assert.equal(result, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /invalid regex/);
  });
});

describe('ReDoS containment', () => {
  test('a catastrophic pattern is dropped with a warning naming the rule', () => {
    _clearRegexCache();
    const started = Date.now();
    const { result, warnings } = quietly(() => compilePattern('^(a+)+$', { ruleName: 'evil-rule' }));
    const elapsed = Date.now() - started;

    assert.equal(result, null, 'nested-quantifier pattern must not survive compile');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /catastrophic regex/);
    assert.match(warnings[0], /rule "evil-rule"/);
    assert.ok(elapsed < 2000, `the canary itself must stay bounded (took ${elapsed}ms)`);
  });

  test('a catastrophic pattern in a catalog does not stall the scan path', () => {
    _clearRegexCache();
    const dir = freshMemoryDir();
    writeRuleFile(dir, 'feedback_evil.md', [
      '---', 'name: evil-rule', 'type: feedback', '---', '',
      '## Detection patterns', '',
      '```yaml',
      'patterns:',
      "  - regex: '^(a+)+$'",
      "  - phrase: 'still scanned'",
      '```', '',
    ].join('\n'));
    const catalog = loadCatalog(dir);
    const hostile = `${'a'.repeat(4000)}!`;

    const started = Date.now();
    const { result: records } = quietly(() => scanResponse(`${hostile} still scanned`, catalog, 'AUTONOMOUS'));
    const elapsed = Date.now() - started;

    assert.equal(records.length, 1, 'the surviving phrase still matches');
    assert.equal(records[0].matched, 'still scanned');
    assert.ok(elapsed < 2000, `scan must stay fast with a hostile pattern present (took ${elapsed}ms)`);
  });

  test('an over-length pattern is skipped with a warning', () => {
    _clearRegexCache();
    const long = `(?i)${'x'.repeat(MAX_PATTERN_LENGTH + 1)}`;
    const { result, warnings } = quietly(() => compilePattern(long));
    assert.equal(result, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /over-length regex/);

    // The ceiling is a ceiling, not a ban on long-ish patterns.
    _clearRegexCache();
    assert.ok(compilePattern('x'.repeat(MAX_PATTERN_LENGTH)), 'exactly at the ceiling still compiles');
  });

  test('scanned text is capped so a huge response cannot multiply pattern cost', () => {
    const patterns = [{ regex: 'needle' }];
    const stripped = applyExclusions(`${'.'.repeat(MAX_SCAN_CHARS + 500)}needle`, patterns);
    assert.equal(stripped.length, MAX_SCAN_CHARS);

    const catalog = [{ name: 'cap', patterns, suppressionSignals: [] }];
    const beyond = `${'.'.repeat(MAX_SCAN_CHARS + 10)}needle`;
    assert.deepEqual(scanResponse(beyond, catalog, 'AUTONOMOUS'), [],
      'a match past the ceiling is out of scope by construction');
    assert.equal(scanResponse(`needle${'.'.repeat(MAX_SCAN_CHARS)}`, catalog, 'AUTONOMOUS').length, 1);
  });
});

describe('resolveBuildUserMode', () => {
  test('defaults to AUTONOMOUS and never infers PACED from prose', () => {
    assert.equal(resolveBuildUserMode(undefined, {}), 'AUTONOMOUS');
    assert.equal(resolveBuildUserMode(null, { skillGated: false }), 'AUTONOMOUS');
  });

  test('a gate step is SKILL_GATED', () => {
    assert.equal(resolveBuildUserMode(undefined, { skillGated: true }), 'SKILL_GATED');
  });

  test('a valid config override wins, case-insensitively', () => {
    assert.equal(resolveBuildUserMode('PACED', { skillGated: false }), 'PACED');
    assert.equal(resolveBuildUserMode('paced', { skillGated: true }), 'PACED');
    assert.equal(resolveBuildUserMode('autonomous', { skillGated: true }), 'AUTONOMOUS');
  });

  test('an invalid override warns and falls through to the default', () => {
    const { result, warnings } = quietly(() => resolveBuildUserMode('SLOW_PLEASE', { skillGated: false }));
    assert.equal(result, 'AUTONOMOUS');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /invalid policyCheck\.userMode/);
  });
});

describe('classifyUserMode', () => {
  test('defaults to AUTONOMOUS with no signal', () => {
    assert.equal(classifyUserMode(['just build it'], CATALOG), 'AUTONOMOUS');
    assert.equal(classifyUserMode([], CATALOG), 'AUTONOMOUS');
    assert.equal(classifyUserMode(undefined, CATALOG), 'AUTONOMOUS');
  });

  test('PACED when a recent turn matches a suppression signal', () => {
    assert.equal(classifyUserMode(['walk me through it'], CATALOG), 'PACED');
    assert.equal(classifyUserMode(['do these one by one please'], CATALOG), 'PACED');
    assert.equal(classifyUserMode(['go step by step'], CATALOG), 'PACED', 'phrase signals match too');
  });

  test('only the last 2 turns count', () => {
    const turns = ['walk me through it', 'ok', 'now do the rest'];
    assert.equal(classifyUserMode(turns, CATALOG), 'AUTONOMOUS', 'signal aged out of the window');
    assert.equal(classifyUserMode(turns, CATALOG, { window: 3 }), 'PACED');
  });

  test('skillGated passthrough wins over everything', () => {
    assert.equal(classifyUserMode(['just build it'], CATALOG, { skillGated: true }), 'SKILL_GATED');
    assert.equal(classifyUserMode(['walk me through'], CATALOG, { skillGated: true }), 'SKILL_GATED');
  });

  test('empty catalog cannot produce PACED', () => {
    assert.equal(classifyUserMode(['walk me through it'], []), 'AUTONOMOUS');
  });
});

describe('scanResponse', () => {
  test('flags a regex match in AUTONOMOUS mode', () => {
    const records = scanResponse('All done. Want me to continue with the next step?', rule(STOPPING), 'AUTONOMOUS');
    assert.equal(records.length, 1);
    assert.equal(records[0].rule, STOPPING);
    assert.equal(records[0].suppressed, false);
    assert.equal(records[0].patternType, 'regex');
    assert.match(records[0].reason, /Response matches/);
  });

  test('flags a phrase match case-insensitively', () => {
    const records = scanResponse('Shall I continue?', rule(STOPPING), 'AUTONOMOUS');
    assert.equal(records.length, 1);
    assert.equal(records[0].patternType, 'phrase');
    assert.equal(records[0].matched, 'shall i continue');
  });

  test('clean response produces no records', () => {
    assert.deepEqual(scanResponse('Implemented the loader and moved on to the tests.', CATALOG, 'AUTONOMOUS'), []);
  });

  test('PACED and SKILL_GATED record the match as suppressed, never drop it', () => {
    for (const mode of ['PACED', 'SKILL_GATED']) {
      const records = scanResponse('Want me to continue?', rule(STOPPING), mode);
      assert.equal(records.length, 1, `${mode} must still record the match for measurement`);
      assert.equal(records[0].suppressed, true);
      assert.match(records[0].reason, new RegExp(`user_mode=${mode}`));
      assert.deepEqual(toViolationStrings(records), [], `${mode} contributes no violation strings`);
    }
  });

  test('multiple patterns in one rule produce one record each', () => {
    const records = scanResponse('Want me to continue? Should I proceed?', rule(STOPPING), 'AUTONOMOUS');
    assert.equal(records.length, 2);
  });

  test('empty text or empty catalog is a no-op', () => {
    assert.deepEqual(scanResponse('', CATALOG, 'AUTONOMOUS'), []);
    assert.deepEqual(scanResponse('Want me to continue?', [], 'AUTONOMOUS'), []);
  });

  test('an invalid regex in one rule does not sink the scan', () => {
    const dir = freshMemoryDir();
    writeRuleFile(dir, 'feedback_bad_regex.md', [
      '---', 'name: bad-regex', 'type: feedback', '---', '',
      '## Detection patterns', '',
      '```yaml',
      'patterns:',
      "  - regex: '([unclosed'",
      "  - phrase: 'still works'",
      '```', '',
    ].join('\n'));
    const catalog = loadCatalog(dir);

    _clearRegexCache();
    const original = console.warn;
    console.warn = () => {};
    let records;
    try {
      records = scanResponse('this still works fine', catalog, 'AUTONOMOUS');
    } finally {
      console.warn = original;
    }
    assert.equal(records.length, 1);
    assert.equal(records[0].matched, 'still works');
  });
});

describe('exclude_regex span removal', () => {
  test('the em-dash pattern does NOT fire inside a code fence', () => {
    const text = [
      'Here is the snippet you asked for:',
      '',
      '```js',
      'const label = "a — b"; // and a semicolon; too',
      '```',
      '',
      'That is all.',
    ].join('\n');

    const records = scanResponse(text, rule(PROSE), 'AUTONOMOUS');
    assert.deepEqual(records, [], 'fenced code must be excluded before pattern evaluation');
  });

  test('the same em dash outside a fence DOES fire', () => {
    const records = scanResponse('This is prose — with an em dash.', rule(PROSE), 'AUTONOMOUS');
    assert.equal(records.length, 1);
    assert.equal(records[0].matched, ' — ');
  });

  test('a fence does not shield prose elsewhere in the same response', () => {
    const text = 'Prose — flagged.\n\n```js\nconst a = "b — c";\n```\n';
    const records = scanResponse(text, rule(PROSE), 'AUTONOMOUS');
    assert.equal(records.length, 1, 'exactly the out-of-fence occurrence');
  });

  test('applyExclusions strips every fenced span', () => {
    const patterns = [{ exclude_regex: '```[\\s\\S]*?```' }];
    const stripped = applyExclusions('a ```one``` b ```two``` c', patterns);
    assert.equal(stripped, 'a  b  c');
  });
});

describe('toViolationStrings / buildRevisionNotice', () => {
  test('violation strings carry rule, pattern, and suppression note', () => {
    const records = scanResponse('Want me to continue?', rule(STOPPING), 'AUTONOMOUS');
    const strings = toViolationStrings(records);
    assert.equal(strings.length, 1);
    assert.match(strings[0], /^policy: /);
    assert.match(strings[0], new RegExp(STOPPING));
    assert.match(strings[0], /unsuppressed; revise unless precedence applies/);
  });

  test('revision notice lists flagged rules and is empty when nothing is flagged', () => {
    const flagged = scanResponse('Want me to continue?', rule(STOPPING), 'AUTONOMOUS');
    const notice = buildRevisionNotice(flagged);
    assert.match(notice, /POLICY CHECK/);
    assert.match(notice, new RegExp(STOPPING));
    assert.match(notice, /unless a user\n?instruction/);

    assert.equal(buildRevisionNotice(scanResponse('Want me to continue?', rule(STOPPING), 'PACED')), '');
    assert.equal(buildRevisionNotice([]), '');
  });
});

describe('attachPolicyCount (COMP-POLICY-CHECK-6)', () => {
  test('attaches the count when the step has no out contract', () => {
    const out = attachPolicyCount({ summary: 'done' }, 2, { has_out_contract: false, output_fields: {} });
    assert.equal(out.unsuppressed_violations, 2);
  });

  test('attaches the count when the contract declares the field', () => {
    const dispatch = { has_out_contract: true, output_fields: { summary: 'str', unsuppressed_violations: 'int' } };
    assert.equal(attachPolicyCount({ summary: 'done' }, 0, dispatch).unsuppressed_violations, 0);
  });

  test('leaves a strict contract untouched when the field is not declared', () => {
    const result = { summary: 'done' };
    const dispatch = { has_out_contract: true, output_fields: { summary: 'str' } };
    assert.deepEqual(attachPolicyCount(result, 3, dispatch), result);
  });

  test('null / non-object results pass through', () => {
    assert.equal(attachPolicyCount(null, 1, {}), null);
    assert.equal(attachPolicyCount('text', 1, {}), 'text');
  });
});
