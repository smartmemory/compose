/**
 * COMP-NEWUSER-README-1: `compose init` -> `compose feature` -> `compose roadmap`
 * must work in an empty project. A clean-install walk found `feature` writing a
 * 4-column row into the 3-column table `init` creates, after which `roadmap`
 * exited 1 with "no named feature rows were parsed".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendFeatureRow } from '../lib/roadmap-append.js';
import { parseRoadmap } from '../lib/roadmap-parser.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'compose.js');

function compose(args, cwd, home) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, NO_COLOR: '1', COMPOSE_NO_UPDATE_CHECK: '1' },
  });
}

test('init -> feature -> feature -> roadmap parses both features in an empty project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-newuser-'));
  const home = mkdtempSync(join(tmpdir(), 'compose-newuser-home-'));
  try {
    assert.equal(compose(['init'], dir, home).status, 0, 'init failed');
    assert.equal(compose(['feature', 'AUTH-1', 'JWT middleware'], dir, home).status, 0);
    assert.equal(compose(['feature', 'AUTH-2', 'Rate limiting'], dir, home).status, 0);

    const roadmap = compose(['roadmap'], dir, home);
    assert.equal(roadmap.status, 0, `roadmap exited ${roadmap.status}: ${roadmap.stderr}${roadmap.stdout}`);
    assert.doesNotMatch(roadmap.stderr + roadmap.stdout, /no named feature rows/);
    assert.match(roadmap.stdout, /AUTH-1/);
    assert.match(roadmap.stdout, /AUTH-2/);

    const codes = parseRoadmap(readFileSync(join(dir, 'ROADMAP.md'), 'utf-8')).map((e) => e.code);
    assert.ok(codes.includes('AUTH-1') && codes.includes('AUTH-2'), `parsed: ${codes}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('appendFeatureRow adds a Feature column to a 3-column table, keeping old rows anonymous', () => {
  const src = '## Phase 1: A — PLANNED\n\n| # | Item | Status |\n|---|------|--------|\n| 1 | Setup | PLANNED |\n';
  const { text, itemNumber } = appendFeatureRow(src, 'X-1', 'Thing');
  assert.equal(itemNumber, 2);
  const entries = parseRoadmap(text);
  assert.deepEqual(entries.map((e) => e.description), ['Setup', 'Thing']);
  assert.equal(entries[1].code, 'X-1');
  assert.ok(entries[0].code.startsWith('_anon_'));
});

test('appendFeatureRow leaves an existing 4-column Feature table shape alone', () => {
  const src = '## Phase 1: A — PLANNED\n\n| # | Feature | Item | Status |\n|---|---------|------|--------|\n| 1 | A-1 | One | COMPLETE |\n| 2 | A-2 | Two | PLANNED |\n';
  const { text } = appendFeatureRow(src, 'A-3', 'Three');
  assert.match(text, /\| 3 \| A-3 \| Three \| PLANNED \|/);
  assert.deepEqual(parseRoadmap(text).map((e) => e.code), ['A-1', 'A-2', 'A-3']);
});

test('appendFeatureRow with no table creates a Features section the parser reads', () => {
  const { text } = appendFeatureRow('# R\n', 'B-1', 'Only');
  assert.deepEqual(parseRoadmap(text).map((e) => e.code), ['B-1']);
});
