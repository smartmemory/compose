import test from 'node:test';
import assert from 'node:assert/strict';

import { SECTIONS_DIR, getSectionsThreshold } from '../lib/constants.js';

function withEnv(value, fn) {
  const prev = process.env.COMPOSE_PLAN_SECTIONS_THRESHOLD;
  if (value === undefined) delete process.env.COMPOSE_PLAN_SECTIONS_THRESHOLD;
  else process.env.COMPOSE_PLAN_SECTIONS_THRESHOLD = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.COMPOSE_PLAN_SECTIONS_THRESHOLD;
    else process.env.COMPOSE_PLAN_SECTIONS_THRESHOLD = prev;
  }
}

test('SECTIONS_DIR is "sections"', () => {
  assert.equal(SECTIONS_DIR, 'sections');
});

test('getSectionsThreshold: no env → 5', () => {
  withEnv(undefined, () => {
    assert.equal(getSectionsThreshold(), 5);
  });
});

test('getSectionsThreshold: "8" → 8', () => {
  withEnv('8', () => {
    assert.equal(getSectionsThreshold(), 8);
  });
});

test('getSectionsThreshold: "abc" → 5', () => {
  withEnv('abc', () => {
    assert.equal(getSectionsThreshold(), 5);
  });
});

test('getSectionsThreshold: "0" → 1', () => {
  withEnv('0', () => {
    assert.equal(getSectionsThreshold(), 1);
  });
});

test('getSectionsThreshold: "-3" → 1', () => {
  withEnv('-3', () => {
    assert.equal(getSectionsThreshold(), 1);
  });
});

test('getSectionsThreshold: "1" → 1', () => {
  withEnv('1', () => {
    assert.equal(getSectionsThreshold(), 1);
  });
});
