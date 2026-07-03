/**
 * smartmemory-config.test.js — COMP-SMARTMEMORY-INGEST T1
 *
 * Tests for lib/smartmemory-config.js: getSmartmemoryConfig, resolveProjectTag,
 * sourcePathFor.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { getSmartmemoryConfig, resolveProjectTag, sourcePathFor } from '../lib/smartmemory-config.js';

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'smartmemory-config-'));
}

function writeComposeJson(dir, obj) {
  mkdirSync(join(dir, '.compose'), { recursive: true });
  writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify(obj));
}

describe('getSmartmemoryConfig', () => {
  test('absent block → {}', () => {
    const dir = makeDir();
    try {
      writeComposeJson(dir, { workspaceId: 'foo' });
      assert.deepEqual(getSmartmemoryConfig(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing compose.json entirely → {}', () => {
    const dir = makeDir();
    try {
      assert.deepEqual(getSmartmemoryConfig(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('present block → verbatim', () => {
    const dir = makeDir();
    try {
      const block = { enabled: true, baseUrl: 'http://localhost:9999', apiKeyEnv: 'SM_KEY', timeoutMs: 5000 };
      writeComposeJson(dir, { workspaceId: 'foo', smartmemory: block });
      assert.deepEqual(getSmartmemoryConfig(dir), block);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('malformed JSON → {}', () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, '.compose'), { recursive: true });
      writeFileSync(join(dir, '.compose', 'compose.json'), '{ not json');
      assert.deepEqual(getSmartmemoryConfig(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('getSmartmemoryConfig — non-standard shapes', () => {
  test('smartmemory as a bare primitive (true, not an object) is returned verbatim, not coerced to {}', () => {
    // `cfg.smartmemory ?? {}` only nullish-coalesces — a malformed but
    // *present* non-object value passes through unchanged. Consumers guard
    // with `.enabled === true` / `?.enabled`, which is safe against a
    // primitive (property access auto-boxes to undefined), but the reader
    // itself does not normalize the shape.
    const dir = makeDir();
    try {
      writeComposeJson(dir, { workspaceId: 'foo', smartmemory: true });
      assert.equal(getSmartmemoryConfig(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveProjectTag', () => {
  test('valid workspaceId → that id', () => {
    const dir = makeDir();
    try {
      writeComposeJson(dir, { workspaceId: 'my-workspace' });
      assert.equal(resolveProjectTag(dir), 'my-workspace');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('absent workspaceId → basename(cwd)', () => {
    const dir = makeDir();
    try {
      assert.equal(resolveProjectTag(dir), basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('invalid workspaceId (uppercase) → basename(cwd)', () => {
    const dir = makeDir();
    try {
      writeComposeJson(dir, { workspaceId: 'NOT-VALID' });
      assert.equal(resolveProjectTag(dir), basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sourcePathFor', () => {
  test('joins project tag + repo-relative path', () => {
    assert.equal(sourcePathFor('regio', 'a/b.md'), 'compose/regio/a/b.md');
  });
});
