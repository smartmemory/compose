// Minimal MCP server (JSON-RPC 2.0, newline-delimited over stdio) exposing the notes store.

import { createInterface } from 'node:readline';
import { NotesError } from './store.js';

export const PROTOCOL_VERSION = '2025-06-18';

export const TOOLS = [
  {
    name: 'write_note',
    description: 'Store a note and return it with its id.',
    inputSchema: {
      type: 'object',
      required: ['title', 'body'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'search_notes',
    description: 'Find notes whose title or body contains the query (case-insensitive), newest first.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        tag: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'recall_note',
    description: 'Return one note by id, or null when it does not exist.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
  },
];

function callTool(store, name, args = {}) {
  switch (name) {
    case 'write_note':
      return store.write(args);
    case 'search_notes':
      return store.search(args.query, { tag: args.tag, limit: args.limit });
    case 'recall_note':
      return store.recall(args.id);
    default:
      throw new NotesError('UNKNOWN_TOOL', `unknown tool: ${name}`);
  }
}

// Returns the JSON-RPC response for one request, or null for a notification.
export function handleMessage(store, msg) {
  const isRequest = msg && Object.hasOwn(msg, 'id');
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } });

  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'invalid request');
  if (!isRequest) return null;

  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'notes-server', version: '1.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args } = msg.params ?? {};
      try {
        const result = callTool(store, name, args);
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
      } catch (err) {
        if (!(err instanceof NotesError)) throw err;
        return reply({ content: [{ type: 'text', text: `${err.code}: ${err.message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

export function serve(store, input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    const response = handleMessage(store, msg);
    if (response) output.write(JSON.stringify(response) + '\n');
  });
  rl.on('close', () => store.close());
  return rl;
}
