import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// COMP-CTX-3: `compose context decisions` reads the build decision log
// (auto-appended to docs/context/decisions.md during builds).
const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_BIN = resolve(__dirname, '..', 'bin', 'compose.js');

function runCli(args, cwd) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [COMPOSE_BIN, 'context', ...args], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => res({ code, stdout, stderr }));
  });
}

// Mirror the exact format written by appendDecisionEntry (lib/build.js).
const DECISIONS = `# Decision Log

Decisions accumulate here during builds.

## [2026-06-16] COMP-CTX-3 — design
**Outcome:** approve
**Rationale:** ship the read-side reader

## [2026-06-16] COMP-OTHER-1 — execute
**Outcome:** revise
**Rationale:** tighten the contract
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fv-cli-context-'));
  mkdirSync(join(root, 'docs', 'context'), { recursive: true });
  writeFileSync(join(root, 'docs', 'context', 'decisions.md'), DECISIONS);
  return root;
}

test('context decisions lists all entries (text)', async () => {
  const { code, stdout } = await runCli(['decisions'], fixture());
  assert.equal(code, 0);
  assert.match(stdout, /2 entries/);
  assert.match(stdout, /COMP-CTX-3 — design/);
  assert.match(stdout, /COMP-OTHER-1 — execute/);
});

test('context decisions --feature filters to one feature', async () => {
  const { code, stdout } = await runCli(['decisions', '--feature', 'COMP-CTX-3'], fixture());
  assert.equal(code, 0);
  assert.match(stdout, /1 entry/);
  assert.match(stdout, /COMP-CTX-3/);
  assert.doesNotMatch(stdout, /COMP-OTHER-1/);
});

test('context decisions --format json parses outcome + rationale', async () => {
  const { code, stdout } = await runCli(['decisions', '--format', 'json'], fixture());
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].feature, 'COMP-CTX-3');
  assert.equal(parsed[0].outcome, 'approve');
  assert.equal(parsed[0].rationale, 'ship the read-side reader');
});

test('context decisions exits 1 when the log is absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fv-cli-context-empty-'));
  const { code, stderr } = await runCli(['decisions'], root);
  assert.equal(code, 1);
  assert.match(stderr, /No decision log/);
});

test('context with an unknown subcommand prints usage', async () => {
  const { code, stderr } = await runCli(['bogus'], fixture());
  assert.equal(code, 1);
  assert.match(stderr, /usage: compose context decisions/);
});
