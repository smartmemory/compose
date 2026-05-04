import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_CODE_RE_STRICT, validateCode } from '../lib/feature-code.js';

test('FEATURE_CODE_RE_STRICT accepts canonical codes', () => {
  for (const code of [
    'COMP-MCP-VALIDATE',
    'STRAT-1',
    'INIT-1',
    'A1',
    'AB',
    'COMP-MCP-FEATURE-MGMT',
    'FOO-BAR-1A',
    'X1Y2',
  ]) {
    assert.ok(FEATURE_CODE_RE_STRICT.test(code), `should accept: ${code}`);
  }
});

test('FEATURE_CODE_RE_STRICT rejects malformed codes', () => {
  for (const code of [
    '',
    'lowercase',
    '-LEADING',
    'TRAILING-',
    '1LEADING',
    'with space',
    '_anon_3',
    'COMP_MCP', // underscore not allowed
    'COMP/MCP', // slash not allowed
  ]) {
    assert.ok(!FEATURE_CODE_RE_STRICT.test(code), `should reject: ${JSON.stringify(code)}`);
  }
});

test('validateCode passes silently for valid codes', () => {
  validateCode('COMP-MCP-VALIDATE');
  validateCode('A1');
});

test('validateCode throws INVALID_INPUT for non-strings', () => {
  for (const value of [null, undefined, 42, {}, [], true]) {
    assert.throws(() => validateCode(value), (err) => err.code === 'INVALID_INPUT');
  }
});

test('validateCode throws INVALID_INPUT for malformed codes', () => {
  for (const code of ['', 'lowercase', '-LEADING', 'TRAILING-', '_anon_3']) {
    assert.throws(() => validateCode(code), (err) => err.code === 'INVALID_INPUT');
  }
});

test('validateCode error message includes the rejected value', () => {
  try { validateCode('bad'); }
  catch (err) {
    assert.match(err.message, /bad/);
    assert.equal(err.code, 'INVALID_INPUT');
  }
});
