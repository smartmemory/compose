// COMP-COCKPIT-FIXES-1 part A: `cockpit.sh start` must return when its output is piped or captured, and `stop` must free the ports.
// Incident 2026-10-31 (twice): `cockpit.sh start | tail -4` never returned, because the backgrounded `cd && nohup node` list left a
// subshell holding the caller's stdout. A stub server stands in for the supervisor, on test-range ports (reserved with
// `port_check.py --reserve-test cockpit-fixes`), so the owner's 4001/4002/5195 are never touched.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HERE = resolve(import.meta.dirname, '..');
const SCRIPT = join(HERE, 'scripts', 'cockpit.sh');
const STUB = join(HERE, 'test', 'fixtures', 'cockpit-stub-server.mjs');
const PORTS = ['19011', '19015', '19033'];
const run = mkdtempSync(join(tmpdir(), 'cockpit-piped-'));
const env = {
  ...process.env, COCKPIT_RUN: run, COCKPIT_PORTS: PORTS.join(' '), COCKPIT_ENTRY: STUB, STUB_PORTS: PORTS.join(' '),
  WIKI_SEALED_DIR: join(run, 'no-sealed'), ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GROQ_API_KEY: '', RESEND_API_KEY: '',
};

const listening = (port) => new Promise((ok) => {
  const c = createConnection({ port: Number(port), host: '127.0.0.1' });
  c.once('connect', () => { c.destroy(); ok(true); });
  c.once('error', () => ok(false));
});
const sh = (cmd) => spawnSync('bash', ['-c', cmd], { env, encoding: 'utf8', timeout: 60_000 });
const stop = () => sh(`${SCRIPT} stop`);

after(() => { stop(); rmSync(run, { recursive: true, force: true }); });

describe('cockpit.sh start with its output captured', () => {
  // label, shell form. Each form must return (spawnSync's 60 s timeout is the hang detector) and print the "up" line.
  const FORMS = [
    ['piped to cat', `${SCRIPT} start | cat`],
    ['piped to tail -4', `${SCRIPT} start | tail -4`],
    ['command substitution', `out="$(${SCRIPT} start)"; echo "$out"`],
  ];
  it('returns for every form, and stop frees every port with nothing left listening', async () => {
    for (const p of PORTS) assert.equal(await listening(p), false, `precondition: test port ${p} is free`);
    for (const [label, cmd] of FORMS) {
      const r = sh(cmd);
      assert.equal(r.error, undefined, `${label}: returned before the timeout (${r.error?.code})`);
      assert.match(r.stdout, /cockpit up/, `${label}: printed the up line`);
      for (const p of PORTS) assert.equal(await listening(p), true, `${label}: port ${p} listening`);
      const s = stop();
      assert.match(s.stdout, /stopped/, `${label}: stop ran`);
      for (const p of PORTS) assert.equal(await listening(p), false, `${label}: port ${p} freed by stop`);
    }
  });
});
