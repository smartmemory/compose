/**
 * panel-state.test.js — COMP-COCKPIT-PHONE-1: the sidebar's first-visit default. ONE row table over `loadSidebarOpen`.
 * A stored choice wins, otherwise a phone starts closed and a desktop open, and a load never writes storage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSidebarOpen, SIDEBAR_OPEN_KEY } from '../src/components/cockpit/panelState.js';

// [name, stored (undefined = absent, 'throw' = getItem throws), phone, want]
const ROWS = [
  ['no choice, phone: closed', undefined, true, false],
  ['no choice, desktop: open', undefined, false, true],
  ['stored open beats the phone default', 'true', true, true],
  ['stored closed beats the desktop default', 'false', false, false],
  ['storage throws, phone: closed', 'throw', true, false],
];

test('loadSidebarOpen: stored value wins, else open unless phone, never writes (one row table)', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    for (const [name, stored, phone, want] of ROWS) {
      const writes = [];
      const reads = [];
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
          getItem: (k) => { reads.push(k); if (stored === 'throw') throw new Error('denied'); return stored === undefined ? null : stored; },
          setItem: (k, v) => writes.push([k, v]),
          removeItem: (k) => writes.push([k, null]),
        },
      });
      assert.equal(loadSidebarOpen(phone), want, name);
      assert.deepEqual(writes, [], `${name}: wrote storage`);
      if (stored !== 'throw') assert.deepEqual(reads, [SIDEBAR_OPEN_KEY], `${name}: read the sidebar key`);
    }
    // No argument is the desktop default, so a caller that never learned about phones is unchanged.
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } });
    assert.equal(loadSidebarOpen(), true, 'default argument');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved); else delete globalThis.localStorage;
  }
});
