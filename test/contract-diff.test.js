/**
 * contract-diff.test.js — Unit tests for compose/server/contract-diff.js
 *
 * Uses tmp dirs with synthetic JSON schema fixtures to avoid touching
 * ~/.claude or the real project repo.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { diffContracts } = await import(`${REPO_ROOT}/server/contract-diff.js`);

// ── Git repo fixture ─────────────────────────────────────────────────────────
//
// We need a real (minimal) git repo so git show and git rev-list work.
// Setup: init repo, write anchor schema, commit, modify schema, keep working tree dirty.

let repoDir;
let anchorRef;

function writeSchema(dir, filename, schema) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(schema, null, 2));
}

before(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-diff-'));
  const git = (cmd) => execSync(cmd, { cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

  git('git init');
  git('git config user.email "test@example.com"');
  git('git config user.name "Test"');

  // Write anchor schema
  writeSchema(repoDir, 'schema.json', {
    type: 'object',
    properties: {
      id:   { type: 'string' },
      name: { type: 'string' },
    },
    additionalProperties: false,
  });

  git('git add schema.json');
  git('git commit -m "anchor"');

  // Capture anchor ref
  anchorRef = git('git rev-parse HEAD').trim();
});

after(() => {
  try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('contract-diff — no change', () => {
  test('identical head and anchor → all counts 0', () => {
    // Schema is still same as anchor; use the committed version as "head"
    const headPath = path.join(repoDir, 'schema.json');
    const result = diffContracts(anchorRef, [headPath], repoDir);
    assert.equal(result.added, 0, 'added should be 0');
    assert.equal(result.removed, 0, 'removed should be 0');
    assert.equal(result.retyped, 0, 'retyped should be 0');
    assert.ok(result.total > 0, 'total should reflect fields in schema');
  });
});

describe('contract-diff — field added', () => {
  test('adding a field increments added count', () => {
    // Write a head schema with an extra field
    const newSchema = {
      type: 'object',
      properties: {
        id:          { type: 'string' },
        name:        { type: 'string' },
        description: { type: 'string' }, // new field
      },
      additionalProperties: false,
    };
    const tmpSchema = path.join(repoDir, 'schema-added.json');
    writeSchema(repoDir, 'schema-added.json', newSchema);

    // Anchor doesn't have schema-added.json at all — treat as empty
    const result = diffContracts(anchorRef, [tmpSchema], repoDir);

    // The anchor has no schema-added.json so anchorFields is empty.
    // All fields in head are "added".
    // 3 properties + 1 additionalProperties sentinel = 4 fields added
    assert.ok(result.added >= 3, `expected added >= 3, got ${result.added}`);
    assert.equal(result.removed, 0);
  });
});

describe('contract-diff — field removed', () => {
  test('removing a field increments removed count', () => {
    // Write a head schema with one field removed
    const reducedSchema = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        // 'name' removed
      },
      additionalProperties: false,
    };
    const tmpPath = path.join(repoDir, 'schema-reduced.json');
    writeSchema(repoDir, 'schema-reduced.json', reducedSchema);

    // Anchor for this file doesn't exist — treated as empty anchor
    // So removed would be 0 (nothing in anchor to be "removed" from head's perspective)
    // BUT: test the real case by using the main schema.json which IS in anchor
    // and providing a HEAD with fewer fields.
    const headPath = path.join(repoDir, 'schema.json');

    // Overwrite the head schema temporarily
    const originalContent = fs.readFileSync(headPath, 'utf8');
    writeSchema(repoDir, 'schema.json', reducedSchema);

    const result = diffContracts(anchorRef, [headPath], repoDir);
    // Anchor has {id, name, __additionalProperties_closed__}
    // Head has {id, __additionalProperties_closed__}
    // => 'name' removed = 1 removed
    assert.ok(result.removed >= 1, `expected removed >= 1, got ${result.removed}`);

    // Restore
    fs.writeFileSync(headPath, originalContent);
  });
});

describe('contract-diff — field retyped', () => {
  test('changing a field type increments retyped count', () => {
    const retypedSchema = {
      type: 'object',
      properties: {
        id:   { type: 'integer' }, // was 'string'
        name: { type: 'string' },
      },
      additionalProperties: false,
    };
    const headPath = path.join(repoDir, 'schema.json');
    const originalContent = fs.readFileSync(headPath, 'utf8');
    writeSchema(repoDir, 'schema.json', retypedSchema);

    const result = diffContracts(anchorRef, [headPath], repoDir);
    assert.ok(result.retyped >= 1, `expected retyped >= 1, got ${result.retyped}`);

    fs.writeFileSync(headPath, originalContent);
  });

  test('regression: nested property retype is detected (codex round-2 finding)', () => {
    // Earlier draft only compared top-level schema.properties for retype, so a
    // nested field whose type changed (e.g. `address.zip: string → integer`)
    // was silently undercounted. Guard against that regression.
    const headPath = path.join(repoDir, 'nested.json');
    const anchorSchema = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            zip:    { type: 'string' },
            street: { type: 'string' },
          },
        },
      },
    };
    writeSchema(repoDir, 'nested.json', anchorSchema);
    execSync(`git add nested.json && git commit -m "anchor with nested"`, { cwd: repoDir });
    const newAnchorRef = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();

    const retypedNested = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: {
            zip:    { type: 'integer' }, // ← nested retype
            street: { type: 'string' },
          },
        },
      },
    };
    writeSchema(repoDir, 'nested.json', retypedNested);

    const result = diffContracts(newAnchorRef, [headPath], repoDir);
    assert.ok(
      result.retyped >= 1,
      `nested retype must be counted; got retyped=${result.retyped}`,
    );
  });
});

describe('contract-diff — empty headPaths', () => {
  test('empty headPaths → all zeros', () => {
    const result = diffContracts(anchorRef, [], repoDir);
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
    assert.equal(result.retyped, 0);
    assert.equal(result.total, 0);
  });
});

describe('contract-diff — unparseable file', () => {
  test('unparseable head file is skipped gracefully', () => {
    const badPath = path.join(repoDir, 'bad.json');
    fs.writeFileSync(badPath, 'not-json{{{');
    // Should not throw; result has all zeros for this file
    const result = diffContracts(anchorRef, [badPath], repoDir);
    assert.equal(result.total, 0, 'unparseable file should contribute 0 total');
  });
});
