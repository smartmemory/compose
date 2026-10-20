#!/usr/bin/env node
// Start the notes MCP server on stdio. Database: argv[2], else $NOTES_DB, else in-memory.

import { NotesStore } from '../src/store.js';
import { serve } from '../src/server.js';

serve(new NotesStore(process.argv[2] ?? process.env.NOTES_DB ?? ':memory:'));
