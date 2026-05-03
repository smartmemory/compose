/**
 * mcp-fail-index-write.mjs — test fixture for MCP boundary err.cause test.
 *
 * Installs a renameSync hook that throws on the second call (the index write),
 * then starts the real MCP server. The failure must be set BEFORE the server
 * imports run so the hook is in place when tools/call arrives.
 *
 * Usage: spawn `node compose/test/fixtures/mcp-fail-index-write.mjs`
 * with COMPOSE_TARGET set to a tmp dir containing a valid journal index.
 */

import { _fsHooks } from '../../lib/journal-writer.js';

const origRenameSync = _fsHooks.renameSync;
let callCount = 0;
_fsHooks.renameSync = (src, dst) => {
  callCount++;
  if (callCount === 2) {
    throw Object.assign(
      new Error('forced index-write failure'),
      { code: 'ETESTFAIL' },
    );
  }
  return origRenameSync(src, dst);
};

// Start the server with the hook already in place.
await import('../../server/compose-mcp.js');
