/**
 * COMP-COCKPIT-13-POLISH-FU-1 M1: rankTone on a row of figures. A lone value is good, tied values share one tone
 * (the rank of the tie group, not of the first index), and dir=low mirrors dir=high. One row table.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rankTone } from '../src/components/cockpit/process/processTones.js';

// [dir, key, row, tone]
const ROWS = [
  ['high', 100, [100], 'good'],
  ['high', 100, [100, 100], 'good'],
  ['high', 100, [1, 100, 100], 'good'],
  ['low', 1, [1], 'good'],
  ['low', 1, [1, 1], 'good'],
  ['low', 1, [1, 1, 100], 'good'],
  ['high', 100, [1, 50, 100], 'good'],
  ['high', 50, [1, 50, 100], 'warn'],
  ['high', 1, [1, 50, 100], 'bad'],
  ['low', 1, [1, 50, 100], 'good'],
  ['low', 50, [1, 50, 100], 'warn'],
  ['low', 100, [1, 50, 100], 'bad'],
  ['high', 1, [1, 100, 100], 'bad'],
  ['high', null, [1, 100], null],
  ['high', 5, [], null],
];

describe('rankTone', () => {
  for (const [dir, key, row, tone] of ROWS) it(`${dir} ${key} in [${row}] is ${tone}`, () => assert.equal(rankTone(dir, key, row), tone));
});
