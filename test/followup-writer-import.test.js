/**
 * COMP-MCP-FOLLOWUP-1 regression guard.
 *
 * propose_followup broke at runtime with "module './project-paths.js' does not
 * provide an export named 'resolveRoadmapPath'" — a stale long-running MCP
 * server linking the lazily-imported followup-writer against a cached
 * project-paths.js. The on-disk code was fine; a server reconnect fixed it.
 *
 * These tests are the *genuine* CI guard: they fail if the export ever actually
 * goes missing on disk (the case the stale-server hint would mislead about).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('followup-writer import graph (COMP-MCP-FOLLOWUP-1)', () => {
  test('lib/followup-writer.js imports cleanly and exports proposeFollowup', async () => {
    const mod = await import('../lib/followup-writer.js');
    assert.equal(typeof mod.proposeFollowup, 'function');
  });

  test('lib/project-paths.js exports resolveRoadmapPath (the export whose absence broke propose_followup)', async () => {
    const mod = await import('../lib/project-paths.js');
    assert.equal(typeof mod.resolveRoadmapPath, 'function');
  });
});
