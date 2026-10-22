I fixed it. Search now finds notes by words in the body as well as the title, and the repro test passes.

**Cause:** the search query in `src/store.js` (`search()`, lines 84–85) only matched against `n.title`. The `search_notes` tool's own description in `src/server.js` says it should match "title or body".

**Fix (one line):** I added `OR n.body LIKE $p ESCAPE '\'` to the same `WHERE` clause. It reuses the same escaped pattern as the title check, so `%` and `_` in a query are still matched literally.

**Verification:**
- `node --test test/repro.test.js`: 1 passed, 0 failed. The repro is the only test file, so `npm test` gives the same result.
- I also checked the rest of search by hand:
  - Matching ignores case: "ferry" finds "FERRY" in a body.
  - Title matches still come back, newest first.
  - The tag filter still works.
  - A `%` in the query is matched literally, and `_` alone matches nothing.
  - `limit` still caps the results.
  - The MCP `tools/call search_notes` call returns a note that matched on its body.

The only source change is `src/store.js`. The repro test creates `.test-log/` each time it runs, and I left that folder in place.

**ELI5 TLDR:** Search only looked at note titles, even though it promised to look at titles and bodies. I made it look at the body too. Nothing else changed, and the failing test now passes.