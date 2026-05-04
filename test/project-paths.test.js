/**
 * project-paths.test.js — coverage for lib/project-paths.js
 * (COMP-MCP-MIGRATION-2).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadFeaturesDir, _internals } from '../lib/project-paths.js';

function freshCwd() {
  return mkdtempSync(join(tmpdir(), 'project-paths-'));
}

function writeConfig(cwd, cfg) {
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify(cfg), 'utf-8');
}

describe('loadFeaturesDir', () => {
  test('returns default when no .compose/compose.json', () => {
    const cwd = freshCwd();
    assert.equal(loadFeaturesDir(cwd), 'docs/features');
    assert.equal(_internals.DEFAULT_FEATURES_DIR, 'docs/features');
  });

  test('returns default when paths.features is unset', () => {
    const cwd = freshCwd();
    writeConfig(cwd, { paths: {} });
    assert.equal(loadFeaturesDir(cwd), 'docs/features');
  });

  test('returns default when config has no paths block', () => {
    const cwd = freshCwd();
    writeConfig(cwd, { capabilities: { stratum: true } });
    assert.equal(loadFeaturesDir(cwd), 'docs/features');
  });

  test('honors paths.features override', () => {
    const cwd = freshCwd();
    writeConfig(cwd, { paths: { features: 'specs/features' } });
    assert.equal(loadFeaturesDir(cwd), 'specs/features');
  });

  test('returns default on malformed JSON', () => {
    const cwd = freshCwd();
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'compose.json'), '{not valid', 'utf-8');
    assert.equal(loadFeaturesDir(cwd), 'docs/features');
  });

  test('returns default when paths.features is empty string', () => {
    const cwd = freshCwd();
    writeConfig(cwd, { paths: { features: '' } });
    assert.equal(loadFeaturesDir(cwd), 'docs/features');
  });

  test('returns default when paths.features is non-string', () => {
    const cwd = freshCwd();
    writeConfig(cwd, { paths: { features: 42 } });
    assert.equal(loadFeaturesDir(cwd), 'docs/features');
  });
});
