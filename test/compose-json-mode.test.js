/** COMP-COCKPIT-12-FU-1 (FLEET-PROJECTS-1 M2): writeComposeJson's tmp-then-rename keeps the file's mode. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeComposeJson } from '../lib/cli-remote.js';

test('a 0600 compose.json stays 0600 after a write, and the patch lands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-json-mode-'));
  try {
    mkdirSync(join(dir, '.compose'));
    const file = join(dir, '.compose', 'compose.json');
    writeFileSync(file, '{"keep":1}\n');
    chmodSync(file, 0o600);
    writeComposeJson(dir, { fleet: { projects: ['a'] } });
    assert.equal(statSync(file).mode & 0o7777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { keep: 1, fleet: { projects: ['a'] } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a 0644 file stays 0644 and a new file is created', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-json-mode-'));
  try {
    mkdirSync(join(dir, '.compose'));
    const file = join(dir, '.compose', 'compose.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o644);
    writeComposeJson(dir, { a: 1 });
    assert.equal(statSync(file).mode & 0o7777, 0o644);
    rmSync(file);
    writeComposeJson(dir, { b: 2 });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { b: 2 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
