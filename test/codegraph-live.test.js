// STRAT-CODEGRAPH-1 live: the real producer (SmartMemory CLI or bundle_fallback.py) on a
// small temp git tree. SKIPS when no capable SmartMemory is installed (point
// COMPOSE_CODEGRAPH_PYTHON at a Python whose smartmemory has CodeIndexer.parse to run it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectCodegraph, resetAvailabilityCache } from '../lib/codegraph/availability.js';
import { loadSnapshots } from '../lib/codegraph/snapshot.js';
import { buildModel } from '../lib/codegraph/model.js';

const env = { ...process.env, COMPOSE_CODEGRAPH: '1' };
delete env.SMARTMEMORY_CODE_CHECKPOINT_DIR; // parse cache must land inside the temp project
resetAvailabilityCache();
const availability = await detectCodegraph({ cwd: tmpdir(), env });

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

test('live producer: snapshot, callers, cache hit, re-index on edit', { skip: availability.available ? false : `codegraph unavailable: ${availability.reason}`, timeout: 600000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codegraph-live-'));
  try {
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib', 'store.js'), 'export function saveThing(x) {\n  return x;\n}\n');
    writeFileSync(join(dir, 'lib', 'use.js'), "import { saveThing } from './store.js';\n\nexport function run() {\n  return saveThing(1);\n}\n");
    git(dir, 'init', '-q');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');

    const first = await loadSnapshots({ projectRoot: dir, availability, env });
    assert.deepEqual(first.errors, []);
    assert.equal(first.snapshots.length, 1);
    assert.equal(first.snapshots[0].cached, false);
    assert.equal(first.snapshots[0].snapshot.schema_version, '1');
    const model = buildModel(first.snapshots);
    const callers = model.callersOf('saveThing');
    assert.deepEqual(callers.definitions, ['lib/store.js:1']);
    assert.ok(callers.resolved.some((c) => c.path === 'lib/use.js' && c.line === 4), JSON.stringify(callers));

    const second = await loadSnapshots({ projectRoot: dir, availability, env });
    assert.equal(second.snapshots[0].cached, true);

    writeFileSync(join(dir, 'lib', 'use.js'), "import { saveThing } from './store.js';\n\nexport function run() {\n  saveThing(0);\n  return saveThing(1);\n}\n");
    const third = await loadSnapshots({ projectRoot: dir, availability, env });
    assert.equal(third.snapshots[0].cached, false);
    assert.ok(buildModel(third.snapshots).callersOf('saveThing').resolved.some((c) => c.line === 5));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
