I’ll run the repro, trace the search logic, and fix the source without changing the repro test.I’m using the systematic debugging and test-driven development skills to confirm the failure before making a minimal fix.The repro fails as reported. The SQL checks only the title at `src/store.js:84`, while the tool description promises title or body matches at `src/server.js:24`. I’ll add the body condition using the existing escaped query pattern.Fixed `src/store.js:84` to search both title and body using the existing escaped query pattern. The repro is unchanged.

Verified:
- `node --test test/repro.test.js` passes.
- `npm test` passes.
- Additional SQLite checks pass for tags, ordering, limits, literal escaping, recall, validation, removal, and MCP responses.