I’ll run the repro, trace how tags are stored and filtered, then make a focused source fix and check the other tests. I’m using the systematic debugging skill.The repro fails because `write()` lowercases tags, while `search()` compares them case-sensitively (`src/store.js:40,125`). Updates and imports preserve tag case (`src/store.js:84,100`), so I’ll fix the comparison without changing stored tags.Fixed `src/store.js:125` with a case-insensitive tag comparison, preserving stored tags. The repro is unchanged.

Verified:
- `node --test test/repro.test.js` passes.
- `npm test` passes.
- Additional SQLite checks pass for imports, updates, ordering, limits, literal search, validation, and MCP calls.