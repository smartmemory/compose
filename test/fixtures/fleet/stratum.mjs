#!/usr/bin/env node
// COMP-COCKPIT-12 fixture standing in for `stratum session fleet --json` (contract operations.fleet envelope).
// FLEET_FIXTURE_STRATUM: ok (default) | refused | slow.
import { appendFileSync } from 'node:fs';
const mode = process.env.FLEET_FIXTURE_STRATUM || 'ok';
if (process.env.FLEET_FIXTURE_COUNT) appendFileSync(process.env.FLEET_FIXTURE_COUNT, 'stratum\n');
const [verb, sub, flag] = process.argv.slice(2);
if (verb !== 'session' || sub !== 'fleet' || flag !== '--json') { process.stderr.write('usage\n'); process.exit(2); }
if (mode === 'refused') {
  process.stdout.write(JSON.stringify({ ok: false, op: 'fleet', backend: 'none', refusal: { code: 'backend-unconfigured', reason: 'session backend not configured', script: null, script_exit: null }, record: null }));
  process.exit(4);
}
const body = { ok: true, op: 'fleet', backend: 'scripts', data: { count: 1, max: 16, jobs: [{ session: 'lane-a-main', label: 'claude:opus', pid: 4242 }] } };
setTimeout(() => process.stdout.write(JSON.stringify(body)), mode === 'slow' ? 20_000 : 0);
