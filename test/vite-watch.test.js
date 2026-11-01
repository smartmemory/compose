/**
 * vite-watch.test.js — COMP-WIKI-GRAPH-SURFACES-1: the cockpit's dev server ignores the sessions' git worktrees.
 *
 * The real vite.config.js `server.watch.ignored`, matched the way the watcher matches it (chokidar 3 through anymatch,
 * on absolute paths with `dot`), over one row per kind of path: a worktree's files must not reload the cockpit, the
 * app's own entry and sources must still be watched, including when this checkout is itself a worktree.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import anymatch from 'anymatch';
import { loadConfigFromFile } from 'vite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Loaded the way vite loads it (bundled, so the config's `__dirname` resolves), not a bare import.
const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, join(ROOT, 'vite.config.js'), ROOT, 'silent');
const ignored = config.server.watch.ignored;

const ROWS = [
  // relative path, ignored?
  ['.worktrees/push-2f367d82/index.html', true],
  ['.worktrees/doc-path-links/poc/vision-surface.html', true],
  ['.worktrees/doc-path-links/src/App.jsx', true],
  ['node_modules/vite/dist/node/index.js', true],
  ['.compose/data/graph-layout.json', true],
  ['docs/features/X-1/design.md', true],
  ['index.html', false],
  ['src/App.jsx', false],
  ['src/components/vision/GraphView.jsx', false],
];

describe('vite server.watch.ignored', () => {
  for (const [rel, want] of ROWS) {
    test(`${rel} is ${want ? 'ignored' : 'watched'}`, () => {
      assert.equal(anymatch(ignored, join(ROOT, rel), { dot: true }), want); // chokidar's ANYMATCH_OPTS
    });
  }
});
