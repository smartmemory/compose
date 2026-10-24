// COMP-FANOUT-GIT-DIAG-1: a failing git() call must say how it failed
// (status / signal / code / stderr tail) while keeping the original message
// prefix, the Error identity and its properties. Real git, one row per failure kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fanoutGit } from '../lib/consumer-fanout.js';
import { isolatedGitEnv } from './helpers/git-sandbox.js';

const env = isolatedGitEnv();
const ROWS = [
  { kind: 'nonzero exit', args: ['rev-parse', '--verify', 'no-such-ref^{commit}'], opts: {},
    expect: [/status=128/, /signal=null/, /stderr="[^"]*(fatal|unknown revision|Needed a single revision)/i], prefix: /^Command failed: git rev-parse/ },
  { kind: 'killed by signal', args: ['-c', 'alias.die=!kill -9 $PPID', 'die'], opts: {},
    expect: [/status=null/, /signal=SIGKILL/], prefix: /^Command failed: git /, skipOn: 'win32' },
  { kind: 'timeout (ETIMEDOUT)', args: ['-c', 'alias.nap=!sleep 5', 'nap'], opts: { timeout: 200 },
    expect: [/code=ETIMEDOUT/, /signal=SIGTERM/], prefix: /ETIMEDOUT/, skipOn: 'win32' },
  { kind: 'output over maxBuffer (ENOBUFS)', args: ['-c', 'alias.big=!yes x | head -c 100000', 'big'], opts: { maxBuffer: 1024 },
    expect: [/code=ENOBUFS/], prefix: /ENOBUFS/, skipOn: 'win32' },
];

test('git() failures carry status, signal, code and stderr; prefix and identity unchanged', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-fanout-git-diag-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  fanoutGit(dir, ['init', '-q'], { env });
  for (const row of ROWS) {
    await t.test(row.kind, { skip: row.skipOn === process.platform }, () => {
      let caught;
      try { fanoutGit(dir, row.args, { env, ...row.opts }); } catch (e) { caught = e; }
      assert.ok(caught instanceof Error, 'git() should throw');
      assert.match(caught.message, row.prefix);
      assert.match(caught.message, /\[git-diag status=/);
      for (const re of row.expect) assert.match(caught.message, re);
      // identity of the underlying properties is preserved for callers that read them
      assert.ok('status' in caught && 'signal' in caught);
    });
  }
});

test('git-diag stderr is capped at the last 300 chars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-fanout-git-diag-'));
  try {
    fanoutGit(dir, ['init', '-q'], { env });
    const longName = 'a'.repeat(600);
    let caught;
    try { fanoutGit(dir, ['-c', `alias.noisy=!echo ${longName} >&2; exit 3`, 'noisy'], { env }); } catch (e) { caught = e; }
    const m = caught.message.match(/stderr=("(?:[^"\\]|\\.)*")\]$/);
    assert.ok(m, caught.message.slice(-120));
    assert.ok(JSON.parse(m[1]).length <= 300);
    assert.match(caught.message, /status=3/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a successful call is unchanged (trim and trim:false)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-fanout-git-diag-'));
  try {
    fanoutGit(dir, ['init', '-q'], { env });
    assert.equal(fanoutGit(dir, ['rev-parse', '--is-inside-work-tree'], { env }), 'true');
    assert.equal(fanoutGit(dir, ['rev-parse', '--is-inside-work-tree'], { env, trim: false }), 'true\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
