import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import * as build from '../lib/build.js';

test('writeActiveBuild stamps by default and preserves the driver pid on request', t => {
  const dir = mkdtempSync(join(tmpdir(), 's04-pid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  build.writeActiveBuild(dir, { pid: 123, status: 'running' });
  assert.equal(JSON.parse(readFileSync(join(dir, 'active-build.json'))).pid, process.pid);
  build.writeActiveBuild(dir, { pid: 123, status: 'aborted' }, { stampPid: false });
  assert.equal(JSON.parse(readFileSync(join(dir, 'active-build.json'))).pid, 123);
  assert.deepEqual(readdirSync(dir), ['active-build.json']);
});

test('concurrent processes publish only complete, unmixed active-build records', { timeout: 60000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 's04-race-'));
  const children = [];
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });
  const url = new URL('../lib/build.js', import.meta.url).href;
  const script = `
    import { writeActiveBuild } from ${JSON.stringify(url)};
    process.send('ready');
    process.once('message', () => {
      for (let i = 0; i < 250; i++) {
        const identity = process.pid + ':' + i;
        writeActiveBuild(process.argv[1], {
          featureCode: identity, flowId: identity, startedAt: identity,
          payload: identity.repeat(6000), end: identity,
        });
      }
    });
  `;
  let done = 0;
  const completions = [];
  const ready = [];
  for (let i = 0; i < 5; i++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    ready.push(new Promise(resolve => { child.once('message', resolve); child.once('exit', resolve); child.once('error', resolve); }));
    completions.push(new Promise(resolve => {
      child.once('error', error => { done++; resolve({ error }); });
      child.once('exit', (code, signal) => { done++; resolve({ code, signal, stderr }); });
    }));
  }
  await Promise.all(ready);
  for (const child of children) if (child.connected) child.send('go');
  const failures = [];
  let reads = 0;
  while (done < children.length) {
    try {
      const record = JSON.parse(readFileSync(join(dir, 'active-build.json'), 'utf8'));
      assert.equal(record.flowId, record.featureCode);
      assert.equal(record.startedAt, record.flowId);
      assert.equal(record.end, record.flowId);
      assert.equal(record.payload, record.flowId.repeat(6000));
      assert.equal(record.pid, Number(record.flowId.split(':')[0]));
      reads++;
    } catch (error) { if (error.code !== 'ENOENT') failures.push(error.message); }
    await delay(1);
  }
  const outcomes = await Promise.all(completions);
  assert.deepEqual(outcomes.filter(r => r.code !== 0 || r.signal || r.error), [], 'every real writer must finish without shared-tmp rename failures');
  assert.deepEqual(failures, [], 'no torn JSON or mixed identities');
  assert.ok(reads > 10, `parent observed ${reads} records during the race`);
  assert.deepEqual(readdirSync(dir), ['active-build.json']);
});
