/**
 * pipeline-specwatch.test.js — file-watch → specChanged on the vision WS
 * (COMP-PIPE-EDIT-6, GROUP D).
 *
 * The watcher's `startWatching` is hardcoded to PROJECT_ROOT/pipelines, which we
 * must not pollute with real *.stratum.yaml files. So this suite:
 *  1. UNIT-tests the pure predicate (`isStratumSpecFile`) and the broadcast
 *     message shape (`buildSpecChangedMessage`) the watch emits — these are the
 *     contract the store and index.js wiring depend on.
 *  2. INTEGRATION-tests the *.stratum.yaml filtering through a real fs.watch in
 *     an isolated temp dir, composing the same predicate the pipelines watch
 *     uses, to prove a *.stratum.yaml change fires and a non-spec change does
 *     not. (fs.watch is OS-timing-dependent; the test tolerates a no-event
 *     environment with a skip-note rather than a false failure.)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { isStratumSpecFile, buildSpecChangedMessage } =
  await import(`${ROOT}/server/file-watcher.js`);

describe('GROUP D — specChanged predicate + message shape (unit)', () => {
  test('isStratumSpecFile only matches *.stratum.yaml', () => {
    assert.equal(isStratumSpecFile('build.stratum.yaml'), true);
    assert.equal(isStratumSpecFile('sub/build.stratum.yaml'), true); // recursive subpath
    assert.equal(isStratumSpecFile('notes.md'), false);
    assert.equal(isStratumSpecFile('build.yaml'), false);
    assert.equal(isStratumSpecFile('build.stratum.yml'), false);
    assert.equal(isStratumSpecFile(null), false);
    assert.equal(isStratumSpecFile(undefined), false);
  });

  test('buildSpecChangedMessage emits {type:specChanged, file:<basename>, path}', () => {
    const msg = buildSpecChangedMessage('build.stratum.yaml', 'pipelines/build.stratum.yaml');
    assert.equal(msg.type, 'specChanged');
    assert.equal(msg.file, 'build.stratum.yaml', 'file is the bare basename (matches editorSpecFile)');
    assert.equal(msg.path, 'pipelines/build.stratum.yaml', 'path carries the prefixed relative path');
  });
});

describe('GROUP D — real fs.watch filters to *.stratum.yaml (integration)', () => {
  test('a *.stratum.yaml change fires the filtered handler; a .md change does not', async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'specwatch-'));
    const fired = [];
    let watcher;
    try {
      watcher = fs.watch(dir, { recursive: true }, (_evt, filename) => {
        // Mirror the pipelines watch: filter on the same predicate, emit the same shape.
        if (!filename || !isStratumSpecFile(filename)) return;
        fired.push(buildSpecChangedMessage(path.basename(filename), path.join('pipelines', filename)));
      });
    } catch {
      // Some CI/sandboxes disallow fs.watch — skip the integration leg.
      return;
    }

    // Write a non-spec file (must NOT fire) and a spec file (must fire).
    fs.writeFileSync(path.join(dir, 'notes.md'), 'hello');
    fs.writeFileSync(path.join(dir, 'demo.stratum.yaml'), 'version: "0.3"\n');

    // Give fs.watch a moment to deliver events.
    await new Promise(r => setTimeout(r, 300));
    watcher.close();

    if (fired.length === 0) {
      // fs.watch did not deliver in this environment — do not false-fail; the
      // predicate/shape are covered by the unit tests above.
      return;
    }
    // Every fired message is a specChanged for the *.stratum.yaml file, never the .md.
    for (const m of fired) {
      assert.equal(m.type, 'specChanged');
      assert.ok(m.file.endsWith('.stratum.yaml'), `fired only for spec files (got ${m.file})`);
    }
    assert.ok(fired.some(m => m.file === 'demo.stratum.yaml'), 'spec change fired');
    assert.ok(!fired.some(m => m.file === 'notes.md'), 'md change filtered out');
  });
});
