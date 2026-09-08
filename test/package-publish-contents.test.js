import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function packDryRun(cacheDir) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('npm', ['pack', '--dry-run', '--json'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        RESEND_API_KEY: '',
        STRIPE_API_KEY: '',
        npm_config_cache: cacheDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolveResult({ code, stdout, stderr }));
  });
}

test('npm package contains every shipped .claude runtime input', async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'compose-npm-pack-cache-'));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));

  const result = await packDryRun(cacheDir);
  assert.equal(result.code, 0, `npm pack failed: ${result.stderr}`);

  const [{ files }] = JSON.parse(result.stdout);
  const packedPaths = new Set(files.map(({ path }) => path));
  for (const requiredPath of [
    '.claude/hooks/canon-guard.mjs',
    '.claude/agents/compose-explorer.md',
    '.claude/agents/compose-architect.md',
  ]) {
    assert.ok(packedPaths.has(requiredPath), `npm pack output is missing runtime path: ${requiredPath}`);
  }
});
