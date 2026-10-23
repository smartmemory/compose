# notes-server

A small MCP server that stores notes in SQLite (`node:sqlite`, no dependencies).

Tools: `write_note {title, body, tags?}`, `search_notes {query, tag?, limit?}`, `recall_note {id}`.
Search returns matching notes, newest first.
Tags are stored trimmed, lower-case and unique however a note gets them (write, update, importNotes), and tag searches match the same way.
The store also offers `update(id, {title?, body?, tags?})` and `importNotes(rows)` (see `src/seed.js` for sample rows).

Run: `node bin/notes-server.js [db-path]` (newline-delimited JSON-RPC on stdio). Test: `npm test`.
