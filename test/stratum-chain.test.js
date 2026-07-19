/**
 * compose #50 — Stratum package chaining and wiring repair golden.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIVE_STRATUM_TS_MCP_BIN,
  healStratumWiring,
  resolveStratumMcpConnection,
} from '../lib/stratum-engine.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function installStubStratum(root) {
  const packageRoot = join(root, 'node_modules', '@smartmemory', 'stratum');
  const mcpBin = join(packageRoot, 'dist', 'mcp', 'main.js');
  const cliBin = join(packageRoot, 'dist', 'cli', 'stratum.js');
  mkdirSync(dirname(mcpBin), { recursive: true });
  mkdirSync(dirname(cliBin), { recursive: true });
  writeFileSync(mcpBin, '#!/usr/bin/env node\n');
  writeFileSync(cliBin, '#!/usr/bin/env node\n');
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@smartmemory/stratum',
    bin: {
      'stratum-mcp': './dist/mcp/main.js',
      stratum: './dist/cli/stratum.js',
    },
  }));
  return { mcpBin };
}

function resolverFrom(root) {
  return createRequire(join(root, 'package.json')).resolve;
}

function noInstalledDependency(specifier) {
  const error = new Error(`Cannot find module '${specifier}'`);
  error.code = 'MODULE_NOT_FOUND';
  throw error;
}

test('installed @smartmemory/stratum MCP bin wins over the sibling checkout', (t) => {
  const root = fixture(t, 'compose-stratum-installed-');
  const { mcpBin } = installStubStratum(root);

  const connection = resolveStratumMcpConnection(root, {
    env: {},
    requireResolve: resolverFrom(root),
  });

  assert.equal(connection.args[0], realpathSync(mcpBin));
  assert.notEqual(connection.args[0], LIVE_STRATUM_TS_MCP_BIN);
});

test('missing installed dependency falls back to the sibling checkout', (t) => {
  // Inject a real (existing) sibling bin so the test is deterministic in CI, where
  // the actual monorepo sibling path does not exist. resolveStratumBin only returns
  // a sibling candidate that exists on disk.
  const root = fixture(t, 'compose-stratum-sibling-');
  const fakeSibling = join(root, 'bin.mjs');
  writeFileSync(fakeSibling, '');
  const connection = resolveStratumMcpConnection(REPO_ROOT, {
    env: {},
    requireResolve: noInstalledDependency,
    siblingBins: { mcp: fakeSibling },
  });

  assert.equal(connection.args[0], fakeSibling);
});

test('explicit env override wins over installed dependency and sibling checkout', (t) => {
  const root = fixture(t, 'compose-stratum-env-');
  installStubStratum(root);
  const envBin = join(root, 'env-stratum-mcp.mjs');
  writeFileSync(envBin, '#!/usr/bin/env node\n');

  const connection = resolveStratumMcpConnection(root, {
    env: { COMPOSE_STRATUM_TS_MCP_BIN: envBin },
    requireResolve: resolverFrom(root),
  });

  assert.equal(connection.args[0], envBin);
});

test('resolution fails loudly when neither dependency nor sibling bin exists', (t) => {
  const root = fixture(t, 'compose-stratum-missing-');
  const bogusSibling = join(root, 'missing', 'stratum-mcp.mjs');

  assert.throws(
    () => resolveStratumMcpConnection(root, {
      env: {},
      requireResolve: noInstalledDependency,
      siblingBins: { mcp: bogusSibling },
    }),
    (error) => {
      assert.match(error.message, /install @smartmemory\/stratum/i);
      assert.match(error.message, /stratum checkout as a sibling/i);
      return true;
    },
  );
});

test('healStratumWiring replaces stale Stratum wiring and preserves sibling servers', (t) => {
  const workspace = fixture(t, 'compose-stratum-heal-');
  const mcpPath = join(workspace, '.mcp.json');
  const other = { command: 'other-server', args: ['--keep-me'] };
  writeFileSync(mcpPath, `${JSON.stringify({
    mcpServers: {
      stratum: { command: 'stratum-mcp', args: [] },
      other,
    },
  }, null, 2)}\n`);

  const result = healStratumWiring(workspace);
  const healed = JSON.parse(readFileSync(mcpPath, 'utf8'));

  // Compose heals to its OWN resolved entry (installed dep OR sibling bin,
  // whichever the resolver picks — NOT hardcoded, so this holds whether or not
  // @smartmemory/stratum is installed), and NEVER the npx-pinned form that
  // stratum doctor writes (broken until published). Regression guard.
  const conn = resolveStratumMcpConnection(workspace);
  const expected = { command: conn.command, args: conn.args };
  assert.equal(result.healed, true);
  assert.deepEqual(result.before, { command: 'stratum-mcp', args: [] });
  assert.deepEqual(result.after, expected);
  assert.notEqual(healed.mcpServers.stratum.command, 'npx');
  assert.deepEqual(healed.mcpServers.stratum, expected);
  assert.deepEqual(healed.mcpServers.other, other);

  // Idempotent: a second heal is a no-op.
  const again = healStratumWiring(workspace);
  assert.equal(again.healed, false);
  assert.deepEqual(JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.stratum, expected);
});
