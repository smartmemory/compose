import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StratumMcpClient } from '../../lib/stratum-mcp-client.js';
import { TS_MCP_BIN, TS_CLI_BIN } from '../helpers/stratum-test-bin.js';
import { makeFakeCodexProject, CANCEL_FANOUT_SPEC, processGroupGone, waitForReceipt } from '../helpers/fake-codex-project.js';

const cli = fileURLToPath(new URL('../../bin/compose.js', import.meta.url));
const marker = 's07-lane-a.txt';
async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

test('S07-2: real build --abort preserves captured lane A evidence without merging (C50)', { timeout: 120000 }, async t => {
  if (process.platform === 'win32') {
    t.skip('win32 refuses cancellationId dispatch before spawn: CANCELLATION_UNSUPPORTED_PLATFORM');
    return;
  }
  const fixture = await makeFakeCodexProject({ featureCode: 'S07-BUILD-1', spec: CANCEL_FANOUT_SPEC, git: true,
    lanes: [
      { name: 'enumerate', match: 'S07_ENUMERATE', text: '{"items":["S07_LANE_A","S07_LANE_B"]}' },
      { name: 'A', match: 'S07_LANE_A', marker, markerBody: 'S07 captured lane A evidence\n', text: '{"value":"lane A done"}' },
      { name: 'B', match: 'S07_LANE_B', sleep: true },
    ],
  });
  const env = { ...fixture.env, COMPOSE_STRATUM_TS_MCP_BIN: TS_MCP_BIN, COMPOSE_STRATUM_TS_CLI_BIN: TS_CLI_BIN };
  const client = new StratumMcpClient();
  const groups = new Set();
  const children = [];
  let output = '';
  // CLI has no artifact-root flag. Follow the production default for this unique
  // canonical target, and only READ its journal (constructing a manager mutates it).
  const target = await realpath(fixture.workspace);
  const artifactRoot = join(tmpdir(), 'compose-consumer-fanout', createHash('sha256').update(target).digest('hex').slice(0, 24));
  t.after(async () => {
    for (const entry of await fixture.readAgentPids()) groups.add(entry.pid);
    for (const entry of await fixture.readForegroundEntries()) {
      for (const group of entry.groups) groups.add(group.childPid);
    }
    for (const pid of groups) {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; }
    }
    await Promise.all(children.map(child => child.exited));
    await client.close();
    await fixture.cleanup();
    await rm(artifactRoot, { recursive: true, force: true });
    for (const pid of groups) assert.ok(processGroupGone(pid), `stray process group ${pid}`);
  });
  function start(args) {
    const child = spawn(process.execPath, [cli, 'build', ...args], {
      cwd: fixture.workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) groups.add(child.pid);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.exited.catch(() => {});
    children.push(child);
    return child;
  }
  const build = start(['S07-BUILD-1', '--skip-triage', '--non-interactive']);
  const activePath = join(fixture.workspace, '.compose', 'data', 'active-build.json');
  const diagnostics = () => output;
  const active = await waitForReceipt(async () => {
    const record = await readJson(activePath);
    return record?.status === 'running' && record.flowId ? record : null;
  }, 'running build flow', { diagnostics });
  let journalPath;
  const captured = await waitForReceipt(async () => {
    for (const name of await readdir(artifactRoot).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      const path = join(artifactRoot, name, 'journal.json');
      const journal = await readJson(path);
      const issuance = journal?.issuances.find(entry => entry.itemIndex === 0 && entry.state === 'accepted' && entry.diff?.includes(marker));
      if (issuance) { journalPath = path; return issuance; }
    }
  }, 'lane A accepted captured diff', { diagnostics });
  const laneB = await waitForReceipt(async () => (await fixture.readAgentPids()).find(entry => entry.lane === 'B'), 'lane B sleeper', { diagnostics });
  await waitForReceipt(async () => (await fixture.readForegroundEntries()).find(entry =>
    entry.flow?.runId === active.flowId && entry.state === 'running' && entry.groups.some(group => group.childPid === laneB.pid)),
  'lane B stamped running group', { diagnostics });
  groups.add(laneB.pid);
  assert.equal(processGroupGone(laneB.pid), false, 'abort lands while lane B is live');

  const aborter = start(['--abort', '--non-interactive']);
  const abortExit = await aborter.exited;
  assert.equal(abortExit.code, 0, output);
  const buildExit = await build.exited;
  await client.connect({ command: process.execPath, args: [TS_MCP_BIN], env, cwd: fixture.workspace });

  // Exactly the C50 outcomes. Post-apply reversal is unreachable mid-fanout.
  assert.equal((await client.audit(active.flowId)).status, 'cancelled');
  assert.ok(processGroupGone(laneB.pid), 'lane B group is gone');
  // Node reports signal termination as { code: null, signal: 'SIGTERM' };
  // shells expose that unsuccessful exit as 143.
  if (buildExit.signal !== null) assert.equal(buildExit.signal, 'SIGTERM', output);
  else {
    assert.equal(typeof buildExit.code, 'number', output);
    assert.notEqual(buildExit.code, 0, output);
  }
  t.diagnostic(`build exit: ${JSON.stringify(buildExit)}`);
  const final = await readJson(activePath);
  assert.equal(final.status, 'aborted');
  assert.equal(final.pid, build.pid, 'BUILD child retains terminal ownership');
  assert.notEqual(final.pid, aborter.pid);
  const journal = await readJson(journalPath);
  assert.deepEqual(journal.mergeTransactions, [], 'mid-fanout abort never reaches merge');
  const retained = journal.issuances.find(entry => entry.dispatchToken === captured.dispatchToken);
  assert.ok(retained, 'lane A issuance remains journaled');
  assert.equal(retained.diff, captured.diff, 'captured patch evidence is preserved');
  assert.match(retained.diff, /\+S07 captured lane A evidence/);
  assert.equal(existsSync(join(target, marker)), false, 'captured marker was not landed');
});
