import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import uiConfig from '../vitest.config.js';
import trackerConfig from '../vitest.tracker.config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : /\.test\.(js|jsx)$/.test(entry.name) ? [relative(root, path)] : [];
  });
}

function matches(file, glob) {
  const pattern = glob.replaceAll('.', '\\.')
    .replaceAll('**/', '§').replaceAll('*', '[^/]*').replaceAll('§', '(?:.*/)?')
    .replace(/\{([^}]+)\}/g, (_m, choices) => `(${choices.split(',').join('|')})`);
  return new RegExp(`^${pattern}$`).test(file);
}

test('every checked-in test location is included by npm test runners', () => {
  const nodeGlobs = pkg.scripts.test.match(/\S+\*\S*\.test\.js/g) ?? [];
  const globs = [...nodeGlobs, ...uiConfig.test.include, ...trackerConfig.test.include];
  // stage-grading fixtures are hidden tests and a seeded scenario that the debug archetype's oracle runs inside a workspace copy
  // (test/archetype-debug.test.js, test/experiment-stage-debug-integration.test.js); npm test must never run them directly.
  const oracleFixtures = 'test/fixtures/stage-grading/';
  const omitted = ['test', 'tests', 'src'].flatMap(dir => files(join(root, dir)))
    .filter(file => !file.startsWith(oracleFixtures))
    .filter(file => !globs.some(glob => matches(file, glob)));
  assert.deepEqual(omitted, [], 'Tests outside runner discovery silently stop protecting shipped paths');
});
