I fixed it: `search_notes` now finds notes when the query appears in the body, not just the title.

**Cause:** the search query in `src/store.js` (`search()`, line 84) only checked the title. The tool's own description in `src/server.js:24` says it searches "title or body".

**Fix:** I added one line that also checks the body, using the same escaped pattern as the title check:
```js
sql += " OR n.body LIKE $p ESCAPE '\\'";
```

**Verification:**
- `node --test test/repro.test.js` now passes (1 pass, 0 fail).
- I spot-checked the rest of search by hand. Matching ignores case, results come newest first, and title and body matches both come back. The tag filter still narrows results, and `%` and `_` are still matched as literal characters. `limit` is still respected.
- The repo has no other test files, so nothing beyond the repro and these checks was run.

The diff touches only `src/store.js`. Running the repro also creates `.test-log/`, which I left in place.

**ELI5 TLDR:** Search was only looking at note titles, even though it was meant to look inside the text too. I made it check both, and nothing else changed.