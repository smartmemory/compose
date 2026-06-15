/**
 * project-paths.test.js — coverage for lib/project-paths.js
 * (COMP-MCP-MIGRATION-2).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadFeaturesDir, loadExternalPrefixes, _internals,
  resolveFeaturesPath, resolveRoadmapPath, resolveJournalPath,
  resolveContextPath, resolveIdeaboxPath, resolveDocsPath,
  resolveFeaturesPathFromConfig, resolveJournalPathFromConfig,
} from '../lib/project-paths.js';
import { join as pjoin } from 'node:path';

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

describe('resolve*Path readers (absolute)', () => {
  test('default-identity: unset config → legacy absolute path per key', () => {
    const cwd = freshCwd();
    assert.equal(resolveDocsPath(cwd),    pjoin(cwd, 'docs'));
    assert.equal(resolveRoadmapPath(cwd), pjoin(cwd, 'ROADMAP.md'));
    assert.equal(resolveFeaturesPath(cwd),pjoin(cwd, 'docs/features'));
    assert.equal(resolveJournalPath(cwd), pjoin(cwd, 'docs/journal'));
    assert.equal(resolveContextPath(cwd), pjoin(cwd, 'docs/context'));
    assert.equal(resolveIdeaboxPath(cwd), pjoin(cwd, 'docs/product/ideabox.md'));
  });

  test('honors an absolute override (not re-rooted under cwd)', () => {
    const cwd = freshCwd();
    writeConfig(cwd, { paths: { features: '/external/docs/features', roadmap: '/external/ROADMAP.md' } });
    assert.equal(resolveFeaturesPath(cwd), '/external/docs/features');
    assert.equal(resolveRoadmapPath(cwd), '/external/ROADMAP.md');
  });

  test('honors a ../-escaping override', () => {
    const cwd = freshCwd();
    writeConfig(cwd, { paths: { features: '../shared-docs/features' } });
    assert.equal(resolveFeaturesPath(cwd), pjoin(cwd, '../shared-docs/features'));
  });

  test('*FromConfig resolves against the PASSED root/config (no file read)', () => {
    assert.equal(resolveFeaturesPathFromConfig('/other/root', { paths: { features: 'specs/f' } }), '/other/root/specs/f');
    assert.equal(resolveJournalPathFromConfig('/other/root', {}), '/other/root/docs/journal');
  });
});

describe('loadExternalPrefixes', () => {
  test('returns [] when no .compose/compose.json', () => {
    const cwd = freshCwd();
    assert.deepEqual(loadExternalPrefixes(cwd), []);
  });

  test('returns [] when externalPrefixes is absent', () => {
    const cwd = freshCwd();
    writeConfig(cwd, { paths: {} });
    assert.deepEqual(loadExternalPrefixes(cwd), []);
  });

  test('returns the array when present', () => {
    const cwd = freshCwd();
    writeConfig(cwd, { externalPrefixes: ['STRAT-', 'EXT-'] });
    assert.deepEqual(loadExternalPrefixes(cwd), ['STRAT-', 'EXT-']);
  });

  test('returns [] when externalPrefixes is non-array', () => {
    const cwd = freshCwd();
    writeConfig(cwd, { externalPrefixes: 'STRAT-' });
    assert.deepEqual(loadExternalPrefixes(cwd), []);
  });

  test('returns [] on malformed JSON', () => {
    const cwd = freshCwd();
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'compose.json'), '{not valid', 'utf-8');
    assert.deepEqual(loadExternalPrefixes(cwd), []);
  });
});
