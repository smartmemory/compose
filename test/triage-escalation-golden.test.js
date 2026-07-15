// COMP-TRIAGE-5 S04 — escalation golden (load-bearing).
// Proves the E3 "Expand" safety net: a looks-trivial feature that fails its
// ship-time test gate auto-escalates to a wider lane, widens the profile so the
// next build runs the heavy phases, and drops a resume checkpoint — bounded, so
// it cannot loop forever. Real lane-gate + escalation logic + real fs checkpoint;
// only the storage provider is faked.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { maybeEscalateLane } from '../lib/lane-gate.js';

function fakeProvider(initial) {
  let store = initial;
  return {
    _get: () => store,
    async getFeature() { return store; },
    async putFeature(_code, obj) { store = { ...obj }; return store; },
  };
}

describe('COMP-TRIAGE-5 escalation golden', () => {
  test('looks-trivial-but-fails-test → escalate trivial→standard, widen profile, checkpoint written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-esc-'));
    try {
      const provider = fakeProvider({
        code: 'FOO-1',
        lane: 'trivial',
        escalationCount: 0,
        profile: { needs_architecture: false, needs_prd: false },
      });
      const res = await maybeEscalateLane({ featureCode: 'FOO-1', provider, featureDir: dir });

      assert.equal(res.action, 'escalate');
      assert.equal(res.from, 'trivial');
      assert.equal(res.to, 'standard');
      assert.equal(res.reEntryPhase, 'blueprint');

      const saved = provider._get();
      assert.equal(saved.lane, 'standard');
      assert.equal(saved.estimateSource, 'escalated');
      assert.equal(saved.escalationCount, 1);
      // profile widened so the NEXT build runs the heavy phases
      assert.equal(saved.profile.needs_architecture, true);
      assert.equal(saved.profile.needs_prd, true);

      const cp = join(dir, 'escalation-checkpoint.md');
      assert.ok(existsSync(cp), 'checkpoint written');
      assert.match(readFileSync(cp, 'utf8'), /escalate/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bounded: escalationCount already 2 → STOP + human-handoff checkpoint (no infinite loop)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-esc-'));
    try {
      const provider = fakeProvider({ code: 'FOO-2', lane: 'standard', escalationCount: 2 });
      const res = await maybeEscalateLane({ featureCode: 'FOO-2', provider, featureDir: dir });

      assert.equal(res.action, 'stop');
      // lane must NOT advance past the bound
      assert.equal(provider._get().lane, 'standard');
      assert.match(readFileSync(join(dir, 'escalation-checkpoint.md'), 'utf8'), /human/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a feature that never went through front triage (no lane) is never escalated', async () => {
    const provider = fakeProvider({ code: 'FOO-3', status: 'PLANNED' });
    const res = await maybeEscalateLane({ featureCode: 'FOO-3', provider, featureDir: null });
    assert.equal(res.action, 'none');
  });
});
