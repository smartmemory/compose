import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

function setupDanglingFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cli-fix-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
  mkdirSync(join(root, 'docs', 'journal'), { recursive: true });
  writeFileSync(join(root, 'docs', 'journal', 'README.md'), '# Journal\n');
  for (const [code, n] of [['FEAT-1', 1], ['FEAT-2', 2]]) {
    const dir = join(root, 'docs', 'features', code);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'design.md'), '# d');
  }
  writeFileSync(join(root, 'docs', 'features', 'FEAT-1', 'feature.json'),
    JSON.stringify({ code: 'FEAT-1', status: 'IN_PROGRESS', description: 'd' }));
  writeFileSync(join(root, 'docs', 'features', 'FEAT-2', 'feature.json'),
    JSON.stringify({ code: 'FEAT-2', status: 'IN_PROGRESS', description: 'd',
      links: [{ kind: 'blocks', to_code: 'GHOST-9' }] }));
  writeFileSync(join(root, 'ROADMAP.md'),
`# R\n\n## Phase 1\n\n| # | Feature | Description | Status |\n|---|---|---|---|\n| 1 | FEAT-1 | d | IN_PROGRESS |\n| 2 | FEAT-2 | d | IN_PROGRESS |\n`);
  writeFileSync(join(root, '.compose', 'data', 'vision-state.json'), JSON.stringify({
    items: [
      { id: '00000000-0000-0000-0000-000000000001', type: 'feature', featureCode: 'FEAT-1', status: 'in_progress' },
      { id: '00000000-0000-0000-0000-000000000002', type: 'feature', featureCode: 'FEAT-2', status: 'in_progress' },
    ], connections: [], gates: [],
  }));
  return root;
}

function fj(root, code) {
  return JSON.parse(readFileSync(join(root, 'docs', 'features', code, 'feature.json'), 'utf8'));
}

test('compose validate --fix (dry-run) prints a plan and writes nothing', async () => {
  const root = setupDanglingFixture();
  const r = await runCli(['--fix'], root);
  assert.match(r.stdout, /validate --fix \(dry-run\)/);
  assert.match(r.stdout, /dangling_link.*FEAT-2/s);
  // unchanged on disk
  assert.deepEqual(fj(root, 'FEAT-2').links, [{ kind: 'blocks', to_code: 'GHOST-9' }]);
});

test('compose validate --fix --apply drops the dangling link', async () => {
  const root = setupDanglingFixture();
  const r = await runCli(['--fix', '--apply'], root);
  assert.match(r.stdout, /validate --fix \(apply\)/);
  assert.deepEqual(fj(root, 'FEAT-2').links, []);
});

test('compose validate --fix --json includes the reconcile result', async () => {
  const root = setupDanglingFixture();
  const r = await runCli(['--fix', '--json'], root);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.reconcile);
  assert.equal(parsed.reconcile.dry_run, true);
  assert.ok(Array.isArray(parsed.reconcile.plan));
});

test('compose validate --help documents the fix flags', async () => {
  const root = setupDanglingFixture();
  const r = await runCli(['--help'], root);
  assert.match(r.stdout, /--fix\b/);
  assert.match(r.stdout, /--apply\b/);
  assert.match(r.stdout, /--fix-class=/);
});
