#!/usr/bin/env node
// T2-F5 retirement shim. The agent_run capability moved to stratum-mcp's
// stratum_agent_run tool. This file exists only to fail fast with a clear
// message for users whose .mcp.json still references it. Re-running
// `compose init` removes the stale entry.
process.stderr.write(
  'agent-mcp.js is retired (T2-F5). Use stratum_agent_run on the stratum MCP server.\n'
  + 'Re-run `compose init` to remove the legacy entry from .mcp.json.\n'
);
process.exit(1);
