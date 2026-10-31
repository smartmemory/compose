/**
 * owner-count.test.js — COMP-COCKPIT-COUNT-ONE-1: `ownerAsks`, the one function that decides what "waiting on you" counts.
 * One row table: every queue tag, overdue or not, a text-less row, an empty queue, an unknown source and the ordering.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ownerAsks } from '../src/components/cockpit/notify/notifyLogic.js';

const row = (id, text, over = {}) => ({ id, text, by: 'x', age: 100, red: false, ...over });

describe('ownerAsks', () => {
  // [name, queue rows, expected ids in order (null = unknown source)]
  const ROWS = [
    ['SECURITY and CREDENTIAL count', [row('a', 'SECURITY: leak'), row('b', 'CREDENTIAL, rotate')], ['a', 'b']],
    ['QUESTION counts, overdue or not', [row('a', 'QUESTION: pick', { red: true }), row('b', 'QUESTION: pick 2', { red: false })], ['a', 'b']],
    ['an untyped row is an ask', [row('a', 'plain words')], ['a']],
    ['APPLIED (decided-for-you) never counts', [row('a', 'APPLIED: done', { red: true })], []],
    ['FYI and UPDATED never count', [row('a', 'FYI: note'), row('b', 'UPDATED: moved', { red: true })], []],
    ['a text-less row is an ask (groupOf(undefined) is asks)', [{ id: 'q0' }], ['q0']],
    ['the 5-kind fixture reads 3', [row('s', 'SECURITY: k'), row('o', 'QUESTION: q', { red: true }), row('n', 'QUESTION: r'), row('d', 'APPLIED: z'), row('f', 'FYI: y')], ['s', 'o', 'n']],
    ['security first, then oldest first (largest age)', [row('young', 'QUESTION: a', { age: 10 }), row('old', 'QUESTION: b', { age: 900 }), row('sec', 'SECURITY: c', { age: 5 })], ['sec', 'old', 'young']],
    ['a row without an age sorts last among asks', [row('none', 'QUESTION: a', { age: undefined }), row('old', 'QUESTION: b', { age: 900 })], ['old', 'none']],
    ['an empty queue is zero, not unknown', [], []],
    ['a null source is unknown', null, null],
    ['a source that is not an array is unknown', { not: 'rows' }, null],
    ['an undefined source is unknown', undefined, null],
  ];
  it('rows', () => {
    for (const [name, rows, want] of ROWS) {
      const got = ownerAsks(rows);
      assert.deepEqual(got === null ? null : got.rows.map((r) => r.id), want, name);
      if (got !== null) assert.equal(got.n, want.length, `${name}: n`);
    }
  });
});
