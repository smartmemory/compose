/**
 * gate-input-guard.test.js — COMP-PLAN-GATE-LOOP (secondary).
 *
 * The server-down gate path reads stdin via readline. On a backgrounded/non-TTY
 * runner with no input that blocks forever. The guarded `ask` bounds the read:
 * it rejects on EOF or after a deadline so the build fails fast (flow state
 * preserved) instead of hanging. Piped input and the unguarded path are
 * unaffected.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { ask, GateInputUnavailableError } from '../lib/gate-prompt.js';

function makeRl() {
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = createInterface({ input, output });
  return { rl, input };
}

describe('ask() non-interactive guard', () => {
  it('unguarded: resolves with the typed line (back-compat)', async () => {
    const { rl, input } = makeRl();
    setTimeout(() => input.write('approve\n'), 5);
    assert.equal(await ask(rl, '> '), 'approve');
    rl.close();
  });

  it('guarded: resolves when a line arrives before the deadline', async () => {
    const { rl, input } = makeRl();
    setTimeout(() => input.write('a\n'), 5);
    assert.equal(await ask(rl, '> ', { armGuard: true, deadlineMs: 2000 }), 'a');
    rl.close();
  });

  it('guarded: rejects when no input arrives within the deadline', async () => {
    const { rl } = makeRl();
    await assert.rejects(
      ask(rl, '> ', { armGuard: true, deadlineMs: 30 }),
      (err) => {
        assert.ok(err instanceof GateInputUnavailableError);
        assert.match(err.message, /--resume/);
        return true;
      },
    );
    rl.close();
  });

  it('guarded: rejects fast when stdin closes (EOF) with no decision', async () => {
    const { rl, input } = makeRl();
    setTimeout(() => input.end(), 5);
    await assert.rejects(
      ask(rl, '> ', { armGuard: true, deadlineMs: 10_000 }),
      (err) => {
        assert.ok(err instanceof GateInputUnavailableError);
        assert.match(err.message, /closed/);
        return true;
      },
    );
    rl.close();
  });
});
