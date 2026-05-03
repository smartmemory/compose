import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wrapperRoot = resolve(__dirname, '..', 'compose-mcp');
const composeRoot = resolve(__dirname, '..');

const wrapperPkg = JSON.parse(readFileSync(join(wrapperRoot, 'package.json'), 'utf8'));
const wrapperServer = JSON.parse(readFileSync(join(wrapperRoot, 'server.json'), 'utf8'));

test('compose-mcp package.json: identity, version, license', () => {
  assert.equal(wrapperPkg.name, '@smartmemory/compose-mcp');
  assert.equal(wrapperPkg.version, '0.1.0');
  assert.equal(wrapperPkg.license, 'MIT');
  assert.equal(wrapperPkg.type, 'module');
  assert.equal(wrapperPkg.engines.node, '>=18.0.0');
});

test('compose-mcp package.json: bin and dependency', () => {
  assert.equal(wrapperPkg.bin['compose-mcp'], './bin/compose-mcp.js');
  assert.equal(wrapperPkg.dependencies['@smartmemory/compose'], '^0.1.5-beta');
});

test('compose-mcp package.json: files allowlist', () => {
  assert.deepEqual(wrapperPkg.files, ['bin/**', 'README.md', 'LICENSE']);
  assert.equal(wrapperPkg.publishConfig.access, 'public');
});

test('compose-mcp server.json: registry identity and version match', () => {
  assert.equal(wrapperServer.name, 'io.github.smartmemory/compose-mcp');
  assert.equal(wrapperServer.version, '0.1.0');
  assert.equal(wrapperServer.version, wrapperPkg.version);
  assert.equal(wrapperServer.packages[0].identifier, '@smartmemory/compose-mcp');
  assert.equal(wrapperServer.packages[0].registryType, 'npm');
  assert.equal(wrapperServer.packages[0].transport.type, 'stdio');
  assert.equal(wrapperServer.packages[0].version, '0.1.0');
});

test('compose-mcp LICENSE: present and starts with MIT License', () => {
  const license = readFileSync(join(wrapperRoot, 'LICENSE'), 'utf8');
  assert.match(license, /^MIT License/);
  // Byte-identical to root LICENSE
  const rootLicense = readFileSync(join(composeRoot, 'LICENSE'), 'utf8');
  assert.equal(license, rootLicense);
});

test('compose-mcp bin/compose-mcp.js: shebang and executable bit', () => {
  const binPath = join(wrapperRoot, 'bin', 'compose-mcp.js');
  const content = readFileSync(binPath, 'utf8');
  assert.equal(content.split('\n')[0], '#!/usr/bin/env node');
  const mode = statSync(binPath).mode;
  assert.ok(mode & 0o111, 'bin file must be executable');
});

test('compose-mcp launcher: resolution smoke (positive) — launches when parent is installed', { timeout: 5000 }, async () => {
  // Simulate the published-install layout: a consumer dir with node_modules/@smartmemory/compose
  // symlinked to the compose repo, and the wrapper bin invoked from there.
  const tmp = mkdtempSync(join(tmpdir(), 'compose-mcp-pos-'));
  mkdirSync(join(tmp, 'node_modules', '@smartmemory'), { recursive: true });
  const { symlinkSync } = await import('node:fs');
  symlinkSync(composeRoot, join(tmp, 'node_modules', '@smartmemory', 'compose'), 'dir');

  const binPath = join(wrapperRoot, 'bin', 'compose-mcp.js');
  const tmpBin = join(tmp, 'compose-mcp.js');
  writeFileSync(tmpBin, readFileSync(binPath, 'utf8'));

  const child = spawn(process.execPath, [tmpBin], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: tmp,
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  // Close stdin shortly to allow clean termination if SDK supports it.
  setTimeout(() => child.stdin.end(), 200);

  const result = await new Promise((res) => {
    const timer = setTimeout(() => {
      // Server still running after 2s — that's success: it didn't crash.
      child.kill('SIGTERM');
      res({ kind: 'still-running', stderr });
    }, 2000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      res({ kind: 'exited', code, stderr });
    });
  });

  // The launcher should NOT print the "Could not locate" error from the compose repo.
  assert.ok(
    !result.stderr.includes('Could not locate @smartmemory/compose'),
    `launcher should resolve from compose repo; stderr=${result.stderr}`
  );
  // Exit code 127 = resolution failure; should NOT happen here.
  if (result.kind === 'exited') {
    assert.notEqual(result.code, 127, `launcher resolution failed: stderr=${result.stderr}`);
  }
});

test('compose-mcp launcher: resolution smoke (negative) — exit 127 when parent unresolvable', { timeout: 5000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'compose-mcp-neg-'));
  // Create empty node_modules to ensure require.resolve cannot find @smartmemory/compose
  mkdirSync(join(tmp, 'node_modules'));
  writeFileSync(join(tmp, 'package.json'), '{"name":"neg-test","version":"0.0.0"}');

  const binPath = join(wrapperRoot, 'bin', 'compose-mcp.js');
  // Copy the bin into the tmp dir so require.resolve walks up from there
  const tmpBin = join(tmp, 'compose-mcp.js');
  writeFileSync(tmpBin, readFileSync(binPath, 'utf8'));

  const child = spawn(process.execPath, [tmpBin], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: tmp,
    env: { ...process.env, NODE_PATH: '' },
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const result = await new Promise((res) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      res({ code: null, stderr });
    }, 3000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      res({ code, stderr });
    });
  });

  assert.equal(result.code, 127, `expected exit 127, got ${result.code}; stderr=${result.stderr}`);
  assert.match(result.stderr, /Could not locate @smartmemory\/compose/);
});

test('compose-mcp npm pack --dry-run: lists exactly 4 files', { timeout: 30000 }, async () => {
  const result = await new Promise((res) => {
    const child = spawn('npm', ['pack', '--dry-run', '--json'], { cwd: wrapperRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => res({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, `npm pack failed: ${result.stderr}`);
  const data = JSON.parse(result.stdout);
  const fileNames = data[0].files.map((f) => f.path).sort();
  assert.deepEqual(
    fileNames,
    ['LICENSE', 'README.md', 'bin/compose-mcp.js', 'package.json'],
    `pack listed: ${fileNames.join(', ')}`
  );
});
