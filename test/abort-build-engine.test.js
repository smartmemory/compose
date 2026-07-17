/**
 * C2: abortBuild resolves the stratum engine from the PROJECT ROOT that dataDir
 * represents, not process.cwd(). A python-pinned project must audit through the
 * python engine even when the server process cwd (or default) selects TS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { abortBuild } = await import(`${REPO_ROOT}/lib/build.js`);

function makeProject(engine) {
  const root = mkdtempSync(join(tmpdir(), 'abort-engine-'));
  const dataDir = join(root, '.compose', 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(root, '.compose', 'compose.json'),
    JSON.stringify({ version: 2, capabilities: { stratum: true, stratumEngine: engine } }));
  writeFileSync(join(dataDir, 'active-build.json'),
    JSON.stringify({ featureCode: 'F-1', flowId: 'flow-abc', status: 'running' }));
  return { root, dataDir };
}

function fakeStratum(record) {
  return {
    connect: async (conn) => { record.conn = conn; },
    audit: async () => ({ status: 'completed' }), // terminal → no flow-file deletion
    close: async () => {},
  };
}

test('C2: abortBuild resolves the engine from the project root (python-pinned → stratum-mcp)', async () => {
  // COMPOSE_STRATUM_ENGINE must be unset so the PROJECT capability drives selection.
  const savedEnv = process.env.COMPOSE_STRATUM_ENGINE;
  delete process.env.COMPOSE_STRATUM_ENGINE;
  const { root, dataDir } = makeProject('python');
  try {
    const record = {};
    await abortBuild(dataDir, 'F-1', root, { stratum: fakeStratum(record) });
    assert.ok(record.conn, 'abortBuild must connect the stratum client');
    assert.equal(record.conn.command, 'stratum-mcp', 'python-pinned project → python connection');
    assert.equal(record.conn.cwd, root, 'connection cwd is the project root');
  } finally {
    if (savedEnv === undefined) delete process.env.COMPOSE_STRATUM_ENGINE;
    else process.env.COMPOSE_STRATUM_ENGINE = savedEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test('C2: a TS-pinned project resolves the TS engine connection (node + mcp bin)', async () => {
  const savedEnv = process.env.COMPOSE_STRATUM_ENGINE;
  delete process.env.COMPOSE_STRATUM_ENGINE;
  const { root, dataDir } = makeProject('ts');
  try {
    const record = {};
    await abortBuild(dataDir, 'F-1', root, { stratum: fakeStratum(record) });
    assert.ok(record.conn, 'abortBuild must connect the stratum client');
    assert.notEqual(record.conn.command, 'stratum-mcp', 'TS-pinned project → not the python bin');
    assert.match(record.conn.args?.[0] ?? '', /mcp[\/\\]bin\.mjs$/, 'TS connection points at the mcp bin');
  } finally {
    if (savedEnv === undefined) delete process.env.COMPOSE_STRATUM_ENGINE;
    else process.env.COMPOSE_STRATUM_ENGINE = savedEnv;
    rmSync(root, { recursive: true, force: true });
  }
});
