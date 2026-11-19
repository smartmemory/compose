import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { CliProgress } from '../lib/cli-progress.js';

function fixture(t, isTTY = false) {
  let now = 1000;
  let output = '';
  t.mock.method(Date, 'now', () => now);
  const stream = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  stream.isTTY = isTTY;
  stream.columns = 120;
  const progress = new CliProgress({ stream });
  t.after(() => progress.finish());
  return { progress, at: (time) => { now = time; }, output: () => output };
}

function finishThreeSteps(t, isTTY) {
  const { progress, at, output } = fixture(t, isTTY);

  progress.stepStart(1, 3, 'plan');
  at(13000); // 13000 - 1000 = 12000 ms = 12.0s
  progress.stepDone('plan');

  progress.stepStart(2, 3, 'execute');
  at(53000); // first attempt: 53000 - 13000 = 40000 ms
  progress.stepDone('execute', 'failed');
  progress.retry('build', 'execute', 'codex');
  progress.stepStart(2, 3, 'execute');
  at(108500); // 108500 - 53000 = 55500 ms; 40.0s + 55.5s = 1m35.5s
  progress.stepDone('execute');

  progress.stepStart(3, 3, 'review');
  at(138700); // 138700 - 108500 = 30200 ms = 30.2s
  progress.stepDone('review', 'failed');
  // Wall time: 138700 - 1000 = 137700 ms = 2m17.7s. Retries: 0 + 1 + 0 = 1.
  // Usage: 12,345 tokens and $0.42 from execute alone.
  // Feed usage through the same entry point used by the build accumulator.
  progress.recordUsage('execute', { tokens: 12345, costUsd: 0.42 });
  progress.finish();
  return output();
}

test('finish prints one table with each final status, duration and retry count', (t) => {
  const output = finishThreeSteps(t);
  assert.equal((output.match(/Build summary/g) ?? []).length, 1);
  assert.match(output, /^\s*plan\s+ok\s+12\.0s\s+0\s+n\/a\s+n\/a$/m);
  assert.match(output, /^\s*execute\s+ok\s+1m35\.5s\s+1\s+12,345\s+\$0\.42$/m);
  assert.match(output, /^\s*review\s+failed\s+30\.2s\s+0\s+n\/a\s+n\/a$/m);
});

test('totals show elapsed wall time, summed retries and available usage, and fail on a failed step', (t) => {
  assert.match(finishThreeSteps(t), /wall time: 2m17\.7s\s+retries: 1\s+tokens: 12,345\s+cost: \$0\.42\s+result: FAILED/);
});

test('unavailable build cost is n/a with one debug warning and no zero cost', (t) => {
  const { progress, at, output } = fixture(t);
  progress.stepStart(1, 1, 'plan');
  at(13000); // 13000 - 1000 = 12.0s, zero retries and no usage
  progress.stepDone('plan');
  progress.finish();
  progress.finish();
  assert.match(output(), /wall time: 12\.0s\s+retries: 0\s+tokens: n\/a\s+cost: n\/a\s+result: OK/);
  assert.equal((output().match(/\[debug\] WARNING: .*cost/g) ?? []).length, 1);
  assert.doesNotMatch(output(), /\$0\.00/);
});

test('piped progress is plain text and TTY output can style the summary', (t) => {
  const plain = finishThreeSteps(t);
  assert.doesNotMatch(plain, /\x1b/);
  const tty = finishThreeSteps(t, true);
  assert.match(tty.slice(tty.indexOf('Build summary')), /\x1b\[/);
});

test('build totals use the accumulator when present and wall time includes time between steps', (t) => {
  const { progress, at, output } = fixture(t);
  progress.stepStart(1, 2, 'plan');
  at(13000); // 12.0s in plan
  progress.stepDone('plan');
  at(18000); // 5.0s outside steps
  progress.stepStart(2, 2, 'execute', { retries: 2 });
  at(19500); // 1.5s in execute; 12.0 + 5.0 + 1.5 = 18.5s wall time
  progress.stepDone('execute');
  progress.recordUsage('execute', { tokens: 345, costUsd: 0.02 });
  // The owner also has 1,000 tokens and $0.40 from prior work.
  // 345 + 1,000 = 1,345 tokens; $0.02 + $0.40 = $0.42.
  progress.finish({ status: 'failed', usage: { tokens: 1345, costUsd: 0.42 } });
  assert.match(output(), /^\s*execute\s+ok\s+1\.5s\s+2\s+345\s+\$0\.02$/m);
  assert.match(output(), /wall time: 18\.5s\s+retries: 2\s+tokens: 1,345\s+cost: \$0\.42\s+result: FAILED/);
});
