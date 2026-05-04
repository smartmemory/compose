import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_BIN = resolve(__dirname, '..', 'bin', 'compose.js');

function runCli(args, cwd) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [COMPOSE_BIN, 'validate', ...args], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => res({ code, stdout, stderr }));
  });
}

function setupCleanFixture() {
  const root = mkdtempSync(join(tmpdir(), 'fv-cli-clean-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features', 'FEAT-1'), { recursive: true });
  mkdirSync(join(root, 'docs', 'journal'), { recursive: true });
  writeFileSync(join(root, 'ROADMAP.md'),
`# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | FEAT-1 | desc | IN_PROGRESS |\n`);
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'),
    JSON.stringify({ items: [{ id: '00000000-0000-0000-0000-000000000001', type: 'feature', featureCode: 'FEAT-1', status: 'in_progress' }], connections: [], gates: [] }));
  writeFileSync(join(root, 'docs', 'features', 'FEAT-1', 'design.md'), '# d');
  writeFileSync(join(root, 'docs', 'features', 'FEAT-1', 'feature.json'),
    JSON.stringify({ code: 'FEAT-1', status: 'IN_PROGRESS', description: 'desc' }));
  writeFileSync(join(root, 'docs', 'journal', 'README.md'), '# Journal\n\n| Date | Entry | Summary |\n|---|---|---|\n');
  return root;
}

function setupDriftFixture() {
  const root = mkdtempSync(join(tmpdir(), 'fv-cli-drift-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'features', 'FEAT-1'), { recursive: true });
  mkdirSync(join(root, 'docs', 'journal'), { recursive: true });
  writeFileSync(join(root, 'ROADMAP.md'),
`# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | FEAT-1 | desc | COMPLETE |\n`);
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'),
    JSON.stringify({ items: [{ id: '00000000-0000-0000-0000-000000000001', type: 'feature', featureCode: 'FEAT-1', status: 'in_progress' }], connections: [], gates: [] }));
  // status mismatch — feature.json IN_PROGRESS vs ROADMAP COMPLETE
  writeFileSync(join(root, 'docs', 'features', 'FEAT-1', 'design.md'), '# d');
  writeFileSync(join(root, 'docs', 'features', 'FEAT-1', 'feature.json'),
    JSON.stringify({ code: 'FEAT-1', status: 'IN_PROGRESS' }));
  writeFileSync(join(root, 'docs', 'journal', 'README.md'), '# Journal\n');
  return root;
}

test('compose validate: clean project exits 0', async () => {
  const root = setupCleanFixture();
  const r = await runCli([], root);
  assert.equal(r.code, 0, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
});

test('compose validate: drift project exits 1 (block-on=error default)', async () => {
  const root = setupDriftFixture();
  const r = await runCli([], root);
  assert.equal(r.code, 1, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
});

test('compose validate --json: emits structured findings', async () => {
  const root = setupDriftFixture();
  const r = await runCli(['--json'], root);
  assert.equal(r.code, 1);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.scope, 'project');
  assert.ok(Array.isArray(parsed.findings));
  assert.ok(parsed.findings.length > 0);
});

test('compose validate --scope=feature without --code exits 2', async () => {
  const root = setupCleanFixture();
  const r = await runCli(['--scope=feature'], root);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /requires --code/);
});

test('compose validate --scope=feature --code=FEAT-1', async () => {
  const root = setupCleanFixture();
  const r = await runCli(['--scope=feature', '--code=FEAT-1', '--json'], root);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.scope, 'feature');
  assert.equal(parsed.feature_code, 'FEAT-1');
});

test('compose validate --code with bad code exits 2', async () => {
  const root = setupCleanFixture();
  const r = await runCli(['--scope=feature', '--code=lowercase-bad'], root);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /INVALID_INPUT/);
});

test('compose validate --block-on=info blocks even on warnings/info', async () => {
  const root = setupDriftFixture();
  // Drift fixture has at least one warning (e.g. journal index missing entries) — info threshold blocks
  const r = await runCli(['--block-on=info'], root);
  assert.equal(r.code, 1);
});

test('compose validate --help exits 0', async () => {
  const root = setupCleanFixture();
  const r = await runCli(['--help'], root);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: compose validate/);
});

test('compose validate --block-on=invalid exits 2', async () => {
  const root = setupCleanFixture();
  const r = await runCli(['--block-on=banana'], root);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Invalid --block-on/);
});
