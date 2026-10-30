// COMP-COCKPIT-12 fixture reader standing in for `sm_status.py --json` (run with COMPOSE_FLEET_PYTHON=node).
// FLEET_FIXTURE_SM: ok (default) | fail | slow | garbage. FLEET_FIXTURE_COUNT: file that counts spawns.
import { appendFileSync, readFileSync } from 'node:fs';
const mode = process.env.FLEET_FIXTURE_SM || 'ok';
if (process.env.FLEET_FIXTURE_COUNT) appendFileSync(process.env.FLEET_FIXTURE_COUNT, 'sm\n');
if (!process.argv.includes('--json')) { process.stderr.write('usage: --json\n'); process.exit(2); }
if (mode === 'fail') { process.stderr.write('Traceback: fixture failure\n'); process.exit(1); }
if (mode === 'garbage') { process.stdout.write('not json\n'); process.exit(0); }
const delay = mode === 'slow' ? 20_000 : Number(process.env.FLEET_FIXTURE_DELAY_MS || 0);
setTimeout(() => process.stdout.write(readFileSync(new URL('./sm-status.json', import.meta.url), 'utf8')), delay);
