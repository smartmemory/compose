// COMP-COCKPIT-12 fixture reader standing in for `sm_status.py --json` (run with COMPOSE_FLEET_PYTHON=node).
// FLEET_FIXTURE_SM: ok (default) | fail | slow | garbage | warn (queue carries `warnings`) | jobs (live bash, live Codex detached, detached Claude). FLEET_FIXTURE_COUNT: file that counts spawns.
import { appendFileSync, readFileSync } from 'node:fs';
const mode = process.env.FLEET_FIXTURE_SM || 'ok';
if (process.env.FLEET_FIXTURE_COUNT) appendFileSync(process.env.FLEET_FIXTURE_COUNT, 'sm\n');
if (!process.argv.includes('--json')) { process.stderr.write('usage: --json\n'); process.exit(2); }
if (mode === 'fail') { process.stderr.write('Traceback: fixture failure\n'); process.exit(1); }
if (mode === 'fail-home') { process.stderr.write(`can't open ${process.env.HOME}/x.py\n`); process.exit(1); }
if (mode === 'garbage') { process.stdout.write('not json\n'); process.exit(0); }
const delay = mode === 'slow' ? 20_000 : Number(process.env.FLEET_FIXTURE_DELAY_MS || 0);
const doc = JSON.parse(readFileSync(new URL('./sm-status.json', import.meta.url), 'utf8'));
if (mode === 'warn') doc.sources.queue.warnings = ['owner_queue.py: line 7 unreadable', 'x'.repeat(500), 3, 'c', 'd', 'e', 'f'];
if (mode === 'jobs') {
  const row = (id, kind, vendor, pid) => ({ session: 's', id, kind, vendor, priority: 'P2', age: 60, pid, alive: true, error: null });
  doc.sources.jobs.value = [row('live-bash', 'bash', null, 7001), row('live-codex', 'detached', 'codex', 7002), row('claude-gone', 'detached', 'claude', 7003)];
}
setTimeout(() => process.stdout.write(JSON.stringify(doc)), delay);
