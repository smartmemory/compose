/**
 * COMP-CLI-HONEST-EXIT-1 — commands that do less than requested must fail
 * visibly, while their complete and deliberately-no-op paths stay unchanged.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'bin', 'compose.js');
const TEST_PORT = '19997';
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function cleanEnv(extra = {}) {
  const env = { ...process.env, COMPOSE_PORT: TEST_PORT, ...extra };
  delete env.COMPOSE_API_TOKEN;
  delete env.COMPOSE_HOST;
  delete env.COMPOSE_REMOTE_AUTH;
  if (extra.COMPOSE_API_TOKEN !== undefined) env.COMPOSE_API_TOKEN = extra.COMPOSE_API_TOKEN;
  return env;
}

function runCli(cwd, args, { env = {}, nodeArgs = [] } = {}) {
  return spawnSync(process.execPath, [...nodeArgs, CLI, ...args], {
    cwd,
    env: cleanEnv(env),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function makeProject(roadmap) {
  const cwd = mkdtempSync(join(tmpdir(), 'compose-honest-exit-'));
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({ version: 2 }) + '\n');
  if (roadmap !== undefined) writeFileSync(join(cwd, 'ROADMAP.md'), roadmap);
  return cwd;
}

function significantLines(stdout) {
  return stdout
    .replace(ANSI_RE, '')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

describe('SD01 — compose roadmap', () => {
  test('exits non-zero and explains when a populated roadmap renders nothing', () => {
    const cwd = makeProject(`# Legacy Roadmap

## Phase A

| # | Code | Description | Status |
|---|------|-------------|--------|
| 1 | NAMED-1 | Named work | PLANNED |
`);
    try {
      const result = runCli(cwd, ['roadmap']);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /roadmap.*nothing rendered.*no named feature rows.*Feature.*or.*ID/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a supported roadmap still exits 0 with its existing rendered output', () => {
    const cwd = makeProject(`# Good Roadmap

## Phase A

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | NAMED-1 | Named work | PLANNED |
`);
    try {
      const result = runCli(cwd, ['roadmap']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, '');
      assert.deepEqual(significantLines(result.stdout), [
        'Good (1 features)',
        'Phase A (0/1)',
        '○ NAMED-1 Named work',
        '1 planned',
        'Next up:',
        'compose build NAMED-1 — Named work',
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function makeExperimentLoader(dir) {
  const mockPath = join(dir, 'experiment-mock.mjs');
  const loaderPath = join(dir, 'experiment-loader.mjs');
  writeFileSync(mockPath, `
export async function runExperiment() {
  const completed = process.env.COMPOSE_TEST_EXPERIMENT_COMPLETE === '1';
  return {
    resultsPath: '/tmp/results.json',
    reportPath: '/tmp/report.md',
    runs: [{
      runId: 'auth-run-1',
      metrics: { outcome: { completed } },
      ...(completed ? {} : { _error: 'authentication failed' }),
    }],
  };
}
`);
  writeFileSync(loaderPath, `
import { pathToFileURL } from 'node:url';
const mockUrl = pathToFileURL(${JSON.stringify(mockPath)}).href;
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '../lib/experiment.js' && context.parentURL?.endsWith('/bin/compose.js')) {
    return { url: mockUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`);
  return ['--no-warnings', '--experimental-loader', loaderPath];
}

describe('SD02 — compose experiment', () => {
  test('exits non-zero and names incomplete authenticated work', () => {
    const cwd = makeProject();
    const specPath = join(cwd, 'spec.json');
    writeFileSync(specPath, '{}\n');
    try {
      const result = runCli(cwd, ['experiment', specPath], {
        nodeArgs: makeExperimentLoader(cwd),
      });
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /experiment incomplete.*1 of 1 run.*auth-run-1.*authentication failed/is);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a completed experiment still exits 0 with the existing result paths', () => {
    const cwd = makeProject();
    const specPath = join(cwd, 'spec.json');
    writeFileSync(specPath, '{}\n');
    try {
      const result = runCli(cwd, ['experiment', specPath], {
        env: { COMPOSE_TEST_EXPERIMENT_COMPLETE: '1' },
        nodeArgs: makeExperimentLoader(cwd),
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, 'Results: /tmp/results.json\nReport:  /tmp/report.md\n');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function makeHttpLoader(dir) {
  const mockPath = join(dir, 'http-mock.mjs');
  const loaderPath = join(dir, 'http-loader.mjs');
  writeFileSync(mockPath, `
import { EventEmitter } from 'node:events';
class MockRequest extends EventEmitter {
  constructor(callback) { super(); this.callback = callback; }
  write() {}
  setTimeout() {}
  destroy() {}
  end() {
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      this.callback(response);
      queueMicrotask(() => {
        response.emit('data', Buffer.from(JSON.stringify({ devices: [{ id: 'dev-1', revoked: false }] })));
        response.emit('end');
      });
    });
  }
}
export default { request(_options, callback) { return new MockRequest(callback); } };
`);
  writeFileSync(loaderPath, `
import { pathToFileURL } from 'node:url';
const mockUrl = pathToFileURL(${JSON.stringify(mockPath)}).href;
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:http' && context.parentURL?.endsWith('/lib/cli-remote.js')) {
    return { url: mockUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`);
  return ['--no-warnings', '--experimental-loader', loaderPath];
}

describe('SD03 — compose remote status', () => {

  test('exits non-zero when the paired-device query is skipped without a token', () => {
    const cwd = makeProject();
    try {
      const result = runCli(cwd, ['remote', 'status']);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /remote status incomplete.*paired-device query skipped.*COMPOSE_API_TOKEN/i);
      assert.match(result.stdout, /Paired devices:\s+\(COMPOSE_API_TOKEN not set — cannot query server\)/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a completed device query still exits 0 with the existing status output', () => {
    const cwd = makeProject();
    try {
      const result = runCli(cwd, ['remote', 'status'], {
        env: { COMPOSE_API_TOKEN: 'status-token' },
        nodeArgs: makeHttpLoader(cwd),
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, '');
      assert.deepEqual(
        significantLines(result.stdout).filter((line) => !line.startsWith('dist/ bundle:')),
        [
          'Bind host: 127.0.0.1',
          'Remote auth: disabled',
          'Public host: not configured',
          'Paired devices: 1 active (1 total)',
          'To configure remote access:',
          '1. Start a tunnel to port 4001 (Tailscale Funnel, Cloudflare Tunnel, ngrok, etc.)',
          '2. Run: compose remote pair --public-host=<your-tunnel-URL>',
        ],
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

const ANON_ROADMAP = `# Anonymous Roadmap

## Phase A

| # | Item | Status |
|---|------|--------|
| — | Historical work | PLANNED |
`;

describe('SD04 — compose migrate-anon', () => {
  test('--non-interactive exits non-zero when rows were listed but none promoted', () => {
    const cwd = makeProject(ANON_ROADMAP);
    try {
      const result = runCli(cwd, ['migrate-anon', '--non-interactive']);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /migrate-anon incomplete.*1 anonymous row.*zero promoted.*non-interactive/i);
      assert.equal(result.stdout, [
        'migrate-anon: 1 anonymous row(s):',
        '  [Phase A] Historical work  (PLANNED)',
        'Run interactively in a TTY to promote rows.',
        '',
      ].join('\n'));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('--dry-run remains a successful deliberate listing with unchanged output', () => {
    const cwd = makeProject(ANON_ROADMAP);
    try {
      const result = runCli(cwd, ['migrate-anon', '--dry-run']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, [
        'migrate-anon: 1 anonymous row(s):',
        '  [Phase A] Historical work  (PLANNED)',
        'Run interactively in a TTY to promote rows.',
        '',
      ].join('\n'));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
