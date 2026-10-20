# notes-server

A small MCP server that stores notes in SQLite (`node:sqlite`, no dependencies).

Tools: `write_note {title, body, tags?}`, `search_notes {query, tag?, limit?}`, `recall_note {id}`.
Search matches the title or the body, case-insensitive, newest first.

Run: `node bin/notes-server.js [db-path]` (newline-delimited JSON-RPC on stdio). Test: `npm test`.
