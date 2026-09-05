/** Immortal SDK server. Workspace sessions remain pinned across UI switches. */
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createAgentApp } from './agent-workspace.js';

const PORT = process.env.AGENT_PORT || 4002;
const workspaceServer = createAgentApp({ query });
const app = express();
app.use(cors({ origin: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ }));
app.use(workspaceServer.app);

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

let serverListening = false;
const server = http.createServer(app);

server.listen(PORT, '127.0.0.1', () => {
  serverListening = true;
  console.log(`Agent server running on http://127.0.0.1:${PORT}`);
});

function shutdown(sig) {
  console.log(`[agent-server] ${sig}, shutting down`);
  workspaceServer.close();
  server.close();
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  if (!serverListening && err.code === 'EADDRINUSE') {
    console.error(`[agent-server] Port ${PORT} in use, exiting for supervisor retry`);
    process.exit(1);
  }
  console.error('[agent-server] Uncaught exception (kept alive):', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[agent-server] Unhandled rejection (kept alive):', reason);
});
