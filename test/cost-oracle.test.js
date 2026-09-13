import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const oracle = fileURLToPath(new URL('../scripts/cost-oracle.mjs', import.meta.url));
function report(t, rows) {
  const cwd = mkdtempSync(join(tmpdir(), 'cost-oracle-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.compose/data'), { recursive: true });
  writeFileSync(join(cwd, '.compose/data/build-history.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  const preload = join(cwd, 'preload.mjs');
  // Keep the real CLI/file/report path; replace the external ccusage response
  // and home-directory lookup so this test never reads user data or uses npx.
  writeFileSync(preload, `
import cp from 'node:child_process';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
cp.execFileSync = () => JSON.stringify({ session: [] });
os.homedir = () => ${JSON.stringify(cwd)};
syncBuiltinESMExports();
`);
  const child = spawnSync(process.execPath, ['--import', preload, oracle, '--all', '--json'], {
    cwd, encoding: 'utf8', timeout: 30000, env: { ...process.env, COMPOSE_PORT: '19997' },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout).flows;
}

test('oracle sums the last snapshot per (flowId, accumulator_build_id)', t => {
  const flows = report(t, [
    { flowId: 'a', accumulator_build_id: 'one', cost_usd: 2, startedAt: '2026-09-13T01:00:00Z' },
    { flowId: 'a', accumulator_build_id: 'two', cost_usd: 0.5, startedAt: '2026-09-13T03:00:00Z' },
    { flowId: 'a', accumulator_build_id: 'one', cost_usd: 4, startedAt: '2026-09-13T02:00:00Z' },
    // Same identity in another flow must not merge groups across flows.
    { flowId: 'b', accumulator_build_id: 'one', cost_usd: 7 },
  ]);
  assert.equal(flows[0].ledger_rows, 3);
  assert.equal(flows[0].ledger_sum_usd, 6.5);
  assert.equal(flows[0].ledger_last_usd, 0.5);
  assert.equal(flows[0].ledger_usd, 4.5);
  assert.equal(flows[1].ledger_usd, 7);
});

for (const missing of [undefined, null]) {
  test(`oracle keeps conservative fallback when any identity is ${missing}`, t => {
    const [flow] = report(t, [
      { flowId: 'legacy', accumulator_build_id: 'one', cost_usd: 2 },
      { flowId: 'legacy', accumulator_build_id: 'one', cost_usd: 4 },
      { flowId: 'legacy', accumulator_build_id: missing, cost_usd: 0.5 },
    ]);
    assert.equal(flow.ledger_usd, 6.5);
    assert.equal(flow.ledger_usd, Math.max(flow.ledger_sum_usd, flow.ledger_last_usd));
  });
}

test('oracle preserves the fallback for entirely legacy flows', t => {
  const [flow] = report(t, [{ flowId: 'legacy', cost_usd: 1.6045 }, { flowId: 'legacy', cost_usd: 0.6974 }]);
  assert.equal(flow.ledger_usd, 2.3019);
});
