#!/usr/bin/env node
/**
 * @smartmemory/compose-mcp — stdio launcher
 *
 * Resolves and spawns the MCP stdio server embedded in @smartmemory/compose.
 * Discovery is via the slim package; install pulls the full app transitively.
 * Single source of truth: every consumer runs server/compose-mcp.js.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let serverPath;
try {
  serverPath = require.resolve('@smartmemory/compose/mcp');
} catch (err) {
  console.error(
    '[compose-mcp] Could not locate @smartmemory/compose. Install it: npm install @smartmemory/compose'
  );
  console.error(`[compose-mcp] resolve error: ${err.message}`);
  process.exit(127);
}

const child = spawn(process.execPath, [serverPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', (err) => {
  console.error(`[compose-mcp] failed to spawn server: ${err.message}`);
  process.exit(1);
});
